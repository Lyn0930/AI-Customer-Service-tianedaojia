import { Injectable, Inject, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { leads, requirements, chatSessions, agents } from '@server/database/schema';
import { eq, and, count, desc, asc, or, ilike, sql, isNull, isNotNull, inArray } from 'drizzle-orm';
import { RoutingService } from '../routing/routing.service';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { LeadGradingService } from './lead-grading.service';
import { normalizeFieldByKey } from '../chat/lead-field-normalizer';
import { SchemaMigrationService } from '../migration/schema-migration.service';
import type {
  Lead,
  LeadStatus,
  LeadSource,
  LeadListParams,
  LeadListResponse,
  CreateLeadRequest,
  Requirement,
  RequirementStatus,
  DashboardStats,
  PoolListParams,
  PoolListResponse,
  AutoAssignResult,
  RecycleResult,
  GradeHistory,
  UpdateRequirementRequest,
} from '@shared/api.interface';
import { normalizeSource, sanitizeCity, normalizeLead } from '@shared/channels';
import { normalizeServiceSubType, chineseServiceType, isValidBaomuType, getDefaultServiceHours } from '../automation/requirement-templates';
import { computeRecycleLoadDeltas } from './recycle.util';
import { RequirementDeltaService } from './requirement-delta.service';

/** 将数据库行映射为 Lead 接口（Date → ISO string） */
function mapToLead(row: typeof leads.$inferSelect): Lead {
    return {
      id: row.id,
      serviceCity: sanitizeCity(row.serviceCity),
      phoneNumber: row.phoneNumber,
      customerName: row.customerName,
      source: normalizeSource(row.source) as LeadSource,
      status: row.status as LeadStatus,
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
      serviceType: row.serviceType,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(forwardRef(() => RoutingService))
    private readonly routingService: RoutingService,
    private readonly dispatchService: AgentDispatchService,
    private readonly leadGradingService: LeadGradingService,
    private readonly schemaMigration: SchemaMigrationService,
    private readonly requirementDeltaService: RequirementDeltaService,
  ) {}

  /**
   * 分页查询线索列表
   */
  async list(params: LeadListParams): Promise<LeadListResponse> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(1, params.pageSize ?? 10), 50);

    const conditions = [];

    if (params.status) {
      conditions.push(eq(leads.status, params.status));
    }
    if (params.serviceCity) {
      conditions.push(eq(leads.serviceCity, params.serviceCity));
    }
    if (params.assigneeId) {
      conditions.push(eq(leads.assigneeId, params.assigneeId));
    }
    if (params.leadGrade) {
      conditions.push(eq(leads.leadGrade, params.leadGrade));
    }
    if (params.urgencyLevel) {
      conditions.push(eq(leads.urgencyLevel, params.urgencyLevel));
    }
    if (params.keyword) {
      const keywordCondition = or(
        ilike(leads.customerName, `%${params.keyword}%`),
        ilike(leads.phoneNumber, `%${params.keyword}%`),
      );
      if (keywordCondition) {
        conditions.push(keywordCondition);
      }
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // 查询总数
    const totalResult = await this.db
      .select({ count: count() })
      .from(leads)
      .where(whereClause);
    const total = Number(totalResult[0]?.count ?? 0);

    // 查询分页数据
    const rows = await this.db
      .select()
      .from(leads)
      .where(whereClause)
      .orderBy(desc(leads.createdAt))
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    return {
      items: rows.map(mapToLead),
      total,
      page,
      pageSize,
    };
  }

  /**
   * 根据 ID 查询线索详情
   */
  async getById(id: string): Promise<Lead> {
    const rows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new NotFoundException(`线索 ${id} 不存在`);
    }

    return mapToLead(rows[0]);
  }

  /**
   * 根据线索 ID 查询需求信息
   */
  async getRequirementsByLeadId(leadId: string): Promise<Requirement | null> {
    const rows = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.leadId, leadId))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      id: row.id,
      leadId: row.leadId,
      serviceType: row.serviceType ?? '',
      householdSize: row.householdSize ?? '',
      area: row.area ?? '',
      elderlyCare: row.elderlyCare ?? '',
      restDays: row.restDays ?? '',
      startTime: row.startTime ?? '',
      serviceAddress: row.serviceAddress ?? '',
      helperRequirements: row.helperRequirements ?? '',
      dietaryPreferences: row.dietaryPreferences ?? '',
      budget: row.budget ?? '',
      // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
      specialRequirements: row.specialRequirements ?? '',
      serviceItems: row.serviceItems ?? '',
      serviceHours: row.serviceHours ?? '',
      hasPet: row.hasPet ?? '',
      source: row.source ?? null,
      cardSubmittedAt: row.cardSubmittedAt ?? null,
      childCare: row.childCare ?? '',
      aiSummary: row.aiSummary ?? '',
      status: row.status as RequirementStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 创建线索（外部推送，自动按城市分配客服）
   * 如果传了 serviceType，会一并创建 requirements 记录
   */
  async create(data: CreateLeadRequest): Promise<Lead> {
    // 8/16 修复：写路径上先确保 leads DDL（idx_leads_phone_number），IF NOT EXISTS 幂等，重复跑安全
    await this.schemaMigration.ensureLeadsRoutingColumns();

    const normalized = normalizeLead({
      channel: data.channel ?? 'openapi',
      phoneNumber: data.phoneNumber,
      serviceCity: data.serviceCity,
      customerName: data.customerName,
      source: data.source,
      serviceType: data.serviceType,
      serviceTypeGroup: data.serviceTypeGroup,
      leadSourceDetail: data.leadSourceDetail,
    });
    const rawServiceType = normalizeServiceSubType(normalized.serviceType);
    const cnServiceType = rawServiceType ? chineseServiceType(rawServiceType) : null;
    // 8/16 8/10 跨渠道归一：同 phone 跨渠道留资合并为 1 条 lead
    // 返回 merged 标志：true=命中已有 lead，false=新建 lead
    const { row, merged: wasMerged } = await this.mergeOrCreateByPhone({
      serviceCity: normalized.serviceCity,
      phoneNumber: normalized.phoneNumber,
      customerName: normalized.customerName,
      source: normalized.source,
      phoneVerified: normalized.phoneVerified,
      leadSourceDetail: normalized.leadSourceDetail,
      channel: normalized.channel,
        serviceType: cnServiceType,
      });

    // 只有新建 lead 才插入 requirements（避免重复留资时插入多个 requirements 行）
    // v6 重构：6 种保姆类型白名单 + 默认时长自动填充
    if (cnServiceType && !wasMerged && isValidBaomuType(cnServiceType)) {
      const defaultHours = getDefaultServiceHours(cnServiceType);
      await this.db.insert(requirements).values({
        leadId: row.id,
        serviceType: cnServiceType,
        serviceHours: defaultHours ?? undefined,
        status: 'collecting',
      });
    }

    try {
      await this.dispatchService.assignLead(row.id, '新线索创建派单');
    } catch (error) {
      this.logger.error(
        `新线索派单失败，回退到待分配: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
    void this.dispatchService.triggerFullCheck();

    const [updated] = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, row.id))
      .limit(1);

    if (!wasMerged) {
      this.leadGradingService.recomputeGrade(row.id).catch((err: unknown) => {
        this.logger.warn(
          `新线索初始分级计算失败（不阻塞主流程）: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }

    const [after] = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, row.id))
      .limit(1);

    return mapToLead(after);
  }

  /**
   * 8/16 8/10 跨渠道归一：基于手机号查重合并
   *
   * 业务规则（来自 8/10 方案 3.6）：
   * - 同一 phone 已有 lead → UPDATE 已有 lead
   * - 同一 phone 无 lead → INSERT 新 lead
   * - 不丢弃跨渠道数据本身——3 渠道都搜过的客户是真有需求
   *
   * 并发安全：transaction + SELECT FOR UPDATE 锁住同一 phone 行，
   * 防止两个留资请求同时穿过判断后各 INSERT 一条重复 lead。
   */
  async mergeOrCreateByPhone(params: {
    serviceCity: string | null;
    phoneNumber: string;
    customerName: string | null;
    source: string;
    phoneVerified: boolean;
    leadSourceDetail: string | null;
    channel: string;
    /** form 留资时客户选的 serviceType（中文："住家保姆"/"钟点工"等） */
    serviceType: string | null;
  }): Promise<{ row: typeof leads.$inferSelect; merged: boolean }> {
    const now = new Date();

    return await this.db.transaction(async (tx) => {
      // SELECT FOR UPDATE 锁住同 phone 行
      const existingRows = await tx
        .select({
          id: leads.id,
          createdAt: leads.createdAt,
          updatedAt: leads.updatedAt,
        })
        .from(leads)
        .where(eq(leads.phoneNumber, params.phoneNumber))
        .orderBy(desc(leads.createdAt))
        .limit(1)
        .for('update');

      if (existingRows.length > 0) {
        const existing = existingRows[0];

        const updateSet: Partial<typeof leads.$inferInsert> = { updatedAt: now };
        if (params.serviceType) {
          updateSet.serviceType = params.serviceType;
        }
        const [updated] = await tx
          .update(leads)
          .set(updateSet)
          .where(eq(leads.id, existing.id))
          .returning();

        return { row: updated, merged: true };
      }

      const [row] = await tx
        .insert(leads)
        .values({
          serviceCity: params.serviceCity,
          phoneNumber: params.phoneNumber,
          customerName: params.customerName,
          source: params.source,
          phoneVerified: params.phoneVerified,
          leadSourceDetail: params.leadSourceDetail,
          channel: params.channel,
          serviceType: params.serviceType,
        })
        .returning();

      return { row, merged: false };
    });
  }

  async updateRequirement(leadId: string, data: UpdateRequirementRequest): Promise<Requirement> {
    const beforeReqRows = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.leadId, leadId))
      .limit(1);
    const beforeReqRow = beforeReqRows[0] ?? null;

    const patch: Partial<typeof requirements.$inferInsert> = {};
    if (data.serviceType !== undefined) patch.serviceType = data.serviceType;
    if (data.householdSize !== undefined) patch.householdSize = normalizeFieldByKey('householdSize', data.householdSize);
    if (data.area !== undefined) patch.area = normalizeFieldByKey('area', data.area);
    if (data.elderlyCare !== undefined) patch.elderlyCare = normalizeFieldByKey('elderlyCare', data.elderlyCare);
    if (data.restDays !== undefined) patch.restDays = data.restDays;
    if (data.startTime !== undefined) patch.startTime = normalizeFieldByKey('startTime', data.startTime);
    if (data.serviceAddress !== undefined) patch.serviceAddress = data.serviceAddress;
    if (data.helperRequirements !== undefined) patch.helperRequirements = data.helperRequirements;
    if (data.dietaryPreferences !== undefined) patch.dietaryPreferences = normalizeFieldByKey('dietaryPreferences', data.dietaryPreferences);
    if (data.budget !== undefined) patch.budget = normalizeFieldByKey('budget', data.budget);
    if (data.specialRequirements !== undefined) patch.specialRequirements = data.specialRequirements;
    if (data.hasPet !== undefined) patch.hasPet = data.hasPet;
    if (data.childCare !== undefined) patch.childCare = data.childCare;

    if (Object.keys(patch).length === 0) {
      throw new Error('未提供可更新字段');
    }

    patch.updatedAt = new Date();

    const updated = await this.db
      .update(requirements)
      .set(patch)
      .where(eq(requirements.leadId, leadId))
      .returning();

    if (updated.length === 0) {
      throw new NotFoundException(`线索 ${leadId} 的需求记录不存在`);
    }

    // delta 日志：运营/客服后台修改的字段变更（source=agent_edit）
    const oldRowMap: Record<string, string | null> = (beforeReqRow ?? {}) as Record<string, string | null>;
    const editDeltaChanges = Object.keys(patch)
      .filter((key: string) => key !== 'updatedAt')
      .map((key: string) => ({
        fieldKey: key,
        oldValue: oldRowMap[key] ?? null,
        newValue: (patch as Record<string, string | null>)[key] ?? null,
      }));
    void this.requirementDeltaService.recordDeltas({
      leadId,
      source: 'agent_edit',
      changes: editDeltaChanges,
    });

    return this.getRequirementsByLeadId(leadId) as Promise<Requirement>;
  }

  /**
   * 获取仪表盘统计数据
   *
   * 设计原则：任何子查询失败不应让整个接口返回 500，而是把失败信息填到 `debug` 字段
   * 返回 200，前端会展示 debug 面板。这样 dashboard 500 这种问题能立刻定位到具体 SQL。
   */
  async getStats(): Promise<DashboardStats> {
    // 一次性补齐 commit a994ed5 引入但未迁移到 DB 的 6 个 leads 列。
    // 失败不抛：service 内部已 swallow 错误，dashboard 走 fallback。
    await this.schemaMigration.ensureLeadsRoutingColumns();

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const safe = async <T>(
      stage: string,
      fallback: T,
      run: () => Promise<T>,
    ): Promise<{ value: T; debug?: DashboardStats['debug'] }> => {
      try {
        return { value: await run() };
      } catch (err) {
        const e = err as Error & { code?: string; detail?: string };
        const message = e?.message || String(err);
        const stack = e?.stack?.split('\n').slice(0, 6).join('\n');
        this.logger.error(`[getStats:${stage}] ${message}`);
        return {
          value: fallback,
          debug: {
            stage,
            message,
            stack,
            // 一些 PG 错误会带 code/detail，附上更便于排查
            ...(e?.code ? { code: String(e.code) } : {}),
            ...(e?.detail ? { detail: String(e.detail) } : {}),
          } as DashboardStats['debug'],
        };
      }
    };

    const total = await safe('totalLeads', 0, async () => {
      const r = await this.db.select({ value: count() }).from(leads);
      return Number(r[0]?.value ?? 0);
    });

    const todayCount = await safe('todayNew', 0, async () => {
      const r = await this.db
        .select({ value: count() })
        .from(leads)
        .where(sql`${leads.createdAt} >= ${today.toISOString()}`);
      return Number(r[0]?.value ?? 0);
    });

    const unassignedCount = await safe('unassigned', 0, async () => {
      const r = await this.db
        .select({ value: count() })
        .from(leads)
        .where(isNull(leads.assigneeId));
      return Number(r[0]?.value ?? 0);
    });

    const activeCount = await safe('activeSessions', 0, async () => {
      const r = await this.db
        .select({ value: count() })
        .from(chatSessions)
        .where(eq(chatSessions.status, 'active'));
      return Number(r[0]?.value ?? 0);
    });

    // 近 7 天时间范围（和其他运营指标保持一致口径）
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    // 平均聊天时长：所有转人工会话 ended_at - started_at 平均值（秒）
    const avgChatDuration = await safe('avgChatDuration', 0, async () => {
      const r = await this.db.select({
        avgSec: sql<number>`EXTRACT(EPOCH FROM AVG(${chatSessions.endedAt} - ${chatSessions.startedAt}))`,
      }).from(chatSessions).where(and(
        eq(chatSessions.mode, 'human'),
        isNotNull(chatSessions.endedAt),
        sql`${chatSessions.startedAt} >= ${sevenDaysAgo.toISOString()}`,
      ));
      return Math.round(Number(r[0]?.avgSec ?? 0));
    });

    // AI 采集耗时：transferReason='需求采集完成' 的会话平均时长（秒）
    const avgCollectionDuration = await safe('avgCollectionDuration', 0, async () => {
      const r = await this.db.select({
        avgSec: sql<number>`EXTRACT(EPOCH FROM AVG(${chatSessions.endedAt} - ${chatSessions.startedAt}))`,
      }).from(chatSessions).where(and(
        eq(chatSessions.mode, 'human'),
        eq(chatSessions.transferReason, '需求采集完成'),
        isNotNull(chatSessions.endedAt),
        sql`${chatSessions.startedAt} >= ${sevenDaysAgo.toISOString()}`,
      ));
      return Math.round(Number(r[0]?.avgSec ?? 0));
    });

    // 采集完成率：需求采集完成转人工 / 所有转人工（百分比，保留 1 位小数）
    const collectionCompletionRate = await safe('collectionCompletionRate', 0, async () => {
      const [totalRow, completedRow] = await Promise.all([
        this.db.select({ value: count() })
          .from(chatSessions)
          .where(and(
            eq(chatSessions.mode, 'human'),
            isNotNull(chatSessions.endedAt),
            sql`${chatSessions.startedAt} >= ${sevenDaysAgo.toISOString()}`,
          )),
        this.db.select({ value: count() })
          .from(chatSessions)
          .where(and(
            eq(chatSessions.mode, 'human'),
            eq(chatSessions.transferReason, '需求采集完成'),
            isNotNull(chatSessions.endedAt),
            sql`${chatSessions.startedAt} >= ${sevenDaysAgo.toISOString()}`,
          )),
      ]);
      const total = Number(totalRow[0]?.value ?? 0);
      const completed = Number(completedRow[0]?.value ?? 0);
      if (total === 0) return 0;
      return Math.round((completed / total) * 1000) / 10;
    });

    const sourceDist = await safe('sourceDistribution', [], async () => {
      const r = await this.db
        .select({ source: leads.source, count: count() })
        .from(leads)
        .groupBy(leads.source);
      return r.map((x) => ({ source: normalizeSource(x.source), count: Number(x.count) }));
    });

    const statusDist = await safe('statusDistribution', [], async () => {
      const r = await this.db
        .select({ status: leads.status, count: count() })
        .from(leads)
        .groupBy(leads.status);
      return r.map((x) => ({ status: x.status, count: Number(x.count) }));
    });

    const cityDist = await safe('cityDistribution', [], async () => {
      const r = await this.db
        .select({ city: leads.serviceCity, count: count() })
        .from(leads)
        .groupBy(leads.serviceCity)
        .orderBy(sql`count(*) DESC`)
        .limit(10);
      return r.map((x) => ({ city: x.city, count: Number(x.count) }));
    });

    const recent = await safe('recentLeads', [], async () => {
      const r = await this.db
        .select()
        .from(leads)
        .orderBy(desc(leads.createdAt))
        .limit(5);
      return r.map(mapToLead);
    });

    // 收集所有失败阶段，按顺序取第一个非空的作为 debug
    const stages = [total, todayCount, unassignedCount, activeCount, avgChatDuration, avgCollectionDuration, collectionCompletionRate, sourceDist, statusDist, cityDist, recent];
    const firstFailure = stages.find((s) => s.debug);
    const debug = firstFailure?.debug;

    return {
      totalLeads: total.value,
      todayNew: todayCount.value,
      unassigned: unassignedCount.value,
      activeSessions: activeCount.value,
      avgChatDuration: avgChatDuration.value,
      avgCollectionDuration: avgCollectionDuration.value,
      collectionCompletionRate: collectionCompletionRate.value,
      sourceDistribution: sourceDist.value,
      statusDistribution: statusDist.value,
      cityDistribution: cityDist.value,
      recentLeads: recent.value,
      debug,
      migrationInfo: this.schemaMigration.lastAttempt.length > 0
        ? this.schemaMigration.lastAttempt
        : undefined,
    };
  }

  /**
   * 手动分配/转派客服
   */
  async assignLead(id: string, assigneeId: string): Promise<Lead> {
    const [row] = await this.db
      .update(leads)
      .set({ assigneeId, assignedAt: new Date(), lastFollowedUpAt: null })
      .where(eq(leads.id, id))
      .returning();

    if (!row) {
      throw new NotFoundException(`线索 ${id} 不存在`);
    }

    return mapToLead(row);
  }

  async getPoolLeads(params: PoolListParams): Promise<PoolListResponse> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(1, params.pageSize ?? 10), 50);

    const conditions = [
      isNull(leads.assigneeId),
      sql`${leads.status} NOT IN ('closed', 'collected')`,
      sql`${leads.leadGrade} IS NULL OR ${leads.leadGrade} IN ('A', 'B', 'C1')`,
    ];

    if (params.serviceCity) {
      conditions.push(eq(leads.serviceCity, params.serviceCity));
    }
    if (params.keyword) {
      const kw = or(
        ilike(leads.customerName, `%${params.keyword}%`),
        ilike(leads.phoneNumber, `%${params.keyword}%`),
      );
      if (kw) conditions.push(kw);
    }

    const whereClause = and(...conditions);

    const totalResult = await this.db.select({ count: count() }).from(leads).where(whereClause);
    const total = Number(totalResult[0]?.count ?? 0);

    const rows = await this.db.select().from(leads)
      .where(whereClause)
      .orderBy(desc(leads.createdAt))
      .offset((page - 1) * pageSize)
      .limit(pageSize);

    return { items: rows.map(mapToLead), total, page, pageSize };
  }

  async claimLead(id: string, userId: string): Promise<Lead> {
    const [row] = await this.db
      .update(leads)
      .set({ assigneeId: userId, assignedAt: new Date(), lastFollowedUpAt: null })
      .where(and(eq(leads.id, id), isNull(leads.assigneeId)))
      .returning();

    if (!row) {
      throw new NotFoundException('线索不存在或已被领取');
    }

    return mapToLead(row);
  }

  async autoAssignPool(): Promise<AutoAssignResult> {
    const assignedCount = await this.dispatchService.assignPendingLeads();
    return { assignedCount };
  }

  async recycleStaleLeads(): Promise<RecycleResult> {
    const staleCondition = and(
      isNotNull(leads.assigneeId),
      sql`${leads.status} NOT IN ('closed', 'collected')`,
      sql`COALESCE(${leads.lastFollowedUpAt}, ${leads.assignedAt}) < NOW() - INTERVAL '3 days'`,
      sql`(${leads.leadGrade} IS NULL OR ${leads.leadGrade} != 'A')`,
    );

    const staleRows = await this.db
      .select({ id: leads.id, assigneeId: leads.assigneeId })
      .from(leads)
      .where(staleCondition);
    if (staleRows.length === 0) {
      return { recycledCount: 0 };
    }

    const loadDeltas = computeRecycleLoadDeltas(staleRows);
    const staleIds = staleRows.map((r) => r.id);
    await this.db.transaction(async (tx) => {
      for (const [agentId, releasedCount] of loadDeltas) {
        await tx
          .update(agents)
          .set({ activeLeadsCount: sql`GREATEST(${agents.activeLeadsCount} - ${releasedCount}, 0)` })
          .where(eq(agents.id, agentId));
      }
      await tx
        .update(leads)
        .set({ assigneeId: null, assignedAt: null, respondedAt: null, assignmentStatus: 'pending' })
        .where(inArray(leads.id, staleIds));
    });

    return { recycledCount: staleRows.length };
  }

  async getGradeHistory(leadId: string): Promise<GradeHistory[]> {
    return this.leadGradingService.getGradeHistory(leadId);
  }

  async regrade(leadId: string, grade: string, reason: string): Promise<void> {
    await this.leadGradingService.regrade(leadId, grade, reason);
  }

  /**
   * 批量补算存量线索分级（线索列表分级列显示为空的修复）
   * 只处理 lead_grade 为 NULL 的行，逐条调用 recomputeGrade。
   */
  async repairMissingGrades(): Promise<{ total: number; updated: number }> {
    const rows = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(isNull(leads.leadGrade))
      .limit(500);
    let updated = 0;
    for (const { id } of rows) {
      try {
        await this.leadGradingService.recomputeGrade(id);
        updated += 1;
      } catch (err) {
        this.logger.warn(
          `补算分级失败 lead=${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    this.logger.log(`存量分级补算完成: total=${rows.length} updated=${updated}`);
    return { total: rows.length, updated };
  }
}
