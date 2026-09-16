import { Injectable, Inject, Logger, NotFoundException, ConflictException, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase, CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, count, isNotNull, isNull, sql, inArray } from 'drizzle-orm';
import { leads, agentSkills, chatSessions, chatMessages, requirements, agentOnlineStatus, serviceOrders, agents } from '@server/database/schema';
import { AiConfigService } from '../admin/ai-config.service';
import { SchemaMigrationService } from '../migration/schema-migration.service';
import { normalizeStream } from '../chat/stream-utils';
import { ChatService } from '../chat/chat.service';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentSkillsSyncService } from '../agents/agent-skills-sync.service';
import {
  AI_REPLY_PLUGIN_ID,
  AI_REPLY_ACTION_KEY,
  INTENT_CLASSIFICATION_PROMPT,
  C1_EMOTION_PROMPT,
  SKILL_TAG_MAP,
  INTENT_SKILL_MAP,
} from '../chat/chat.prompt';
import type {
  AgentSkill,
  AgentWorkload,
  AgentOnlineStatus,
  AgentOnlineState,
  CreateAgentSkillRequest,
  UpdateAgentSkillRequest,
  IntentClassification,
  IntentType,
  UrgencyLevel,
  RoutingResult,
} from '@shared/api.interface';

const VALID_INTENTS: IntentType[] = [
  'urgent_complaint',
  'service_inquiry',
  'price_inquiry',
  'booking',
  'after_sale',
  'general',
];

const VALID_URGENCIES: UrgencyLevel[] = ['high', 'medium', 'low'];

const ONLINE_TIMEOUT_MINUTES = 5;

const GRADE_POOL_STATUS: Record<string, string> = {
  B_PRICE: 'nurturing',
  D: 'filtered',
};

