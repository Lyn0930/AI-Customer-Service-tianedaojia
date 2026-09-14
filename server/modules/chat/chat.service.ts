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
import { ChatEventBus } from './chat-event-bus.service';
import { AiConfigService } from '../admin/ai-config.service';
import { RoutingService } from '../routing/routing.service';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import { RequirementCollectionService } from '../automation/requirement-collection.service';
import { LeadGradingService } from '../leads/lead-grading.service';
import { SalaryConfigService } from '../salary-config/salary-config.service';
import { normalizeServiceType, normalizeServiceSubType, chineseServiceType, getServiceTypeLabel, OPENING_MESSAGES, DEFAULT_OPENING_MESSAGE } from '../automation/requirement-templates';
import { normalizeStream } from './stream-utils';
import { normalizeSource, sanitizeCity, normalizeLead } from '@shared/channels';
import {
  buildReturnCustomerContext,
  buildReturnCustomerOpening,
  type ReturnCustomerContext,
  type ReturnCustomerHistoryEntry,
} from './return-customer.util';
import {
  SWAN_PERSONA,
  AI_REPLY_PLUGIN_ID,
  AI_REPLY_ACTION_KEY,
  REQUIREMENT_EXTRACTION_PLUGIN_ID,
  REQUIREMENT_EXTRACTION_ACTION_KEY,
  REQUIREMENT_EXTRACTION_INTERVAL,
  MAX_HISTORY_MESSAGES,
  TRANSFER_KEYWORDS,
  TRANSFER_MESSAGE,
  NO_AGENT_ONLINE_MESSAGE,
  FRUSTRATION_KEYWORDS,
  FRUSTRATION_TRANSFER_MESSAGE,
  FEE_INFO_KEYWORDS,
  FEE_INFO_REPLY,
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
} from '@shared/api.interface';



/** AI 需求提取返回的结构（字段全为 string | null） */
interface ExtractedRequirement {
  service_type: string | null;
  household_size: string | null;
  area: string | null;
  elderly_care: string | null;
  rest_days: string | null;
  start_time: string | null;
  service_address: string | null;
  helper_requirements: string | null;
  dietary_preferences: string | null;
  budget: string | null;
  service_duration: string | null;
  special_requirements: string | null;
  family_info: string | null;
  work_mode: string | null;
}

const FIELD_LABEL_MAP: Record<string, string> = {
  serviceType: '服务类型',
  householdSize: '家庭情况',
  area: '房屋面积',
  elderlyCare: '老人照护',
  restDays: '休息天数',
  startTime: '到岗时间',
  serviceAddress: '服务地址',
  helperRequirements: '阿姨要求',
  dietaryPreferences: '做饭口味',
  budget: '薪资预算',
  serviceDuration: '服务周期',
  specialRequirements: '特殊需求',
  familyInfo: '家庭情况',
};

/**
 * 预算字符串 → 数字（2026-09-05：budget 列 varchar → integer，入库前统一解析）
 * 输入形态：AI 提取的 "6000-8000元/月" / "5000" / "大概6000"，或正则匹配的 "6000吧" / "6000元"
 * 规则（与定稿口径一致：只存总预算数字）：
 *   - 取第一个出现的数字（区间 6000-8000 → 取下限 6000，保守匹配不超预算）
 *   - 一个数字都找不到（如 "面议"）→ null（视为未采集）
 */
