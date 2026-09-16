import { BadRequestException, Injectable, Inject, Logger, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull, sql, asc, count } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import {
  agents,
  agentSessions,
  agentOnlineStatus,
  leads,
  chatSessions,
  chatMessages,
} from '@server/database/schema';
import { normalizeServiceSubType } from '../automation/requirement-templates';

/** 超时阈值（分钟）：A 档、C1 情绪 high 为 2 分钟，其余（B、C1 非 high）为 5 分钟 */
function timeoutMinutes(grade: string | null, urgency: string | null): number {
  if (grade === 'A') return 2;
  if (grade === 'C1' && urgency === 'high') return 2;
  return 5;
}

/** 不分配经纪人的档位（培育池 / 过滤池 / 待采集） */
const DISPATCH_SKIP_GRADES = ['D', 'C2', 'B_PRICE'];

/**
 * 服务类型匹配：线索侧存拼音码（zhujia），经纪人侧存中文（住家保姆），
 * 统一归一化为拼音码再比对；无法归一化时降级原始相等。
 */
function serviceTypeMatches(candidate: string, leadType: string): boolean {
  if (candidate === leadType) return true;
  const a = normalizeServiceSubType(candidate);
  const b = normalizeServiceSubType(leadType);
  return a !== null && a === b;
}

/** C1 高情绪进入待分配时的 AI 安抚话术 */
const C1_HIGH_COMFORT_MESSAGE =
  '非常理解您的心情，已为您加急安排专属顾问，稍后就会主动联系您，请稍等~';

interface CandidateAgent {
  id: string;
  serviceTypes: string[];
  activeLeadsCount: number;
  conversionRate: number;
}

interface LeadDispatchInfo {
  city: string;
  serviceType: string | null;
  grade: string | null;
  urgency: string | null;
  originalAgentId: string | null;
  pendingComfortAt: Date | null;
  assigneeId: string | null;
}

@Injectable()
export class AgentDispatchService {
  private readonly logger = new Logger(AgentDispatchService.name);
  private lastFullCheckAt = 0;
  private readonly FULL_CHECK_MIN_INTERVAL_MS = 60_000;

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  /** 带档位守卫的派单：D / C2 / B_PRICE 档不分配经纪人，其余走 assignLead */
  async assignLeadIfEligible(leadId: string, reason?: string): Promise<string | null> {
    const rows = await this.db
      .select({ grade: leads.leadGrade })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (rows.length === 0) {
      throw new NotFoundException(`线索 ${leadId} 不存在`);
    }
    const grade: string | null = rows[0].grade;
    if (grade && DISPATCH_SKIP_GRADES.includes(grade)) {
      this.logger.log(`线索 ${leadId} 档位 ${grade} 不分配经纪人，跳过派单`);
      return null;
    }
    return this.assignLead(leadId, reason);
  }

