import { Injectable, Inject, Logger, NotFoundException, ForbiddenException, forwardRef } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
  CapabilityService,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc, and, count, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import {
  leads,
  chatSessions,
  chatMessages,
  requirements,
} from '@server/database/schema';
import { NotifyService } from '../notify/notify.service';
import { normalizeFieldByKey } from './lead-field-normalizer';
import { ChatEventBus } from './chat-event-bus.service';
import { AiConfigService } from '../admin/ai-config.service';
import { RoutingService } from '../routing/routing.service';
import { RequirementCollectionService } from '../automation/requirement-collection.service';
import { LeadGradingService } from '../leads/lead-grading.service';
import { SalaryConfigService } from '../salary-config/salary-config.service';
import { normalizeServiceType, normalizeServiceSubType, chineseServiceType, getServiceTypeLabel, getTemplate, OPENING_MESSAGES, DEFAULT_OPENING_MESSAGE, isZhujiaRequiredFieldsComplete, isZhongdianRequiredFieldsComplete } from '../automation/requirement-templates';
import { normalizeStream } from './stream-utils';
import { normalizeSource, sanitizeCity, normalizeLead } from '@shared/channels';
import { formatBudgetRange } from '@shared/budget-format';
import {
  SWAN_PERSONA,
  AI_REPLY_PLUGIN_ID,
  AI_REPLY_ACTION_KEY,
  buildFieldsOutputInstruction,
  REQUIREMENT_EXTRACTION_PLUGIN_ID,
  REQUIREMENT_EXTRACTION_ACTION_KEY,
  REQUIREMENT_EXTRACTION_INTERVAL,
  MAX_HISTORY_MESSAGES,
  TRANSFER_KEYWORDS,
  TRANSFER_MESSAGE,
  NO_AGENT_ONLINE_MESSAGE,
  FRUSTRATION_KEYWORDS,
  FRUSTRATION_TRANSFER_MESSAGE,
  buildTemplateReferencePrompt,
  SUGGESTION_PROMPT,
  SUMMARY_PLUGIN_ID,
  SUMMARY_ACTION_KEY,
  detectServiceTypeFromText,
  detectCityTier,
  detectAreaFromText,
  extractAreaFromHistory,
  OPENING_MESSAGES_BY_SERVICE,
} from './chat.prompt';
import { ReplyLearningService, type LearnedTemplate } from './reply-learning.service';
import { ChatGuardService } from './chat-guard.service';
import { ChatPricingService } from './chat-pricing.service';
import { IntelligentRouterService } from './intelligent-router/intelligent-router.service';
import { ChatTransferService } from './chat-transfer.service';
import { ChatRequirementsService } from './chat-requirements.service';
import { ChatSessionService } from './chat-session.service';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import {
  RequirementDeltaService,
  type FieldDeltaChange,
} from '../leads/requirement-delta.service';
import type {
  ChatSession,
  ChatMessage,
  ChatSessionListItem,
  ChatSessionListResponse,
  ChatSessionDetail,
  CustomerChatInfo,
  CustomerPollResult,
  Lead,
  LeadSource,
  Requirement,
  RequirementStatus,
  ChatSessionMode,
  ChatSessionStatus,
  TransferSource,
  ReplySuggestion,
  HandoffSummary,
  CollectionProgress,
  FormSubmitRequest,
  FormSubmitResponse,
} from '@shared/api.interface';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
    private readonly notifyService: NotifyService,
    private readonly aiConfigService: AiConfigService,
    @Inject(forwardRef(() => RoutingService))
    private readonly routingService: RoutingService,
    private readonly requirementCollectionService: RequirementCollectionService,
    @Inject(forwardRef(() => LeadGradingService))
    private readonly leadGradingService: LeadGradingService,
    private readonly replyLearningService: ReplyLearningService,
    private readonly salaryConfigService: SalaryConfigService,
    private readonly chatEventBus: ChatEventBus,
    private readonly chatGuardService: ChatGuardService,
    private readonly chatPricingService: ChatPricingService,
    private readonly intelligentRouter: IntelligentRouterService,
    @Inject(forwardRef(() => ChatTransferService))
    private readonly chatTransferService: ChatTransferService,
    @Inject(forwardRef(() => ChatRequirementsService))
    private readonly chatRequirementsService: ChatRequirementsService,
    @Inject(forwardRef(() => ChatSessionService))
    private readonly chatSessionService: ChatSessionService,
    private readonly agentDispatchService: AgentDispatchService,
    private readonly requirementDeltaService: RequirementDeltaService,
  ) {}

  // ============ 核心调度 ============


  /**
   * 客户端 - 发送消息
   * 流程：① 存储客户消息 ② 调用 AI 生成回复 ③ 存储 AI 回复
   *      ④ 每 N 轮调用 AI 提取结构化需求 ⑤ 需求完成时更新 lead 状态并通知运营
   */
  async sendCustomerMessage(
    token: string,
    content: string,
  ): Promise<ChatMessage> {
    // 1. 获取或创建会话
    const { session, lead } = await this.chatSessionService.getOrCreateSessionAndLead(token);

    // 2. 客户首次发消息时更新 lead 状态为 chatting
    if (lead.status === 'new') {
      await this.db
        .update(leads)
        .set({ status: 'chatting' })
        .where(eq(leads.id, lead.id));
    }

    // 3. 存储客户消息
    const insertedCustomerMsg = await this.db
      .insert(chatMessages)
      .values({
        sessionId: session.id,
        role: 'customer',
        content,
      })
      .returning();
    const customerMessage = this.chatSessionService.mapMessage(insertedCustomerMsg[0]);

    // 实时性保障：客户活跃时顺带跑一次超时转派 + pending 补派（防抖，不阻塞主流程）
    void this.agentDispatchService.triggerFullCheck();

    // 3.1 SSE：推给 lead 的 assignee（已分配）或全池（未分配 + human 模式）
    try {
      const event = {
        type: 'message.created' as const,
        sessionId: session.id,
        message: customerMessage,
      };
      if (lead.assigneeId) {
        this.chatEventBus.emitToUser(lead.assigneeId, event);
      } else if (session.mode === 'human') {
        this.chatEventBus.emitToAll(event);
      }
    } catch (err) {
      this.logger.warn(`SSE emit sendCustomerMessage 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3.5 人工接管模式下，检查客服是否已响应
    if (session.mode === 'human') {
      const recentMsgsForCheck = await this.db
        .select({ role: chatMessages.role, createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id))
        .orderBy(desc(chatMessages.createdAt))
        .limit(50);

      const hasAgentReply = recentMsgsForCheck.some(
        (m) => m.role === 'agent',
      );

      if (hasAgentReply) {
        this.logger.log(`会话 ${session.id} 处于人工接管模式，跳过 AI 回复`);

        // 2026-08-16 林琳 19:31 反馈修复：转人工后，需求采集进度面板不再继续提取客户要求
        // 根因：hasAgentReply 块直接 return 跳过了 5.5 节实时字段提取，导致客户在 human 模式下回答的
        //   字段（薪资预算 / 阿姨要求 / 做饭口味 等）写不进 requirements 表，UI 进度面板永远停在转人工前的状态
        // 修法：return 之前 fetch 完整 chatMessages + 调 runRealtimeFieldDetection（只更新采集进度，不调 AI 回复）
        try {
          const humanFullMsgs = await this.db
            .select()
            .from(chatMessages)
            .where(eq(chatMessages.sessionId, session.id))
            .orderBy(desc(chatMessages.createdAt))
            .limit(50);
          humanFullMsgs.reverse();
          await this.chatRequirementsService.runRealtimeFieldDetection(lead.id, humanFullMsgs, '[人工模式]');
        } catch (err) {
          this.logger.warn(`[人工模式] 实时字段检测异常: ${err instanceof Error ? err.message : String(err)}`);
        }

        return customerMessage;
      }

      // 无客服回复，检查转人工超时
      const lastBotMsgForCheck = recentMsgsForCheck.find(
        (m) => m.role === 'bot',
      );
      if (lastBotMsgForCheck) {
        const elapsedMs =
          Date.now() - new Date(lastBotMsgForCheck.createdAt).getTime();
                // 2026-08-15 缩短：原 2*60*1000 = 2min，2min 内客户被晾无任何响应。
        // 改为 30s：30s 内若仍无客服接入，立即 fallback AI 模式 + 兜底消息，避免客户被长时间挂起。
        const HUMAN_WAIT_TIMEOUT_MS = 30 * 1000;

        if (elapsedMs < HUMAN_WAIT_TIMEOUT_MS) {
          this.logger.log(
            `会话 ${session.id} 等待客服接入中 (${Math.round(elapsedMs / 1000)}s)`,
          );
          return customerMessage;
        }

        this.logger.log(
          `会话 ${session.id} 转人工 ${Math.round(elapsedMs / 1000)}s 无客服接入，自动回退 AI`,
        );
        await this.db
          .update(chatSessions)
          .set({ mode: 'ai' })
          .where(eq(chatSessions.id, session.id));

        await this.db.insert(chatMessages).values({
          sessionId: session.id,
          role: 'bot',
          content: NO_AGENT_ONLINE_MESSAGE,
        });
        // 继续走 AI 回复流程（不 return）
      } else {
        return customerMessage;
      }
    }

    // 3.5.1 检查上一轮 AI 是否使用了学习模板，记录结果
    const pendingUsage = await this.replyLearningService.checkPendingUsage(session.id);
    if (pendingUsage) {
      const transferKws = await this.aiConfigService.getTransferKeywords(TRANSFER_KEYWORDS);
      const isTransferRequest = transferKws.some((kw: string) => content.includes(kw));
      await this.replyLearningService.recordOutcome(
        pendingUsage.id,
        pendingUsage.templateId,
        !isTransferRequest,
      );
      this.logger.log(
        `模板使用结果: ${!isTransferRequest ? 'success' : 'fail'} (template=${pendingUsage.templateId})`,
      );
    }

    // 3.6 首条客户消息：AI 意图分类（B 培育触达依赖意向分类，保留）+ 新派单服务分配
    if (!lead.intent) {
      try {
        const intent = await this.routingService.classifyIntent(content);
        if (intent) {
          await this.db
            .update(leads)
            .set({ intent: intent.intent, routingReason: `AI意图:${intent.category}` })
            .where(eq(leads.id, lead.id));
          const urgentAutoTransfer =
            intent.urgency === 'high' &&
            (await this.aiConfigService.getConfigWithDefault('urgent_auto_transfer', 'true')) === 'true';
          if (urgentAutoTransfer) {
            this.logger.log(`线索 ${lead.id} 紧急投诉自动转人工`);
            await this.chatTransferService.doTransferToHuman(session.id, 'AI识别紧急投诉，自动转人工', 'auto', lead);
            return customerMessage;
          }
        }
        const assignedAgentId = await this.agentDispatchService.assignLeadIfEligible(lead.id, '首条消息派单');
        this.logger.log(
          `线索 ${lead.id} 首条消息派单: intent=${intent?.intent ?? 'null'}, assignee=${assignedAgentId ?? '无'}`,
        );
      } catch (error) {
        this.logger.error(
          `首条消息派单失败: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    // 3.7 月休非标早拦截（早于 transfer 关键词/情绪/checkRestDaysResponse）
    // 2026-09-12 林琳拍板（文档 §5.4）：月休非标（月休 1/3/5/6 天等）一律转人工沟通，
    //   带薪资/匹配范围说明话术作安抚；取代 2026-08-15 "插模板不转人工"的临时修法
    // 2026-08-16 林琳 16:58 拍板：钟点工场景（isZhongdian=true）跳过"无月休"早拦截
    //   钟点工"无月休"是正常选项，AI 应继续采 8 字段
    // 2026-08-16 林琳 19:44 拍板：钟点工选了"无月休" 8 字段全齐**不**走转人工（见下方护栏）
    //   这里继续跳过"无月休"早拦截，让 AI 把月休当成正常选项记录下来
    // 修复：serviceType 在 requirements.serviceType 而非 lead.serviceType
    const currentRequirement = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
    const leadSubType = normalizeServiceSubType(currentRequirement?.serviceType ?? null);
    const isLeadZhongdian = leadSubType === 'zhongdian';
    const restDaysEarly = this.chatGuardService.detectNonStandardRestDays(content, isLeadZhongdian);
    if (restDaysEarly) {
      this.logger.log(
        `月休非标→转人工: customer="${content.slice(0, 40)}" reason=${restDaysEarly.reason}`,
      );
      await this.chatTransferService.doTransferToHuman(
        session.id,
        restDaysEarly.reason,
        'auto',
        lead,
        restDaysEarly.message,
      );
      return customerMessage;
    }

    // 3.7 关键词自动转人工检测
    const keywords = await this.aiConfigService.getTransferKeywords(TRANSFER_KEYWORDS);
    const matchedKeyword = this.chatTransferService.autoDetectTransfer(content, keywords);
    if (matchedKeyword) {
      this.logger.log(`会话 ${session.id} 客户消息命中转人工关键词: ${matchedKeyword}`);
      await this.chatTransferService.doTransferToHuman(
        session.id,
        '客户申请转人工',
        'customer',
        lead,
        '好的，马上为您转接人工客服，请稍等~',
      );
      return customerMessage;
    }

    // 3.7.1 客户情绪升级 / 重复提问 → 立即转人工（2026-08-14 新增）
    // 优先级最高：宁可误转也不让客户气走。命中后跳过 LLM 直接转人工。
    const frustrationKeyword = this.chatTransferService.detectFrustration(content);
    if (frustrationKeyword) {
      this.logger.log(
        `会话 ${session.id} 客户情绪升级，关键词: "${frustrationKeyword}"，立即转人工`,
      );
      await this.chatTransferService.doTransferToHuman(
        session.id,
        '情绪升级',
        'auto',
        lead,
        FRUSTRATION_TRANSFER_MESSAGE,
      );
      return customerMessage;
    }

    // 3.7.2 C1 情绪评分超阈值转人工：AI 打分、代码判阈值
    try {
      const emotionResult = await this.routingService.classifyC1Emotion(content);
      if (emotionResult?.level === 'high') {
        this.logger.log(`会话 ${session.id} C1 情绪评分 high，系统自动转人工`);
        await this.chatTransferService.doTransferToHuman(
          session.id,
          '情绪升级',
          'auto',
          lead,
          FRUSTRATION_TRANSFER_MESSAGE,
        );
        return customerMessage;
      }
    } catch (error) {
      this.logger.warn(
        `C1 情绪评分调用失败，跳过: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 4. AI 回复改为异步防抖：接口立即返回，客户可随时连续发消息
    //    2.5 秒防抖窗口内有新客户消息则重置计时，触发后就连续消息统一生成一次回复
    this.scheduleAiReply(session.id, lead);

    return customerMessage;
  }

  private aiReplyDebounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  private aiReplyInFlight = new Set<string>();
  private aiReplyPendingRetry = new Set<string>();

  private scheduleAiReply(sessionId: string, lead: Lead): void {
    const existing = this.aiReplyDebounceTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.aiReplyDebounceTimers.delete(sessionId);
      void this.runDebouncedAiReply(sessionId, lead);
    }, 2500);
    this.aiReplyDebounceTimers.set(sessionId, timer);
  }

  private async runDebouncedAiReply(
    sessionId: string,
    lead: Lead,
  ): Promise<void> {
    try {
      const sessionRows = await this.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);
      if (sessionRows.length === 0) return;
      const session = sessionRows[0];
      if (session.mode !== 'ai') {
        this.logger.log(
          `会话 ${sessionId} 防抖回复触发时已非 AI 模式，跳过`,
        );
        return;
      }
      if (this.aiReplyInFlight.has(sessionId)) {
        this.aiReplyPendingRetry.add(sessionId);
        this.logger.log(
          `会话 ${sessionId} 已有进行中的 AI 回复，标记待重跑，当前回复完成后补发`,
        );
        return;
      }
      this.aiReplyInFlight.add(sessionId);
      try {
      const recentMsgs = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionId))
        .orderBy(desc(chatMessages.createdAt))
        .limit(20);
      const burst: string[] = [];
      for (const m of recentMsgs) {
        if (m.role === 'customer') {
          burst.unshift(m.content);
        } else {
          break;
        }
      }
      if (burst.length === 0) return;
      this.logger.log(
        `会话 ${sessionId} 防抖回复触发，合并 ${burst.length} 条客户消息统一回复`,
      );
      await this.runAiReplyPipeline(session, lead, burst.join('\n'));
      } finally {
        this.aiReplyInFlight.delete(sessionId);
        // 回复完成后检查是否有待重跑标记——客户在回复生成期间又发了新消息
        if (this.aiReplyPendingRetry.has(sessionId)) {
          this.aiReplyPendingRetry.delete(sessionId);
          this.logger.log(`会话 ${sessionId} 当前回复完成，有待重跑标记，重新触发防抖回复`);
          setTimeout(() => {
            void this.runDebouncedAiReply(sessionId, lead);
          }, 500);
        }
      }
    } catch (error) {
      this.logger.error(
        `防抖 AI 回复失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private async runAiReplyPipeline(
    session: typeof chatSessions.$inferSelect,
    lead: Lead,
    content: string,
  ): Promise<void> {
    const currentRequirement =
      await this.chatRequirementsService.getRequirementByLeadId(lead.id);
    const pipelineSubType = normalizeServiceSubType(
      currentRequirement?.serviceType ?? null,
    );
    const isLeadZhongdian = pipelineSubType === 'zhongdian';

    // 4. 组装对话历史
    const maxHistory = await this.aiConfigService.getConfigNumber('max_history_messages', MAX_HISTORY_MESSAGES);
    const historyMessages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(maxHistory);

    // 按时间正序排列
    historyMessages.reverse();

    // 3.8 月休问题专项检测 + 其他二选一超范围检测（含AI话术学习拦截）
    let activeTemplate: LearnedTemplate | null = null;
    const botMsgs = historyMessages.filter((m) => m.role === 'bot');
    const lastBotMsg = botMsgs[botMsgs.length - 1];
    if (lastBotMsg) {
      // 2026-08-16 林琳 16:58 拍板：钟点工场景跳过 checkRestDaysResponse
      const restDaysResult = this.chatGuardService.checkRestDaysResponse(lastBotMsg.content, content, isLeadZhongdian);
      if (restDaysResult.shouldTransfer) {
        // 2026-09-12 林琳拍板（文档 §5.4）：二选一超范围答案（如"休 6 天"）一律转人工，
        //   checkRestDaysResponse 已算好含薪资/范围说明的安抚话术作为转接前的 bot 消息
        this.logger.log(
          `月休非标→转人工: bot问="${lastBotMsg.content.slice(0, 50)}" customer="${content}" reason=${restDaysResult.reason}`,
        );
        await this.chatTransferService.doTransferToHuman(
          session.id,
          restDaysResult.reason ?? '月休非标需求，转人工沟通',
          'auto',
          lead,
          restDaysResult.message,
        );
        return;
      }
      if (!activeTemplate) {
        const twoChoiceResponse = this.chatGuardService.buildTwoChoiceOutOfRangeResponse(lastBotMsg.content, content);
        if (twoChoiceResponse) {
          const topicKey = 'two_choice_out_of_range';
          const template = await this.replyLearningService.findTemplate(topicKey);
          if (template) {
            activeTemplate = template;
            this.logger.log(`命中学习模板: topic=${topicKey}, template=${template.id}, status=${template.status}`);
          } else {
            // 不再转人工：复用「休6天」详细模板风格，直接插入 AI 模板回复
            this.logger.log(`二选一超范围(已改为不转人工): bot问="${lastBotMsg.content.slice(0, 50)}" customer="${content}"`);
            await this.db.insert(chatMessages).values({
              sessionId: session.id,
              role: 'bot',
              content: twoChoiceResponse,
            });
            return;
          }
        }
      }
    }
    const conversationHistory = historyMessages
      .map((m) => `${m.role === 'customer' ? '雇主' : '小书'}: ${m.content}`)
      .join('\n');

    // 5. 获取当前已收集需求（含关键词快速识别服务类型 + 轻量级字段检测）
    // 注：已在 3.7 节 fetch 过 currentRequirement（用于 isLeadZhongdian），直接复用
    //   若 upsertServiceType / mergeRequirementFields 更新了 DB，再重新 fetch
    // 先答问题，再采需求：命中问答类意图（询价/收费/服务范围/转人工）时，
    // 本轮不做关键词服务类型识别，避免泛称（如只说'保姆'）被默认写成具体类型，
    // 导致路由层工具拿不到泛称、无法反问澄清；推卡判断复用该结果一并跳过
    const qaIntentHit: boolean = this.intelligentRouter.hasQaIntent(content);
    let reqForGuidance = currentRequirement;
    if (!qaIntentHit && !reqForGuidance?.serviceType) {
      const detectedType = detectServiceTypeFromText(content);
      if (detectedType) {
        await this.chatRequirementsService.upsertServiceType(lead.id, detectedType);
        reqForGuidance = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
        this.logger.log(`关键词识别服务类型: ${detectedType}`);
      }
    }

    // 5.5 轻量级实时字段检测：每轮都从最近对话中提取已答字段，避免 AI 重复询问
    //   2026-08-16 19:31：封装成 runRealtimeFieldDetection，让"人工接管"路径也能复用
    const updatedReq = await this.chatRequirementsService.runRealtimeFieldDetection(lead.id, historyMessages);
    if (updatedReq) {
      reqForGuidance = updatedReq;
    }

    // 5.6 form_card 推送判断：服务类型已确认 + 阶段1字段已采≤1 + 未推送过表单
    if (reqForGuidance?.serviceType) {
      const phase1Fields = [
        reqForGuidance.householdSize,
        reqForGuidance.area,
        reqForGuidance.hasPet,
        reqForGuidance.elderlyCare,
        reqForGuidance.childCare,
        reqForGuidance.restDays,
        reqForGuidance.startTime,
        reqForGuidance.serviceAddress,
      ];
      const collectedCount = phase1Fields.filter(
        (v) => v && String(v).trim() !== '',
      ).length;
      const hasFormCard = historyMessages.some(
        (m) => m.role === 'bot' && m.content.startsWith('{"type":"form_card"'),
      );
      if (qaIntentHit) {
        this.logger.log('[runAiReplyPipeline] 跳过 form_card 推送: 命中问答类意图，交由路由层回答');
      } else if (collectedCount <= 1 && !hasFormCard) {
        const serviceTypeLabel = getServiceTypeLabel(reqForGuidance.serviceType);
        const formCardContent = JSON.stringify({
          type: 'form_card',
          serviceType: serviceTypeLabel,
          formName: 'live_in_nanny_demand',
        });
          await this.db.insert(chatMessages).values({
            sessionId: session.id,
            role: 'bot',
            content: formCardContent,
          });
          this.logger.log(`[runAiReplyPipeline] 推送 form_card: serviceType=${serviceTypeLabel}, collected=${collectedCount}`);
          return;
      }
    }

    const guidancePrompt = this.requirementCollectionService.buildGuidancePrompt(
      reqForGuidance?.serviceType ?? null,
      reqForGuidance,
      lead.serviceCity,
    );

    // 6. 智能调度层 + AI 流式回复（Function Calling 改造阶段一 MVP）
    //   报价意图命中 → 工具直读 salary_config 生成回复，不调 LLM；未命中 → 老路不变；工具失败自动回退老路
    let fullResponse = '';
    let routedByTool = false;
    const routeResult = await this.intelligentRouter.tryRoute(
      content,
      {
        requirement: reqForGuidance ?? currentRequirement,
        serviceCity: lead.serviceCity,
        currentMessage: content,
        historyMessages,
        sessionId: session.id,
        lead,
      },
      `session=${session.id}`,
    );
    if (routeResult.handled) {
      fullResponse = routeResult.reply;
      routedByTool = true;
    } else {
      try {
        const aiReplyPluginId = await this.aiConfigService.getConfigWithDefault('ai_reply_plugin_id', AI_REPLY_PLUGIN_ID);
        const persona = await this.aiConfigService.getPersonaWithQa(SWAN_PERSONA);
        // 把业务维护的薪资区间表拼到 persona 末尾，让 AI 在客户询问市场价时按表回答
        const salaryReference = await this.salaryConfigService
          .buildPersonaReference()
          .catch((err) => {
            this.logger.warn(`加载薪资参考失败（不阻塞 persona）: ${err instanceof Error ? err.message : String(err)}`);
            return '';
          });
        const personaWithSalary = persona + salaryReference;
        const effectivePersona = activeTemplate
          ? personaWithSalary + buildTemplateReferencePrompt(activeTemplate.answerText)
          : personaWithSalary;
        // 合并调用：在 collected_requirements 末尾加字段输出指令
        // 让 AI 同时输出回复 + 结构化字段，一次调用搞定
        const guidanceWithFields = guidancePrompt + buildFieldsOutputInstruction();
        const streamResult = await this.capabilityService
          .load(aiReplyPluginId)
          .callStream(AI_REPLY_ACTION_KEY, {
            persona: effectivePersona,
            conversation_history: conversationHistory,
            collected_requirements: guidanceWithFields,
            latest_customer_message: content,
          });

        const stream = normalizeStream(streamResult);
        this.logger.log('AI 流式连接成功，开始接收回复');

        for await (const chunk of stream) {
          const chunkContent = (chunk as { content?: string }).content;
          if (chunkContent) {
            fullResponse += chunkContent;
          }
        }
        this.logger.log(`AI 回复完成，长度: ${fullResponse.length}`);

        // 合并调用：从 AI 回复中解析结构化字段并写入 DB
        // 字段解析失败不影响回复展示
        const parsed = this.chatRequirementsService.parseFieldsFromAiReply(fullResponse);
        if (parsed.enrichedFields) {
          fullResponse = parsed.reply;
          try {
            // 字段提取完整性校验：AI 可能丢方向词/限定词，用代码正则兜底
            this.chatRequirementsService.validateFieldExtraction(parsed.enrichedFields, content);
            await this.chatRequirementsService.saveParsedFields(lead.id, parsed.enrichedFields);
            this.logger.log(`合并字段已写入 DB: lead=${lead.id.slice(0, 8)}`);
          } catch (err) {
            this.logger.warn(
              `合并字段写入 DB 失败（不阻塞回复）: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          this.logger.warn('AI 回复中未解析到字段 JSON，走正则兜底');
        }
      } catch (error) {
        this.logger.error(
          `AI 回复生成失败: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        fullResponse = '抱歉，我暂时无法回复，请稍后再试~';
      }
    }

    // 6.2.5 B-price 误转人工护栏：月休4天嫌贵想换6天的特殊场景，不应触发 B-price 转人工
    // 触发条件：客户消息同时含"月休4天"+"贵/便宜"+"换/改/变/月休6天"等
    if (this.chatPricingService.isMonthRest4TooExpensiveSwitchTo6(content)) {
      const canonical = '可以为您协商，但是需要先提前说明，接受月休6天的阿姨会比较少一些，所以您的可选范围也会比较少。您这边要不要先看下，我们帮您匹配看下有没有合适的？';
      // 1) 剥离【转人工】（B-price 误触发）
      let patched = fullResponse.replace(/【转人工】/g, '').trim();
      // 2) 如果 LLM 答非所问（没包含"月休6天阿姨少"这层意思），强制覆写为标准模板
      const isGood = /月休\s*6\s*天.{0,15}(比较少|少一些|不多|少)/.test(patched) || /(可选范围|协商)/.test(patched);
      if (!isGood) {
        patched = canonical;
      }
      if (patched !== fullResponse) {
        this.logger.warn(`月休4天嫌贵想换6天场景强制覆写: customer="${content.slice(0, 40)}" llm="${fullResponse.slice(0, 80)}" patched="${patched.slice(0, 80)}"`);
      }
      fullResponse = patched;
    }

    // 6.3 老人问句剔除护栏：elderlyCare 已填 → 强制把 LLM 输出里含"老人/照护/陪护 + ？"的疑问句剔除
    // 这是最后一锤子：即使 detectFieldsFromConversation 没采到 / 引导 prompt LLM 没读 / LLM 故意再问
    // 这一步保证客户端永远不会再被问"家里有需要照顾的老人吗"
    if (currentRequirement?.elderlyCare) {
      const stripped = this.chatGuardService.stripElderlyQuestion(fullResponse);
      if (stripped !== fullResponse) {
        this.logger.warn(`elderlyCare 已填但 LLM 又问老人问题，强制剔除: customer="${content.slice(0, 30)}" llm="${fullResponse.slice(0, 80)}" stripped="${stripped.slice(0, 80)}"`);
        fullResponse = stripped.length < 4 ? '好的~' : stripped;
      }
    }

    // 6.3.5 已采集字段又被 LLM 反复询问的通用护栏（2026-08-15 林琳反馈服务类型已确认白班保姆又被问）
    // 根因：LLM 在 persona / guidance prompt 都明示"不要重复问已采集字段"但仍反复违反
    // 与 elderlyCare 一样做"输出端代码级硬约束"——把已采集字段的疑问句整对剔除
    // 覆盖字段：服务类型、月休、面积、家庭人口、住家/白班、薪资预算（高频被复问的）
    // 2026-08-16 23:04 林琳反馈死循环：AI 重新问"主要想让阿姨负责哪些事呢"——LLM 丢失字段状态
    // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
    //   直接从 reqForStrip.serviceItems / serviceHours 读
    const reqForStrip = reqForGuidance ?? currentRequirement;
    if (reqForStrip) {
      const stripInputs = {
        serviceType: reqForStrip.serviceType,
        restDays: reqForStrip.restDays,
        area: reqForStrip.area,
        householdSize: reqForStrip.householdSize,
        elderlyCare: reqForStrip.elderlyCare,
        budget: reqForStrip.budget,
        serviceItems: reqForStrip.serviceItems,
        serviceHours: reqForStrip.serviceHours,
        startTime: reqForStrip.startTime,
        serviceAddress: reqForStrip.serviceAddress,
        helperRequirements: reqForStrip.helperRequirements,
        dietaryPreferences: reqForStrip.dietaryPreferences,
      };
      const filledKeys = Object.keys(stripInputs).filter(
        (k) => stripInputs[k as keyof typeof stripInputs] && String(stripInputs[k as keyof typeof stripInputs]).trim(),
      );
      // 诊断日志：只在 fullResponse 含问号时打（避免噪音），让林琳复现后我能从 log 看 collectedFields 实际值
      if (fullResponse.includes('？') || fullResponse.includes('?')) {
        this.logger.warn(
          `[strip 6.3.5 诊断] lead=${lead.id.slice(0, 8)} filledKeys=${filledKeys.join(',')} ` +
          `serviceItems=${JSON.stringify(stripInputs.serviceItems)} ` +
          `serviceHours=${JSON.stringify(stripInputs.serviceHours)} ` +
          `helperReq=${JSON.stringify(stripInputs.helperRequirements)} ` +
          `dietaryPref=${JSON.stringify(stripInputs.dietaryPreferences)} ` +
          `fullResponse=${JSON.stringify(fullResponse.slice(0, 80))}`,
        );
      }
      const stripped = this.chatGuardService.stripReaskCollectedFields(fullResponse, stripInputs);
      let didStrip = false;
      if (stripped !== fullResponse) {
        this.logger.warn(`已采集字段被 LLM 反复询问，强制剔除: customer="${content.slice(0, 30)}" llm="${fullResponse.slice(0, 80)}" stripped="${stripped.slice(0, 80)}"`);
        fullResponse = stripped.length < 4 ? '好的~' : stripped;
        didStrip = true;
      }
      // 6.3.5 v2 超前回答防护：剔除复问后若回复变短且还有未采字段，自动续问下一题
      //   场景：客户在一条消息里答了多个问题（超前回答），LLM 只识别了第一个并追问已采的，
      //         剔除后回复空了 → 自动跳到下一个未采字段继续采集
      if (didStrip && reqForGuidance?.serviceType) {
        const tplForNext = getTemplate(reqForGuidance.serviceType);
        const getReqValue = (key: string): string => {
          return (reqForGuidance?.[key as keyof typeof reqForGuidance] as string | null | undefined)?.trim() || '';
        };
        const isFieldFilled = (key: string): boolean => {
          if (key === 'householdSize' || key === 'area') {
            return getReqValue('householdSize').length > 0 || getReqValue('area').length > 0;
          }
          return getReqValue(key).length > 0;
        };
        let nextFieldQuestion: string | null = null;
        for (const f of tplForNext) {
          if (!isFieldFilled(f.key)) {
            nextFieldQuestion = f.question;
            break;
          }
        }
        // 续问条件：有下一未采字段 & 当前回复不含任何有效问题（剔除后只剩确认语）
        const hasQuestionLeft = /[？?]/.test(fullResponse);
        if (nextFieldQuestion && !hasQuestionLeft) {
          const prefix = fullResponse.length > 2 ? fullResponse.replace(/[。！!~～,， ]+$/, '') + '，' : '好的~ ';
          this.logger.warn(
            `[超前回答防护] 剔除后无后续问题，自动续问下一项: lead=${lead.id.slice(0, 8)} nextQ="${nextFieldQuestion.slice(0, 40)}"`,
          );
          fullResponse = prefix + nextFieldQuestion;
        }
      }
    }

    // 6.4 月休+价格问题护栏：客户问"月休和价格的关系"时，强制覆写 LLM 输出为短答模板
    // 根因：LLM 在此场景反复输出"城市调整"错答（即使 persona 改了也没用），需要代码级硬约束
    // 2026-08-15 林琳反馈原模板两处问题：
    //   1) "月休多阿姨少赚点、月休少阿姨多赚点"——以阿姨角度说，要改成客户角度："月休多，薪酬就低一点；月休少，薪酬就高一点"
    //   2) "咱们这边您倾向月休几天呢？"——主动给客户自由选择的余地，月休 2/4 天是平台标准不能主动提起
    if (this.chatPricingService.isRestDaysPriceQuestion(content)) {
      // 已采到月休天数 → 答完关系后顺手呼应一下，让客户知道这条信息对得上；未采到 → 不主动问，止于关系说明
      const canonical = currentRequirement?.restDays
        ? `月休天数会影响价格——月休多，价格就低一点；月休少，价格就高一点。平台这边不额外加价。您之前定的月休 ${currentRequirement.restDays} 天就是按这个算的~`
        : '月休天数会影响价格——月休多，价格就低一点；月休少，价格就高一点。平台这边不额外加价。';
      if (fullResponse !== canonical) {
        this.logger.warn(`月休+价格问题强制覆写 LLM 输出: customer="${content.slice(0, 30)}" llm="${fullResponse.slice(0, 60)}"`);
      }
      fullResponse = canonical;
    }

    // 6.5 市场价护栏（v4 加固版，2026-08-15 林琳反馈"AI 答得太宽，没针对客户情况"）
    // 根因：
    //   v1: 旧 detectMarketPriceQuestion 正则漏掉"一般市场价是多少"（一般 在 市场价 前面），护栏根本没触发
    //   v2: 即使触发了，旧护栏只剥【转人工】；新增 isWrongPriceTemplate 检测"城市调整/客服后续给报价"后强制覆写为"您是想了解哪类服务..."问句
    //   v3: 问句本身还在 deflect —— 客户问市场价、没得到任何价格信息，林琳明确要求"给个价格区间，不要再问哪一类"
    //   v4: 即使给了 6 条还是太宽 —— 林琳反馈"客户说北京 200 平，AI 不该答 6 条线，只答一线大面积那条"；按客户已知 cityTier + area 精准过滤
    // 修法（v4）：
    //   a) detectMarketPriceQuestion / isWrongPriceTemplate 保持 v2 不变
    //   b) buildMarketPriceCanonical 改用 chat.prompt.ts 的 detectCityTier + detectAreaFromText 工具函数
    //      按已知 cityTier/area 过滤 salary_config 列表，cityTier+area 都已知 → 1 条；仅其一 → 2/3 条；都没采到 → 6 条
    //   c) 删去 v3 末尾"您想了解的是住家保姆，还是其他几类？"的反问（林琳："按客户路径来，灵活的聊天"）
    const isPurePriceQuestion =
      this.chatPricingService.detectMarketPriceQuestion(content) &&
      !this.chatPricingService.hasNonPriceContent(content);
    if (!routedByTool && isPurePriceQuestion) {
      const canonical = await this.chatPricingService.buildMarketPriceCanonical(
        reqForGuidance ?? currentRequirement,
        lead?.serviceCity,
        historyMessages,
      );
      if (canonical) {
        this.logger.warn(
          `市场价场景直接覆写为 canonical: customer="${content.slice(0, 40)}" llm="${fullResponse.slice(0, 80)}" canonical="${canonical.slice(0, 80)}"`,
        );
        fullResponse = canonical;
      }
    }

    // 2026-08-16 林琳 19:44 拍板：钟点工选了"无月休"不需要转人工
    // 钟点工"无月休"是正常选项，AI 不应触发转人工
    // 代码层护栏：剥离【转人工】标记 + 移除"现在为您转人工..."等转人工话术，正常 insert 即可
    // 2026-08-16 22:20 林琳反馈：护栏原写于 generateAiReplyForSession（line 2178），仅覆盖"释放回 AI 后补答"路径
    //   普通客户对话路径（sendCustomerMessage 主流程）未生效——line 979 之前补一份
    // 2026-08-16 22:49 林琳反馈（截图：5/9 字段采到无月休时 AI 主动输出"帮您转接人工客服，让专员为您详细沟通哦~"）：
    //   LLM 没加【转人工】tag，输出"帮您转接人工/让专员为您/我帮您转接"等软转人工话术——原护栏 4 个正则全不命中
    // 修法：扩护栏"转人工语义"检测（包含"转人工/转接人工/帮您转/让专员/让顾问/我帮您转接/涉及薪资"等所有变体）+ 整句剥离
    //   剥完不足 4 字 → 兜底"好的~ 无月休收到，咱们继续~"
    // 2026-08-16 22:57 林琳反馈（截图：客户答"无月休"后 AI 答"好的~ 无月休收到，咱们继续~"，**没有自动问下一项**，客户被迫手动说"继续"）：
    //   v2 护栏的"兜底"只占位不说下一问，customer 必须再发"继续"才推进——UX 差
    // 修法（v3）：兜底不只是占位，**主动查下一缺失字段 + 用模板 question 拼回复**
    //   - 阶段 1 字段（serviceItems/serviceHours/householdSize+area/restDays/startTime/serviceAddress）
    //   - 阶段 2 字段（helperRequirements/dietaryPreferences/budget）—— 阶段 1 全齐后才问
    //   - householdSize/area 视为"工作内容 1+"，任一填就算 filled
    // 注：用 reqForGuidance（line 841 后含最新字段）而非 currentRequirement（line 693 仅 fetch 一次）
    const isZhongdianNoRest = isLeadZhongdian && reqForGuidance?.restDays === '无月休';
    if (isZhongdianNoRest) {
      // 转人工语义关键词：覆盖带【转人工】tag 和无tag的所有变体
      const transferKeywords = /转人工|转接人工|帮您转|帮您转接|我帮您转|我帮您转接|让专员|让顾问|由专员|为您转接|为您转人工|转人工服务|转人工客服|涉及薪资|薪资调整/;
      if (transferKeywords.test(fullResponse)) {
        // 保存原始值用于日志
        const originalResponse = fullResponse;
        // 1) 先剥转人工 tag（兼容新旧两种标签）
        fullResponse = fullResponse.replace(/【转人工】|<transfer>/gi, '');
        // 2) 整句剥离含转人工关键词的句对（按 。！!~～\n？? 切分）
        const parts = fullResponse.split(/([。！!~～\n？?])/);
        const kept: string[] = [];
        for (let i = 0; i < parts.length; i += 2) {
          const text = parts[i] ?? '';
          const delim = parts[i + 1] ?? '';
          if (transferKeywords.test(text)) {
            // 跳过这一对（含转人工关键词的整句）
            continue;
          }
          kept.push(text);
          if (delim) kept.push(delim);
        }

        // 3) v3 新增：主动找下一缺失字段，**用模板 question 替代 LLM 输出**
        //   不依赖 LLM "自行决定问什么"——LLM 在无月休场景会倾向"转人工"，不靠谱
        //   走"结构化输出"路线（林琳 8/16 19:35 拍板：字段值已在 DB 里就别让 LLM 重新讲一遍）
        const tplForNext = getTemplate(reqForGuidance?.serviceType ?? null);
        // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
        //   直接从 reqForGuidance 读所有字段
        const getReqValue = (key: string): string => {
          return (reqForGuidance?.[key as keyof typeof reqForGuidance] as string | null | undefined)?.trim() || '';
        };
        const isFieldFilled = (key: string): boolean => {
          if (key === 'householdSize' || key === 'area') {
            // 阶段 1 工作内容：householdSize/area 任一填就算 filled
            return getReqValue('householdSize').length > 0 || getReqValue('area').length > 0;
          }
          return getReqValue(key).length > 0;
        };
        // 找下一缺失字段（按 tpl 顺序）
        let nextFieldQuestion: string | null = null;
        for (const f of tplForNext) {
          if (!isFieldFilled(f.key)) {
            nextFieldQuestion = f.question;
            break;
          }
        }

        if (nextFieldQuestion) {
          // 还有字段没采 → 拼"好的~ 无月休收到，" + 下一问
          fullResponse = `好的~ 无月休收到，${nextFieldQuestion}`;
          this.logger.warn(
            `[sendCustomerMessage 钟点工+无月休护栏v3] 检测到转人工话术，自动续问下一项: customer="${content.slice(0, 40)}" llm="${originalResponse.slice(0, 100)}" nextQ="${nextFieldQuestion.slice(0, 40)}"`,
          );
        } else {
          // 全部 9 字段已采齐（钟点工+无月休 8 字段全齐不转人工）—— LLM 输出"转人工"是错的
          // 兜底：复述需求结束采集
          fullResponse = '好的~ 您的情况我都记下了，无月休 8 项已全齐，顾问稍后跟您联系~';
          this.logger.warn(
            `[sendCustomerMessage 钟点工+无月休护栏v3] 9 字段全齐仍输出转人工话术，强制改写为复述: customer="${content.slice(0, 40)}" llm="${originalResponse.slice(0, 100)}"`,
          );
        }
      }
    }

    // 6.6 字段全齐自动转人工已下沉至需求写入底层：
    //   ChatRequirementsService.autoTransferIfFieldsComplete 在字段写入成功后
    //   直接判定并触发转人工（含钟点工+无月休例外），不再在 LLM 回复文本上加护栏

    // 6.7 第三道防线：回复后价格校验（2026-08-30 新增）
    //   扫描 LLM 输出中的价格数字，凡不在 salary_config 合理区间内的编造数字拦截换成标准话术
    const priceGuard = await this.chatPricingService.sanitizeAiPriceReply(
      fullResponse,
      reqForGuidance ?? currentRequirement,
      lead?.serviceCity,
      historyMessages,
      isPurePriceQuestion,
    );
    if (priceGuard.blocked && priceGuard.replacement) {
      this.logger.warn(
        `[价格护栏·第三道防线] 拦截编造价格: session=${session.id} lead=${lead?.id ?? '无'} invalid=[${priceGuard.invalidNumbers.join(',')}] llm="${fullResponse.slice(0, 100)}"`,
      );
      this.intelligentRouter.recordValidatorBlock();
      fullResponse = priceGuard.replacement;
    }

    // 转人工信号统一判定（2026-09-01 收窄）：裸"人工客服"会误命中"之后人工客服会跟您协调"、
    //   "具体价格由人工客服向您推荐阿姨之后确定"等无害话术导致误转人工（9/1 14:17 实测误转案例）。
    //   转人工信号必须带转接动作动词（转/帮/让/交/由专员）或显式 tag；6.8 沉默兜底与 7 转人工检测共用
    const transferSignalRegex = /<transfer>|【转人工】|转人工|转接人工|转接.{0,6}(人工|客服|专员)|帮您转|为您转|我帮您转|让专员|让顾问|专员对接|由专员为您/i;

    // 6.8 通用沉默兜底（2026-09-01 林琳反馈：AI 重复问了被代码剔除、或只说"记下啦"就停了，客户被迫沉默）
    //   触发条件：回复不含任何问题 & 不含转人工信号 & 还有未采字段 & 不在纯询价场景
    //   动作：自动续问下一个未采字段，推进采集流程
    //   注：放所有护栏之后、转人工检测之前，确保所有改写都完成后再判断
    if (
      !/[？?]/.test(fullResponse) &&
      !transferSignalRegex.test(fullResponse) &&
      reqForGuidance?.serviceType &&
      !this.chatPricingService.detectMarketPriceQuestion(content)
    ) {
      const tplForSilentGuard = getTemplate(reqForGuidance.serviceType);
      const getReqSilent = (key: string): string => {
        return (reqForGuidance?.[key as keyof typeof reqForGuidance] as string | null | undefined)?.trim() || '';
      };
      const isFieldFilledSilent = (key: string): boolean => {
        if (key === 'householdSize' || key === 'area') {
          return getReqSilent('householdSize').length > 0 || getReqSilent('area').length > 0;
        }
        return getReqSilent(key).length > 0;
      };
      let nextFieldSilent: string | null = null;
      for (const f of tplForSilentGuard) {
        if (!isFieldFilledSilent(f.key)) {
          nextFieldSilent = f.question;
          break;
        }
      }
      if (nextFieldSilent) {
        const trimmed = fullResponse.trim();
        const prefix = trimmed && trimmed.length > 1
          ? trimmed.replace(/[。！!~～,， ]+$/, '') + '，'
          : '好的~ ';
        this.logger.warn(
          `[沉默兜底] AI回复无问题且有未采字段，自动续问: lead=${lead.id.slice(0, 8)} ` +
          `resp="${fullResponse.slice(0, 40)}" nextQ="${nextFieldSilent.slice(0, 40)}"`,
        );
        fullResponse = prefix + nextFieldSilent;
      }
    }

    // 6.9 回复校验器 v2（阶段二）：转人工承诺/绝对化用词/敏感词，在转人工信号检测前执行。
    //   工具路由回复（routedByTool）是受控模板不校验，避免误删 transferToHuman 工具自己的转接话术。
    if (!routedByTool && fullResponse) {
      const validationV2 = this.chatGuardService.validateResponseV2(fullResponse, {
        sessionMode: session.mode as 'ai' | 'human',
      });
      if (validationV2.blocked) {
        this.logger.warn(
          `[回复校验器 v2] 命中: reason=${validationV2.reason} session=${session.id} lead=${lead?.id ?? '无'} llm="${fullResponse.slice(0, 100)}"`,
        );
        this.intelligentRouter.recordValidatorBlock();
        if (validationV2.reason === 'transfer_promise') {
          if (session.mode === 'ai' && lead) {
            await this.chatTransferService.doTransferToHuman(
              session.id,
              'LLM承诺转人工但未实际触发，自动补转',
              'auto',
              lead,
              fullResponse,
            );
          }
        } else if (validationV2.reason === 'absolute_promise' && validationV2.patchedText) {
          fullResponse = validationV2.patchedText;
        } else if (validationV2.reason === 'sensitive_word') {
          fullResponse = '抱歉，关于您的问题，建议您直接联系我们的顾问为您详细解答～';
        }
      }
    }

    // 7. 检测 AI 转人工信号（transfer 标记优先，话术关键词兜底，与 6.8 同一判定）
    const hasTransferSignal = transferSignalRegex.test(fullResponse);
    if (hasTransferSignal) {
      const cleanResponse = fullResponse.replace(/【转人工】|<transfer>/gi, '').trim();
      const hasTag = fullResponse.includes('【转人工】') || /<transfer>/i.test(fullResponse);
      this.logger.log(
        `AI 触发转人工信号 (${hasTag ? 'tag' : 'keyword-fallback'})，清理后回复: ${cleanResponse.slice(0, 80)}`,
      );
      await this.chatTransferService.doTransferToHuman(
        session.id,
        'AI 主动申请转接（AI处理不了）',
        'auto',
        lead,
        cleanResponse || '这个情况比较特殊，我帮您转接人工客服，让专员为您详细沟通哦~',
      );
      return;
    }

    // 8. 存储 AI 回复（字段写入中途触发全齐转人工时会话已为 human，丢弃回复避免转接话术后 AI 再说话）
    const sessionRows = await this.db
      .select({ mode: chatSessions.mode })
      .from(chatSessions)
      .where(eq(chatSessions.id, session.id));
    if (sessionRows.length > 0 && sessionRows[0].mode === 'human') {
      this.logger.log(`[runAiReplyPipeline] 会话中途已转人工，丢弃 AI 回复: ${fullResponse.slice(0, 80)}`);
      return;
    }

    if (fullResponse) {
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: fullResponse,
      });
    } else {
      this.logger.warn('AI 回复为空，使用兜底消息');
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: '抱歉，我暂时遇到了一些问题，请稍后再试~',
      });
    }

    // 8.5 如果使用了学习模板，开始追踪使用结果
    if (activeTemplate) {
      await this.replyLearningService.startUsage(activeTemplate.id, session.id);
      this.logger.log(`开始追踪模板使用: template=${activeTemplate.id}, session=${session.id}`);
    }

    // 9. 计算客户消息轮次（当前消息为止的客户消息数）
    const customerMsgCount = await this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, session.id),
          eq(chatMessages.role, 'customer'),
        ),
      );
    const customerTurns = Number(customerMsgCount[0]?.value ?? 0);

    // 10. 每 N 轮提取结构化需求
    const extractionInterval = await this.aiConfigService.getConfigNumber('extraction_interval', REQUIREMENT_EXTRACTION_INTERVAL);
    const shouldExtract = customerTurns % extractionInterval === 0 || customerTurns === 1;
    if (shouldExtract) {
      try {
        await this.chatRequirementsService.extractAndSaveRequirements(lead.id, session.id);
      } catch (error) {
        this.logger.error(
          `需求提取失败: ${JSON.stringify(error)}`,
          (error as Error).stack,
        );
      }
    }

    // 10. 动态分级检测
    this.leadGradingService
      .checkGradeTransition(lead.id, content)
      .catch((err: unknown) => {
        this.logger.warn(`分级动态检测失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }



  /**
   * 生成 AI 回复建议（3 条）
   */
  async generateReplySuggestions(sessionId: string): Promise<string[]> {
    const historyMessages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(MAX_HISTORY_MESSAGES);

    historyMessages.reverse();
    const conversationHistory = historyMessages
      .map((m) => `${m.role === 'customer' ? '雇主' : m.role === 'agent' ? '客服' : '小书'}: ${m.content}`)
      .join('\n');

    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) return [];

    const currentRequirement = await this.chatRequirementsService.getRequirementByLeadId(sessionRows[0].leadId);
    const collectedRequirements = this.chatRequirementsService.summarizeRequirement(currentRequirement);

    const latestCustomerMsg = historyMessages
      .filter((m) => m.role === 'customer')
      .pop();

    let fullResponse = '';
    try {
      const aiReplyPluginId = await this.aiConfigService.getConfigWithDefault('ai_reply_plugin_id', AI_REPLY_PLUGIN_ID);
      const streamResult = await this.capabilityService
        .load(aiReplyPluginId)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona: SUGGESTION_PROMPT,
          conversation_history: conversationHistory,
          collected_requirements: collectedRequirements,
          latest_customer_message: latestCustomerMsg?.content ?? '暂无',
        });

      const stream = normalizeStream(streamResult);
      for await (const chunk of stream) {
        const chunkContent = (chunk as { content?: string }).content;
        if (chunkContent) {
          fullResponse += chunkContent;
        }
      }
    } catch (error) {
      this.logger.error(
        `AI 建议生成失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return [];
    }

    const suggestions = fullResponse
      .split('|||')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 3);

    return suggestions;
  }



  /**
   * 生成需求确认卡片（结构化文本）
   * 2026-08-16 林琳 19:35 拍板：
   *   - 触发条件：必填项齐就能生成（前端按 canSend 控制按钮 enabled）
   *   - 形态：结构化文本（不调 LLM 润色，直接基于 requirement 字段格式化输出——更稳定）
   *   - 用途：客服发给客户，让他再次确认之前沟通确认过的所有需求
   *
   * @param sessionId 会话 ID
   * @param userId 客服 userId（运营端会校验 lead.assigneeId）
   * @returns { canSend, text, fields, missingRequired, serviceTypeLabel }
   *   - canSend: 必填项全齐 = true（前端据此决定是否启用"插入到输入框"按钮）
   *   - text: 结构化文本（默认填到前端 textarea，客服可编辑后发送）
   *   - fields: 字段详情（key/label/value/required/filled），前端可渲染预览
   *   - missingRequired: 必填项未采的 label 列表（前端展示"必填项未采：xxx"警告）
   *   - serviceTypeLabel: 服务类型中文名（用于日志/调试）
   */
  async generateConfirmationCard(
    sessionId: string,
    userId: string,
  ): Promise<{
    canSend: boolean;
    text: string;
    fields: Array<{ key: string; label: string; value: string; required: boolean; filled: boolean }>;
    missingRequired: string[];
    serviceTypeLabel: string;
  }> {
    // 1. fetch session
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }
    const session = sessionRows[0];

    // 2. fetch lead + 校验归属
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);
    if (leadRows.length === 0) {
      throw new NotFoundException('线索不存在');
    }
    const lead = leadRows[0];
    if (lead.assigneeId !== null && lead.assigneeId !== userId) {
      throw new ForbiddenException('无权操作此会话');
    }

    // 3. fetch requirement + 取模板
    const requirement = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
    const tpl = getTemplate(requirement?.serviceType ?? null);
    const serviceTypeLabel = getServiceTypeLabel(requirement?.serviceType ?? null);

    // 4. 字段值映射：DB 列 → 模板 key
    // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
    const rawReqMap: Record<string, string | null | undefined> = {
      serviceType: requirement?.serviceType,
      householdSize: requirement?.householdSize,
      area: requirement?.area,
      elderlyCare: requirement?.elderlyCare,
      restDays: requirement?.restDays,
      startTime: requirement?.startTime,
      serviceAddress: requirement?.serviceAddress,
      helperRequirements: requirement?.helperRequirements,
      dietaryPreferences: requirement?.dietaryPreferences,
      budget: requirement?.budget,
      specialRequirements: requirement?.specialRequirements,
      serviceItems: requirement?.serviceItems,
      serviceHours: requirement?.serviceHours,
    };

    // 4.5 展示值格式化：预算归一化串 → 自然语言（统一走 shared，其余字段原样）
    const reqMap: Record<string, string | null | undefined> = { ...rawReqMap };
    if (rawReqMap.budget) {
      reqMap.budget = formatBudgetRange(rawReqMap.budget) ?? '';
    }

    // 5. 拼每个字段的 value + 标记必填项未采
    const fields = tpl.map((f) => {
      const raw = reqMap[f.key];
      const value = (raw ?? '').trim();
      return {
        key: f.key,
        label: f.label,
        value,
        required: f.required,
        filled: value.length > 0,
      };
    });
    const missingRequired = fields.filter((f) => f.required && !f.filled).map((f) => f.label);
    const canSend = missingRequired.length === 0;

    // 6. 拼结构化文本（不调 LLM 润色——林琳决策）
    // 模板：
    //   您好，为了确保我们准确理解您的需求，请确认以下信息：
    //
    //   使用类型：住家保姆
    //   家庭情况：5口人
    //   房屋面积：200平
    //   老人照护：不需要老人照护
    //   休息天数：月休4天
    //   到岗时间：一周之内
    //   服务地址：海淀区上地街道
    //   阿姨要求：（未提供）
    //   做饭口味：清淡
    //   薪资预算：8000元
    //
    //   以上信息如都正确，请回复"确认"；如需修改，请直接告诉我~
    const lines: string[] = [];
    lines.push('您好，为了确保我们准确理解您的需求，请确认以下信息：');
    lines.push('');
    for (const f of fields) {
      const display = f.filled ? f.value : '（未提供）';
      lines.push(`${f.label}：${display}`);
    }
    lines.push('');
    lines.push('以上信息如都正确，请回复"确认"；如需修改，请直接告诉我~');
    const text = lines.join('\n');

    this.logger.log(
      `需求确认卡片生成: session=${sessionId.slice(0, 8)} svc="${serviceTypeLabel}" canSend=${canSend} missing=${missingRequired.length}`,
    );

    return { canSend, text, fields, missingRequired, serviceTypeLabel };
  }



  /**
   * 释放回AI后补答：检测人工接管期间是否有未回复的客户消息，有则触发AI回复
   * 直接复用 sendCustomerMessage 中的 AI 回复主流程，确保月休检测、字段提取、需求抽取等逻辑一致
   */
  private async catchUpAiReplyAfterRelease(
    sessionId: string,
    session: typeof chatSessions.$inferSelect,
  ): Promise<void> {
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);
    if (leadRows.length === 0) {
      this.logger.warn(`会话 ${sessionId} 释放回AI时未找到线索，跳过补答`);
      return;
    }

    const recentMsgs = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(50);

    if (recentMsgs.length === 0) return;

    const isSystemBotMsg = (m: typeof chatMessages.$inferSelect): boolean =>
      m.role === 'bot' && (
        m.content.includes('转接人工客服') ||
        m.content === '客服已接入，专员正在为您服务~' ||
        m.content === '客服已退出，小书继续为您服务~' ||
        m.content.includes('暂无客服在线')
      );

    let lastReplyIndex = -1;
    for (let i = 0; i < recentMsgs.length; i++) {
      const m = recentMsgs[i];
      if (m.role === 'agent') {
        lastReplyIndex = i;
        break;
      }
      if (m.role === 'bot' && !isSystemBotMsg(m)) {
        lastReplyIndex = i;
        break;
      }
    }

    const unrepliedMsgs = lastReplyIndex >= 0 ? recentMsgs.slice(0, lastReplyIndex) : recentMsgs;
    const customerUnreplied = unrepliedMsgs.filter((m) => m.role === 'customer');

    if (customerUnreplied.length === 0) {
      this.logger.log(`会话 ${sessionId} 释放回AI，无待回复客户消息`);
      return;
    }

    const lastMsg = customerUnreplied[0];
    this.logger.log(`会话 ${sessionId} 释放回AI，检测到 ${customerUnreplied.length} 条未回复客户消息，最新: ${lastMsg.content.slice(0, 50)}`);

    const lead = this.chatSessionService.mapLead(leadRows[0]);
    await this.generateAiReplyForSession(session, lead, lastMsg.content);
  }

  async submitFormAndContinue(
    sessionId: string,
    formData: FormSubmitRequest,
  ): Promise<FormSubmitResponse> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }
    const session = sessionRows[0];

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);
    if (leadRows.length === 0) {
      throw new NotFoundException('线索不存在');
    }
    const lead = this.chatSessionService.mapLead(leadRows[0]);

    const patch: Partial<typeof requirements.$inferInsert> = {
      householdSize: normalizeFieldByKey('householdSize', formData.householdSize),
      area: normalizeFieldByKey('area', formData.area),
      hasPet: formData.hasPet,
      elderlyCare: normalizeFieldByKey('elderlyCare', formData.elderlyCare),
      childCare: formData.childCare,
      restDays: formData.restDays || null,
      startTime: normalizeFieldByKey('startTime', formData.startTime),
      serviceAddress: formData.serviceAddress,
      cardSubmittedAt: new Date().toISOString(),
      updatedAt: new Date(),
    };

    const existingReqRows = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.leadId, lead.id))
      .limit(1);
    const existingReqRow = existingReqRows[0] ?? null;

    const updated = await this.db
      .update(requirements)
      .set(patch)
      .where(eq(requirements.leadId, lead.id))
      .returning({ id: requirements.id });

    if (updated.length === 0) {
      throw new NotFoundException('需求记录不存在');
    }

    // delta 日志：表单卡提交的字段变更（source=form_card）
    const FORM_DELTA_KEYS = [
      'householdSize', 'area', 'hasPet', 'elderlyCare', 'childCare',
      'restDays', 'startTime', 'serviceAddress',
    ] as const;
    const oldRowMap: Record<string, string | null> = (existingReqRow ?? {}) as Record<string, string | null>;
    const formDeltaChanges: FieldDeltaChange[] = FORM_DELTA_KEYS.map((key) => ({
      fieldKey: key,
      oldValue: oldRowMap[key] ?? null,
      newValue: (patch[key] as string | null | undefined) ?? null,
    }));
    void this.requirementDeltaService.recordDeltas({
      leadId: lead.id,
      sessionId: session.id,
      source: 'form_card',
      changes: formDeltaChanges,
    });

    this.logger.log(`表单提交: lead=${lead.id.slice(0, 8)}, session=${sessionId.slice(0, 8)}`);

    try {
      await this.chatRequirementsService.autoTransferIfFieldsComplete(lead.id);
    } catch (err) {
      this.logger.warn(
        `表单提交路径字段全齐自动转人工失败（不阻塞）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    void (async () => {
      try {
        await this.generateAiReplyForSession(session, lead, '表单已提交');
      } catch (err) {
        this.logger.error(
          `表单提交后异步生成AI回复失败: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    })();

    return { success: true, message: '表单提交成功' };
  }

  async submitFormByToken(
    token: string,
    formData: FormSubmitRequest,
  ): Promise<FormSubmitResponse> {
    const sessionInfo = await this.chatSessionService.findSessionByToken(token);
    if (!sessionInfo) {
      throw new NotFoundException('会话不存在');
    }
    return this.submitFormAndContinue(sessionInfo.id, formData);
  }

  /**
   * 为指定会话生成 AI 回复（复用 sendCustomerMessage 中的主流程：月休检测/二选一检测/字段提取/AI生成/需求抽取/分级）
   */
  private async generateAiReplyForSession(
    session: typeof chatSessions.$inferSelect,
    lead: Lead,
    content: string,
  ): Promise<void> {
    const maxHistory = await this.aiConfigService.getConfigNumber('max_history_messages', MAX_HISTORY_MESSAGES);
    const historyMessages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(desc(chatMessages.createdAt))
      .limit(maxHistory);
    historyMessages.reverse();

    // 2026-08-16 林琳 16:58 拍板：钟点工场景跳过"无月休"早拦截
    // 2026-08-16 林琳 19:44 拍板：钟点工+无月休 8 字段全齐不转人工（护栏在下方）
    // serviceType 在 requirements.serviceType 而非 lead.serviceType，提前 fetch
    const currentRequirement = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
    const leadSubType = normalizeServiceSubType(currentRequirement?.serviceType ?? null);
    const isLeadZhongdian = leadSubType === 'zhongdian';

    let activeTemplate: LearnedTemplate | null = null;
    const botMsgs = historyMessages.filter((m) => m.role === 'bot');
    const lastBotMsg = botMsgs[botMsgs.length - 1];
    if (lastBotMsg) {
      // 2026-08-16 林琳 16:58 拍板：钟点工场景跳过 checkRestDaysResponse
      const restDaysResult = this.chatGuardService.checkRestDaysResponse(lastBotMsg.content, content, isLeadZhongdian);
      if (restDaysResult.shouldTransfer) {
        this.logger.log(`月休非标→转人工: bot问="${lastBotMsg.content.slice(0, 50)}" customer="${content}" reason=${restDaysResult.reason}`);
        await this.chatTransferService.doTransferToHuman(
          session.id,
          restDaysResult.reason ?? '月休非标需求，转人工沟通',
          'auto',
          lead,
          restDaysResult.message,
        );
        return;
      }
      if (!activeTemplate) {
        const twoChoiceResponse = this.chatGuardService.buildTwoChoiceOutOfRangeResponse(lastBotMsg.content, content);
        if (twoChoiceResponse) {
          const topicKey = 'two_choice_out_of_range';
          const template = await this.replyLearningService.findTemplate(topicKey);
          if (template) {
            activeTemplate = template;
            this.logger.log(`命中学习模板: topic=${topicKey}, template=${template.id}, status=${template.status}`);
          } else {
            // 不再转人工：复用「休6天」详细模板风格，直接插入 AI 模板回复
            this.logger.log(`二选一超范围(已改为不转人工): bot问="${lastBotMsg.content.slice(0, 50)}" customer="${content}"`);
            await this.db.insert(chatMessages).values({
              sessionId: session.id,
              role: 'bot',
              content: twoChoiceResponse,
            });
            return;
          }
        }
      }
    }

    const conversationHistory = historyMessages
      .map((m) => `${m.role === 'customer' ? '雇主' : '小书'}: ${m.content}`)
      .join('\n');

    // 5. 获取当前已收集需求（注：已在月休非标早拦截 fetch 过 currentRequirement，直接复用）
    // 若 upsertServiceType / mergeRequirementFields 更新了 DB，再重新 fetch
    // 与主路径一致：问答意图优先，本轮不做关键词服务类型识别与推卡（先答问题，再采需求）
    const qaIntentHit2: boolean = this.intelligentRouter.hasQaIntent(content);
    let reqForGuidance2 = currentRequirement;
    if (!qaIntentHit2 && !reqForGuidance2?.serviceType) {
      const detectedType = detectServiceTypeFromText(content);
      if (detectedType) {
        await this.chatRequirementsService.upsertServiceType(lead.id, detectedType);
        reqForGuidance2 = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
        this.logger.log(`关键词识别服务类型: ${detectedType}`);
      }
    }

    try {
      const realtimeUpdates = this.chatRequirementsService.detectFieldsFromConversation(historyMessages);
      if (realtimeUpdates.size > 0) {
        this.logger.log(`实时字段检测到: ${[...realtimeUpdates.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
        await this.chatRequirementsService.mergeRequirementFields(lead.id, reqForGuidance2, realtimeUpdates);
        reqForGuidance2 = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
      } else {
        this.logger.log('实时字段检测: 无匹配');
      }
    } catch (err) {
      this.logger.warn(`实时字段检测异常: ${err instanceof Error ? err.message : String(err)}`);
    }

    // form_card 推送判断：服务类型已确认 + 阶段1字段已采≤1 + 未推送过表单
    if (reqForGuidance2?.serviceType) {
      const phase1Fields = [
        reqForGuidance2.householdSize,
        reqForGuidance2.area,
        reqForGuidance2.hasPet,
        reqForGuidance2.elderlyCare,
        reqForGuidance2.childCare,
        reqForGuidance2.restDays,
        reqForGuidance2.startTime,
        reqForGuidance2.serviceAddress,
      ];
      const collectedCount = phase1Fields.filter((v) => v && v.trim() !== '').length;
      const hasFormCard = historyMessages.some(
        (m) => m.role === 'bot' && m.content.startsWith('{"type":"form_card"'),
      );
      if (qaIntentHit2) {
        this.logger.log('跳过 form_card 推送: 命中问答类意图，交由路由层回答');
      } else if (collectedCount <= 1 && !hasFormCard) {
        const serviceTypeLabel = getServiceTypeLabel(reqForGuidance2.serviceType);
        const formCardContent = JSON.stringify({
          type: 'form_card',
          serviceType: serviceTypeLabel,
          formName: 'live_in_nanny_demand',
        });
        await this.db.insert(chatMessages).values({
          sessionId: session.id,
          role: 'bot',
          content: formCardContent,
        });
        this.logger.log(`推送 form_card: serviceType=${serviceTypeLabel}, collected=${collectedCount}`);
        return;
      }
    }

    const guidancePrompt = this.requirementCollectionService.buildGuidancePrompt(
      reqForGuidance2?.serviceType ?? null,
      reqForGuidance2,
      lead.serviceCity,
    );

    // 智能调度层（补答路径，与 runAiReplyPipeline 一致）
    let fullResponse = '';
    const routeResult = await this.intelligentRouter.tryRoute(
      content,
      {
        requirement: reqForGuidance2,
        serviceCity: lead.serviceCity,
        currentMessage: content,
        historyMessages,
        sessionId: session.id,
        lead,
      },
      `session=${session.id} 补答`,
    );
    if (routeResult.handled) {
      fullResponse = routeResult.reply;
    } else {
      const aiReplyPluginId = await this.aiConfigService.getConfigWithDefault('ai_reply_plugin_id', AI_REPLY_PLUGIN_ID);
      const persona = await this.aiConfigService.getPersonaWithQa(SWAN_PERSONA);
      const salaryReference = await this.salaryConfigService
        .buildPersonaReference()
        .catch((err) => {
          this.logger.warn(`加载薪资参考失败（不阻塞 persona）: ${err instanceof Error ? err.message : String(err)}`);
          return '';
        });
      const personaWithSalary = persona + salaryReference;
      const effectivePersona = activeTemplate
        ? personaWithSalary + buildTemplateReferencePrompt(activeTemplate.answerText)
        : personaWithSalary;

      try {
        // 合并调用：在 collected_requirements 末尾加字段输出指令
        const guidanceWithFields = guidancePrompt + buildFieldsOutputInstruction();
        const streamResult = await this.capabilityService
          .load(aiReplyPluginId)
          .callStream(AI_REPLY_ACTION_KEY, {
            persona: effectivePersona,
            conversation_history: conversationHistory,
            collected_requirements: guidanceWithFields,
            latest_customer_message: content,
          });

        const stream = normalizeStream(streamResult);
        this.logger.log('AI 流式连接成功，开始接收回复');

        for await (const chunk of stream) {
          const chunkContent = (chunk as { content?: string }).content;
          if (chunkContent) {
            fullResponse += chunkContent;
          }
        }
        this.logger.log(`AI 回复完成，长度: ${fullResponse.length}`);

        // 合并调用：从 AI 回复中解析结构化字段并写入 DB
        const parsed = this.chatRequirementsService.parseFieldsFromAiReply(fullResponse);
        if (parsed.enrichedFields) {
          fullResponse = parsed.reply;
          try {
            // 字段提取完整性校验：AI 可能丢方向词/限定词，用代码正则兜底
            this.chatRequirementsService.validateFieldExtraction(parsed.enrichedFields, content);
            await this.chatRequirementsService.saveParsedFields(lead.id, parsed.enrichedFields);
            this.logger.log(`合并字段已写入 DB (补答路径): lead=${lead.id.slice(0, 8)}`);
          } catch (err) {
            this.logger.warn(
              `合并字段写入 DB 失败（补答路径，不阻塞）: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (error) {
        this.logger.error(
          `AI 回复生成失败: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
        fullResponse = '抱歉，我暂时无法回复，请稍后再试~';
      }
    }

    // 2026-08-16 林琳 19:44 拍板：钟点工选了"无月休"不需要转人工
    // 钟点工"无月休"是正常选项，8 字段全齐后 AI 不应触发转人工
    // 代码层护栏：剥离【转人工】标记 + 移除"现在为您转人工..."等转人工话术，正常 insert 即可
    const isZhongdianNoRest = isLeadZhongdian && currentRequirement?.restDays === '无月休';
    if (isZhongdianNoRest && fullResponse.includes('【转人工】')) {
      fullResponse = fullResponse
        .replace(/【转人工】/g, '')
        .replace(/现在为您转[^。~]*[。~]/g, '')
        .replace(/为您转[^。~]*[。~]/g, '')
        .replace(/由专员[^。~]*[。~]/g, '')
        .trim();
      this.logger.log(
        `[钟点工+无月休护栏] 剥离【转人工】标记不转人工: ${fullResponse.slice(0, 80)}`,
      );
    }

    // 全齐自动转人工已下沉至需求写入底层（ChatRequirementsService.autoTransferIfFieldsComplete）

    // 第三道防线：回复后价格校验（补答路径，与 runAiReplyPipeline 一致）
    const priceGuard = await this.chatPricingService.sanitizeAiPriceReply(
      fullResponse,
      reqForGuidance2,
      lead.serviceCity,
      historyMessages,
      this.chatPricingService.detectMarketPriceQuestion(content),
    );
    if (priceGuard.blocked && priceGuard.replacement) {
      this.logger.warn(
        `[价格护栏·第三道防线·补答] 拦截编造价格: session=${session.id} lead=${lead.id} invalid=[${priceGuard.invalidNumbers.join(',')}] llm="${fullResponse.slice(0, 100)}"`,
      );
      this.intelligentRouter.recordValidatorBlock();
      fullResponse = priceGuard.replacement;
    }

    const hasTransferSignal = /【转人工】|转人工客服/.test(fullResponse);
    if (hasTransferSignal) {
      const cleanResponse = fullResponse.replace(/【转人工】/g, '').trim();
      const hasTag = fullResponse.includes('【转人工】');
      this.logger.log(
        `AI 触发转人工信号 (${hasTag ? 'tag' : 'keyword-fallback'})，清理后回复: ${cleanResponse.slice(0, 80)}`,
      );
      await this.chatTransferService.doTransferToHuman(
        session.id,
        'AI 主动申请转接（AI处理不了）',
        'auto',
        lead,
        cleanResponse || '这个情况比较特殊，我帮您转接人工客服，让专员为您详细沟通哦~',
      );
      return;
    }

    // 字段写入中途触发全齐转人工时会话已为 human，丢弃 AI 回复（补答路径）
    const sessionRows = await this.db
      .select({ mode: chatSessions.mode })
      .from(chatSessions)
      .where(eq(chatSessions.id, session.id));
    if (sessionRows.length > 0 && sessionRows[0].mode === 'human') {
      this.logger.log(`[generateAiReplyForSession] 会话中途已转人工，丢弃 AI 回复: ${fullResponse.slice(0, 80)}`);
      return;
    }

    if (fullResponse) {
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: fullResponse,
      });
    } else {
      this.logger.warn('AI 回复为空，使用兜底消息');
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: '抱歉，我暂时遇到了一些问题，请稍后再试~',
      });
    }

    if (activeTemplate) {
      await this.replyLearningService.startUsage(activeTemplate.id, session.id);
      this.logger.log(`开始追踪模板使用: template=${activeTemplate.id}, session=${session.id}`);
    }

    const customerMsgCount = await this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, session.id),
          eq(chatMessages.role, 'customer'),
        ),
      );
    const customerTurns = Number(customerMsgCount[0]?.value ?? 0);

    const extractionInterval = await this.aiConfigService.getConfigNumber('extraction_interval', REQUIREMENT_EXTRACTION_INTERVAL);
    const shouldExtract = customerTurns % extractionInterval === 0 || customerTurns === 1;
    if (shouldExtract) {
      try {
        await this.chatRequirementsService.extractAndSaveRequirements(lead.id, session.id);
      } catch (error) {
        this.logger.error(
          `需求提取失败: ${JSON.stringify(error)}`,
          (error as Error).stack,
        );
      }
    }

    this.leadGradingService
      .checkGradeTransition(lead.id, content)
      .catch((err: unknown) => {
        this.logger.warn(`分级动态检测失败: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /**
   * AI话术学习：从人工客服回复中提取问答对存为学习模板
   */
  private async tryLearnFromAgentReply(
    sessionId: string,
    session: typeof chatSessions.$inferSelect,
    agentReply: string,
  ): Promise<void> {
    const topicKey = this.replyLearningService.determineTopicKey(session.transferReason ?? '');
    if (!topicKey) return;

    // 仅学习首条客服回复（后续可能是追问，不是对原始问题的回答）
    const priorAgentMsgs = await this.db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, 'agent')))
      .limit(2);
    if (priorAgentMsgs.length > 1) return;

    // 获取转人工前最后一条客户消息作为问题
    const transferBotMsgs = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(50);
    const transferBotIndex = transferBotMsgs.findIndex(
      (m) => m.role === 'bot' && (
        m.content === TRANSFER_MESSAGE ||
        m.content.includes('转接') ||
        m.content === NO_AGENT_ONLINE_MESSAGE
      ),
    );
    let questionText = '';
    if (transferBotIndex >= 0) {
      for (let i = transferBotIndex + 1; i < transferBotMsgs.length; i++) {
        if (transferBotMsgs[i].role === 'customer') {
          questionText = transferBotMsgs[i].content;
          break;
        }
      }
    }
    if (!questionText) return;

    await this.replyLearningService.storeTemplate(topicKey, questionText, agentReply, sessionId);
    this.logger.log(`AI话术学习: topic=${topicKey}, question=${questionText.slice(0, 50)}...`);
  }

  // ============ 会话管理（委托给 ChatSessionService） ============

  async getSessionList(params: {
    status?: string;
    page?: number;
    pageSize?: number;
    userId: string;
    all?: boolean;
  }): Promise<ChatSessionListResponse> {
    return this.chatSessionService.getSessionList(params);
  }

  async getSessionDetail(sessionId: string, userId: string, all = false): Promise<ChatSessionDetail> {
    return this.chatSessionService.getSessionDetail(sessionId, userId, all);
  }

  async getOrCreateSessionByToken(token: string): Promise<CustomerChatInfo> {
    return this.chatSessionService.getOrCreateSessionByToken(token);
  }

  async getMessagesByToken(token: string, afterId?: string): Promise<CustomerPollResult> {
    return this.chatSessionService.getMessagesByToken(token, afterId);
  }

  async takeoverSession(sessionId: string, userId: string): Promise<ChatSession> {
    return this.chatSessionService.takeoverSession(sessionId, userId);
  }

  async reassignSession(
    sessionId: string,
    targetAgentId: string,
    userId: string,
  ): Promise<ChatSession> {
    return this.chatSessionService.reassignSession(sessionId, targetAgentId, userId);
  }

  async releaseSession(sessionId: string, userId: string): Promise<ChatSession> {
    const session = await this.chatSessionService.releaseSession(sessionId, userId);
    // 异步检查：人工接管期间若有未回复的客户消息，AI 自动补答
    this.catchUpAiReplyAfterRelease(sessionId, session as unknown as typeof chatSessions.$inferSelect)
      .catch((err: unknown) => {
        this.logger.error(
          `释放回AI后补答失败: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      });
    return session;
  }

  async sendAgentMessage(sessionId: string, content: string, userId: string): Promise<ChatMessage> {
    const result = await this.chatSessionService.sendAgentMessage(sessionId, content, userId);
    // AI话术学习：如果是转人工后的首条客服回复，提取问答对存为模板
    try {
      const sessionRows = await this.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);
      if (sessionRows.length > 0) {
        await this.tryLearnFromAgentReply(sessionId, sessionRows[0], content);
      }
    } catch (err) {
      this.logger.warn(`话术学习失败（不阻塞）: ${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  async createLeadFromChat(
    phone: string,
    serviceType: string,
    source: LeadSource,
    serviceCity?: string,
    customerName?: string,
  ): Promise<{ session: ChatSession; lead: Lead }> {
    return this.chatSessionService.createLeadFromChat({
      phoneNumber: phone,
      serviceType,
      serviceCity,
      customerName,
    });
  }

  async notifyAgentOfNewAssignment(assigneeId: string, leadId: string): Promise<void> {
    return this.chatSessionService.notifyAgentOfNewAssignment(assigneeId, leadId);
  }

  // ============ 转人工（委托给 ChatTransferService） ============

  async transferToHuman(token: string, reason?: string): Promise<void> {
    return this.chatTransferService.transferToHuman(token, reason);
  }

  autoDetectTransfer(content: string, keywords: string[]): string | null {
    return this.chatTransferService.autoDetectTransfer(content, keywords);
  }

  detectFrustration(content: string): string | null {
    return this.chatTransferService.detectFrustration(content);
  }

  async getHandoffSummaryWithAuth(sessionId: string, userId: string, all = false): Promise<HandoffSummary> {
    return this.chatTransferService.getHandoffSummaryWithAuth(sessionId, userId, all);
  }

  async getHandoffSummary(sessionId: string): Promise<HandoffSummary> {
    return this.chatTransferService.getHandoffSummary(sessionId);
  }

  // ============ 需求采集（委托给 ChatRequirementsService） ============

  async getCollectionProgress(leadId: string): Promise<CollectionProgress> {
    return this.chatRequirementsService.getCollectionProgress(leadId);
  }

}