function parseBudgetNumber(raw: string | number | null | undefined): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const m = raw.match(/\d+/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function buildCollectedFields(result: ExtractedRequirement): { field: string; value: string; label: string }[] {
  const map: Record<string, string | null> = {
    serviceType: result.service_type,
    householdSize: result.household_size,
    area: result.area,
    elderlyCare: result.elderly_care,
    restDays: result.rest_days,
    startTime: result.start_time,
    serviceAddress: result.service_address,
    helperRequirements: result.helper_requirements,
    dietaryPreferences: result.dietary_preferences,
    budget: result.budget,
    serviceDuration: result.service_duration,
    specialRequirements: result.special_requirements,
    familyInfo: result.family_info,
    workMode: result.work_mode,
  };
  const fields: { field: string; value: string; label: string }[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (v && v.trim()) {
      fields.push({ field: k, value: v, label: FIELD_LABEL_MAP[k] ?? k });
    }
  }
  return fields;
}

function inferUrgencyLevel(startTime: string | null): string {
  if (!startTime) return 'low';
  const date = new Date(startTime);
  if (isNaN(date.getTime())) return 'low';
  const diffDays = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (diffDays <= 7) return 'high';
  if (diffDays <= 30) return 'medium';
  return 'low';
}

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
    private readonly bitableSyncService: BitableSyncService,
    private readonly requirementCollectionService: RequirementCollectionService,
    @Inject(forwardRef(() => LeadGradingService))
    private readonly leadGradingService: LeadGradingService,
    private readonly replyLearningService: ReplyLearningService,
    private readonly salaryConfigService: SalaryConfigService,
    private readonly chatEventBus: ChatEventBus,
  ) {}

  // ============ 运营端 ============

  /**
   * 运营端 - 会话列表
   */
  async getSessionList(params: {
    status?: string;
    page?: number;
    pageSize?: number;
    userId: string;
    all?: boolean;
  }): Promise<ChatSessionListResponse> {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize =
      params.pageSize && params.pageSize > 0 ? params.pageSize : 10;
    const offset = (page - 1) * pageSize;

    // 构建查询条件
    const conditions = [];

    if (!params.all) {
      // 客服模式：查当前客服负责的线索 + 未分配但处于人工模式的会话
      const userLeads = await this.db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.assigneeId, params.userId));

      const userLeadIds = userLeads.map((l) => l.id);

      // 未分配且有人工模式活跃会话的线索（转人工后无人接入的会话）
      const unassignedHumanLeads = await this.db
        .select({ leadId: chatSessions.leadId })
        .from(chatSessions)
        .innerJoin(leads, eq(leads.id, chatSessions.leadId))
        .where(
          and(
            isNull(leads.assigneeId),
            eq(chatSessions.mode, 'human'),
            eq(chatSessions.status, 'active'),
          ),
        );

      const allLeadIds = [
        ...userLeadIds,
        ...unassignedHumanLeads.map((s) => s.leadId),
      ];

      if (allLeadIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }

      conditions.push(inArray(chatSessions.leadId, allLeadIds));
    }
    if (params.status) {
      conditions.push(eq(chatSessions.status, params.status));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const sessions = await this.db
      .select()
      .from(chatSessions)
      .where(whereClause)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(pageSize)
      .offset(offset);

    const totalResult = await this.db
      .select({ value: count() })
      .from(chatSessions)
      .where(whereClause);
    const total = Number(totalResult[0]?.value ?? 0);

    if (sessions.length === 0) {
      return { items: [], total, page, pageSize };
    }

    // 批量查 lead
    const sessionLeadIds = sessions.map((s) => s.leadId);
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(inArray(leads.id, sessionLeadIds));
    const leadMap = new Map<string, Lead>();
    for (const l of leadRows) {
      leadMap.set(l.id, this.mapLead(l));
    }

    // 批量查 lastMessage：取每个 session 最新一条消息
    const sessionIds = sessions.map((s) => s.id);
    const allMessages = await this.db
      .select()
      .from(chatMessages)
      .where(inArray(chatMessages.sessionId, sessionIds))
      .orderBy(desc(chatMessages.createdAt));

    const lastMessageMap = new Map<string, ChatMessage>();
    const messageCountMap = new Map<string, number>();
    for (const m of allMessages) {
      const mapped = this.mapMessage(m);
      if (!lastMessageMap.has(m.sessionId)) {
        lastMessageMap.set(m.sessionId, mapped);
      }
      messageCountMap.set(
        m.sessionId,
        (messageCountMap.get(m.sessionId) ?? 0) + 1,
      );
    }

    const items: ChatSessionListItem[] = sessions.map((s) => {
      const lastMessage = lastMessageMap.get(s.id);
      // 未读 = 最新一条消息是客户发的（agent 还没回）
      // 用于工作台列表显示"待回复"红点
      const unread = Boolean(lastMessage && lastMessage.role === 'customer');
      return {
        ...this.mapSession(s),
        lead: leadMap.get(s.leadId),
        lastMessage,
        messageCount: messageCountMap.get(s.id) ?? 0,
        unread,
      };
    });

    return { items, total, page, pageSize };
  }

  /**
   * 运营端 - 会话详情
   */
  async getSessionDetail(sessionId: string, userId: string, all = false): Promise<ChatSessionDetail> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    const messageRows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    if (
      !all &&
      leadRows.length > 0 &&
      leadRows[0].assigneeId !== userId &&
      !(leadRows[0].assigneeId === null && session.mode === 'human')
    ) {
      throw new ForbiddenException('无权查看此会话');
    }

    return {
      ...this.mapSession(session),
      messages: messageRows.map((m) => this.mapMessage(m)),
      lead: leadRows.length > 0 ? this.mapLead(leadRows[0]) : undefined,
    };
  }

  // ============ 客户端 ============

  /**
   * 客户端 - 通过 chatToken 获取或创建会话
   */
  async getOrCreateSessionByToken(token: string): Promise<CustomerChatInfo> {
    // 查找 lead by chatToken
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.chatToken, token))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException('无效的访问链接');
    }

    const lead = leadRows[0];

    // 查找是否已有 active 会话
    const existingSessions = await this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.leadId, lead.id),
          eq(chatSessions.status, 'active'),
        ),
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    let session: typeof chatSessions.$inferSelect;
    let isNewSession = false;

    if (existingSessions.length > 0) {
      session = existingSessions[0];
    } else {
      // 创建新会话
      isNewSession = true;
      const created = await this.db
        .insert(chatSessions)
        .values({
          leadId: lead.id,
          status: 'active',
        })
        .returning();
      session = created[0];
    }

    // 查询消息
    const messageRows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);

    // 新会话发送开场白
    if (isNewSession) {
      const existingReq = await this.getRequirementByLeadId(lead.id);
      const openingText = await this.buildOpeningMessage(lead, existingReq);
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: openingText,
      });

      // 重新查询消息（含开场白）
      const messagesWithOpening = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id))
        .orderBy(chatMessages.createdAt);

      return {
        session: this.mapSession(session),
        messages: messagesWithOpening.map((m) => this.mapMessage(m)),
      };
    }

    return {
      session: this.mapSession(session),
      messages: messageRows.map((m) => this.mapMessage(m)),
    };
  }

  /**
   * 客户端 - 获取消息列表（支持 afterId 轮询），同时返回会话状态
   */
  async getMessagesByToken(
    token: string,
    afterId?: string,
  ): Promise<CustomerPollResult> {
    const sessionInfo = await this.findSessionByToken(token);
    if (!sessionInfo) {
      throw new NotFoundException('无效的访问链接或无活跃会话');
    }

    let messageRows;
    if (afterId) {
      const afterMessage = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, afterId))
        .limit(1);

      if (afterMessage.length === 0) {
        messageRows = await this.db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, sessionInfo.id))
          .orderBy(chatMessages.createdAt);
      } else {
        const afterCreatedAt = afterMessage[0].createdAt;
        messageRows = await this.db
          .select()
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.sessionId, sessionInfo.id),
              gt(chatMessages.createdAt, afterCreatedAt),
            ),
          )
          .orderBy(chatMessages.createdAt);
      }
    } else {
      messageRows = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionInfo.id))
        .orderBy(chatMessages.createdAt);
    }

    return {
      messages: messageRows.map((m) => this.mapMessage(m)),
      mode: sessionInfo.mode as ChatSessionMode,
      status: sessionInfo.status as ChatSessionStatus,
    };
  }

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
    const { session, lead } = await this.getOrCreateSessionAndLead(token);

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
    const customerMessage = this.mapMessage(insertedCustomerMsg[0]);

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

    // 3.6 首条客户消息触发智能路由（AI 意图分类 + 技能匹配 + 负载均衡）
    if (!lead.intent) {
      try {
        const routingResult = await this.routingService.routeLead(lead.id, content);
        this.logger.log(
          `线索 ${lead.id} 智能路由: intent=${routingResult.intent}, assignee=${routingResult.assigneeId}, reason=${routingResult.routingReason}`,
        );
        if (routingResult.autoTransferred) {
          this.logger.log(`线索 ${lead.id} 紧急投诉自动转人工`);
          await this.doTransferToHuman(session.id, 'AI识别紧急投诉，自动转人工', 'auto', lead);
          return customerMessage;
        }
      } catch (error) {
        this.logger.error(
          `智能路由失败: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }

    // 3.7 月休非标早拦截（早于 transfer 关键词/情绪/checkRestDaysResponse，2026-08-15 P0 修复 v2）
    // 根因：客户说"月休 6 天"等非标答案时，AI persona 会自主决策走转人工（LLM 流式输出"我帮您转接人工客服"），
    //   → doTransferToHuman → session.mode='human' → 下次 customer 消息进入 30s 静默
    // 修法：在 transfer 决策之前先检查月休非标，命中则插入 AI 模板回复 + return，不让 AI/persona 走转人工
    const restDaysEarly = this.detectNonStandardRestDays(content);
    if (restDaysEarly) {
      this.logger.log(
        `月休非标早拦截(不转人工): customer="${content.slice(0, 40)}" reason=${restDaysEarly.reason}`,
      );
      const earlyTopicKey = this.replyLearningService.determineTopicKey(restDaysEarly.reason);
      let earlyTemplate: LearnedTemplate | null = null;
      if (earlyTopicKey) {
        earlyTemplate = await this.replyLearningService.findTemplate(earlyTopicKey);
        if (earlyTemplate) {
          this.logger.log(`命中学习模板: topic=${earlyTopicKey}, template=${earlyTemplate.id}, status=${earlyTemplate.status}`);
        }
      }
      const replyContent = earlyTemplate
        ? earlyTemplate.answerText
        : restDaysEarly.message;
      if (replyContent) {
        await this.db.insert(chatMessages).values({
          sessionId: session.id,
          role: 'bot',
          content: replyContent,
        });
      }
      return customerMessage;
    }

    // 3.7 关键词自动转人工检测
    const keywords = await this.aiConfigService.getTransferKeywords(TRANSFER_KEYWORDS);
    const matchedKeyword = this.autoDetectTransfer(content, keywords);
    if (matchedKeyword) {
      this.logger.log(`会话 ${session.id} 触发自动转人工，关键词: ${matchedKeyword}`);
      await this.doTransferToHuman(session.id, matchedKeyword, 'auto', lead);
      return customerMessage;
    }

    // 3.7.1 客户情绪升级 / 重复提问 → 立即转人工（2026-08-14 新增）
    // 优先级最高：宁可误转也不让客户气走。命中后跳过 LLM 直接转人工。
    const frustrationKeyword = this.detectFrustration(content);
    if (frustrationKeyword) {
      this.logger.log(
        `会话 ${session.id} 客户情绪升级，关键词: "${frustrationKeyword}"，立即转人工`,
      );
      await this.doTransferToHuman(
        session.id,
        `客户语气不耐烦（关键词：${frustrationKeyword}）`,
        'auto',
        lead,
        FRUSTRATION_TRANSFER_MESSAGE,
      );
      return customerMessage;
    }

    // 3.7.2 fee_info 收费问法 L1 直出（2026-09-12 中介费=0 定稿，2026-09-14 落地）
    // 句中含 中介费/服务费/信息费/介绍费 任一费用词 → 直出定稿文案，0 次 LLM 调用。
    // 排在情绪升级之后：客户已经不耐烦时转人工优先，不能拿模板把人堵回去。
    // 模糊钱问法（"你们怎么收费"/孤零零"费用多少"）不含这 4 个词，不会被截走，照常走 market_price / L3。
    // L3 prompt 里另有一份同文案的【收费口径兜底】段做漏网兜底，两处口径恒一致。
    const feeInfoKeyword = FEE_INFO_KEYWORDS.find((kw) => content.includes(kw));
    if (feeInfoKeyword) {
      this.logger.log(
        `会话 ${session.id} fee_info L1 直出(不走LLM): customer="${content.slice(0, 40)}" keyword=${feeInfoKeyword}`,
      );
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: FEE_INFO_REPLY,
      });
      return customerMessage;
    }

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
      const restDaysResult = this.checkRestDaysResponse(lastBotMsg.content, content);
      if (restDaysResult.shouldTransfer) {
        const topicKey = this.replyLearningService.determineTopicKey(restDaysResult.reason!);
        if (topicKey) {
          const template = await this.replyLearningService.findTemplate(topicKey);
          if (template) {
            activeTemplate = template;
            this.logger.log(`命中学习模板: topic=${topicKey}, template=${template.id}, status=${template.status}`);
          }
        }
        if (!activeTemplate) {
          // 2026-08-15 P0 修复：月休 6 天/非标不再 doTransferToHuman。
          // 原逻辑：doTransferToHuman → session.mode='human' → 30s 静默等待客服接入
          //   （修复前是 2min，已在 line 530 缩到 30s，但仍静默）。
          //   生产里任何客户说"月休 6 天"都被晾 30s，体感极差。
          // 改为：插入 checkRestDaysResponse 已算好的模板回复（复用「休6天」风格，
          //   含薪资/范围影响说明 + 引导顾问后续沟通），不转人工、不进 human 模式。
          this.logger.log(
            `月休超范围(已改为不转人工): bot问="${lastBotMsg.content.slice(0, 50)}" customer="${content}" reason=${restDaysResult.reason}`,
          );
          if (restDaysResult.message) {
            await this.db.insert(chatMessages).values({
              sessionId: session.id,
              role: 'bot',
              content: restDaysResult.message,
            });
          }
          return customerMessage;
        }
      }
      if (!activeTemplate) {
        const twoChoiceResponse = this.buildTwoChoiceOutOfRangeResponse(lastBotMsg.content, content);
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
            return customerMessage;
          }
        }
      }
    }
    const conversationHistory = historyMessages
      .map((m) => `${m.role === 'customer' ? '雇主' : '小书'}: ${m.content}`)
      .join('\n');

    // 5. 获取当前已收集需求（含关键词快速识别服务类型 + 轻量级字段检测）
    let currentRequirement = await this.getRequirementByLeadId(lead.id);
    if (!currentRequirement?.serviceType) {
      const detectedType = detectServiceTypeFromText(content);
      if (detectedType) {
        await this.upsertServiceType(lead.id, detectedType);
        currentRequirement = await this.getRequirementByLeadId(lead.id);
        this.logger.log(`关键词识别服务类型: ${detectedType}`);
      }
    }

    // 5.5 轻量级实时字段检测：每轮都从最近对话中提取已答字段，避免 AI 重复询问
    try {
      const realtimeUpdates = this.detectFieldsFromConversation(historyMessages);
      if (realtimeUpdates.size > 0) {
        this.logger.log(`实时字段检测到: ${[...realtimeUpdates.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
        await this.mergeRequirementFields(lead.id, currentRequirement, realtimeUpdates);
        currentRequirement = await this.getRequirementByLeadId(lead.id);
      } else {
        this.logger.log('实时字段检测: 无匹配');
      }
    } catch (err) {
      this.logger.warn(`实时字段检测异常: ${err instanceof Error ? err.message : String(err)}`);
    }

    const guidancePrompt = this.requirementCollectionService.buildGuidancePrompt(
      currentRequirement?.serviceType ?? null,
      currentRequirement,
      lead.serviceCity,
    );

    // 6. 调用 AI 流式生成回复
    let fullResponse = '';
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
      const streamResult = await this.capabilityService
        .load(aiReplyPluginId)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona: effectivePersona,
          conversation_history: conversationHistory,
          collected_requirements: guidancePrompt,
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
    } catch (error) {
      this.logger.error(
        `AI 回复生成失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      fullResponse = '抱歉，我暂时无法回复，请稍后再试~';
    }

    // 6.2.5 B-price 误转人工护栏：月休4天嫌贵想换6天的特殊场景，不应触发 B-price 转人工
    // 触发条件：客户消息同时含"月休4天"+"贵/便宜"+"换/改/变/月休6天"等
    if (this.isMonthRest4TooExpensiveSwitchTo6(content)) {
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
      const stripped = this.stripElderlyQuestion(fullResponse);
      if (stripped !== fullResponse) {
        this.logger.warn(`elderlyCare 已填但 LLM 又问老人问题，强制剔除: customer="${content.slice(0, 30)}" llm="${fullResponse.slice(0, 80)}" stripped="${stripped.slice(0, 80)}"`);
        fullResponse = stripped.length < 4 ? '好的~' : stripped;
      }
    }

    // 6.3.5 已采集字段又被 LLM 反复询问的通用护栏（2026-08-15 林琳反馈服务类型已确认白班保姆又被问）
    // 根因：LLM 在 persona / guidance prompt 都明示"不要重复问已采集字段"但仍反复违反
    // 与 elderlyCare 一样做"输出端代码级硬约束"——把已采集字段的疑问句整对剔除
    // 覆盖字段：服务类型、月休、面积、家庭人口、住家/白班、薪资预算（高频被复问的）
    if (currentRequirement) {
      const stripped = this.stripReaskCollectedFields(fullResponse, {
        serviceType: currentRequirement.serviceType,
        restDays: currentRequirement.restDays,
        area: currentRequirement.area,
        householdSize: currentRequirement.householdSize,
        workMode: currentRequirement.workMode,
        budget: currentRequirement.budget,
      });
      if (stripped !== fullResponse) {
        this.logger.warn(`已采集字段被 LLM 反复询问，强制剔除: customer="${content.slice(0, 30)}" llm="${fullResponse.slice(0, 80)}" stripped="${stripped.slice(0, 80)}"`);
        fullResponse = stripped.length < 4 ? '好的~' : stripped;
      }
    }

    // 6.4 月休+价格问题护栏：客户问"月休和价格的关系"时，强制覆写 LLM 输出为短答模板
    // 根因：LLM 在此场景反复输出"城市调整"错答（即使 persona 改了也没用），需要代码级硬约束
    // 2026-08-15 林琳反馈原模板两处问题：
    //   1) "月休多阿姨少赚点、月休少阿姨多赚点"——以阿姨角度说，要改成客户角度："月休多，薪酬就低一点；月休少，薪酬就高一点"
    //   2) "咱们这边您倾向月休几天呢？"——主动给客户自由选择的余地，月休 2/4 天是平台标准不能主动提起
    if (this.isRestDaysPriceQuestion(content)) {
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
    if (this.detectMarketPriceQuestion(content)) {
      const canonical = await this.buildMarketPriceCanonical(
        currentRequirement,
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

    // 7. 检测 AI 转人工信号
    if (fullResponse.includes('【转人工】')) {
      const cleanResponse = fullResponse.replace(/【转人工】/g, '').trim();
      this.logger.log(`AI 触发转人工信号，清理后回复: ${cleanResponse.slice(0, 80)}`);
      await this.doTransferToHuman(
        session.id,
        'AI识别二选一问题超范围，自动转人工',
        'auto',
        lead,
        cleanResponse || '这个情况比较特殊，我帮您转接人工客服，让专员为您详细沟通哦~',
      );
      return customerMessage;
    }

    // 8. 存储 AI 回复
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
    if (customerTurns % extractionInterval === 0) {
      try {
        await this.extractAndSaveRequirements(lead.id, session.id);
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

    return customerMessage;
  }

  // ============ 客户端 - 转人工 ============

  /**
   * 客户端 - 客户主动请求转人工
   */
  async transferToHuman(token: string, reason?: string): Promise<void> {
    const sessionInfo = await this.findSessionByToken(token);
    if (!sessionInfo) {
      throw new NotFoundException('无效的访问链接或无活跃会话');
    }

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, (await this.db.select().from(chatSessions).where(eq(chatSessions.id, sessionInfo.id)).limit(1))[0].leadId))
      .limit(1);

    const lead = leadRows.length > 0 ? this.mapLead(leadRows[0]) : null;
    await this.doTransferToHuman(sessionInfo.id, reason ?? '客户主动请求转人工', 'customer', lead);
  }

  /**
   * 月休问题专项检测：按5种情况分类处理
   * 1. 标准答案(4天/2天) → 不转人工，让AI记录并继续
   * 2. 非标答案(其他天数/无月休) → 转人工，reason=restDaysOverride
   * 3. 困惑(必须二选一吗/只能选这两个吗) → 解释后转人工，reason=restDaysOverride
   * 4. 找人工/不满 → 由关键词检测处理，此处不处理
   * 5. 无关 → 不转人工，让AI拉回主题
   */
  private checkRestDaysResponse(
    lastBotMessage: string,
    customerReply: string,
  ): { shouldTransfer: boolean; reason?: string; message?: string } {
    const isRestDaysQuestion = /月休/.test(lastBotMessage)
      && /\d+\s*天.*?还是.*?\d+\s*天/.test(lastBotMessage);
    if (!isRestDaysQuestion) {
      return { shouldTransfer: false };
    }

    const restDaysMatch = lastBotMessage.match(/(\d+)\s*天.*?还是.*?(\d+)\s*天/);
    if (!restDaysMatch) {
      return { shouldTransfer: false };
    }

    // 1. 标准答案：4天/2天/两天/四天 → 不转人工
    const standardAnswers = [
      restDaysMatch[1] + '天', restDaysMatch[2] + '天',
      '两天', '四天',
    ];
    if (standardAnswers.some((kw) => customerReply.includes(kw))) {
      return { shouldTransfer: false };
    }

    // 2. 非标答案：含具体天数 → 先说明要点再转人工
    const dayMatch = customerReply.match(/(\d+)\s*天/);
    if (dayMatch) {
      const days = dayMatch[1];
      const isMoreThanStandard = Number(days) > 4;
      const salaryNote = isMoreThanStandard
        ? `月休增加意味着阿姨实际工作日减少，薪资会相应做调整（通常是在基础薪资上按天折算，多休${Number(days) - 4}天相应扣减），具体金额可以根据您选定的阿姨等级来算`
        : '休息天数减少涉及薪资上浮，具体金额可以根据您选定的阿姨等级来算';
      const scopeNote = isMoreThanStandard
        ? '大部分阿姨更倾向于月休4天的安排，选择这个天数的话可选阿姨范围会相对窄一些，不过我们会尽量帮您匹配合适的人选'
        : '愿意多上班的阿姨也不少，我们会尽快帮您匹配合适的人选';
      const message = `可以的~跟您说明一下：咱们行业标准的月休一般是4天，住家保姆的服务周期是按整月计算的。薪资方面：${salaryNote}。匹配范围：${scopeNote}。我帮您转接顾问详细沟通，专员马上为您服务~`;
      return {
        shouldTransfer: true,
        reason: 'restDaysOverride',
        message,
      };
    }

    // 2b. 非标答案：无月休/不休息 → 转人工
    if (/无月休|不休息|无休|没有月休|不休/.test(customerReply)) {
      return {
        shouldTransfer: true,
        reason: 'restDaysOverride',
        message: '无月休涉及薪资调整，我帮您转顾问详细沟通哦~',
      };
    }

    // 3. 困惑：必须二选一吗/只能选这两个吗 → 解释要点后转人工
    if (/必须|二选一|只能选|一定要|为什么/.test(customerReply)) {
      return {
        shouldTransfer: true,
        reason: 'restDaysOverride',
        message: '可以的~不是必须的哦，咱们行业标准的月休一般是4天。如果您希望其他天数，薪资会相应做调整（通常是在基础薪资上按天折算），可选阿姨范围也会相应变化。我帮您转接顾问详细沟通，专员马上为您服务~',
      };
    }

    // 5. 无关回答 → 不转人工，让AI拉回主题
    return { shouldTransfer: false };
  }

  /**
   * 月休非标早拦截（2026-08-15 P0 修复 v2 配套）
   *
   * 与 checkRestDaysResponse 区别：
   *   - checkRestDaysResponse 依赖 lastBotMessage（要求 bot 问过"X天还是Y天"），
   *     处理"bot问月休 4/2 → 客户答 6 天"这个特定场景
   *   - detectNonStandardRestDays 不依赖 lastBotMessage，只看 customer 消息，
   *     处理"客户说月休 6 天但 bot 上轮问的是其他事（如老人/小孩）"这种更常见场景
   *
   * 命中条件（满足任一即返回）：
   *   1. 含"月休 X 天"且 X != 4 → 非标答案
   *   2. 含"无月休/不休息/无休/没有月休/不休" → 0 天
   *
   * 用途：在 transfer 关键词/frustration/checkRestDaysResponse 之前先拦截，
   *   避免 AI persona 自主决策走"月休 6 天 → 转人工"造成后续 30s 静默
   */
  private detectNonStandardRestDays(
    customerReply: string,
  ): { reason: string; message: string } | null {
    // 1. 含"月休 X 天"且 X != 4
    const restDaysMatch = customerReply.match(/月休\s*(\d+)\s*天/);
    if (restDaysMatch) {
      const days = Number(restDaysMatch[1]);
      if (days === 4) return null; // 标准答案不拦截
      // 非标答案
      const isMoreThanStandard = days > 4;
      const salaryNote = isMoreThanStandard
        ? `月休增加意味着阿姨实际工作日减少，薪资会相应做调整（通常是在基础薪资上按天折算，多休${days - 4}天相应扣减），具体金额可以根据您选定的阿姨等级来算`
        : '休息天数减少涉及薪资上浮，具体金额可以根据您选定的阿姨等级来算';
      const scopeNote = isMoreThanStandard
        ? '大部分阿姨更倾向于月休4天的安排，选择这个天数的话可选阿姨范围会相对窄一些，不过我们会尽量帮您匹配合适的人选'
        : '愿意多上班的阿姨也不少，我们会尽快帮您匹配合适的人选';
      return {
        reason: 'restDaysOverride',
        message: `可以的~跟您说明一下：咱们行业标准的月休一般是4天，住家保姆的服务周期是按整月计算的。薪资方面：${salaryNote}。匹配范围：${scopeNote}。顾问稍后会跟您详细确认其他需求哈~`,
      };
    }
    // 2. 无月休/不休息
    if (/月休.*?(无|不|没|没有)|不休息|无月休|无休|没有月休|月休.*?0\s*天|月休.*?零\s*天/.test(customerReply)) {
      return {
        reason: 'restDaysOverride',
        message: '可以的~无月休涉及薪资调整，咱们顾问稍后会跟您详细确认其他需求哈~',
      };
    }
    return null;
  }

  /**
   * 二选一问题超范围检测 + 响应构建（5 个二选一，不转人工，复用「休6天」详细模板风格）
   *
   * 范围（5 个）：
   *   1. 住家/白班
   *   2. 26天/42天（月嫂）
   *   3. 日常保洁/深度保洁
   *   4. 住家育儿/白班育儿
   *   5. 住家照顾老人/白班陪护
   *
   * 行为（已确认方案 B + A，2026-08-13）：
   *   - 不再 doTransferToHuman
   *   - 复用「休6天」详细模板：先 acknowledge + 说明影响（薪资/范围） + re-ask 二选一
   *   - 月休问题（4天/2天，checkRestDaysResponse）保持原逻辑不变
   *
   * @returns 响应文案（null = 不触发超范围处理，让 AI 正常生成）
   */
  private buildTwoChoiceOutOfRangeResponse(lastBotMessage: string, customerReply: string): string | null {
    // 客户在提问而非回答（如"必须二选一吗"），不触发超范围
    if (/必须|二选一|能不能|可不可以|一定要|为什么|什么意思/.test(customerReply)) {
      return null;
    }

    const patterns: Array<{ test: RegExp; options: string[]; reask: string }> = [
      {
        test: /住家.*?还是.*?白班|白班.*?还是.*?住家/,
        options: ['住家', '白班'],
        reask: '咱们先确认是【住家】还是【白班】',
      },
      {
        test: /26天.*?还是.*?42天|42天.*?还是.*?26天/,
        options: ['26天', '42天'],
        reask: '咱们先确认是【26 天】还是【42 天】月嫂服务',
      },
      {
        test: /日常保洁.*?还是.*?深度保洁|深度保洁.*?还是.*?日常保洁/,
        options: ['日常保洁', '深度保洁', '日常', '深度'],
        reask: '咱们先确认是【日常保洁】还是【深度保洁】',
      },
      {
        test: /住家育儿.*?还是.*?白班育儿|白班育儿.*?还是.*?住家育儿/,
        options: ['住家育儿', '白班育儿', '住家', '白班'],
        reask: '咱们先确认是【住家育儿】还是【白班育儿】',
      },
      {
        test: /住家.*?照顾.*?老人.*?还是.*?白班.*?陪护|白班.*?陪护.*?还是.*?住家.*?照顾.*?老人/,
        options: ['住家', '白班'],
        reask: '咱们先确认是【住家照顾老人】还是【白班陪护】',
      },
    ];

    for (const p of patterns) {
      if (p.test.test(lastBotMessage)) {
        // 用户回答命中任一选项，不算超范围，让 AI 正常处理
        if (p.options.some((opt) => customerReply.includes(opt))) {
          return null;
        }
        // 用户答非所问：复用「休6天」详细模板，先 explain 影响再 re-ask，不转人工
        const impactNote = this.buildTwoChoiceImpactNote(customerReply);
        return `可以的~${impactNote}${p.reask}，顾问稍后会跟您详细确认其他需求哈~`;
      }
    }
    return null;
  }

  /**
   * 构建二选一超范围时的影响说明（复用「休6天」模板风格）
   *
   * 优先级：
   *   1. 含 "X天" → 走「休6天」模板（薪资/范围影响）
   *   2. 无月休/不休息 → 简化说明
   *   3. 其他需求 → 通用 acknowledge
   */
  private buildTwoChoiceImpactNote(customerReply: string): string {
    // 1. 含具体天数（X天）→ 复用「休6天」模板
    const dayMatch = customerReply.match(/(\d+)\s*天/);
    if (dayMatch) {
      const days = Number(dayMatch[1]);
      if (days > 4) {
        return `跟您说明一下：月休增加意味着阿姨实际工作日减少，薪资会相应做调整（通常是在基础薪资上按天折算，多休${days - 4}天相应扣减），具体金额可以根据您选定的阿姨等级来算。匹配范围：大部分阿姨更倾向于月休4天的安排，不过我们会尽量帮您匹配合适的人选。`;
      } else if (days < 4) {
        return `跟您说明一下：休息天数减少涉及薪资上浮，具体金额可以根据您选定的阿姨等级来算。匹配范围：愿意多上班的阿姨也不少，我们会尽快帮您匹配合适的人选。`;
      }
    }
    // 2. 无月休/不休息
    if (/无月休|不休息|无休|没有月休|不休/.test(customerReply)) {
      return `无月休涉及薪资调整，`;
    }
    // 3. 通用 acknowledge
    return `关于您说的这些需求，咱们后续跟顾问详细确认。`;
  }

  /**
   * 加载"老客回归"上下文（2026-08-16 新增，2026-08-16 林琳反馈修正触发条件）
   *
   * 业务背景：客户用同一手机号二次咨询时，AI 开场白应主动复述他之前留过的信息让他确认。
   *
   * 数据流：
   * - leads.cross_channel_history 由 leads.service.ts mergeOrCreateByPhone 写入
   * - Drizzle schema 未注册 cross_channel_history（DBA 加列后才会同步），
   *   这里用 raw SQL 读，列不存在（42703）或查询失败时 try/catch 兜住，不阻塞主流程
   *
   * 决策矩阵（2026-08-16 v2.1 修正）：
   * - 有 completed/signed 订单（v2.1 修正：去掉 leadGrade='A' 判定，仅靠 hasCompletedOrder）→ 场景 A_recent（< 30 天）/ B_old（≥ 30 天）"强老客"分支
   * - 否则 history ≥ 1 条 → 场景 C_secondary（二次咨询但未成交）"弱老客"分支
   * - 否则 → null（新客户，走普通开场白）
   *
   * 阈值：环境变量 RETURN_CUSTOMER_THRESHOLD_DAYS，默认 30 天
   */
  private async loadReturnCustomerContext(
    lead: typeof leads.$inferSelect,
    existingReq: { serviceType?: string | null } | null,
  ): Promise<ReturnCustomerContext | null> {
    let history: ReturnCustomerHistoryEntry[] = [];
    try {
      const rows = await this.db.execute<{ history: ReturnCustomerHistoryEntry[] }>(sql`
        SELECT cross_channel_history AS history
        FROM leads
        WHERE id = ${lead.id}
        LIMIT 1
      `);
      const rowList = Array.isArray(rows) ? rows : (rows as any).rows ?? [];
      const row = rowList[0] as { history?: ReturnCustomerHistoryEntry[] } | undefined;
      history = Array.isArray(row?.history) ? row!.history! : [];
    } catch (err) {
      // 列不存在（42703）或其他异常 → 跳过老客回归检测，不阻塞主流程
      this.logger.warn(
        `[老客回归] 读 cross_channel_history 失败（列可能未加，主流程不受影响）: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    if (history.length < 1) {
      // 新客户：没有任何 form 留资
      return null;
    }

    // 决策"强老客" vs "弱老客"（C_secondary）：
    // 1) 查 service_orders 是否有过 completed/signed 订单
    let hasCompletedOrder = false;
    try {
      const orderRows = await this.db.execute<{ count: number }>(sql`
        SELECT COUNT(*)::int AS count
        FROM service_orders
        WHERE lead_id = ${lead.id}
          AND status IN ('completed', 'signed')
        LIMIT 1
      `);
      const orderList = Array.isArray(orderRows) ? orderRows : (orderRows as any).rows ?? [];
      hasCompletedOrder = (orderList[0]?.count ?? 0) > 0;
    } catch (err) {
      // 表不存在或其他异常 → 兜底当成"无订单"，不阻塞主流程
      this.logger.warn(
        `[老客回归] 查 service_orders 失败（按无订单兜底）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 2) leadGrade 已在 lead 对象里（select * from leads 会带）
    const leadGrade = (lead as any).leadGrade ?? null;

    return buildReturnCustomerContext({
      lead: {
        serviceCity: lead.serviceCity ?? null,
        phoneNumber: lead.phoneNumber ?? null,
        customerName: lead.customerName ?? null,
      },
      requirement: existingReq as ReturnCustomerContext['requirement'],
      history,
      hasCompletedOrder,
      leadGrade,
    });
  }

  /**
   * 构建开场白：5 级优先级
   *
   * 优先级（2026-08-16 新增 0 级"老客回归"）：
   *   0. 老客回归检测（cross_channel_history ≥ 2 条）：客户二次咨询 → 复述历史让他确认
   *   1. 数据库 ai_configs.opening_message 配置（运营可在线修改）
   *   2. 源码 OPENING_MESSAGES_BY_SERVICE（按 rawServiceType，6 段）
   *   3. 源码 OPENING_MESSAGES（按 normalizeServiceType，5 段 baomu/yuesao/yanglao/yuer/baojie）
   *   4. 动态拼接（基于 serviceCity + serviceType 复述表单信息）
   *
   * 月嫂（26day_yuesao / yuesao）由第 2/3 级模板覆盖。
   */
  private async buildOpeningMessage(
    lead: typeof leads.$inferSelect,
    existingReq: { serviceType?: string | null } | null,
  ): Promise<string> {
    // 0) 老客回归检测（最高优先级）：客户二次咨询时主动复述他之前留过的信息
    const returnCtx = await this.loadReturnCustomerContext(lead, existingReq);
    if (returnCtx) {
      this.logger.log(
        `[老客回归] lead=${lead.id} phone=${lead.phoneNumber} scenario=${returnCtx.scenario} history=${returnCtx.allHistoryCount}条 daysSince=${returnCtx.previousEntry.daysSince}`,
      );
      return buildReturnCustomerOpening(returnCtx);
    }

    const rawServiceType = existingReq?.serviceType ?? null;
    const displayServiceType = rawServiceType
      ? ({
          zhujia: '住家保姆', baiban: '白班保姆', yuer: '育儿保姆',
          '住家': '住家保姆', '白班': '白班保姆', '育儿': '育儿保姆',
          zhongdian: '钟点工保姆', '钟点': '钟点工保姆', '钟点工': '钟点工保姆',
          feishi: '菲式保姆', '菲式': '菲式保姆', '菲佣': '菲式保姆',
          '26day_yuesao': '26天月嫂', '月嫂': '26天月嫂',
          yanglao: '护工保姆', '养老': '护工保姆', '护工': '护工保姆',
          baojie: '保洁', '保洁': '保洁',
        } as Record<string, string>)[rawServiceType] ?? getServiceTypeLabel(rawServiceType)
      : null;

    // 1) 数据库配置（运营可在线改）
    const dbOpening = await this.aiConfigService.getConfig('opening_message');
    if (dbOpening) return dbOpening;

    // 2) chat.prompt.ts 的 6 段按 serviceType 模板（含月嫂兜底）
    if (rawServiceType && OPENING_MESSAGES_BY_SERVICE[rawServiceType]) {
      return OPENING_MESSAGES_BY_SERVICE[rawServiceType];
    }

    // 3) requirement-templates.ts 的 5 段按 normalizeServiceType 模板
    const normalizedKey = normalizeServiceType(rawServiceType);
    if (normalizedKey && normalizedKey !== 'default' && OPENING_MESSAGES[normalizedKey]) {
      return OPENING_MESSAGES[normalizedKey];
    }

    // 4) 兜底：复述表单已有信息 + 抛出关键疑问让客户回应
    const parts: string[] = [
      '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～',
      '',
    ];

    if (displayServiceType) {
      // 已有服务类型：复述 + 抛出关键疑问
      parts.push(
        `收到您的需求啦～您选择的是【${displayServiceType}】，具体价格会根据您所在的城市调整，【客服后续会给准确报价】。\n\n请问您家里几口人？主要想阿姨负责哪些事呢？`,
      );
    } else {
      // 没有服务类型：先问服务类型
      parts.push('请问您需要哪种【服务类型】呢？咱们这边有钟点工、白班、住家、育儿、护工、菲式、月嫂等可选～');
    }

    return parts.join('\n');
  }

  /**
   * 关键词检测：返回匹配的关键词，无匹配返回 null
   */
  autoDetectTransfer(content: string, keywords: string[]): string | null {
    for (const kw of keywords) {
      if (content.includes(kw)) return kw;
    }
    return null;
  }

  /**
   * 客户情绪升级 / 重复提问检测（2026-08-14 新增）
   *
   * 命中任一关键词即认为客户情绪升级，立即转人工，不再走 LLM 回复流程。
   * 关键词都是多字组合（见 FRUSTRATION_KEYWORDS），避免"急"等单字误伤。
   */
  detectFrustration(content: string): string | null {
    for (const kw of FRUSTRATION_KEYWORDS) {
      if (content.includes(kw)) return kw;
    }
    return null;
  }

  /**
   * 执行转人工（内部方法）：设 mode=human + 存转接信息 + 插 bot 提示消息 + 通知专员
   */
  private async doTransferToHuman(
    sessionId: string,
    reason: string,
    transferredBy: TransferSource,
    lead: Lead | null,
    customMessage?: string,
  ): Promise<void> {
    let effectiveLead = lead;
    let assignedToAgent = false;

    if (lead) {
      try {
        const routingResult = await this.routingService.assignForHuman(lead.id, reason);
        if (routingResult.assigneeId) {
          effectiveLead = { ...lead, assigneeId: routingResult.assigneeId };
          assignedToAgent = true;
          this.logger.log(
            `线索 ${lead.id} 转人工加权分配: ${routingResult.assigneeId}, reason=${routingResult.routingReason}`,
          );
        } else {
          this.logger.log(`线索 ${lead.id} 转人工但无客服在线，AI继续接管`);
        }
      } catch (error) {
        this.logger.error(
          `转人工加权分配失败，沿用原分配: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 取消待追踪的模板使用（转人工 = 模板回答未被接受）
    await this.replyLearningService.cancelPendingUsage(sessionId);

    // 关键：无论是否分配到客服，都要切到 mode='human'
    // 否则客服的"我的会话"列表（按 mode='human' 过滤）永远看不到这条会话
    await this.db
      .update(chatSessions)
      .set({ mode: 'human', transferReason: reason, transferredBy })
      .where(eq(chatSessions.id, sessionId));

    if (assignedToAgent) {
      await this.db.insert(chatMessages).values({
        sessionId,
        role: 'bot',
        content: customMessage ?? TRANSFER_MESSAGE,
      });

      try {
        await this.notifyService.notifyTransferToAgent(sessionId, reason, transferredBy, effectiveLead);
      } catch (error) {
        this.logger.error(
          `转人工通知失败: ${JSON.stringify(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    } else {
      // 无客服在线：已切 mode='human'（上方 update），同时 selectAndAssign
      // 已经把 A/B 级线索放进 pending_assignment 队列（30s 缓冲）；
      // 客服上线时由 retryPendingAssignmentsForAgent 抢单分配。
      // 这里只补一条提示消息给客户。
      await this.db.insert(chatMessages).values({
        sessionId,
        role: 'bot',
        content: customMessage ?? NO_AGENT_ONLINE_MESSAGE,
      });
    }

    // SSE：转人工后给 assignee（或全池）推 session.updated，列表立即出现
    try {
      const finalSessionRows = await this.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);
      if (finalSessionRows.length > 0) {
        const event = {
          type: 'session.updated' as const,
          session: this.mapSession(finalSessionRows[0]),
        };
        if (effectiveLead?.assigneeId) {
          this.chatEventBus.emitToUser(effectiveLead.assigneeId, event);
        } else {
          this.chatEventBus.emitToAll(event);
        }
      }
    } catch (err) {
      this.logger.warn(`SSE emit doTransferToHuman 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ============ AI 回复建议 ============

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

    const currentRequirement = await this.getRequirementByLeadId(sessionRows[0].leadId);
    const collectedRequirements = this.summarizeRequirement(currentRequirement);

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

  // ============ 转接摘要 ============

  /**
   * 获取转接摘要（含权限校验）
   */
  async getHandoffSummaryWithAuth(sessionId: string, userId: string, all = false): Promise<HandoffSummary> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    if (!all) {
      const leadRows = await this.db
        .select()
        .from(leads)
        .where(eq(leads.id, sessionRows[0].leadId))
        .limit(1);
      if (leadRows.length > 0 && leadRows[0].assigneeId !== userId) {
        throw new ForbiddenException('无权查看此会话');
      }
    }

    return this.getHandoffSummary(sessionId);
  }

  /**
   * 获取转接摘要（客户画像 + 需求 + 转接信息）
   */
  async getHandoffSummary(sessionId: string): Promise<HandoffSummary> {
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

    const lead = leadRows.length > 0 ? this.mapLead(leadRows[0]) : null;
    const requirement = await this.getRequirementByLeadId(session.leadId);

    const msgCountResult = await this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));

    const customerMsgCountResult = await this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.role, 'customer'),
        ),
      );

    return {
      customerName: lead?.customerName ?? null,
      phoneNumber: lead?.phoneNumber ?? '',
      serviceCity: sanitizeCity(lead?.serviceCity ?? ''),
      source: normalizeSource(lead?.source ?? 'unknown') as LeadSource,
      leadStatus: lead?.status ?? 'new',
      intent: lead?.intent ?? null,
      routingReason: lead?.routingReason ?? null,
      transferReason: session.transferReason ?? null,
      transferredBy: (session.transferredBy ?? null) as TransferSource | null,
      requirements: requirement,
      messageCount: Number(msgCountResult[0]?.value ?? 0),
      customerMessageCount: Number(customerMsgCountResult[0]?.value ?? 0),
      sessionStartedAt: session.startedAt.toISOString(),
    };
  }

  // ============ 运营端 - 人工接管 ============

  /**
   * 运营端 - 客服接管会话（AI → 人工）
   * 兼做「claim」动作：未分配且 human 模式的会话，第一个点接管的客服把它认领走
   */
  async takeoverSession(sessionId: string, userId: string): Promise<ChatSession> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    // 校验归属 / claim
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    if (leadRows.length > 0) {
      const lead = leadRows[0];
      if (lead.assigneeId !== null && lead.assigneeId !== userId) {
        throw new ForbiddenException('无权操作此会话');
      }
      // claim：会话是 unassigned + human 模式时，第一个接管的客服把它认领掉
      if (lead.assigneeId === null && session.mode === 'human') {
        await this.db
          .update(leads)
          .set({ assigneeId: userId })
          .where(and(eq(leads.id, lead.id), isNull(leads.assigneeId)));
        this.logger.log(`客服 ${userId} 认领会话 ${sessionId}（lead ${lead.id}）`);
      }
    }

    const [updated] = await this.db
      .update(chatSessions)
      .set({ mode: 'human' })
      .where(eq(chatSessions.id, sessionId))
      .returning();

    await this.db.insert(chatMessages).values({
      sessionId,
      role: 'bot',
      content: '客服已接入，专员正在为您服务~',
    });

    this.logger.log(`客服 ${userId} 接管会话 ${sessionId}`);

    // SSE：推 session.updated 给接管者（让其它 tab 实时看到 mode 切换 + 接管成功）
    try {
      this.chatEventBus.emitToUser(userId, {
        type: 'session.updated',
        session: this.mapSession(updated),
      });
    } catch (err) {
      this.logger.warn(`SSE emit takeoverSession 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapSession(updated);
  }

  /**
   * 运营端 - 释放会话回 AI（人工 → AI）
   */
  async releaseSession(sessionId: string, userId: string): Promise<ChatSession> {
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

    if (leadRows.length > 0 && leadRows[0].assigneeId !== userId) {
      throw new ForbiddenException('无权操作此会话');
    }

    const [updated] = await this.db
      .update(chatSessions)
      .set({ mode: 'ai' })
      .where(eq(chatSessions.id, sessionId))
      .returning();

    await this.db.insert(chatMessages).values({
      sessionId,
      role: 'bot',
      content: '客服已退出，小书继续为您服务~',
    });

    this.logger.log(`客服 ${userId} 释放会话 ${sessionId} 回 AI`);

    // 异步检查：人工接管期间若有未回复的客户消息，AI 自动补答
    this.catchUpAiReplyAfterRelease(sessionId, updated[0])
      .catch((err: unknown) => {
        this.logger.error(
          `释放回AI后补答失败: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      });

    // SSE：推 session.updated 给释放者
    try {
      this.chatEventBus.emitToUser(userId, {
        type: 'session.updated',
        session: this.mapSession(updated),
      });
    } catch (err) {
      this.logger.warn(`SSE emit releaseSession 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapSession(updated);
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

    const lead = this.mapLead(leadRows[0]);
    await this.generateAiReplyForSession(session, lead, lastMsg.content);
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

    let activeTemplate: LearnedTemplate | null = null;
    const botMsgs = historyMessages.filter((m) => m.role === 'bot');
    const lastBotMsg = botMsgs[botMsgs.length - 1];
    if (lastBotMsg) {
      const restDaysResult = this.checkRestDaysResponse(lastBotMsg.content, content);
      if (restDaysResult.shouldTransfer) {
        const topicKey = this.replyLearningService.determineTopicKey(restDaysResult.reason!);
        if (topicKey) {
          const template = await this.replyLearningService.findTemplate(topicKey);
          if (template) {
            activeTemplate = template;
            this.logger.log(`命中学习模板: topic=${topicKey}, template=${template.id}, status=${template.status}`);
          }
        }
        if (!activeTemplate) {
          this.logger.log(`月休转人工: bot问="${lastBotMsg.content.slice(0, 50)}" customer="${content}" reason=${restDaysResult.reason}`);
          await this.doTransferToHuman(session.id, restDaysResult.reason!, 'auto', lead, restDaysResult.message);
          return;
        }
      }
      if (!activeTemplate) {
        const twoChoiceResponse = this.buildTwoChoiceOutOfRangeResponse(lastBotMsg.content, content);
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

    let currentRequirement = await this.getRequirementByLeadId(lead.id);
    if (!currentRequirement?.serviceType) {
      const detectedType = detectServiceTypeFromText(content);
      if (detectedType) {
        await this.upsertServiceType(lead.id, detectedType);
        currentRequirement = await this.getRequirementByLeadId(lead.id);
        this.logger.log(`关键词识别服务类型: ${detectedType}`);
      }
    }

    try {
      const realtimeUpdates = this.detectFieldsFromConversation(historyMessages);
      if (realtimeUpdates.size > 0) {
        this.logger.log(`实时字段检测到: ${[...realtimeUpdates.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
        await this.mergeRequirementFields(lead.id, currentRequirement, realtimeUpdates);
        currentRequirement = await this.getRequirementByLeadId(lead.id);
      } else {
        this.logger.log('实时字段检测: 无匹配');
      }
    } catch (err) {
      this.logger.warn(`实时字段检测异常: ${err instanceof Error ? err.message : String(err)}`);
    }

    const guidancePrompt = this.requirementCollectionService.buildGuidancePrompt(
      currentRequirement?.serviceType ?? null,
      currentRequirement,
      lead.serviceCity,
    );

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

    let fullResponse = '';
    try {
      const streamResult = await this.capabilityService
        .load(aiReplyPluginId)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona: effectivePersona,
          conversation_history: conversationHistory,
          collected_requirements: guidancePrompt,
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
    } catch (error) {
      this.logger.error(
        `AI 回复生成失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      fullResponse = '抱歉，我暂时无法回复，请稍后再试~';
    }

    if (fullResponse.includes('【转人工】')) {
      const cleanResponse = fullResponse.replace(/【转人工】/g, '').trim();
      this.logger.log(`AI 触发转人工信号，清理后回复: ${cleanResponse.slice(0, 80)}`);
      await this.doTransferToHuman(
        session.id,
        'AI识别二选一问题超范围，自动转人工',
        'auto',
        lead,
        cleanResponse || '这个情况比较特殊，我帮您转接人工客服，让专员为您详细沟通哦~',
      );
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
    if (customerTurns % extractionInterval === 0) {
      try {
        await this.extractAndSaveRequirements(lead.id, session.id);
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
   * 运营端 - 客服发送消息
   */
  async sendAgentMessage(sessionId: string, content: string, userId: string): Promise<ChatMessage> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    // 校验归属 / claim
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    if (leadRows.length > 0) {
      const lead = leadRows[0];
      if (lead.assigneeId !== null && lead.assigneeId !== userId) {
        throw new ForbiddenException('无权操作此会话');
      }
      // 防御性 claim：万一 UI 跳过接管直接发，human 模式 + 未分配就认领
      if (lead.assigneeId === null && session.mode === 'human') {
        await this.db
          .update(leads)
          .set({ assigneeId: userId })
          .where(and(eq(leads.id, lead.id), isNull(leads.assigneeId)));
        this.logger.log(`客服 ${userId} 发送时认领会话 ${sessionId}（lead ${lead.id}）`);
      }
    }

    const [msg] = await this.db
      .insert(chatMessages)
      .values({
        sessionId,
        role: 'agent',
        content,
      })
      .returning();

    this.logger.log(`客服 ${userId} 在会话 ${sessionId} 中发送消息`);

    // AI话术学习：如果是转人工后的首条客服回复，提取问答对存为模板
    await this.tryLearnFromAgentReply(sessionId, session, content);

    // SSE：推 message.created 给该 agent（跨 tab 同步自己发的消息）
    try {
      this.chatEventBus.emitToUser(userId, {
        type: 'message.created',
        sessionId,
        message: this.mapMessage(msg),
      });
    } catch (err) {
      this.logger.warn(`SSE emit sendAgentMessage 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapMessage(msg);
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

  // ============ 需求提取 ============

  /**
   * 调用 AI 提取结构化需求并 upsert 到 requirements 表
   */
  private async extractAndSaveRequirements(
    leadId: string,
    sessionId: string,
  ): Promise<void> {
    // 组装完整对话文本
    const allMessages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    const conversationText = allMessages
      .map((m) => `${m.role === 'customer' ? '雇主' : '小书'}: ${m.content}`)
      .join('\n');

    // 调用 AI 提取
    const extractionPluginId = await this.aiConfigService.getConfigWithDefault('requirement_extraction_plugin_id', REQUIREMENT_EXTRACTION_PLUGIN_ID);
    const result = (await this.capabilityService
      .load(extractionPluginId)
      .call(REQUIREMENT_EXTRACTION_ACTION_KEY, {
        conversation_text: conversationText,
      })) as ExtractedRequirement;

    this.logger.log(
      `需求提取结果: service_type=${result.service_type}, address=${result.service_address}, budget=${result.budget}`,
    );

    // 判定核心字段是否完成（2026-09-05：budget 是 integer 列，须解析出数字才算采到——"面议"这类非数字不算）
    const isCompleted =
      !!result.service_type &&
      !!result.service_address &&
      parseBudgetNumber(result.budget) != null;

    const status: RequirementStatus = isCompleted ? 'completed' : 'collecting';

    // 构建已采集字段快照
    const collectedFields = buildCollectedFields(result);

    // upsert requirements — 老值优先：不覆盖已有值，只填充新值（2026-09-12 定稿，与正则链路同语义）
    // 2026-08-15：用 INSERT ... ON CONFLICT (lead_id) DO UPDATE 走 anon 合法路径
    // （anon 没有 UPDATE 政策，UPDATE 会静默 0 行；ON CONFLICT DO UPDATE 走 INSERT WITH CHECK=true 永远 pass）
    await this.db.execute(sql`
      INSERT INTO requirements (
        lead_id, service_type, household_size, area, elderly_care, rest_days, start_time,
        service_address, helper_requirements, dietary_preferences, budget, service_duration,
        special_requirements, family_info, work_mode, status, collected_fields
      ) VALUES (
        ${leadId},
        ${result.service_type ? chineseServiceType(normalizeServiceSubType(result.service_type)) : null},
        ${result.household_size ?? null},
        ${result.area ?? null},
        ${result.elderly_care ?? null},
        ${result.rest_days ?? null},
        ${result.start_time ?? null},
        ${result.service_address ?? null},
        ${result.helper_requirements ?? null},
        ${result.dietary_preferences ?? null},
        ${parseBudgetNumber(result.budget)},
        ${result.service_duration ?? null},
        ${result.special_requirements ?? null},
        ${result.family_info ?? null},
        ${result.work_mode ?? null},
        ${status},
        ${JSON.stringify(collectedFields)}::jsonb
      )
      ON CONFLICT (lead_id) DO UPDATE SET
        -- 2026-09-12 定稿：全量提取改为"老值优先，只填空不覆盖"。
        -- 之前写法 COALESCE(NULLIF(EXCLUDED.X,''), requirements.X) 是新值优先（每轮覆盖），
        -- 会把正则链路先存对的值盖掉；现改为与 mergeRequirementFields 同语义：
        -- 老值优先，AI 本轮没提到（空/空串）时才落新值。改口场景由顾问后台手动修正兜底。
        service_type = COALESCE(requirements.service_type, NULLIF(EXCLUDED.service_type, '')),
        household_size = COALESCE(requirements.household_size, NULLIF(EXCLUDED.household_size, '')),
        area = COALESCE(requirements.area, NULLIF(EXCLUDED.area, '')),
        elderly_care = COALESCE(requirements.elderly_care, NULLIF(EXCLUDED.elderly_care, '')),
        rest_days = COALESCE(requirements.rest_days, NULLIF(EXCLUDED.rest_days, '')),
        start_time = COALESCE(requirements.start_time, NULLIF(EXCLUDED.start_time, '')),
        service_address = COALESCE(requirements.service_address, NULLIF(EXCLUDED.service_address, '')),
        helper_requirements = COALESCE(requirements.helper_requirements, NULLIF(EXCLUDED.helper_requirements, '')),
        dietary_preferences = COALESCE(requirements.dietary_preferences, NULLIF(EXCLUDED.dietary_preferences, '')),
        -- budget integer 列无空串问题，同口径：老值优先
        budget = COALESCE(requirements.budget, EXCLUDED.budget),
        service_duration = COALESCE(requirements.service_duration, NULLIF(EXCLUDED.service_duration, '')),
        special_requirements = COALESCE(requirements.special_requirements, NULLIF(EXCLUDED.special_requirements, '')),
        family_info = COALESCE(requirements.family_info, NULLIF(EXCLUDED.family_info, '')),
        work_mode = COALESCE(requirements.work_mode, NULLIF(EXCLUDED.work_mode, '')),
        -- status 只进不退：已 completed 不因某轮 AI 没提到而降回 collecting
        status = CASE WHEN requirements.status = 'completed' THEN 'completed' ELSE EXCLUDED.status END,
        collected_fields = EXCLUDED.collected_fields
    `);

    // 同步更新 leads 表：采集字段（2026-09-12 定稿：同 requirements 老值优先，只填空不覆盖，
    // 防止全量提取某轮抽错把已有正确值盖掉；改口场景由顾问后台手动修正兜底）
    const normalizedType = result.service_type ? normalizeServiceType(result.service_type) : null;
    const urgencyLevel = inferUrgencyLevel(result.start_time);
    await this.db
      .update(leads)
      .set({
        budgetRange: sql`COALESCE(${leads.budgetRange}, ${result.budget ?? null})`,
        serviceStartTime: sql`COALESCE(${leads.serviceStartTime}, ${result.start_time ?? null})`,
        serviceDuration: sql`COALESCE(${leads.serviceDuration}, ${result.service_duration ?? null})`,
        specialRequirements: sql`COALESCE(${leads.specialRequirements}, ${result.special_requirements ?? null})`,
        familyInfo: sql`COALESCE(${leads.familyInfo}, ${result.family_info ?? null})`,
        urgencyLevel,
        ...(isCompleted ? { status: 'collected', intent: normalizedType } : {}),
      })
      .where(eq(leads.id, leadId));

    // 需求收集完成时：生成AI摘要 + 通知运营
    if (isCompleted) {
      // 生成AI需求摘要并持久化
      try {
        const summaryResult = await this.capabilityService
          .load(SUMMARY_PLUGIN_ID)
          .callStream(SUMMARY_ACTION_KEY, {
            conversation_text: conversationText,
          });
        const stream = normalizeStream(summaryResult);
        let aiSummary = '';
        for await (const chunk of stream) {
          aiSummary += (chunk as { summary?: string }).summary ?? '';
        }
        if (aiSummary) {
          await this.db
            .update(requirements)
            .set({ aiSummary })
            .where(eq(requirements.leadId, leadId));
          this.logger.log(`线索 ${leadId} AI需求摘要已生成`);
        }
      } catch (error) {
        this.logger.warn(
          `AI摘要生成失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      this.logger.log(`线索 ${leadId} 需求收集完成，通知运营`);
      try {
        await this.notifyService.notifyRequirementsCollected(leadId);
      } catch (error) {
        this.logger.error(
          `通知运营失败: ${JSON.stringify(error)}`,
          (error as Error).stack,
        );
      }

      this.bitableSyncService.syncLeadToBitable(leadId).catch((err: unknown) => {
        this.logger.warn(`多维表格同步失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  // ============ 辅助方法 ============

  /**
   * 通过 token 获取或创建会话 + lead 信息
   */
  private async getOrCreateSessionAndLead(
    token: string,
  ): Promise<{ session: ChatSession; lead: Lead }> {
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.chatToken, token))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException('无效的访问链接');
    }
    const lead = this.mapLead(leadRows[0]);

    // 查找活跃会话
    const existingSessions = await this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.leadId, lead.id),
          eq(chatSessions.status, 'active'),
        ),
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    let session: ChatSession;
    if (existingSessions.length > 0) {
      session = this.mapSession(existingSessions[0]);
    } else {
      // 创建新会话 + 开场白
      const created = await this.db
        .insert(chatSessions)
        .values({ leadId: lead.id, status: 'active' })
        .returning();
      session = this.mapSession(created[0]);

      const existingReq = await this.getRequirementByLeadId(lead.id);
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: await this.buildOpeningMessage(leadRows[0], existingReq),
      });
    }

    return { session, lead };
  }

  /**
   * 会话转线索：从聊天上下文创建新线索（channel=chat）
   * 当 AI 识别到服务意图且获取到手机号时调用
   */
  async createLeadFromChat(params: {
    phoneNumber: string;
    serviceCity?: string;
    customerName?: string;
    serviceType?: string;
  }): Promise<{ session: ChatSession; lead: Lead }> {
    const normalized = normalizeLead({
      channel: 'chat',
      phoneNumber: params.phoneNumber,
      serviceCity: params.serviceCity ?? '',
      customerName: params.customerName,
      source: '在线咨询',
      serviceType: params.serviceType,
    });
    const serviceType = normalized.serviceType;

    const [row] = await this.db
      .insert(leads)
      .values({
        serviceCity: normalized.serviceCity,
        phoneNumber: normalized.phoneNumber,
        customerName: normalized.customerName,
        source: normalized.source,
        phoneVerified: normalized.phoneVerified,
        channel: normalized.channel,
      })
      .returning();

    if (serviceType) {
      await this.db.insert(requirements).values({
        leadId: row.id,
        serviceType,
        status: 'collecting',
      });
    }

    try {
      await this.routingService.routeLead(row.id);
    } catch (error) {
      this.logger.error(
        `会话转线索智能路由失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    this.bitableSyncService.syncLeadToBitable(row.id).catch((err: unknown) => {
      this.logger.warn(`多维表格同步失败: ${err instanceof Error ? err.message : String(err)}`);
    });

    const [updated] = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, row.id))
      .limit(1);

    const lead = this.mapLead(updated);

    const created = await this.db
      .insert(chatSessions)
      .values({ leadId: lead.id, status: 'active' })
      .returning();
    const session = this.mapSession(created[0]);

    const existingReq = await this.getRequirementByLeadId(lead.id);
    await this.db.insert(chatMessages).values({
      sessionId: session.id,
      role: 'bot',
      content: await this.buildOpeningMessage(updated, existingReq),
    });

    return { session, lead };
  }

  /**
   * 通过 token 找到活跃会话（不创建）
   */
  private async findSessionByToken(
    token: string,
  ): Promise<{ id: string; mode: string; status: string } | null> {
    const leadRows = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.chatToken, token))
      .limit(1);

    if (leadRows.length === 0) return null;

    const sessionRows = await this.db
      .select({ id: chatSessions.id, mode: chatSessions.mode, status: chatSessions.status })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.leadId, leadRows[0].id),
          eq(chatSessions.status, 'active'),
        ),
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (sessionRows.length === 0) return null;
    return sessionRows[0];
  }

  /**
   * 获取 lead 对应的 requirement
   */
  private async getRequirementByLeadId(
    leadId: string,
  ): Promise<Requirement | null> {
    const rows = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.leadId, leadId))
      .limit(1);
    return rows.length > 0 ? this.mapRequirement(rows[0]) : null;
  }

  /**
   * 快速写入服务类型（关键词识别后调用）
   */
  private async upsertServiceType(
    leadId: string,
    serviceType: string,
  ): Promise<void> {
    // 2026-08-15：用 ON CONFLICT DO UPDATE 走 anon 合法路径（service_type 不空，COALESCE 总是用 EXCLUDED）
    await this.db.execute(sql`
      INSERT INTO requirements (lead_id, service_type, status) VALUES (${leadId}, ${serviceType}, 'collecting')
      ON CONFLICT (lead_id) DO UPDATE SET service_type = EXCLUDED.service_type
    `);
  }

  /**
   * 把 LLM 输出中含"老人/照护/陪护"的疑问句剔除
   * 用于"elderlyCare 已填但 LLM 又问老人问题"的护栏——按句分割，识别含关键词且以"？"结尾的整句
   * 返回剔除后的字符串
   */
  private stripElderlyQuestion(response: string): string {
    // 按 (text, delimiter) 配对处理，避免单步推进导致重复 push
    const parts = response.split(/([。！!~～\n？?])/);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i] ?? '';
      const delim = parts[i + 1] ?? '';
      const isQuestion = delim === '？' || delim === '?';
      const hasElderly = /(老人|照护|陪护|老人家|家中老人|老人照护)/.test(text);
      if (isQuestion && hasElderly) {
        // 跳过这一对（含问号的老人疑问句）
        continue;
      }
      kept.push(text);
      if (delim) kept.push(delim);
    }
    return kept.join('').trim();
  }

  /**
   * 把 LLM 输出中"已采集字段被再次询问"的句子整对剔除
   * 用于"服务类型/面积/月休/家庭人口/工作制/薪资预算已填但 LLM 又问"的通用护栏
   *
   * 工作原理：按 (text, delimiter) 配对切分整段 LLM 输出，
   * 识别"以 ？结尾 + 含已采集字段关键词"的整句（疑问句），或
   * 识别"含显式询问动词 + 已采集字段"的整句（陈述式请求），整对剔除。
   *
   * 两种剔除条件都覆盖：
   *   a) 疑问句：句子以 ？或 ? 结尾 + 含字段关键词
   *   b) 显式询问句：含"告诉我您要 / 您要选 / 想找哪种"等强询问语（不要求 ？结尾）
   *      例："告诉我您要哪一类" / "您想找哪种呢"——这些是典型的"礼貌式询问"陈述
   */
  private stripReaskCollectedFields(
    response: string,
    collected: {
      serviceType?: string | null;
      restDays?: string | null;
      area?: string | null;
      householdSize?: string | null;
      workMode?: string | null;
      budget?: number | null;
    },
  ): string {
    // 字段 → 关键词列表。疑问句触发词 + 显式询问触发词分开
    // 疑问句触发词：句末是 ？/？时才生效（避免误伤正常陈述句）
    const questionTriggers: Record<string, RegExp> = {
      serviceType: /(哪类服务|您要哪类|您需要哪类|您想找哪种|想找哪种|找哪种|找什么类型|您想找.{0,4}(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|您要(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|您要找.{0,4}(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|您需要.{0,4}(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|需要(.{0,4})(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|想要(.{0,4})(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|哪种(类型)?的?(阿姨|服务|月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|要(哪种|哪类|什么)(类型|服务|月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|选择(哪种|哪类|什么)|需要(哪种|哪类|什么)|您是.{0,6}哪种|您想要哪种|您要.{0,3}哪一|要哪一(类|种)|服务类型)/,
      restDays: /(月休(几|多少|哪)天|休息(几|多少|哪)天|休(几|多少|哪)天|月休(安排|选择)|\d+\s*天还是\s*\d+\s*天|几天呢)/,
      area: /(多大(面积|平米|平方|平)|多少(平米|平方|平|大)|(房屋|家|您家)?(面积|平米|平方|户型)|面积(多大|多少|怎么样))/,
      householdSize: /(几口人|家里几口|家庭几口|家(里|中)有(几|多少)人|有(几|多少)口人|几口之家)/,
      workMode: /(住家(还是|或者|或|跟)白班|白班(还是|或者|或|跟)住家|工作制|住家.{0,3}白班|白班.{0,3}住家)/,
      budget: /(薪资(预算|大概)|预算(多少|大概)|能(给到|出)(多少|什么价))/,
    };
    // 显式询问触发词：即使句末是 ~ 或 句号 也算"在问"（用于剥离"告诉我您要哪一类"这类礼貌式询问）
    const imperativeTriggers: Record<string, RegExp> = {
      serviceType: /(告诉我您要(哪一|什么|哪种)|您想找.{0,4}告诉我|您要(选|挑|确定|确认)哪|请告诉我您(要|想|需要)哪|想找.{0,4}告诉我|告诉我.{0,4}(哪一|什么类型|哪种))/,
      // 其他字段用疑问句触发词已经够（不会出现在陈述句里）
    };

    const collectedFields = Object.keys(collected).filter(
      (k) => collected[k as keyof typeof collected] && String(collected[k as keyof typeof collected]).trim(),
    );
    if (collectedFields.length === 0) return response;

    // 按 (text, delimiter) 配对处理
    const parts = response.split(/([。！!~～\n？?])/);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i] ?? '';
      const delim = parts[i + 1] ?? '';
      const isQuestion = delim === '？' || delim === '?';

      // 检查是否命中任意已采集字段的"复问"模式
      let hitReask = false;
      for (const field of collectedFields) {
        const qRe = questionTriggers[field];
        const iRe = imperativeTriggers[field];
        // 条件 a：疑问句 + 疑问触发词
        if (isQuestion && qRe && qRe.test(text)) {
          hitReask = true;
          break;
        }
        // 条件 b：显式询问触发词（不要求 ？结尾）
        if (iRe && iRe.test(text)) {
          hitReask = true;
          break;
        }
      }

      if (hitReask) {
        // 跳过这一对（已采集字段又被问的整句）
        continue;
      }
      kept.push(text);
      if (delim) kept.push(delim);
    }
    return kept.join('').trim();
  }

  /**
   * 检测客户消息是否为"月休和价格的关系"类高频问题
   * 命中后会被代码强制覆写为短答模板（避免 LLM 输出"城市调整"错答或长版薪资换算）
   */
  /**
   * 检测"月休4天嫌贵想换月休6天"这一专项场景
   * 客户因月休4天报价贵，主动提出换月休6天——是合理月休调整，不是议价
   * 用于护栏：阻止 LLM 误触发 B-price 转人工
   */
  private isMonthRest4TooExpensiveSwitchTo6(content: string): boolean {
    // 关键三件套：月休4天(或4天/月休4) + 贵/便宜 + 换/改成/试试/月休6天
    const has4Days = /4\s*天|月休\s*4/.test(content);
    const hasPriceWord = /贵|便宜|价高|价格高|有点贵|太贵|不划算|费用高|太高|贵了|贵了点|贵了一些|贵哦|贵呀|贵啊|贵呐/.test(content);
    const has6DaysOrSwitch = /6\s*天|月休\s*6|换\s*月休|改\s*月休|换\s*成|改\s*成|改\s*一下|试试\s*6|想\s*6|想要\s*6|看看\s*6/.test(content);
    return has4Days && hasPriceWord && has6DaysOrSwitch;
  }

  /**
   * 检测客户消息是否为"月休和价格的关系"类高频问题
   * 命中后会被代码强制覆写为短答模板（避免 LLM 输出"城市调整"错答或长版薪资换算）
   */
  private isRestDaysPriceQuestion(content: string): boolean {
    // 客户消息同时含"月休" + "价格/价钱/费用/报价/月薪/工资/薪资" + 任意问句形式
    const hasRest = /月休|休息天数|休假/.test(content);
    const hasPrice = /价格|价钱|费用|报价|贵|便宜|月薪|工资|薪资|收入|多少钱/.test(content);
    const isQuestion = /[？?]/.test(content) || /^(是|有|会|能|怎|什|哪|多少|几)/.test(content) || /(吗|呢|呀|啊|哈|嘛|的|关系|影响|挂钩)/.test(content);
    return hasRest && hasPrice && isQuestion;
  }

  /**
   * 检测客户消息是否为市场价/行情信息询问（不是议价/还价）
   * 用于"市场价有模板时强制按模板答，剥离误加的【转人工】"的护栏
   *
   * 2026-08-15 加固：补"一般市场价是多少"（"一般"在"市场价"前）这类同义变体，
   * 以及"市场价X""什么价位""X 一个月多少钱"等更宽的问法
   */
  private detectMarketPriceQuestion(content: string): boolean {
    const patterns = [
      // 直接含"市场价"任何位置
      /市场价/,
      /行情/,
      /市面上/,
      /参考(一下|价|价格)/,
      // "一般/大概/通常/市面上 + 多少钱/价格"
      /(一般|大概|差不多|通常|一般行情|通常的?|通常情况下?)(多少|几|多少[钱块钱元]?|什么样的?价|什么样的?价位|价位)/,
      // "X 一般 / X 大概 + 多少"（如"住家保姆一般多少钱"）
      /(住家|白班|育儿|护工|菲式|月嫂|钟点|保姆|阿姨).{0,8}(一般|大概|差不多)(多少|几|价|价位)/,
      // "住家保姆多少钱 / 月嫂多少钱 / 育儿嫂价格" —— 必须含钱/块/元/价/位/价格/费用等钱相关词
      /(住家|白班|育儿|护工|菲式|月嫂|钟点|保姆|阿姨).{0,5}(多少钱|多少块|多少元|什么价|什么价位|价位|价格是多少|价格怎么样|费用是多少|费用大概)/,
      // "X 一个月多少钱 / X 月薪多少"
      /(一个月|每月|月薪|月工资|月薪资|月收入|一个月薪)(多少|几|大概多少)/,
      // "多少钱一个月 / 一个月多少钱 / 一个月大概多少"
      /(多少钱|多少块|多少元)(一个月|每月|一个月薪|每个月)/,
      // "现在多少钱 / 现在什么价位"
      /现在(多少|几|什么价|什么价位|价位)/,
    ];
    return patterns.some((p) => p.test(content));
  }

  /**
   * 检测 LLM 输出是否使用了 persona 禁答的"城市调整 + 客服后续给报价"错答模板
   * 2026-08-15 新增：林琳反馈"一般市场价是多少"AI 仍答"价格会根据您所在城市调整，【客服后续会给准确报价】"
   * 这是 OPENING_MESSAGE 的兜底语，persona【流程 C】明示不该用在市场价问题上
   */
  private isWrongPriceTemplate(response: string): boolean {
    // 错答信号：宽松匹配"城市 / 客服后续给报价"系列兜底语
    const wrongSignals = [
      // "根据您所在城市调整 / 根据您所在的城市，价格会...不同"
      /根据.{0,6}所在(的)?城市/,
      /所在(的)?城市.{0,15}(不同|调整|影响|有差异|有(所)?不同)/,
      // "价格会根据城市调整 / 价格会因城市不同"
      /价格(会|将)?根据.{0,8}(城市|地区|区域)/,
      /价格(会|将)?(因|因.{0,4}城市|跟|随着).{0,12}(不同|调整|有差异|有(所)?不同)/,
      // "客服后续给报价 / 客服会给您最终确认"
      /客服(后续|之后|会)(会)?给(您)?(准确|最终|具体|精确)?(报价|确认|价格|答复|回复|沟通)/,
      /客服(后续|之后|会).{0,8}(联系|回复|沟通|对接)/,
      /后续(会|由|交给).{0,8}(客服|人工|专员|顾问).{0,8}(联系|回复|沟通|对接|给到)/,
      /由(我们|人工|客服|专员|顾问).{0,8}(联系|对接|给到|确认|沟通)/,
    ];
    // 命中"城市调整/客服后续给报价"任一错答信号即可
    return wrongSignals.some((p) => p.test(response));
  }

  /**
   * 6.5 市场价护栏的强制覆写模板（v4，2026-08-15 林琳反馈"AI 答得太宽，没针对客户情况"）
   *
   * 设计原则：
   *   - 业务维护的 salary_config 表里只有【住家保姆】的 6 条区间（一/二/三线 × 大/小面积），
   *     所以"有数据"时给住家保姆参考；其他服务类型没数据，老实说"差异较大要看具体需求"
   *   - 按对话中已知的 cityTier + area 精准过滤（v4 新增）：
   *     cityTier+area 都已知 → 1 条；仅 cityTier → 2 条（同一城市 2 个 areaType）；
   *     仅 area → 3 条（同一 areaType 3 个 cityTier）；都没采到 → 6 条（住家保姆默认场景）
   *   - 不报"城市调整/客服后续给准确报价"等 persona 禁答模板
   *   - 删去 v3 末尾"您想了解的是住家保姆，还是其他几类？"反问（"按客户路径来，灵活的聊天"）
   *
   * 三个分支：
   *   1) serviceType=住家保姆 → 按已知 cityTier/area 过滤 cfgList，1/2/3/6 条
   *   2) serviceType 是其他 5 类（白班/月嫂/育儿/护工/菲式/钟点工）→ 说差异大要看具体需求
   *   3) serviceType 未采到 → 按已知 cityTier/area 过滤 cfgList，1/2/3/6 条
   *
   * @param currentRequirement 已采集的需求（含 serviceType）
   * @param serviceCity lead 关联的服务城市（用于查 cityTier）
   * @param historyMessages 对话历史（用于从客户消息中识别面积）
   */
  private async buildMarketPriceCanonical(
    currentRequirement:
      | {
          serviceType?: string | null;
        }
      | null
      | undefined,
    serviceCity?: string | null,
    historyMessages?: Array<{ role: string; content: string }>,
  ): Promise<string> {
    const rawType = currentRequirement?.serviceType?.trim() ?? '';
    const cnType = chineseServiceType(rawType) || rawType;
    const serviceType = cnType;

    // 公共：识别 cityTier + area（用于精准过滤）
    const cityTier = detectCityTier(serviceCity);
    const area = historyMessages ? extractAreaFromHistory(historyMessages) : null;

    // 工具：把 cfgList 按已知 cityTier/area 过滤，返回格式化好的若干行
    const filterCfgList = (cfgList: Array<{
      cityTier: string;
      areaType: string;
      baseLow: number;
      baseHigh: number;
      altLow: number;
      altHigh: number;
    }>): string[] => {
      const order = ['一线', '二线', '三线'];
      const sorted = [...cfgList].sort(
        (a, b) =>
          order.indexOf(a.cityTier) - order.indexOf(b.cityTier) ||
          (a.areaType === '大面积' ? -1 : 1) - (b.areaType === '大面积' ? -1 : 1),
      );
      let filtered = sorted;
      const areaTypeMatches = (cfgAreaType: string, knownArea: '大' | '小') =>
        (knownArea === '大' && cfgAreaType === '大面积') ||
        (knownArea === '小' && cfgAreaType === '小面积');
      if (cityTier && area) {
        // 都已知 → 只 1 条
        filtered = sorted.filter((c) => c.cityTier === cityTier && areaTypeMatches(c.areaType, area));
      } else if (cityTier) {
        // 仅 cityTier → 同城市的 2 个 areaType
        filtered = sorted.filter((c) => c.cityTier === cityTier);
      } else if (area) {
        // 仅 area → 同 areaType 的 3 个 cityTier
        filtered = sorted.filter((c) => areaTypeMatches(c.areaType, area));
      }
      // 过滤后为空（极端情况：salary_config 没数据）→ 退回全部 6 条兜底
      if (filtered.length === 0) filtered = sorted;
      return filtered.map(
        (c) =>
          `• ${c.cityTier}${c.areaType}：${c.baseLow}-${c.baseHigh} 元/月（对阿姨要求不高可尝试 ${c.altLow}-${c.altHigh} 元/月）`,
      );
    };

    // 工具：根据对话场景生成最终文案
    const formatByContext = (
      lines: string[],
      serviceTypeName: string,
    ): string => {
      if (lines.length === 0) {
        return `【${serviceTypeName}】市场价大概在【4500-8500 元/月】区间，具体看城市和房屋面积~`;
      }
      if (lines.length === 1) {
        // cityTier+area 都已知：单句直接给数（去掉项目符号 + 简化措辞）
        const first = lines[0].replace(/^• /, '').replace('：', '参考：');
        return `【${serviceTypeName}】${first}。`;
      }
      // 2/3/6 条：保留项目符号列表
      const header = lines.length === 6
        ? `【${serviceTypeName}】市场价参考：`
        : `【${serviceTypeName}】${cityTier ?? (area === '大' ? '大面积' : '小面积')}参考：`;
      return `${header}\n${lines.join('\n')}`;
    };

    // 分支 1：客户已确认是住家保姆 → 按已知 cityTier/area 过滤
    if (serviceType && (serviceType === '住家保姆' || serviceType.includes('住家'))) {
      const cfgList = await this.salaryConfigService
        .listByServiceType('住家保姆')
        .catch(() => []);
      if (cfgList.length > 0) {
        const lines = filterCfgList(cfgList);
        return formatByContext(lines, '住家保姆');
      }
      // 极端情况：表里没数据，兜底给一个笼统范围
      return '【住家保姆】市场价大概在【4500-8500 元/月】区间，具体看城市（一线会到 8000+，二线 5000-7000，三线 4500-6000）和房屋面积~';
    }

    // 分支 2：客户已确认是其他服务类型（白班保姆/月嫂/育儿保姆/护工/菲式/钟点工）→ 查表给区间
    if (serviceType) {
      const otherTypes = ['白班保姆', '月嫂', '育儿保姆', '育儿嫂', '护工', '菲式', '钟点工'];
      const matched = otherTypes.find(
        (t) => serviceType === t || serviceType.includes(t),
      );
      if (matched) {
        // 育儿嫂 → 育儿保姆（salary_config 表用的是'育儿保姆'）
        const SALARY_TYPE_MAP: Record<string, string> = { '育儿嫂': '育儿保姆' };
        const salaryType = SALARY_TYPE_MAP[matched] ?? matched;
        const cfgList = await this.salaryConfigService
          .listByServiceType(salaryType)
          .catch(() => []);
        if (cfgList.length > 0) {
          const order = ['一线', '二线', '三线', '二三线'];
          const sorted = [...cfgList].sort(
            (a, b) => order.indexOf(a.cityTier) - order.indexOf(b.cityTier),
          );
          const lines = sorted.map(
            (c) =>
              c.subDimension
                ? `• ${c.cityTier} ${c.subDimension}：${c.baseLow}-${c.baseHigh} 元/月${c.altLow > 0 ? `（要求不高可尝试 ${c.altLow}-${c.altHigh} 元/月）` : ''}`
                : `• ${c.cityTier}：${c.baseLow}-${c.baseHigh} 元/月${c.altLow > 0 ? `（要求不高可尝试 ${c.altLow}-${c.altHigh} 元/月）` : ''}`,
          );
          return `【${matched}】市场价参考：\n${lines.join('\n')}\n具体看您所在城市和具体需求，需要更精准的话告诉我更多细节~`;
        }
        return `【${matched}】价格差异较大，要看具体需求（工作制 / 月子天数 / 宝宝月龄 / 老人身体状况 / 是否带睡 等）才能报参考区间。您方便说一下具体需求吗？`;
      }
    }

    // 分支 3：serviceType 未采到 → 给住家保姆参考（业务最常见），按已知 cityTier/area 过滤
    // 不再末尾加"您想了解的是住家保姆，还是其他几类？"反问（v4 删）
    const cfgList = await this.salaryConfigService
      .listByServiceType('住家保姆')
      .catch(() => []);
    if (cfgList.length > 0) {
      const lines = filterCfgList(cfgList);
      return formatByContext(lines, '住家保姆');
    }
    return '【住家保姆】市场价大概在【4500-8500 元/月】区间，具体看城市和房屋面积~';
  }

  /**
   * 轻量级实时字段检测：从最近对话中用正则提取已答字段
   * 避免因 AI 提取失败导致 guidance prompt 信息过期
   */
  private detectFieldsFromConversation(
    messages: typeof chatMessages.$inferSelect[],
  ): Map<string, string | number> {
    const updates = new Map<string, string | number>();
    const recentCustomerMsgs = messages
      .filter((m) => m.role === 'customer')
      .slice(-8)
      .map((m) => m.content);
    const text = recentCustomerMsgs.join('\n');
    this.logger.log(`实时字段检测扫描文本: ${text.slice(0, 100)}`);

    const lastBotMsg = [...messages].reverse().find((m) => m.role === 'bot');
    const lastCustomerMsg = recentCustomerMsgs[recentCustomerMsgs.length - 1];
    // 放宽：允许带语气词（哦/呢/呀/啊/哈/啦/吧/咯/嗯/噢）、标点、轻微修饰（真的/真的不需要/真的不用）
    // 例："不需要哦" / "不用了谢谢" / "暂时不需要呢" / "没有啦" / "不要了哈" / "不需要照顾"（带尾巴词）
    const isNegativeReply = (msg: string): boolean => {
      const t = msg.trim();
      if (/^(不需要|不用|没有|暂不|暂时不需要|不用了|不要|没有了)\s*[。！!~～,，。 ]?$/.test(t)) return true;
      if (/^(不需要|不用|没有|暂不|暂时不需要|不用了|不要|没有了)[哦呢呀啊哈啦吧咯嗯噢喔诶]\s*[。！!~～,。]?$/.test(t)) return true;
      if (/^(真的|那|那就不|好吧?)[，,]?\s*(不需要|不用|没有|不要)/.test(t)) return true;
      return false;
    };

    if (lastBotMsg && lastCustomerMsg && isNegativeReply(lastCustomerMsg)) {
      const botQ = lastBotMsg.content;
      if (/老人|照护|陪护/.test(botQ)) {
        updates.set('elderlyCare', '不需要老人照护');
      }
    }

    const householdMatch = text.match(/([\d一二三四五六七八九十两]+)\s*口/);
    if (householdMatch) updates.set('householdSize', householdMatch[1] + '口');

    const areaMatch = text.match(/([\d一二三四五六七八九十百]+)\s*平/);
    if (areaMatch) updates.set('area', areaMatch[1] + '平');

    // 老人照护（2026-08-15 增强版，林琳反馈"老人照护问了但没记录"）
    // 旧版只覆盖：
    //   a) 客户短答"不需要/不用/没有/不要" + bot 上一条问过老人/照护/陪护 → "不需要老人照护"
    //   b) 客户提到"老人/父母/爷爷/奶奶/外婆/外公" + 年龄数字 → 抓出整段
    // 漏掉：
    //   c) 客户答"有老人需要照护"（无年龄）→ 漏
    //   d) 客户答"是的"+"有"（肯定）→ 漏
    //   e) 客户说"家里有老人"但没年龄 → 漏
    //   f) negative 词扩展："暂时不用" / "不用照顾" / "家里没有" 等旧版不识别
    // 修法：分三路判断（negative → positive 无年龄 → positive 有年龄），negative 词扩展
    const negativeRe = /(不需要|不用|没有|暂不|暂时不用|暂时不需要|不要|不用了|没有了|不用照顾|不用照护|不需要照顾|不需要照护|不用陪护|不需要陪护|家里没有|无老人|没老人|没有老人|不需要人|不需要老人)/;
    const positiveRe = /(有老人|需要照护|需要照顾|需要陪护|要照顾|要照护|要陪护|有长辈|家里有老人|家里有长辈|需要人照顾|需要人照护|要人照顾|要人照护|需要人陪)/;
    const elderlyContextRe = /老人|照护|陪护|长辈|父母/;

    if (negativeRe.test(text) && (elderlyContextRe.test(text) || (lastBotMsg && elderlyContextRe.test(lastBotMsg.content)))) {
      updates.set('elderlyCare', '不需要老人照护');
    } else if (positiveRe.test(text)) {
      // 客户明确说"有老人需要照护"等 → 设为 positive
      updates.set('elderlyCare', '有老人需要照护');
    } else if (lastBotMsg && elderlyContextRe.test(lastBotMsg.content) && /^(有|是的?|对|嗯|哦|要|需要|好|是)$/.test(lastCustomerMsg.trim())) {
      // bot 上一条问过老人/照护 + 客户短答"有"/"是的"/"对"/"嗯"/"要"等 → positive
      updates.set('elderlyCare', '有老人需要照护');
    } else {
      // 旧版：老人 + 年龄
      const elderlyMatch = text.match(/(?:老人|父母|爷爷|奶奶|外婆|外公|长辈)[^\n]{0,8}?(\d+\s*岁|八十|七十|六十|九十|八十多岁|七十多岁|六十多岁|九十多岁)/);
      if (elderlyMatch) updates.set('elderlyCare', elderlyMatch[0]);
    }

    // 休息天数
    if (/没有休息|不休息|无休|无月休|无休息|不休|不休假|没有月休/.test(text)) {
      updates.set('restDays', '无月休');
    } else {
      const restMatch = text.match(/月休\s*[\d一二三四五六七八九十两]+\s*天|[\d一二三四五六七八九十两]+\s*天休息|休息\s*[\d一二三四五六七八九十两]+\s*天/);
      if (restMatch) updates.set('restDays', restMatch[0]);
    }

    // 到岗时间
    const startTimePatterns = [
      /(?:到岗|上班|上岗|开始|入职)\s*(?:时间|日期)?[^\n]{0,6}?([^，。\n]{1,20}?)/,
      /(?:一周内|一个礼拜|这周|下周|马上|尽快|随时|几号|哪天)[前后左右]?[都就可以]*/,
    ];
    const startTimeMatch = text.match(/(?:一周之内|一周内|马上|尽快|随时|下个月|这月|下月|下周|这周|几号以后|\d+\s*月\s*\d+\s*号)[^，。\n]{0,4}/);
    if (startTimeMatch) updates.set('startTime', startTimeMatch[0].trim());

    // 服务地址：优先匹配含城市名的完整地址，其次匹配单独的区/街道
    const addrMatch = text.match(/(?:北京市|上海市|广州市|深圳市|杭州市)[^，。\n]{0,15}?(?:区|街道|路|号)/);
    if (addrMatch) {
      updates.set('serviceAddress', addrMatch[0].trim());
    } else {
      const districtMatch = text.match(/([\u4e00-\u9fa5]{2,6}(?:区|街道|镇|路\d*号?))/);
      if (districtMatch) updates.set('serviceAddress', districtMatch[0].trim());
    }

    // 阿姨要求
    const helperKeywords = ['做饭好吃', '勤快', '干净', '爱干净', '经验丰富', '年轻', '脾气好', '有耐心', '干活麻利', '老实', '人品好', '有经验'];
    const helperReqList: string[] = helperKeywords.filter((kw: string) => text.includes(kw));
    if (helperReqList.length > 0) updates.set('helperRequirements', helperReqList.join('、'));

    // 薪资预算（2026-08-15 增强版，林琳反馈"6000的吧"没采到）
    // 客户口语习惯多样：6000吧、6000的吧、6000左右、大概6000、6000-7000、6000到7000元、6000块、6000元/月
    const budgetPatterns: RegExp[] = [
      // 区间+单位：6000-7000元 / 6000到7000块 / 6000~7000
      /(\d{4,5})\s*[-~～—到至]\s*(\d{4,5})\s*[元块]?/,
      // 数字+单位：6000元 / 6000块 / 6000元/月
      /(\d{4,5})\s*[元块](\s*\/\s*月)?/,
      // 数字+左右/上下：6000左右 / 6000上下
      /(\d{4,5})\s*(?:左右|上下|多|来)/,
      // 数字+的+吧（口语连用，优先匹配）：6000的吧
      /(\d{4,5})\s*的\s*吧(?=\s|$|[，。!！?？~～\n,])/,
      // 数字+吧（单语气词）：6000吧
      /(\d{4,5})\s*吧(?=\s|$|[，。!！?？~～\n,])/,
      // 大概/差不多/估计/约+数字：大概6000 / 差不多6000 / 预算是6000
      /(?:大概|差不多|估计|约|大概预算|预算是?|价位是?|月薪是?)\s*(\d{4,5})\s*[元块]?/,
    ];
    for (const pattern of budgetPatterns) {
      const m = text.match(pattern);
      if (m) {
        // 2026-09-05：budget 列改 integer——匹配原文（如"6000吧""6000-7000元"）解析成数字再入库（区间取下限）
        const budgetNum = parseBudgetNumber(m[0]);
        if (budgetNum != null) {
          updates.set('budget', budgetNum);
        }
        break;
      }
    }

    // 工作模式（24 小时住家 / 8 小时白班）— yuer/yanglao/feishi 服务类型必填
    if (/24\s*小时|二十四小时|全天|住家|整月|整月住家/.test(text)) {
      updates.set('workMode', '24小时住家');
    } else if (/8\s*小时|八小时|白班|非住家|不住家|仅白天|白天班|白班制/.test(text)) {
      updates.set('workMode', '8小时白班');
    }

    return updates;
  }

  /**
   * 将实时检测到的字段合并到 requirements 表（不覆盖已有值）
   *
   * 2026-08-15 第二次修复：改用 INSERT ... ON CONFLICT (lead_id) DO UPDATE 走 anon 合法路径。
   * 背景：第一次修复（SET LOCAL app.user_id='system-bot' + UPDATE 事务）压测 50 条对话 0/50 入库。
   *       根因查清：RLS 策略只给 anon 配了 INSERT 政策（匿名创建需求 with_check=true），
   *       没有任何 UPDATE 政策——UPDATE 静默 0 行。
   *       解法：先在 requirements 表加 UNIQUE(lead_id) 约束，然后用 ON CONFLICT DO UPDATE
   *       走 INSERT 路径，WITH CHECK=true 永远 pass。COALESCE(requirements.X, EXCLUDED.X)
   *       保留"只填空不覆盖"语义。
   */
  private async mergeRequirementFields(
    leadId: string,
    existing: Requirement | null,
    updates: Map<string, string | number>,
  ): Promise<void> {
    if (updates.size === 0) return;

    // 字段映射：camelCase (TS) → snake_case (DB)
    const COL_MAP: Array<[string, string]> = [
      ['householdSize', 'household_size'],
      ['area', 'area'],
      ['elderlyCare', 'elderly_care'],
      ['restDays', 'rest_days'],
      ['startTime', 'start_time'],
      ['serviceAddress', 'service_address'],
      ['helperRequirements', 'helper_requirements'],
      ['budget', 'budget'],
      ['workMode', 'work_mode'],
    ];

    const insertCols: SQL[] = [sql`lead_id`];
    const insertVals: SQL[] = [sql`${leadId}`];
    const updateParts: SQL[] = [];

    for (const [camel, snake] of COL_MAP) {
      if (updates.has(camel)) {
        const val = updates.get(camel)!;
        insertCols.push(sql`${sql.raw(snake)}`);
        insertVals.push(sql`${val}`);
        // 2026-08-15 第三次修复：COALESCE + NULLIF 兜底空字符串。
        // 原写法 COALESCE(requirements.X, EXCLUDED.X) 看似 requirements 优先保留老值，
        // 但如果老值是 ''（之前 ON CONFLICT 把空串钉进去了），COALESCE 不会触发 EXCLUDED 覆盖。
        // NULLIF(requirements.X, '') 把 '' 转成 NULL，COALESCE 才会落到 EXCLUDED.X。
        // 2026-09-05 例外：budget 已是 integer 列，NULLIF(X, '') 会因 integer=text 无隐式转换而报错，
        // 且 integer 列不存在"空串钉住"问题，直接 COALESCE 即可（老值优先，只填空不覆盖）。
        if (snake === 'budget') {
          updateParts.push(
            sql`${sql.raw(snake)} = COALESCE(requirements.${sql.raw(snake)}, EXCLUDED.${sql.raw(snake)})`,
          );
        } else {
          updateParts.push(
            sql`${sql.raw(snake)} = COALESCE(NULLIF(requirements.${sql.raw(snake)}, ''), EXCLUDED.${sql.raw(snake)})`,
          );
        }
      }
    }

    if (insertCols.length === 1) return;

    this.logger.log(
      `合并需求字段: ${updates.size} 个 lead=${leadId.slice(0, 8)} fields=${[...updates.keys()].join(',')}`,
    );

    try {
      const result = await this.db.execute(
        sql`INSERT INTO requirements (${sql.join(insertCols, sql`, `)}, status) VALUES (${sql.join(insertVals, sql`, `)}, 'collecting') ON CONFLICT (lead_id) DO UPDATE SET ${sql.join(updateParts, sql`, `)} RETURNING id`,
      );
      const rowCount = Array.isArray(result)
        ? result.length
        : result && typeof (result as { count?: number }).count === 'number'
          ? (result as { count: number }).count
          : -1;
      this.logger.log(`需求字段合并完成 (UPSERT) lead=${leadId.slice(0, 8)} rowCount=${rowCount}`);
    } catch (err) {
      this.logger.error(
        `mergeRequirementFields 异常 lead=${leadId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      // 不重抛：字段落库失败不应该阻塞对话主流程（LLM 仍能基于已收集信息回复）
    }
  }

  /**
   * 将 requirement 摘要为字符串供 AI 使用
   */
  private summarizeRequirement(req: Requirement | null): string {
    if (!req) return '暂无已收集的需求信息';
    const parts: string[] = [];
    if (req.serviceType) parts.push(`服务类型: ${req.serviceType}`);
    if (req.householdSize) parts.push(`家庭人数: ${req.householdSize}`);
    if (req.area) parts.push(`面积: ${req.area}`);
    if (req.elderlyCare) parts.push(`老人照护: ${req.elderlyCare}`);
    if (req.restDays) parts.push(`休息天数: ${req.restDays}`);
    if (req.startTime) parts.push(`到岗时间: ${req.startTime}`);
    if (req.serviceAddress) parts.push(`服务地址: ${req.serviceAddress}`);
    if (req.helperRequirements)
      parts.push(`阿姨要求: ${req.helperRequirements}`);
    if (req.dietaryPreferences)
      parts.push(`做饭口味: ${req.dietaryPreferences}`);
    if (req.budget) parts.push(`预算: ${req.budget}元`);
    return parts.length > 0 ? parts.join('; ') : '暂无已收集的需求信息';
  }

  // ============ 类型映射 ============

  private mapLead(row: typeof leads.$inferSelect): Lead {
    return {
      id: row.id,
      serviceCity: sanitizeCity(row.serviceCity),
      phoneNumber: row.phoneNumber,
      customerName: row.customerName,
      source: normalizeSource(row.source) as Lead['source'],
      status: row.status as Lead['status'],
      chatToken: row.chatToken,
      assigneeId: row.assigneeId,
      bitableRecordId: row.bitableRecordId,
      assignedAt: row.assignedAt ? row.assignedAt.toISOString() : null,
      lastFollowedUpAt: row.lastFollowedUpAt ? row.lastFollowedUpAt.toISOString() : null,
      intent: row.intent,
      routingReason: row.routingReason,
      leadGrade: row.leadGrade,
      leadScore: row.leadScore ? Number(row.leadScore) : null,
      gradeReason: row.gradeReason,
      gradeConfidence: row.gradeConfidence ? Number(row.gradeConfidence) : null,
      budgetRange: row.budgetRange,
      serviceStartTime: row.serviceStartTime,
      serviceDuration: row.serviceDuration,
      specialRequirements: row.specialRequirements,
      familyInfo: row.familyInfo,
      urgencyLevel: row.urgencyLevel,
      phoneVerified: row.phoneVerified,
      leadSourceDetail: row.leadSourceDetail,
      channel: row.channel as Lead['channel'],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapSession(row: typeof chatSessions.$inferSelect): ChatSession {
    return {
      id: row.id,
      leadId: row.leadId,
      status: row.status as ChatSession['status'],
      mode: (row.mode ?? 'ai') as ChatSessionMode,
      transferReason: row.transferReason ?? null,
      transferredBy: (row.transferredBy ?? null) as TransferSource | null,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role as ChatMessage['role'],
      content: row.content,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async getCollectionProgress(sessionId: string): Promise<CollectionProgress> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }
    const leadId = sessionRows[0].leadId;
    const requirement = await this.getRequirementByLeadId(leadId);
    return this.requirementCollectionService.getCollectionProgress(
      requirement,
      requirement?.serviceType ?? null,
    );
  }

  private mapRequirement(
    row: typeof requirements.$inferSelect,
  ): Requirement {
    return {
      id: row.id,
      leadId: row.leadId,
      serviceType: row.serviceType,
      householdSize: row.householdSize,
      area: row.area,
      elderlyCare: row.elderlyCare,
      restDays: row.restDays,
      startTime: row.startTime,
      serviceAddress: row.serviceAddress,
      helperRequirements: row.helperRequirements,
      dietaryPreferences: row.dietaryPreferences,
      budget: row.budget,
      serviceDuration: row.serviceDuration,
      livingPreference: row.livingPreference,
      specialRequirements: row.specialRequirements,
      familyInfo: row.familyInfo,
      workMode: row.workMode,
      collectedFields: Array.isArray(row.collectedFields) ? row.collectedFields as { field: string; value: string; label: string }[] : [],
      aiSummary: row.aiSummary,
      status: row.status as RequirementStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ============================================================
  // 2026-08-15 客服新线索分配通知（接通 notify service + 实时推送）
  // 由 routing.service.ts 在 retryPendingAssignmentsForAgent 抢单成功后调用
  // ============================================================

  /**
   * 客服新线索分配：飞书 IM 卡片 + SSE 实时推送 + 列表角标
   * @param assigneeId 客服 userId
   * @param lead 已分配的 lead（必含 chatSession，便于 SSE event 携带）
   */
  async notifyAgentOfNewAssignment(
    assigneeId: string,
    leadId: string,
  ): Promise<void> {
    // 1. 取 lead 详情 + session
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (leadRows.length === 0) {
      this.logger.warn(`notifyAgentOfNewAssignment: lead=${leadId} 不存在`);
      return;
    }
    const lead = this.mapLead(leadRows[0]);

    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);
    if (sessionRows.length === 0) {
      this.logger.warn(`notifyAgentOfNewAssignment: lead=${leadId} 没有 session`);
      return;
    }
    const session = this.mapSession(sessionRows[0]);

    // 2. 飞书 IM 通知（不发到运营群，直接发到客服个人 userId）
    await this.notifyService
      .notifyAgentNewLead(assigneeId, lead, session)
      .catch((err) =>
        this.logger.warn(
          `notifyAgentNewLead 失败 agent=${assigneeId} lead=${leadId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    // 3. SSE 实时推送（客服工作台列表自动刷新 + 弹 toast）
    this.chatEventBus.emitToUser(assigneeId, {
      type: 'session.created',
      session,
    });
    this.logger.log(
      `notifyAgentOfNewAssignment: agent=${assigneeId} lead=${leadId} IM 通知 + SSE 推送已发`,
    );
  }
}