  /**
   * 分配一条线索：
   * 1. 有原经纪人（C1 跟到底）且在线 + 同城 + 擅长 → 强制分配，不受负载上限限制
   * 2. 否则在线 + 同城市 + 擅长该服务类型 + 未达负载上限，按负载升序、成交率降序取第一个
   * 3. 无匹配 → pending（C1 高情绪进 pending_high 并发 AI 安抚）
   */
  async assignLead(leadId: string, reason?: string): Promise<string | null> {
    const leadRows = await this.db
      .select({
        city: leads.serviceCity,
        serviceType: leads.serviceType,
        grade: leads.leadGrade,
        urgency: leads.urgencyLevel,
        originalAgentId: leads.originalAgentId,
        pendingComfortAt: leads.pendingComfortAt,
        assigneeId: leads.assigneeId,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (leadRows.length === 0) {
      throw new NotFoundException(`线索 ${leadId} 不存在`);
    }
    const lead: LeadDispatchInfo = leadRows[0];
    if (!lead.serviceType) {
      this.logger.warn(`线索 ${leadId} 无服务类型，无法派单`);
      await this.markPending(leadId, lead);
      return null;
    }

    if (lead.originalAgentId) {
      const forced: boolean = await this.tryAssignToOriginalAgent(leadId, lead, reason);
      if (forced) return lead.originalAgentId;
    }

    const candidate = await this.pickCandidate(lead.city, lead.serviceType);
    if (!candidate) {
      this.logger.log(`线索 ${leadId} 无可用经纪人（城市=${lead.city} 服务=${lead.serviceType}），置为 pending`);
      await this.markPending(leadId, lead);
      return null;
    }

    const committed: boolean = await this.commitAssignment(
      leadId,
      candidate.id,
      reason ?? `派单：负载最低/成交率优先（经纪人 ${candidate.id}）`,
      false,
      lead.assigneeId,
    );
    if (!committed) {
      this.logger.log(`线索 ${leadId} 提交分配未命中（经纪人 ${candidate.id} 负载已满），置为 pending`);
      await this.markPending(leadId, lead);
      return null;
    }
    if (lead.grade === 'C1' && !lead.originalAgentId) {
      await this.db
        .update(leads)
        .set({ originalAgentId: candidate.id })
        .where(eq(leads.id, leadId));
    }
    this.logger.log(`线索 ${leadId} 已派给经纪人 ${candidate.id}`);
    return candidate.id;
  }

  /** C1 跟到底：原经纪人在线 + 同城 + 擅长该服务类型时强制分配，不检查负载上限 */
  private async tryAssignToOriginalAgent(
    leadId: string,
    lead: LeadDispatchInfo,
    reason?: string,
  ): Promise<boolean> {
    const originalAgentId: string = lead.originalAgentId as string;
    const rows = await this.db
      .select({
        id: agents.id,
        city: agents.city,
        serviceTypes: agents.serviceTypes,
      })
      .from(agents)
      .innerJoin(
        agentSessions,
        and(eq(agentSessions.agentId, agents.id), eq(agentSessions.isOnline, true)),
      )
      .where(eq(agents.id, originalAgentId))
      .limit(1);
    if (rows.length === 0) return false;

    const agent = rows[0];
    if (agent.city !== lead.city) return false;
    const types: string[] = Array.isArray(agent.serviceTypes)
      ? (agent.serviceTypes as string[])
      : [];
    if (!lead.serviceType || !types.some((t: string) => serviceTypeMatches(t, lead.serviceType as string))) {
      return false;
    }

    const committed: boolean = await this.commitAssignment(
      leadId,
      originalAgentId,
      reason ?? `C1 跟到底：分配原经纪人 ${originalAgentId}`,
      true,
      lead.assigneeId,
    );
    if (!committed) return false;
    this.logger.log(`线索 ${leadId} C1 跟到底，强制派给原经纪人 ${originalAgentId}（不受负载上限限制）`);
    return true;
  }

  /** 事务内部标记：分配未命中（负载满/经纪人不存在），需要回滚已做的负载释放 */
  private static readonly ASSIGN_NOT_COMMITTED = 'ASSIGN_NOT_COMMITTED';

  /**
   * 分配落库：负载 +1 与线索状态同一事务；若线索原已分配给他人，先释放原经纪人负载；
   * skipLoadCheck=true 时允许超过 maxLeads。prevAssignee 为新经纪人相同时不重复释放。
   */
  private async commitAssignment(
    leadId: string,
    agentId: string,
    reason: string,
    skipLoadCheck: boolean,
    prevAssignee: string | null,
  ): Promise<boolean> {
    try {
      await this.db.transaction(async (tx) => {
        if (prevAssignee && prevAssignee !== agentId) {
          await tx
            .update(agents)
            .set({ activeLeadsCount: sql`GREATEST(${agents.activeLeadsCount} - 1, 0)` })
            .where(eq(agents.id, prevAssignee));
        }
        const loadCondition = skipLoadCheck
          ? eq(agents.id, agentId)
          : and(eq(agents.id, agentId), sql`${agents.activeLeadsCount} < ${agents.maxLeads}`);
        const locked = await tx
          .update(agents)
          .set({ activeLeadsCount: sql`${agents.activeLeadsCount} + 1` })
          .where(loadCondition)
          .returning({ id: agents.id });
        if (locked.length === 0) {
          throw new Error(AgentDispatchService.ASSIGN_NOT_COMMITTED);
        }
        await tx
          .update(leads)
          .set({
            assigneeId: agentId,
            assignedAt: new Date(),
            respondedAt: null,
            assignmentStatus: 'assigned',
            status: 'assigned',
            routingReason: reason,
          })
          .where(eq(leads.id, leadId));
      });
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === AgentDispatchService.ASSIGN_NOT_COMMITTED) {
        this.logger.warn(`分配未命中（负载已满或经纪人不存在）: 线索 ${leadId} 目标经纪人 ${agentId}`);
        return false;
      }
      throw error;
    }
  }

  /**
   * 进入池子（培育池/过滤池）：同一事务释放原负责人负载并清空分配。
   * 分级变更（B_PRICE→nurturing、D→filtered）必须走此方法，否则负载泄漏。
   */
  async moveToPool(leadId: string, poolStatus: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [lead] = await tx
        .select({ assigneeId: leads.assigneeId })
        .from(leads)
        .where(eq(leads.id, leadId))
        .limit(1);
      if (!lead) return;
      if (lead.assigneeId) {
        await tx
          .update(agents)
          .set({ activeLeadsCount: sql`GREATEST(${agents.activeLeadsCount} - 1, 0)` })
          .where(eq(agents.id, lead.assigneeId));
      }
      await tx
        .update(leads)
        .set({
          status: poolStatus,
          assigneeId: null,
          assignedAt: null,
          assignmentStatus: 'pending',
          routingReason: reason,
        })
        .where(eq(leads.id, leadId));
    });
  }

  /** 候选人选取：在线 + 同城市 + 未接满，内存过滤服务类型并排序取第一个 */
  private async pickCandidate(city: string, serviceType: string): Promise<CandidateAgent | null> {
    const rows = await this.db
      .select({
        id: agents.id,
        serviceTypes: agents.serviceTypes,
        activeLeadsCount: agents.activeLeadsCount,
        conversionRate: agents.conversionRate,
      })
      .from(agents)
      .innerJoin(agentSessions, and(eq(agentSessions.agentId, agents.id), eq(agentSessions.isOnline, true)))
      .where(and(eq(agents.city, city), sql`${agents.activeLeadsCount} < ${agents.maxLeads}`));

    const eligible = rows.filter((row) => {
      const types: string[] = Array.isArray(row.serviceTypes) ? (row.serviceTypes as string[]) : [];
      return types.some((t: string) => serviceTypeMatches(t, serviceType));
    });
    if (eligible.length === 0) return null;

    eligible.sort(
      (a, b) => a.activeLeadsCount - b.activeLeadsCount || b.conversionRate - a.conversionRate,
    );
    const top = eligible[0];
    return {
      id: top.id,
      serviceTypes: top.serviceTypes as string[],
      activeLeadsCount: top.activeLeadsCount,
      conversionRate: top.conversionRate,
    };
  }

  /** 进入待分配：C1 高情绪进 pending_high 并按需发安抚，其余进 pending */
  private async markPending(leadId: string, lead: LeadDispatchInfo): Promise<void> {
    const isHighPriority: boolean = lead.grade === 'C1' && lead.urgency === 'high';
    await this.db
      .update(leads)
      .set({ assignmentStatus: isHighPriority ? 'pending_high' : 'pending' })
      .where(eq(leads.id, leadId));
    if (isHighPriority && !lead.pendingComfortAt) {
      await this.sendComfortMessage(leadId);
    }
  }

  /** C1 高情绪安抚：向客户会话插入 AI 安抚消息并记录发送时间（同一周期只发一次） */
  private async sendComfortMessage(leadId: string): Promise<void> {
    try {
      const sessions = await this.db
        .select({ id: chatSessions.id })
        .from(chatSessions)
        .where(eq(chatSessions.leadId, leadId))
        .orderBy(sql`${chatSessions.createdAt} DESC`)
        .limit(1);
      if (sessions.length === 0) {
        this.logger.log(`线索 ${leadId} 无会话，跳过安抚消息`);
        return;
      }
      await this.db.insert(chatMessages).values({
        sessionId: sessions[0].id,
        role: 'bot',
        content: C1_HIGH_COMFORT_MESSAGE,
      });
      await this.db
        .update(leads)
        .set({ pendingComfortAt: new Date() })
        .where(eq(leads.id, leadId));
      this.logger.log(`线索 ${leadId} 已发送 C1 高情绪安抚消息`);
    } catch (error) {
      this.logger.error(
        `线索 ${leadId} 安抚消息发送失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /** 经纪人点接单：仅当线索处于 assigned 且未响应、且归属该经纪人时成功 */
  async agentRespond(leadId: string, agentId: string): Promise<boolean> {
    const updated = await this.db
      .update(leads)
      .set({ respondedAt: new Date(), assignmentStatus: 'responded' })
      .where(
        and(
          eq(leads.id, leadId),
          eq(leads.assigneeId, agentId),
          eq(leads.assignmentStatus, 'assigned'),
          isNull(leads.respondedAt),
        ),
      )
      .returning({ id: leads.id });
    return updated.length > 0;
  }

  /**
   * 超时转派：检查所有 assigned 且未响应的线索，超时的
   * 旧经纪人负载 -1 → 线索清空回 pending → 重新走 assignLead。
   */
  async checkTimeoutAndReassign(): Promise<number> {
    const rows = await this.db
      .select({
        id: leads.id,
        grade: leads.leadGrade,
        urgency: leads.urgencyLevel,
        assignedAt: leads.assignedAt,
        assigneeId: leads.assigneeId,
      })
      .from(leads)
      .where(
        and(
          eq(leads.assignmentStatus, 'assigned'),
          isNull(leads.respondedAt),
          isNotNull(leads.assignedAt),
        ),
      );

    const now = Date.now();
    let reassigned = 0;
    for (const row of rows) {
      const limitMs = timeoutMinutes(row.grade, row.urgency) * 60_000;
      const assignedMs = row.assignedAt ? new Date(row.assignedAt).getTime() : 0;
      if (now - assignedMs < limitMs) continue;

      try {
        await this.db.transaction(async (tx) => {
          if (row.assigneeId) {
            await tx
              .update(agents)
              .set({ activeLeadsCount: sql`GREATEST(${agents.activeLeadsCount} - 1, 0)` })
              .where(eq(agents.id, row.assigneeId));
          }
          await tx
            .update(leads)
            .set({ assigneeId: null, assignedAt: null, assignmentStatus: 'pending', status: 'pending' })
            .where(eq(leads.id, row.id));
        });

        this.logger.log(`线索 ${row.id} 超时未响应（原经纪人 ${row.assigneeId}），重新派单`);
        await this.assignLead(row.id, '超时未响应自动转派');
        await this.markSessionHumanTransferred(
          row.id,
          '客服超时未响应',
        );
        reassigned++;
      } catch (error) {
        this.logger.error(
          `线索 ${row.id} 超时转派失败: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
    return reassigned;
  }

  /** 人工转接标记：给线索最新会话写 transferredBy=agent + 转接原因 */
  private async markSessionHumanTransferred(
    leadId: string,
    reason: string,
  ): Promise<void> {
    const [session] = await this.db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    if (!session) return;
    await this.db
      .update(chatSessions)
      .set({ transferredBy: 'agent', transferReason: reason })
      .where(eq(chatSessions.id, session.id));
  }

  /** 客服手动转接：校验目标在线，同一事务调负载并换负责人，会话写人工转接标记 */
  async manualReassign(leadId: string, targetAgentId: string): Promise<void> {
    const [lead] = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) throw new NotFoundException('线索不存在');
    if (lead.assigneeId === targetAgentId) {
      throw new BadRequestException('不能转接给当前负责人');
    }
    const [target] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.id, targetAgentId))
      .limit(1);
    if (!target) throw new NotFoundException('目标经纪人不存在');
    const [onlineRow] = await this.db
      .select()
      .from(agentOnlineStatus)
      .where(
        and(
          eq(agentOnlineStatus.assigneeId, targetAgentId),
          sql`${agentOnlineStatus.lastHeartbeatAt} > NOW() - INTERVAL '5 minutes'`,
        ),
      )
      .limit(1);
    if (!onlineRow) {
      throw new BadRequestException('目标经纪人不在线，无法转接');
    }

    await this.db.transaction(async (tx) => {
      if (lead.assigneeId) {
        await tx
          .update(agents)
          .set({ activeLeadsCount: sql`GREATEST(${agents.activeLeadsCount} - 1, 0)` })
          .where(eq(agents.id, lead.assigneeId));
      }
      await tx
        .update(agents)
        .set({ activeLeadsCount: sql`${agents.activeLeadsCount} + 1` })
        .where(eq(agents.id, targetAgentId));
      await tx
        .update(leads)
        .set({
          assigneeId: targetAgentId,
          assignedAt: new Date(),
          assignmentStatus: 'assigned',
        })
        .where(eq(leads.id, leadId));
    });
    await this.markSessionHumanTransferred(leadId, '客服手动转接');
  }

  /** 批量分配待分配线索：pending_high（C1 高情绪）先于普通 pending，各自先进先出 */
  async assignPendingLeads(): Promise<number> {
    const rows = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(
        and(
          inArray(leads.assignmentStatus, ['pending', 'pending_high']),
          inArray(leads.leadGrade, ['A', 'B', 'C1']),
          sql`${leads.status} NOT IN ('closed', 'collected', 'nurturing', 'recycled', 'filtered')`,
        ),
      )
      .orderBy(
        sql`CASE WHEN ${leads.assignmentStatus} = 'pending_high' THEN 0 ELSE 1 END`,
        sql`COALESCE(${leads.assignedAt}, ${leads.createdAt}) ASC`,
        asc(leads.createdAt),
      );

    let assigned = 0;
    for (const row of rows) {
      try {
        const agentId = await this.assignLead(row.id);
        if (agentId) assigned++;
      } catch (error) {
        this.logger.error(
          `线索 ${row.id} 派单失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return assigned;
  }

  /** 统计经纪人当前跟进中的线索数量（下线前检查用） */
  async countActiveLeadsForAgent(agentId: string): Promise<number> {
    const result = await this.db
      .select({ count: count() })
      .from(leads)
      .where(
        and(
          eq(leads.assigneeId, agentId),
          sql`${leads.status} NOT IN ('closed', 'collected', 'filtered', 'recycled', 'nurturing')`,
        ),
      );
    return Number(result[0]?.count ?? 0);
  }

  /** 全量检查：超时转派 + pending 补派，供定时任务与手动接口共用 */
  async runFullCheck(): Promise<{ reassigned: number; newlyAssigned: number }> {
    const reassigned = await this.checkTimeoutAndReassign();
    const newlyAssigned = await this.assignPendingLeads();
    return { reassigned, newlyAssigned };
  }

  /** 业务事件触发入口：1 分钟防抖，内部错误不抛给调用方 */
  async triggerFullCheck(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFullCheckAt < this.FULL_CHECK_MIN_INTERVAL_MS) return;
    this.lastFullCheckAt = now;
    try {
      await this.runFullCheck();
    } catch (error) {
      this.logger.error(
        `派单全量检查失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