const GRADE_POOL_LABEL: Record<string, string> = {
  B_PRICE: '培育池',
  D: '过滤',
};

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
    private readonly aiConfigService: AiConfigService,
    private readonly schemaMigration: SchemaMigrationService,
    @Inject(forwardRef(() => ChatService))
    private readonly chatService: ChatService,
    private readonly agentDispatchService: AgentDispatchService,
    private readonly agentSkillsSync: AgentSkillsSyncService,
  ) {}

  // ============ 意图分类 ============

  async classifyIntent(content: string): Promise<IntentClassification | null> {
    let fullResponse = '';
    try {
      const aiReplyPluginId = await this.aiConfigService.getConfigWithDefault(
        'ai_reply_plugin_id',
        AI_REPLY_PLUGIN_ID,
      );
      const streamResult = await this.capabilityService
        .load(aiReplyPluginId)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona: INTENT_CLASSIFICATION_PROMPT,
          conversation_history: '（无，仅根据本条消息分类）',
          collected_requirements: '（无）',
          latest_customer_message: content,
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
        `意图分类 AI 调用失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }

    return this.parseIntentResponse(fullResponse);
  }

  private parseIntentResponse(text: string): IntentClassification | null {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn(`意图分类未匹配到 JSON: ${text.slice(0, 200)}`);
      return null;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        intent?: string;
        urgency?: string;
        category?: string;
        suggested_skill?: string;
      };

      const intent = VALID_INTENTS.includes(parsed.intent as IntentType)
        ? (parsed.intent as IntentType)
        : 'general';
      const urgency = VALID_URGENCIES.includes(parsed.urgency as UrgencyLevel)
        ? (parsed.urgency as UrgencyLevel)
        : 'low';

      return {
        intent,
        urgency,
        category: parsed.category ?? '',
        suggestedSkill: parsed.suggested_skill ?? '通用咨询',
      };
    } catch {
      this.logger.warn(`意图分类 JSON 解析失败: ${text.slice(0, 200)}`);
      return null;
    }
  }

  // ============ C1 情绪分级 ============

  async classifyC1Emotion(content: string): Promise<{ level: 'high' | 'medium'; reason: string } | null> {
    let fullResponse = '';
    try {
      const aiReplyPluginId = await this.aiConfigService.getConfigWithDefault(
        'ai_reply_plugin_id',
        AI_REPLY_PLUGIN_ID,
      );
      const streamResult = await this.capabilityService
        .load(aiReplyPluginId)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona: C1_EMOTION_PROMPT,
          conversation_history: '（无，仅根据本条消息判断）',
          collected_requirements: '（无）',
          latest_customer_message: content,
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
        `C1情绪分类 AI 调用失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }

    return this.parseEmotionResponse(fullResponse);
  }

  private parseEmotionResponse(text: string): { level: 'high' | 'medium'; reason: string } | null {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger.warn(`C1情绪分类未匹配到 JSON: ${text.slice(0, 200)}`);
      return null;
    }
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { emotion?: string; reason?: string };
      if (parsed.emotion !== 'high' && parsed.emotion !== 'medium') {
        this.logger.warn(`C1情绪分类非法 emotion: ${String(parsed.emotion)}`);
        return null;
      }
      return { level: parsed.emotion, reason: parsed.reason ?? '' };
    } catch {
      this.logger.warn(`C1情绪分类 JSON 解析失败: ${text.slice(0, 200)}`);
      return null;
    }
  }

  // ============ 路由分配 ============

  /**
   * @deprecated 2026-08-28 旧智能路由，已由 AgentDispatchService.assignLead 取代（转人工/采集完成/分级变更/转接四个入口均已切换）。保留仅供回滚，验证跑通后清理。
   */
  async routeLead(leadId: string, firstMessage?: string): Promise<RoutingResult> {
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException(`线索 ${leadId} 不存在`);
    }

    const lead = leadRows[0];

    const grade = lead.leadGrade;
    if (grade && grade in GRADE_POOL_STATUS) {
      const reason = `${grade}级线索不分配人工`;
      await this.db
        .update(leads)
        .set({ routingReason: reason })
        .where(eq(leads.id, leadId));
      return {
        assigneeId: null,
        intent: null,
        urgency: null,
        routingReason: reason,
        autoTransferred: false,
        priorityLevel: 'skip',
      };
    }

    if (grade === 'C2') {
      const reason = 'C2级待采集，AI继续采集，不分配人工';
      await this.db
        .update(leads)
        .set({ routingReason: reason })
        .where(eq(leads.id, leadId));
      return {
        assigneeId: null,
        intent: null,
        urgency: null,
        routingReason: reason,
        autoTransferred: false,
        priorityLevel: 'skip',
      };
    }

    const { skill: targetSkill, intent } = await this.determineSkill(leadId, lead, firstMessage);
    const isPriority = grade === 'A'
      || (grade === 'C1' && lead.urgencyLevel === 'high');
    return this.selectAndAssign(lead, targetSkill, intent, isPriority);
  }

  /** @deprecated 同 routeLead，保留仅供回滚 */
  async reRouteLead(leadId: string): Promise<RoutingResult> {
    return this.routeLead(leadId);
  }

  // ============ 2026-08-14 避免"无人管"3 层 - 第 2 层任务卡 ============

  /**
   * 经纪人接单时获取结构化任务卡。
   * 包含客户基本信息 + 需求摘要 + AI 推荐话术 + 客户等待时长。
   */
  async getLeadTaskCard(leadId: string) {
    const [lead] = await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) throw new NotFoundException(`Lead ${leadId} not found`);

    // 拉取需求摘要
    const reqs = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.leadId, leadId))
      .limit(1);
    const req = reqs[0];

    // 拉取最近客户消息
    const recentMessages = await this.db
      .select()
      .from(chatSessions)
      .leftJoin(chatMessages, eq(chatMessages.sessionId, chatSessions.id))
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(sql`${chatMessages.createdAt} DESC`)
      .limit(5);

    const lastCustomerMessage =
      recentMessages.find((m) => m.chat_messages?.role === 'customer')?.chat_messages?.content ??
      '';

    // 客户等待时长（秒）
    const waitSeconds = lead.assignedAt
      ? Math.floor((Date.now() - new Date(lead.assignedAt).getTime()) / 1000)
      : 0;

    // 按 B 子类生成推荐话术
    const bSubtype = lead.intent ?? '';
    const recommendedScripts = this.buildRecommendedScripts(bSubtype, lead);

    return {
      leadId: lead.id,
      leadGrade: lead.leadGrade,
      escalated: lead.escalatedToSupervisor ?? false,
      customer: {
        name: lead.customerName ?? '未填',
        phone: lead.phoneNumber,
        city: lead.serviceCity,
        channel: lead.channel,
        source: lead.source,
      },
      requirements: req
        ? {
            serviceType: req.serviceType,
            elderlyCare: req.elderlyCare,
            householdSize: req.householdSize,
            restDays: req.restDays,
            startTime: req.startTime,
            serviceAddress: req.serviceAddress,
            budget: req.budget,
          }
        : null,
      // ===== 2026-08-14 AI 辅助经纪人 3 层 - 第 1 层客户画像 =====
      // 需求摘要按"原本的形式"呈现：进度条 + 字段列表（已采集打勾，未采集空圈）
      requirementProgress: this.buildRequirementProgress(req),
      // ====================================================
      routing: {
        reason: lead.routingReason,
        assignedAt: lead.assignedAt?.toISOString() ?? null,
        waitSeconds,
        attempts: lead.routingAttempts ?? 0,
      },
      lastCustomerMessage,
      recommendedScripts,
      urgency:
        lead.urgencyLevel === 'urgent'
          ? '🔥 紧急'
          : lead.urgencyLevel === 'soon'
            ? '⏰ 较急'
            : '普通',
    };
  }

  private buildRecommendedScripts(
    bSubtype: string,
    lead: typeof leads.$inferSelect,
  ): string[] {
    const base: string[] = [];
    if (bSubtype.includes('price') || bSubtype.includes('B-price')) {
      base.push('议价方向 1：月休 6→8 天，单价便宜 8%');
      base.push('议价方向 2：住家改白班，便宜 10-15%');
      base.push('议价方向 3：续约优惠，第 3 月 95 折，第 6 月 9 折');
      base.push('议价方向 4：服务时长 26→42 天，总价便宜 35%');
    } else if (bSubtype.includes('quality') || bSubtype.includes('B-quality')) {
      base.push('3 个匹配简历（同价位 + 同档期 + 同区域）');
      base.push('24h 内推送给客户');
    } else if (bSubtype.includes('time') || bSubtype.includes('B-time')) {
      base.push('最近 7 天档期预约方案');
      base.push('1h 内回复客户');
    } else if (bSubtype.includes('pace') || bSubtype.includes('B-pace')) {
      base.push('3 个真实客户案例故事（同地区 + 同需求 + 已签约）');
      base.push('1h 内回复客户');
    } else if (bSubtype.includes('trust') || bSubtype.includes('B-trust')) {
      base.push('公司资质 + 合同模板 + 第三方评价');
      base.push('1h 内回复客户');
    } else {
      base.push('1 分钟内先发"收到"，让客户知道有人在跟进');
      base.push('查看最近 3 轮对话，定位客户关心点');
    }
    return base;
  }

  /**
   * 2026-08-14 AI 辅助经纪人 3 层 - 第 1 层
   * 需求摘要按"原本的形式"呈现：进度条 + 字段列表（已采集打勾，未采集空圈）
   * 数据结构对齐 client/src/pages/ChatSessionsPage/ContextPanel.tsx 的渲染
   */
  private buildRequirementProgress(req: typeof requirements.$inferSelect | undefined) {
    const fields = [
      { field: 'serviceType', label: '服务类型', value: req?.serviceType, required: true },
      { field: 'householdSize', label: '房屋面积', value: req?.householdSize, required: false },
      { field: 'elderlyCare', label: '老人照护', value: req?.elderlyCare, required: false },
      { field: 'restDays', label: '休息天数', value: req?.restDays, required: true },
      { field: 'startTime', label: '到岗时间', value: req?.startTime, required: true },
      { field: 'serviceAddress', label: '服务地址', value: req?.serviceAddress, required: true },
      { field: 'helperRequirements', label: '阿姨要求', value: req?.helperRequirements, required: false },
      { field: 'dietaryPreferences', label: '做饭口味', value: req?.dietaryPreferences, required: false },
      { field: 'budget', label: '薪资预算', value: req?.budget, required: true },
    ];

    const items = fields.map((f) => ({
      field: f.field,
      label: f.label,
      required: f.required,
      collected: !!f.value,
      value: f.value ?? null,
    }));

    const collectedCount = items.filter((i) => i.collected).length;
    const totalCount = items.length;
    const percent = totalCount === 0 ? 0 : Math.round((collectedCount / totalCount) * 100);
    const requiredCount = items.filter((i) => i.required).length;
    const requiredCollected = items.filter((i) => i.required && i.collected).length;
    const requiredComplete = requiredCount > 0 && requiredCollected >= requiredCount;

    return {
      serviceTypeLabel: req?.serviceType ?? '未识别',
      collectedCount,
      totalCount,
      requiredCount,
      requiredCollected,
      requiredComplete,
      percent,
      items,
      status: requiredComplete ? 'completed' : 'collecting',
    };
  }

  // ============ 分级驱动路由 ============

  async handleGradeChange(
    leadId: string,
    oldGrade: string | null,
    newGrade: string,
  ): Promise<void> {
    this.logger.log(`线索 ${leadId} 分级变更: ${oldGrade ?? 'null'} → ${newGrade}`);

    if (newGrade === 'A') {
      await this.agentDispatchService.assignLead(leadId, '分级升A派单');
      return;
    }

    if (newGrade === 'B' || newGrade === 'C1') {
      const [lead] = await this.db
        .select()
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (!lead) return;
      if (!lead.assigneeId) {
        if (['nurturing', 'recycled', 'filtered'].includes(lead.status)) {
          await this.db
            .update(leads)
            .set({ status: 'chatting' })
            .where(eq(leads.id, leadId));
        }
        await this.agentDispatchService.assignLead(leadId, '分级变更派单');
      } else if (['nurturing', 'recycled', 'filtered'].includes(lead.status)) {
        await this.db
          .update(leads)
          .set({ status: 'chatting' })
          .where(eq(leads.id, leadId));
      }
      return;
    }

    if (newGrade === 'C2') {
      return;
    }

    const poolStatus = GRADE_POOL_STATUS[newGrade];
    if (poolStatus) {
      const label = GRADE_POOL_LABEL[newGrade];
      await this.agentDispatchService.moveToPool(
        leadId,
        poolStatus,
        `${newGrade}级线索进入${label}`,
      );
      this.logger.log(`线索 ${leadId} 进入${label}`);
    }
  }

  /** @deprecated 旧 A 级加权分配，已由新派单服务取代，保留仅供回滚 */
  async assignWithPriority(leadId: string): Promise<RoutingResult> {
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException(`线索 ${leadId} 不存在`);
    }

    const lead = leadRows[0];
    const { skill: targetSkill } = await this.determineSkill(leadId, lead);
    return this.selectAndAssign(lead, targetSkill, null, true);
  }

  /** @deprecated 旧转人工加权分配，已由新派单服务取代，保留仅供回滚 */
  async assignForHuman(leadId: string, reason: string): Promise<RoutingResult> {
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException(`线索 ${leadId} 不存在`);
    }

    const lead = leadRows[0];
    const { skill: targetSkill } = await this.determineSkill(leadId, lead);
    const isPriority = lead.leadGrade === 'A';
    const result = await this.selectAndAssign(lead, targetSkill, null, isPriority);
    if (result.routingReason) {
      result.routingReason = `转人工:${reason}→${result.routingReason}`;
    }
    return result;
  }

  // ============ 核心分配逻辑 ============

  private async determineSkill(
    leadId: string,
    lead: typeof leads.$inferSelect,
    firstMessage?: string,
  ): Promise<{ skill: string | null; intent: IntentClassification | null }> {
    // 一次性数据迁移：老 skillTag → 新 skillTag。in-memory flag 短路，不影响延迟。
    void this.schemaMigration.ensureAgentSkillsTagMigration();

    let intent: IntentClassification | null = null;
    let targetSkill: string | null = null;

    if (firstMessage) {
      intent = await this.classifyIntent(firstMessage);
      if (intent) {
        targetSkill = intent.suggestedSkill;
      }
    }

    if (!targetSkill) {
      const reqRows = await this.db
        .select()
        .from(requirements)
        .where(eq(requirements.leadId, leadId))
        .limit(1);

      if (reqRows.length > 0 && reqRows[0].serviceType) {
        targetSkill = SKILL_TAG_MAP[reqRows[0].serviceType] ?? null;
      }
    }

    if (!targetSkill && intent) {
      targetSkill = INTENT_SKILL_MAP[intent.intent] ?? null;
    }

    return { skill: targetSkill, intent };
  }

  private async selectAndAssign(
    lead: typeof leads.$inferSelect,
    targetSkill: string | null,
    intent: IntentClassification | null,
    isPriority: boolean,
  ): Promise<RoutingResult> {
    let { candidates, matchLevels } = await this.get2DCandidates(lead, targetSkill);

    if (candidates.length === 0) {
      const reasonParts: string[] = [];
      if (intent) reasonParts.push(`AI意图:${intent.category}`);
      reasonParts.push('无可用专员，未分配');
      const reason = reasonParts.join('→');
      await this.db
        .update(leads)
        .set({
          intent: intent?.intent ?? null,
          routingReason: reason,
        })
        .where(eq(leads.id, lead.id));
      return {
        assigneeId: null,
        intent: intent?.intent ?? null,
        urgency: intent?.urgency ?? null,
        routingReason: reason,
        autoTransferred: false,
        priorityLevel: 'skip',
      };
    }

    const workloadMap = await this.getWorkloadMap(candidates);
    const conversionRateMap = await this.getConversionRateMap(candidates);
    const { onlineSet, anyHeartbeat } = await this.getOnlineAgentSet(candidates);

    // ===== 2026-08-15 业务侧新规则：必须在线 =====
    // 有心跳报告时，严格只保留在线的客服。冷启动（anyHeartbeat=false）时
    // 保留容错（所有人都视为在线），避免冷启动期间无任何候选可分配。
    if (anyHeartbeat) {
      candidates = candidates.filter((id) => onlineSet.has(id));
      for (const id of [...matchLevels.keys()]) {
        if (!onlineSet.has(id)) matchLevels.delete(id);
      }
    }
    const effectiveOnlineSet = anyHeartbeat ? onlineSet : new Set(candidates);

    if (!isPriority && effectiveOnlineSet.size === 0) {
      // ===== 2026-08-14 避免"无人管"3 层：第 1 层智能路由 =====
      // A/B 级线索无在线客服时，进入"待分配"缓冲队列（30s 内反复重试），
      // 而不是直接进公海池。缓冲期可配置（环境变量 PENDING_ASSIGNMENT_BUFFER_MS），默认 30s。
      // 设置为 0 表示不缓冲直接升级主管；推荐 30000-120000 区间。
      const isHighPriority = lead.leadGrade === 'A' || lead.leadGrade === 'B';
      if (isHighPriority) {
        const now = new Date();
        const bufferMs = Math.max(
          0,
          Number(process.env.PENDING_ASSIGNMENT_BUFFER_MS ?? 30_000),
        );
        const reasonParts: string[] = [];
        if (intent) reasonParts.push(`AI意图:${intent.category}`);
        if (targetSkill) reasonParts.push(`匹配技能:${targetSkill}`);
        reasonParts.push(`无在线客服,待分配缓冲${Math.round(bufferMs / 1000)}s`);
        const reason = reasonParts.join('→');

        await this.db
          .update(leads)
          .set({
            intent: intent?.intent ?? null,
            routingReason: reason,
            status: 'pending_assignment',
            pendingAssignmentUntil: new Date(now.getTime() + bufferMs),
            lastRoutingAt: now,
            routingAttempts: (lead.routingAttempts ?? 0) + 1,
          })
          .where(eq(leads.id, lead.id));

        this.logger.log(
          `线索 ${lead.id} (${lead.leadGrade}级) 进入待分配缓冲,30s 内重试 (attempt=${(lead.routingAttempts ?? 0) + 1})`,
        );

        // 立即尝试重试一次（如果路由系统启动时已有 agent 状态）
        this.scheduleRetry(lead.id, bufferMs);

        return {
          assigneeId: null,
          intent: intent?.intent ?? null,
          urgency: intent?.urgency ?? null,
          routingReason: reason,
          autoTransferred: false,
          priorityLevel: 'normal',
        };
      }
      // ====================================================

      const reasonParts: string[] = [];
      if (intent) reasonParts.push(`AI意图:${intent.category}`);
      if (targetSkill) reasonParts.push(`匹配技能:${targetSkill}`);
      reasonParts.push('无在线客服，进入公海池');
      const reason = reasonParts.join('→');
      await this.db
        .update(leads)
        .set({
          intent: intent?.intent ?? null,
          routingReason: reason,
        })
        .where(eq(leads.id, lead.id));
      return {
        assigneeId: null,
        intent: intent?.intent ?? null,
        urgency: intent?.urgency ?? null,
        routingReason: reason,
        autoTransferred: false,
        priorityLevel: 'normal',
      };
    }

    let bestAgent: string | null = null;
    let bestScore = -1;
    let bestWorkload = 0;
    let bestConversionRate = 0;

    for (const agentId of candidates) {
      const workload = workloadMap.get(agentId) ?? 0;
      const matchLevel = matchLevels.get(agentId) ?? 0;
      const isOnline = effectiveOnlineSet.has(agentId);
      const conversionRate = conversionRateMap.get(agentId) ?? 0.5;

      const workloadScore = Math.max(0, 40 - workload * 8);
      const skillScore = matchLevel === 2 ? 30 : matchLevel === 1 ? 15 : 0;
      const onlineScore = isOnline ? 15 : 0;
      const conversionScore = Math.round(conversionRate * 7);
      const total = workloadScore + skillScore + onlineScore + conversionScore;

      // 2026-08-15 业务侧新规则：同分 tiebreaker — 相同工作量下转化率较高者优先
      if (
        total > bestScore ||
        (total === bestScore && conversionRate > bestConversionRate)
      ) {
        bestScore = total;
        bestAgent = agentId;
        bestWorkload = workload;
        bestConversionRate = conversionRate;
      }
    }

    if (bestAgent === null) {
      bestAgent = candidates[0] ?? null;
    }

    const reasonParts: string[] = [];
    if (intent) reasonParts.push(`AI意图:${intent.category}`);
    if (targetSkill) reasonParts.push(`匹配技能:${targetSkill}`);
    if (isPriority) reasonParts.push('A级优先分配');
    const matchLevel = matchLevels.get(bestAgent!) ?? 0;
    const matchLabel = matchLevel === 2 ? '城市+技能匹配' : matchLevel === 1 ? '城市匹配' : '兜底分配';
    reasonParts.push(`${matchLabel}:${bestAgent}(${bestWorkload}个活跃会话,转化率${Math.round(bestConversionRate * 100)}%,评分${bestScore})`);
    const routingReason = reasonParts.join('→');

    await this.db
      .update(leads)
      .set({
        assigneeId: bestAgent,
        assignedAt: new Date(),
        lastFollowedUpAt: null,
        intent: intent?.intent ?? null,
        routingReason,
      })
      .where(eq(leads.id, lead.id));

    const autoTransferred =
      intent?.urgency === 'high' &&
      (await this.aiConfigService.getConfigWithDefault('urgent_auto_transfer', 'true')) === 'true';

    return {
      assigneeId: bestAgent,
      intent: intent?.intent ?? null,
      urgency: intent?.urgency ?? null,
      routingReason,
      autoTransferred,
      priorityLevel: isPriority ? 'high' : 'normal',
    };
  }

  private async get2DCandidates(
    lead: typeof leads.$inferSelect,
    targetSkill: string | null,
  ): Promise<{ candidates: string[]; matchLevels: Map<string, number> }> {
    let skillAgents = new Set<string>();
    if (targetSkill) {
      // 与 chat.prompt.ts SKILL_TAG_MAP / client AgentSkillsTab.SKILL_OPTIONS 保持一致
      const BAOMU_SUBSKILLS = ['钟点工保姆', '白班保姆', '住家保姆', '育儿保姆', '护工保姆', '菲式保姆'];
      const querySkills = BAOMU_SUBSKILLS.includes(targetSkill)
        ? [targetSkill, '保姆']
        : [targetSkill];
      const skillRows = await this.db
        .select({ assigneeId: agentSkills.assigneeId })
        .from(agentSkills)
        .where(inArray(agentSkills.skillTag, querySkills));
      skillAgents = new Set(skillRows.map((r: { assigneeId: string }) => r.assigneeId));
    }

    const cityRows = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.city, lead.serviceCity));
    const cityAgents = new Set(cityRows.map((r: { id: string }) => r.id));

    const candidates: string[] = [];
    const matchLevels = new Map<string, number>();

    for (const agentId of skillAgents) {
      if (cityAgents.has(agentId)) {
        candidates.push(agentId);
        matchLevels.set(agentId, 2);
      }
    }
    return { candidates, matchLevels };
  }

  private async getWorkloadMap(candidates: string[]): Promise<Map<string, number>> {
    if (candidates.length === 0) return new Map();
    const rows = await this.db
      .select({
        assigneeId: leads.assigneeId,
        workload: count(),
      })
      .from(leads)
      .where(
        and(
          inArray(leads.assigneeId, candidates),
          eq(leads.status, 'chatting'),
        ),
      )
      .groupBy(leads.assigneeId);
    const map = new Map<string, number>();
    for (const r of rows) {
      map.set(r.assigneeId!, Number(r.workload));
    }
    return map;
  }

  private async getConversionRateMap(candidates: string[]): Promise<Map<string, number>> {
    if (candidates.length === 0) return new Map();

    const totalRows = await this.db
      .select({
        assigneeId: leads.assigneeId,
        total: count(),
      })
      .from(leads)
      .where(
        and(
          inArray(leads.assigneeId, candidates),
          isNotNull(leads.assigneeId),
        ),
      )
      .groupBy(leads.assigneeId);

    const convertedRows = await this.db
      .select({
        assigneeId: leads.assigneeId,
        converted: sql<number>`count(DISTINCT ${leads.id})`,
      })
      .from(leads)
      .innerJoin(serviceOrders, eq(serviceOrders.leadId, leads.id))
      .where(
        and(
          inArray(leads.assigneeId, candidates),
          isNotNull(leads.assigneeId),
        ),
      )
      .groupBy(leads.assigneeId);

    const totalMap = new Map<string, number>();
    for (const r of totalRows) {
      totalMap.set(r.assigneeId!, Number(r.total));
    }

    const convertedMap = new Map<string, number>();
    for (const r of convertedRows) {
      convertedMap.set(r.assigneeId!, Number(r.converted));
    }

    const rateMap = new Map<string, number>();
    for (const agentId of candidates) {
      const total = totalMap.get(agentId) ?? 0;
      const converted = convertedMap.get(agentId) ?? 0;
      const rate = total > 0 ? converted / total : 0.5;
      rateMap.set(agentId, rate);
    }

    return rateMap;
  }

  private async getOnlineAgentSet(
    candidates: string[],
  ): Promise<{ onlineSet: Set<string>; anyHeartbeat: boolean }> {
    const totalCount = await this.db
      .select({ count: count() })
      .from(agentOnlineStatus);
    const anyHeartbeat = Number(totalCount[0]?.count ?? 0) > 0;

    if (!anyHeartbeat) {
      return { onlineSet: new Set(), anyHeartbeat: false };
    }

    const rows = await this.db
      .select({ assigneeId: agentOnlineStatus.assigneeId })
      .from(agentOnlineStatus)
      .where(
        and(
          eq(agentOnlineStatus.status, 'online'),
          sql`${agentOnlineStatus.lastHeartbeatAt} > NOW() - INTERVAL '${ONLINE_TIMEOUT_MINUTES} minutes'`,
        ),
      );

    const onlineSet = new Set<string>();
    for (const r of rows) {
      if (candidates.includes(r.assigneeId)) {
        onlineSet.add(r.assigneeId);
      }
    }
    return { onlineSet, anyHeartbeat: true };
  }

  // ============ 客服在线状态 ============

  async recordHeartbeat(assigneeId: string, status: AgentOnlineState): Promise<void> {
    await this.db
      .insert(agentOnlineStatus)
      .values({ assigneeId, status })
      .onConflictDoUpdate({
        target: agentOnlineStatus.assigneeId,
        set: { status, lastHeartbeatAt: new Date() },
      });

    // ===== 2026-08-14 避免"无人管"3 层：第 1 层智能路由 =====
    // 心跳触发时，主动扫一次"待分配"队列，把在线 agent 技能匹配的线索立刻分配走。
    if (status === 'online') {
      await this.retryPendingAssignmentsForAgent(assigneeId).catch((err) => {
        this.logger.warn(
          `心跳触发重试待分配失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    // ====================================================
  }

  /**
   * 2026-08-14 避免"无人管"3 层 - 第 1 层
   * 心跳触发的"重试待分配"：当有新 agent 上线时，把所有待分配队列里
   * 技能/城市匹配的线索立刻尝试分配（抢单模式：先到先得）。
   */
  private async retryPendingAssignmentsForAgent(assigneeId: string): Promise<void> {
    const pendingLeads = await this.db
      .select()
      .from(leads)
      .where(
        and(
          eq(leads.status, 'pending_assignment'),
          sql`${leads.pendingAssignmentUntil} > NOW()`,
          isNull(leads.assigneeId),
        ),
      )
      .limit(20);

    if (pendingLeads.length === 0) return;

    // 拿 agent 的技能
    const skills = await this.db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.assigneeId, assigneeId));
    const skillTags = new Set(skills.map((s) => s.skillTag));

    let assigned = 0;
    for (const lead of pendingLeads) {
      try {
        // 简化匹配：agent 技能与 lead 服务类型前缀匹配，或 agent 无技能限制
        const matchSkill =
          skillTags.size === 0 ||
          Array.from(skillTags).some((s) => lead.intent?.includes(s) || s === 'all');

        if (!matchSkill) continue;

        // 给 agent 分配这条线索
        await this.db
          .update(leads)
          .set({
            assigneeId,
            assignedAt: new Date(),
            status: 'chatting',
            routingReason: `心跳触发重试分配:待分配缓冲命中(${lead.routingAttempts ?? 0}次重试后)`,
            pendingAssignmentUntil: null,
          })
          .where(
            and(
              eq(leads.id, lead.id),
              eq(leads.status, 'pending_assignment'), // 防止并发竞争
            ),
          );

        // 把对应 lead 的 active chat_session 切到 mode='human'，
        // 否则客服"我的会话"列表（按 mode='human' 过滤）看不到这条会话
        await this.db
          .update(chatSessions)
          .set({
            mode: 'human',
            transferReason: `心跳重试分配: ${lead.routingReason ?? ''}`.slice(0, 200),
          })
          .where(
            and(
              eq(chatSessions.leadId, lead.id),
              eq(chatSessions.status, 'active'),
            ),
          );

        // 给 agent 发飞书 IM 通知 + SSE 推送（由 chatService.notifyAgentOfNewAssignment 统一处理）
        await this.chatService.notifyAgentOfNewAssignment(assigneeId, lead.id).catch((err) =>
          this.logger.warn(
            `notifyAgentOfNewAssignment 失败 agent=${assigneeId} lead=${lead.id}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );

        assigned++;
        this.logger.log(`心跳重试分配成功: lead=${lead.id} → agent=${assigneeId}`);
      } catch (err) {
        this.logger.warn(
          `心跳重试单条失败 lead=${lead.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (assigned > 0) {
      this.logger.log(
        `心跳触发重试: agent=${assigneeId} 从 ${pendingLeads.length} 条待分配中分走 ${assigned} 条`,
      );
    }
  }

  /**
   * 2026-08-14 避免"无人管"3 层 - 第 1 层
   * 30s 缓冲到期时调用：把超时未分配的线索升级到销售主管 + 进公海池
   */
  private async escalatePendingAssignment(leadId: string): Promise<void> {
    const [lead] = await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead || lead.status !== 'pending_assignment') return;

    // 标记为升级 + 进公海池（chatted 状态保留线索可见性）
    await this.db
      .update(leads)
      .set({
        status: 'public_pool',
        routingReason: `${lead.routingReason} → 30s 缓冲超时,升级销售主管,进公海池`,
        escalatedToSupervisor: true,
        supervisorNotifiedAt: new Date(),
        pendingAssignmentUntil: null,
      })
      .where(eq(leads.id, leadId));

    // IM 通知所有 supervisor（按 ai_configs 里的 SUPERVISOR_USER_IDS 配置）
    await this.notifySupervisorOfEscalation(lead).catch((err) =>
      this.logger.warn(`升级销售主管 IM 通知失败: ${err.message}`),
    );

    this.logger.warn(
      `线索 ${leadId} 缓冲超时,已升级到销售主管,进入公海池 (attempts=${lead.routingAttempts})`,
    );
  }

  /**
   * 2026-08-14 避免"无人管"3 层 - 第 1 层
   * 立即安排一次重试（30s 后到期），同时给所有匹配 agent 发 IM 通知
   */
  private scheduleRetry(leadId: string, delayMs: number): void {
    setTimeout(() => {
      this.escalatePendingAssignment(leadId).catch((err) =>
        this.logger.warn(
          `升级 pendingAssignment 失败 lead=${leadId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }, delayMs);
  }

  /**
   * 2026-08-14 避免"无人管"3 层 - 第 2 层任务卡
   * 给 agent 发 IM 任务卡通知
   *
   * 2026-08-15 移除：原实现只 log 不发，已被 chatService.notifyAgentOfNewAssignment 替代
   * （同时发飞书 IM 卡片 + SSE 实时推送）
   */

  /**
   * 2026-08-14 避免"无人管"3 层 - 第 3 层兜底
   * 升级销售主管时调用
   */
  private async notifySupervisorOfEscalation(lead: typeof leads.$inferSelect): Promise<void> {
    // 实现细节：拉取 ai_configs 中配置的 supervisor user ids，批量 IM 推送
    this.logger.warn(
      `[升级兜底] lead=${lead.id} 客户=${lead.customerName ?? lead.phoneNumber} 城市=${lead.serviceCity} 升级销售主管`,
    );
    // 注：IM 推送在生产环境由 NotifyModule + lark-im 实现，本期先写日志
  }

  async getOnlineAgents(): Promise<AgentOnlineStatus[]> {
    const rows = await this.db
      .select()
      .from(agentOnlineStatus)
      .where(sql`${agentOnlineStatus.lastHeartbeatAt} > NOW() - INTERVAL '${ONLINE_TIMEOUT_MINUTES} minutes'`);
    return rows.map((r) => ({
      assigneeId: r.assigneeId,
      status: r.status as AgentOnlineState,
      lastHeartbeatAt: r.lastHeartbeatAt.toISOString(),
    }));
  }

  // ============ 技能管理 ============

  async getAgentSkills(): Promise<AgentSkill[]> {
    const rows = await this.db
      .select()
      .from(agentSkills)
      .orderBy(agentSkills.assigneeId, agentSkills.skillTag);
    return rows.map((r) => this.mapSkillRow(r));
  }

  async addAgentSkill(data: CreateAgentSkillRequest): Promise<AgentSkill> {
    const agentRows = await this.db
      .select({ id: agents.id, serviceTypes: agents.serviceTypes })
      .from(agents)
      .where(eq(agents.id, data.assigneeId))
      .limit(1);
    if (agentRows.length === 0) throw new NotFoundException('专员不存在');
    const types: string[] = Array.isArray(agentRows[0].serviceTypes)
      ? (agentRows[0].serviceTypes as string[])
      : [];
    if (types.includes(data.skillTag)) {
      throw new ConflictException('该专员已拥有此技能');
    }

    await this.db
      .update(agents)
      .set({ serviceTypes: [...types, data.skillTag], updatedAt: new Date() })
      .where(eq(agents.id, agentRows[0].id));
    await this.agentSkillsSync.syncFromServiceTypes(agentRows[0].id);

    return this.findSkillRow(agentRows[0].id, data.skillTag);
  }

  async updateAgentSkill(id: string, data: UpdateAgentSkillRequest): Promise<AgentSkill> {
    const oldRows = await this.db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.id, id))
      .limit(1);
    if (oldRows.length === 0) throw new NotFoundException('技能记录不存在');
    const assigneeId = oldRows[0].assigneeId;
    const oldTag = oldRows[0].skillTag;
    if (oldTag === data.skillTag) return this.mapSkillRow(oldRows[0]);

    const agentRows = await this.db
      .select({ id: agents.id, serviceTypes: agents.serviceTypes })
      .from(agents)
      .where(eq(agents.id, assigneeId))
      .limit(1);
    if (agentRows.length === 0) throw new NotFoundException('专员不存在');
    const types: string[] = Array.isArray(agentRows[0].serviceTypes)
      ? (agentRows[0].serviceTypes as string[])
      : [];
    if (types.includes(data.skillTag)) {
      throw new ConflictException('该专员已拥有此技能');
    }
    const next = types.includes(oldTag)
      ? types.map((t: string) => (t === oldTag ? data.skillTag : t))
      : [...types, data.skillTag];

    await this.db
      .update(agents)
      .set({ serviceTypes: next, updatedAt: new Date() })
      .where(eq(agents.id, assigneeId));
    await this.agentSkillsSync.syncFromServiceTypes(assigneeId);

    return this.findSkillRow(assigneeId, data.skillTag);
  }

  async removeAgentSkill(id: string): Promise<void> {
    const oldRows = await this.db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.id, id))
      .limit(1);
    if (oldRows.length === 0) throw new NotFoundException('技能记录不存在');
    const assigneeId = oldRows[0].assigneeId;
    const oldTag = oldRows[0].skillTag;

    const agentRows = await this.db
      .select({ id: agents.id, serviceTypes: agents.serviceTypes })
      .from(agents)
      .where(eq(agents.id, assigneeId))
      .limit(1);
    if (agentRows.length === 0) {
      await this.db.delete(agentSkills).where(eq(agentSkills.id, id));
      return;
    }
    const types: string[] = Array.isArray(agentRows[0].serviceTypes)
      ? (agentRows[0].serviceTypes as string[])
      : [];
    await this.db
      .update(agents)
      .set({
        serviceTypes: types.filter((t: string) => t !== oldTag),
        updatedAt: new Date(),
      })
      .where(eq(agents.id, assigneeId));
    await this.agentSkillsSync.syncFromServiceTypes(assigneeId);
  }

  private mapSkillRow(r: typeof agentSkills.$inferSelect): AgentSkill {
    return {
      id: r.id,
      assigneeId: r.assigneeId,
      skillTag: r.skillTag,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  private async findSkillRow(assigneeId: string, skillTag: string): Promise<AgentSkill> {
    const rows = await this.db
      .select()
      .from(agentSkills)
      .where(
        and(
          eq(agentSkills.assigneeId, assigneeId),
          eq(agentSkills.skillTag, skillTag),
        ),
      )
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('技能记录不存在');
    return this.mapSkillRow(rows[0]);
  }

  async getAllAgentWorkloads(): Promise<AgentWorkload[]> {
    const agentRows = await this.db
      .select({
        assigneeId: agents.id,
        serviceTypes: agents.serviceTypes,
      })
      .from(agents);

    const skillsMap = new Map<string, string[]>();
    for (const r of agentRows) {
      const types: string[] = Array.isArray(r.serviceTypes) ? (r.serviceTypes as string[]) : [];
      skillsMap.set(r.assigneeId, types);
    }

    const chattingRows = await this.db
      .select({
        assigneeId: leads.assigneeId,
        count: count(),
      })
      .from(leads)
      .where(
        and(
          isNotNull(leads.assigneeId),
          eq(leads.status, 'chatting'),
        ),
      )
      .groupBy(leads.assigneeId);

    const chattingMap = new Map<string, number>();
    for (const r of chattingRows) {
      chattingMap.set(r.assigneeId!, Number(r.count));
    }

    const sessionRows = await this.db
      .select({
        assigneeId: leads.assigneeId,
        count: count(),
      })
      .from(chatSessions)
      .innerJoin(leads, eq(leads.id, chatSessions.leadId))
      .where(
        and(
          isNotNull(leads.assigneeId),
          eq(chatSessions.status, 'active'),
        ),
      )
      .groupBy(leads.assigneeId);

    const sessionMap = new Map<string, number>();
    for (const r of sessionRows) {
      sessionMap.set(r.assigneeId!, Number(r.count));
    }

    const totalRows = await this.db
      .select({
        assigneeId: leads.assigneeId,
        count: count(),
      })
      .from(leads)
      .where(isNotNull(leads.assigneeId))
      .groupBy(leads.assigneeId);

    const totalMap = new Map<string, number>();
    for (const r of totalRows) {
      totalMap.set(r.assigneeId!, Number(r.count));
    }

    const result: AgentWorkload[] = [];
    for (const [agentId, skills] of skillsMap) {
      result.push({
        assigneeId: agentId,
        activeSessions: sessionMap.get(agentId) ?? 0,
        chattingLeads: chattingMap.get(agentId) ?? 0,
        totalLeads: totalMap.get(agentId) ?? 0,
        skills,
      });
    }

    return result.sort((a, b) => a.assigneeId.localeCompare(b.assigneeId));
  }
}
