import { Injectable, Inject, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { leads, requirements, cityAssignments, chatSessions } from '@server/database/schema';
import { eq, and, count, desc, or, ilike, sql, isNull, isNotNull } from 'drizzle-orm';
import { RoutingService } from '../routing/routing.service';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import { LeadGradingService } from './lead-grading.service';
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
} from '@shared/api.interface';
import { normalizeSource, sanitizeCity, normalizeLead } from '@shared/channels';
import { normalizeServiceSubType, chineseServiceType } from '../automation/requirement-templates';

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
    private readonly bitableSyncService: BitableSyncService,
    private readonly leadGradingService: LeadGradingService,
    private readonly schemaMigration: SchemaMigrationService,
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
      budget: row.budget ?? null,
      serviceDuration: row.serviceDuration ?? '',
      livingPreference: row.livingPreference ?? '',
      specialRequirements: row.specialRequirements ?? '',
      familyInfo: row.familyInfo ?? '',
      workMode: row.workMode ?? null,
      collectedFields: Array.isArray(row.collectedFields) ? row.collectedFields as { field: string; value: string; label: string }[] : [],
      aiSummary: row.aiSummary ?? '',
      status: row.status as RequirementStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async create(data: CreateLeadRequest): Promise<Lead> {
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

    const historyEntry = JSON.stringify([{
      channel: normalized.channel,
      source: normalized.source,
      serviceCity: normalized.serviceCity,
      customerName: normalized.customerName,
      submittedAt: new Date().toISOString(),
    }]);

    const { row, wasMerged } = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.phoneNumber, normalized.phoneNumber))
        .orderBy(desc(leads.createdAt))
        .limit(1)
        .for('update');

      if (existing.length > 0) {
        const [updated] = await tx
          .update(leads)
          .set({ updatedAt: new Date() })
          .where(eq(leads.id, existing[0].id))
          .returning();
        try {
          await tx.execute(sql`
            UPDATE leads SET cross_channel_history =
              COALESCE(cross_channel_history, '[]'::jsonb) || ${historyEntry}::jsonb
            WHERE id = ${existing[0].id}
          `);
        } catch (err) {
          this.logger.warn(`cross_channel_history append failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return { row: updated, wasMerged: true };
      }

      const [inserted] = await tx
        .insert(leads)
        .values({
          serviceCity: normalized.serviceCity,
          phoneNumber: normalized.phoneNumber,
          customerName: normalized.customerName,
          source: normalized.source,
          phoneVerified: normalized.phoneVerified,
          leadSourceDetail: normalized.leadSourceDetail,
          channel: normalized.channel,
        })
        .returning();
      try {
        await tx.execute(sql`UPDATE leads SET cross_channel_history = ${historyEntry}::jsonb WHERE id = ${inserted.id}`);
      } catch (err) {
        this.logger.warn(`cross_channel_history init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return { row: inserted, wasMerged: false };
    });

    if (cnServiceType && !wasMerged) {
      await this.db.insert(requirements).values({
        leadId: row.id,
        serviceType: cnServiceType,
        status: 'collecting',
      });
    }

    try {
      await this.routingService.routeLead(row.id);
    } catch (error) {
      this.logger.error(
        `智能路由失败，回退到无分配: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    const [updated] = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, row.id))
      .limit(1);

    this.bitableSyncService.syncLeadToBitable(row.id).catch((err: unknown) => {
      this.logger.warn(`多维表格同步失败: ${err instanceof Error ? err.message : String(err)}`);
    });

    return mapToLead(updated);
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
    const stages = [total, todayCount, unassignedCount, activeCount, sourceDist, statusDist, cityDist, recent];
    const firstFailure = stages.find((s) => s.debug);
    const debug = firstFailure?.debug;

    return {
      totalLeads: total.value,
      todayNew: todayCount.value,
      unassigned: unassignedCount.value,
      activeSessions: activeCount.value,
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
    const poolLeads = await this.db.select({ id: leads.id }).from(leads)
      .where(and(
        isNull(leads.assigneeId),
        sql`${leads.status} NOT IN ('closed', 'collected', 'nurturing', 'recycled', 'filtered')`,
        sql`${leads.leadGrade} IS NULL OR ${leads.leadGrade} IN ('A', 'B')`,
      ))
      .orderBy(
        sql`CASE WHEN ${leads.leadGrade} = 'A' THEN 0 ELSE 1 END`,
        desc(leads.createdAt),
      );

    if (poolLeads.length === 0) return { assignedCount: 0 };

    let assignedCount = 0;
    for (const lead of poolLeads) {
      try {
        const result = await this.routingService.routeLead(lead.id);
        if (result.assigneeId) assignedCount++;
      } catch (error) {
        this.logger.error(
          `线索 ${lead.id} 智能路由失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { assignedCount };
  }

  async recycleStaleLeads(): Promise<RecycleResult> {
    const recycled = await this.db
      .update(leads)
      .set({ assigneeId: null, assignedAt: null })
      .where(and(
        isNotNull(leads.assigneeId),
        sql`${leads.status} NOT IN ('closed', 'collected')`,
        sql`COALESCE(${leads.lastFollowedUpAt}, ${leads.assignedAt}) < NOW() - INTERVAL '3 days'`,
        sql`(${leads.leadGrade} IS NULL OR ${leads.leadGrade} != 'A')`,
      ))
      .returning({ id: leads.id });

    return { recycledCount: recycled.length };
  }

  async getGradeHistory(leadId: string): Promise<GradeHistory[]> {
    return this.leadGradingService.getGradeHistory(leadId);
  }

  async regrade(leadId: string, grade: string, reason: string): Promise<void> {
    await this.leadGradingService.regrade(leadId, grade, reason);
  }
}
