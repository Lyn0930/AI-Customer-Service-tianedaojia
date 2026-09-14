import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';

/**
 * 一次性 schema 迁移：补齐 commit a994ed5 引入但未在数据库执行的 6 个 leads 列。
 *
 * 触发原因：dashboard /api/leads/stats 在 recentLeads 阶段抛 PostgreSQL 42703（列不存在）。
 * 根因：Drizzle schema 加了列但 release 未触发数据库同步；count(*) 子查询对列不敏感
 *      所以 4 张数字卡正常出数，只有 SELECT * 失败。
 *
 * 触发位置：leads.service.getStats 第一行；in-memory 短路 flag 保证只跑一次。
 * 失败策略：catch + log warn，不阻塞 dashboard —— 业务 INSERT/UPDATE 走 routing/automation
 *          那 6 列会失败是另一回事，本方法只保证 dashboard 这条 SQL 路径能跑。
 */
@Injectable()
export class SchemaMigrationService implements OnModuleInit {
  private readonly logger = new Logger(SchemaMigrationService.name);

  private static readonly MIGRATION_MARKER = '[schema-migration:leads-routing-2026-08-14]';

  private static readonly EXPECTED_LEADS_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
    {
      name: 'pending_assignment_until',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS pending_assignment_until timestamptz(3)',
    },
    {
      name: 'routing_attempts',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_attempts integer NOT NULL DEFAULT 0',
    },
    {
      name: 'last_routing_at',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_routing_at timestamptz(3)',
    },
    {
      name: 'escalated_to_supervisor',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS escalated_to_supervisor boolean NOT NULL DEFAULT false',
    },
    {
      name: 'supervisor_notified_at',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS supervisor_notified_at timestamptz(3)',
    },
    {
      name: 'fallback_notified_at',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS fallback_notified_at timestamptz(3)',
    },
  ];

  /** 老 skillTag → 新 skillTag 映射。
   *  新版（钟点工保姆/白班保姆/育儿保姆/养老保姆/护工保姆/住家保姆/菲式保姆）上线后，
   *  agent_skills 表里历史短码 / 旧全名需要一次性转过来，否则 routing 命中失败。 */
  private static readonly LEGACY_SKILL_MAP: Record<string, string> = {
    钟点工: '钟点工保姆',
    白班: '白班保姆',
    住家: '住家保姆',
    育儿: '育儿保姆',
    护工: '护工保姆',
    养老: '养老保姆',
    菲式: '菲式保姆',
    育儿嫂: '育儿保姆',
    白班阿姨: '白班保姆',
    养老照护: '养老保姆',
  };
  private static readonly SKILL_DATA_MIGRATION_MARKER =
    '[schema-migration:agent-skills-tag-2026-08-14]';
  private skillDataMigrationCompleted = false;

  private completed = false;

  /** 最近一次 ensureLeadsRoutingColumns 的逐列尝试结果（暴露到 dashboard debug 面板）。 */
  public lastAttempt: Array<{ name: string; status: 'ok' | 'fail' | 'skip'; error?: string }> = [];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** Nest 启动钩子：自动跑 leads 列补齐 + skill_tag 数据迁移 + salary_config 表/列/seed + budget 列类型迁移。
   *  in-memory 短路 flag 保证只跑一次；任意一步失败都不阻塞其它步骤与启动。 */
  async onModuleInit(): Promise<void> {
    await this.ensureLeadsRoutingColumns();
    await this.ensureAgentSkillsTagMigration();
    await this.ensureSalaryConfigTableAndSeed();
    await this.ensureBudgetColumnInteger();
  }

  /** 幂等：仅第一次调用真正跑 ALTER；后续直接返回。失败不抛、不重试。 */
  async ensureLeadsRoutingColumns(): Promise<void> {
    if (this.completed) return;
    // 每次重试前清空，UI 面板只显示最近一次的结果
    this.lastAttempt = [];

    try {
      const existing = await this.db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'`,
      );
      const present = new Set(
        (existing as unknown as { column_name: string }[]).map((r) => r.column_name),
      );

      const missing = SchemaMigrationService.EXPECTED_LEADS_COLUMNS.filter(
        (c) => !present.has(c.name),
      );

      for (const col of SchemaMigrationService.EXPECTED_LEADS_COLUMNS) {
        if (present.has(col.name)) {
          this.lastAttempt.push({ name: col.name, status: 'skip' });
        }
      }

      if (missing.length === 0) {
        this.logger.log(
          `${SchemaMigrationService.MIGRATION_MARKER} 全部 ${SchemaMigrationService.EXPECTED_LEADS_COLUMNS.length} 列已存在，跳过迁移`,
        );
        this.completed = true;
        return;
      }

      this.logger.log(
        `${SchemaMigrationService.MIGRATION_MARKER} 缺失 ${missing.length}/${SchemaMigrationService.EXPECTED_LEADS_COLUMNS.length} 列，开始 ALTER: ${missing
          .map((m) => m.name)
          .join(', ')}`,
      );

      for (const col of missing) {
        try {
          await this.db.execute(sql.raw(col.ddl));
          this.lastAttempt.push({ name: col.name, status: 'ok' });
          this.logger.log(`${SchemaMigrationService.MIGRATION_MARKER} ✓ ADD COLUMN ${col.name}`);
        } catch (err) {
          // 把整个 error 对象（message/name/code/cause/severity/detail/hint 等）全 dump 出来
          // ——postgres-js 不同版本错误形态不一样，err.cause / 顶层属性 / 字符串化都能命中。
          const seen = new Set<unknown>();
          const safeStr = (v: unknown): string => {
            if (v === undefined) return '';
            if (v === null) return 'null';
            if (typeof v === 'string') return v;
            if (typeof v === 'number' || typeof v === 'boolean') return String(v);
            try {
              if (seen.has(v)) return '[circular]';
              seen.add(v);
              return JSON.stringify(v);
            } catch {
              return String(v);
            }
          };
          const parts: string[] = [];
          if (err instanceof Error) {
            parts.push(`name: ${err.name}`);
            parts.push(`msg: ${err.message}`);
          } else {
            parts.push(`raw: ${String(err)}`);
          }
          const candidates: Array<Record<string, unknown>> = [];
          candidates.push(err as Record<string, unknown>);
          const cause = (err as { cause?: unknown })?.cause;
          if (cause && typeof cause === 'object') candidates.push(cause as Record<string, unknown>);
          for (const obj of candidates) {
            for (const k of ['code', 'severity', 'detail', 'hint', 'position', 'schema', 'table', 'column', 'where', 'routine']) {
              const v = obj[k];
              if (v !== undefined && v !== null && v !== '') {
                parts.push(`${k}: ${safeStr(v)}`);
              }
            }
          }
          this.lastAttempt.push({ name: col.name, status: 'fail', error: parts.join(' | ') });
          this.logger.warn(`${SchemaMigrationService.MIGRATION_MARKER} ✗ ${col.name}: ${parts.join(' | ')}`);
        }
      }

      this.logger.log(`${SchemaMigrationService.MIGRATION_MARKER} 全部尝试完毕`);
      // 只有全部成功才置 completed=true 短路；只要有一列 fail，保留 attempted=false
      // 让下次请求能重试（典型场景：手动授权 / 锁释放后第二次就过）。
      const hasFailure = this.lastAttempt.some((c) => c.status === 'fail');
      this.completed = !hasFailure;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `${SchemaMigrationService.MIGRATION_MARKER} 整体失败（不阻塞 dashboard）: ${message}`,
      );
      this.lastAttempt.push({ name: '(probe)', status: 'fail', error: message });
    }
  }

  /** 一次性数据迁移：把 agent_skills 老 skillTag 改成新 skillTag。
   *  新版（钟点工保姆/白班保姆/育儿保姆/养老保姆/护工保姆/住家保姆/菲式保姆）上线后，
   *  历史数据里的短码（白班/住家/育儿/护工/养老/钟点工/菲式）和旧全名（育儿嫂/白班阿姨/养老照护）
   *  会让 routing 匹配失败（inArray 查不到），需要一次性 UPDATE。
   *
   *  冲突处理：(assignee_id, skill_tag) 有唯一约束，如果同一 assignee 同时有"老值"和"新值"，
   *  保留新值、删除老值。
   *
   *  触发位置：routing.service 第一处 use 之前；in-memory flag 短路保证只跑一次。
   *  失败策略：catch + log warn，不阻塞 routing —— 极少数遗漏行下次手动补就行。 */
  async ensureAgentSkillsTagMigration(): Promise<void> {
    if (this.skillDataMigrationCompleted) return;
    const marker = SchemaMigrationService.SKILL_DATA_MIGRATION_MARKER;
    const legacyToNew = SchemaMigrationService.LEGACY_SKILL_MAP;
    const legacyTags = Object.keys(legacyToNew);
    const newTags = [...new Set(Object.values(legacyToNew))];

    try {
      // 1) 找所有老值行
      const legacyResult = await this.db.execute<{ id: string; assignee_id: string; skill_tag: string }>(
        sql`SELECT id, assignee_id, skill_tag FROM agent_skills
            WHERE skill_tag IN (${sql.join(legacyTags.map((t) => sql`${t}`), sql`, `)})`,
      );
      const legacyRows = legacyResult as unknown as Array<{
        id: string;
        assignee_id: string;
        skill_tag: string;
      }>;
      if (legacyRows.length === 0) {
        this.logger.log(`${marker} 无老值数据，跳过`);
        this.skillDataMigrationCompleted = true;
        return;
      }

      // 2) 索引 (assignee_id → Set<新值>)
      const newResult = await this.db.execute<{ assignee_id: string; skill_tag: string }>(
        sql`SELECT assignee_id, skill_tag FROM agent_skills
            WHERE skill_tag IN (${sql.join(newTags.map((t) => sql`${t}`), sql`, `)})`,
      );
      const newIndex = new Map<string, Set<string>>();
      for (const r of newResult as unknown as Array<{ assignee_id: string; skill_tag: string }>) {
        if (!newIndex.has(r.assignee_id)) newIndex.set(r.assignee_id, new Set());
        newIndex.get(r.assignee_id)!.add(r.skill_tag);
      }

      // 3) 对每个老值行：同 assignee 已有新值 → DELETE；否则 UPDATE
      let updated = 0;
      let deleted = 0;
      let failed = 0;
      for (const row of legacyRows) {
        const newTag = legacyToNew[row.skill_tag];
        if (!newTag) continue;
        try {
          if (newIndex.get(row.assignee_id)?.has(newTag)) {
            await this.db.execute(sql`DELETE FROM agent_skills WHERE id = ${row.id}`);
            deleted++;
          } else {
            await this.db.execute(
              sql`UPDATE agent_skills SET skill_tag = ${newTag} WHERE id = ${row.id}`,
            );
            updated++;
            if (!newIndex.has(row.assignee_id)) newIndex.set(row.assignee_id, new Set());
            newIndex.get(row.assignee_id)!.add(newTag);
          }
        } catch (err) {
          failed++;
          this.logger.warn(
            `${marker} 跳过 row id=${row.id} skill_tag=${row.skill_tag}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      this.logger.log(
        `${marker} 完成 updated=${updated} deleted=${deleted} failed=${failed} total=${legacyRows.length}`,
      );
      this.skillDataMigrationCompleted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${marker} 整体失败（不阻塞 routing）: ${message}`);
    }
  }

  // ==================== salary_config 2026-08-15 扩列迁移 ====================
  // 业务背景：见 chat.service 注入 persona 的「市场薪资参考」。
  // 6.1.1 住家保姆 6 条（按面积分档，subDimension=''），
  // 6.1.2 钟点工 2 条 + 6.1.3 白班 3 条（按时长分档，不按户型，subDimension=''，areaType='不适用'），
  // 6.1.4 育儿 6 条 + 6.1.5 护工 6 条（按 8h/24h 工作制分档，subDimension='8h'/'24h'），
  // 6.1.6 菲式 4 条（按 8h/24h，仅一线/二三线，无低要求）。
  // 全部数据来源：《天鹅到家 AI 客服 - 客服辅助体系设计方案 v1.0》六章。
  // 业务后续可在「智能路由管理 → 薪资话术」Tab 直接修改，修改后无需发布。
  //
  // 1) 表不存在 → CREATE TABLE IF NOT EXISTS + 全部种子（27 行）
  // 2) 表已存在但无 sub_dimension → ALTER TABLE ADD COLUMN；唯一索引 DROP/RECREATE 为 4 列
  // 3) 差集补种（含旧 6 行 subDimension='' 兼容 + 新 21 行）
  // 4) 表已存在且 27 行都在 → 跳过
  //
  // in-memory 短路 flag 只跑一次；失败不阻塞 chat。

  private static readonly SALARY_CONFIG_MARKER =
    '[schema-migration:salary-config-2026-08-15]';

  private static readonly SALARY_CONFIG_SEED: ReadonlyArray<{
    serviceType: string;
    cityTier: string;
    areaType: string;
    subDimension: string;
    baseLow: number;
    baseHigh: number;
    altLow: number;
    altHigh: number;
  }> = [
    // ===== 6.1.1 住家保姆（按面积分档，subDimension=''）=====
    { serviceType: '住家保姆', cityTier: '一线', areaType: '大面积', subDimension: '', baseLow: 8000, baseHigh: 8500, altLow: 7000, altHigh: 8000 },
    { serviceType: '住家保姆', cityTier: '一线', areaType: '小面积', subDimension: '', baseLow: 6500, baseHigh: 7500, altLow: 5500, altHigh: 6500 },
    { serviceType: '住家保姆', cityTier: '二线', areaType: '大面积', subDimension: '', baseLow: 6000, baseHigh: 7000, altLow: 5000, altHigh: 6000 },
    { serviceType: '住家保姆', cityTier: '二线', areaType: '小面积', subDimension: '', baseLow: 5000, baseHigh: 6000, altLow: 4000, altHigh: 5000 },
    { serviceType: '住家保姆', cityTier: '三线', areaType: '大面积', subDimension: '', baseLow: 5000, baseHigh: 6000, altLow: 4000, altHigh: 5000 },
    { serviceType: '住家保姆', cityTier: '三线', areaType: '小面积', subDimension: '', baseLow: 4500, baseHigh: 5500, altLow: 3500, altHigh: 4500 },

    // ===== 6.1.2 钟点工（2000-3500+ /月，2-5h 工作制，不按户型分档，无低要求）=====
    { serviceType: '钟点工', cityTier: '一线', areaType: '不适用', subDimension: '', baseLow: 3000, baseHigh: 4500, altLow: 0, altHigh: 0 },
    { serviceType: '钟点工', cityTier: '二三线', areaType: '不适用', subDimension: '', baseLow: 2000, baseHigh: 3500, altLow: 0, altHigh: 0 },

    // ===== 6.1.3 白班保姆（3500-5500+ /月，8-9h 不过夜，不按户型分档）=====
    { serviceType: '白班保姆', cityTier: '一线', areaType: '不适用', subDimension: '', baseLow: 6500, baseHigh: 7000, altLow: 5500, altHigh: 6500 },
    { serviceType: '白班保姆', cityTier: '二线', areaType: '不适用', subDimension: '', baseLow: 4500, baseHigh: 5500, altLow: 4000, altHigh: 4500 },
    { serviceType: '白班保姆', cityTier: '三线', areaType: '不适用', subDimension: '', baseLow: 4000, baseHigh: 5000, altLow: 3500, altHigh: 4000 },

    // ===== 6.1.4 育儿保姆（6000~13000+/月，按 8h/24h 分档）=====
    { serviceType: '育儿保姆', cityTier: '一线', areaType: '不适用', subDimension: '8h', baseLow: 9200, baseHigh: 10200, altLow: 8200, altHigh: 9200 },
    { serviceType: '育儿保姆', cityTier: '一线', areaType: '不适用', subDimension: '24h', baseLow: 12000, baseHigh: 13000, altLow: 11000, altHigh: 12000 },
    { serviceType: '育儿保姆', cityTier: '二线', areaType: '不适用', subDimension: '8h', baseLow: 8000, baseHigh: 9000, altLow: 7000, altHigh: 8000 },
    { serviceType: '育儿保姆', cityTier: '二线', areaType: '不适用', subDimension: '24h', baseLow: 10000, baseHigh: 11000, altLow: 9000, altHigh: 10000 },
    { serviceType: '育儿保姆', cityTier: '三线', areaType: '不适用', subDimension: '8h', baseLow: 6000, baseHigh: 7000, altLow: 5000, altHigh: 6000 },
    { serviceType: '育儿保姆', cityTier: '三线', areaType: '不适用', subDimension: '24h', baseLow: 8000, baseHigh: 9000, altLow: 7000, altHigh: 8000 },

    // ===== 6.1.5 护工（4500~11500+/月，按 8h/24h 分档）=====
    { serviceType: '护工', cityTier: '一线', areaType: '不适用', subDimension: '8h', baseLow: 9000, baseHigh: 9500, altLow: 7500, altHigh: 8500 },
    { serviceType: '护工', cityTier: '一线', areaType: '不适用', subDimension: '24h', baseLow: 11000, baseHigh: 11500, altLow: 9500, altHigh: 10500 },
    { serviceType: '护工', cityTier: '二线', areaType: '不适用', subDimension: '8h', baseLow: 7000, baseHigh: 8000, altLow: 6000, altHigh: 7000 },
    { serviceType: '护工', cityTier: '二线', areaType: '不适用', subDimension: '24h', baseLow: 9000, baseHigh: 10000, altLow: 8000, altHigh: 9000 },
    { serviceType: '护工', cityTier: '三线', areaType: '不适用', subDimension: '8h', baseLow: 4500, baseHigh: 5500, altLow: 3500, altHigh: 4500 },
    { serviceType: '护工', cityTier: '三线', areaType: '不适用', subDimension: '24h', baseLow: 6500, baseHigh: 7500, altLow: 5500, altHigh: 6500 },

    // ===== 6.1.6 菲式（7000~8000+/月，按 8h/24h 分档，仅一线/二三线，无低要求）=====
    { serviceType: '菲式', cityTier: '一线', areaType: '不适用', subDimension: '8h', baseLow: 7000, baseHigh: 8000, altLow: 0, altHigh: 0 },
    { serviceType: '菲式', cityTier: '一线', areaType: '不适用', subDimension: '24h', baseLow: 8000, baseHigh: 9000, altLow: 0, altHigh: 0 },
    { serviceType: '菲式', cityTier: '二三线', areaType: '不适用', subDimension: '8h', baseLow: 6000, baseHigh: 7000, altLow: 0, altHigh: 0 },
    { serviceType: '菲式', cityTier: '二三线', areaType: '不适用', subDimension: '24h', baseLow: 7000, baseHigh: 8000, altLow: 0, altHigh: 0 },
  ];

  private salaryConfigMigrationCompleted = false;

  async ensureSalaryConfigTableAndSeed(): Promise<void> {
    if (this.salaryConfigMigrationCompleted) return;
    const marker = SchemaMigrationService.SALARY_CONFIG_MARKER;

    // 先检查表是否已存在（DDL 已通过 lark-cli apps +db-execute 执行）
    // 服务角色无 schema CREATE 权限，CREATE TABLE IF NOT EXISTS 仍会 42501
    const tableCheck = await this.db.execute<{ table_name: string }>(
      sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'salary_config' LIMIT 1`,
    );
    const tableExists =
      (tableCheck as unknown as Array<{ table_name: string }>).length > 0;

    if (!tableExists) {
      // 表不存在 → 尝试 DDL（某些环境服务角色有权限）
      try {
        await this.db.execute(sql`
          DO $ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'user_profile') THEN
              CREATE TYPE user_profile AS (id text);
            END IF;
          END $;
        `);
        await this.db.execute(sql`
          CREATE TABLE IF NOT EXISTS salary_config (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            service_type varchar(50) NOT NULL,
            city_tier varchar(20) NOT NULL,
            area_type varchar(20) NOT NULL,
            sub_dimension varchar(20) NOT NULL DEFAULT '',
            base_low integer NOT NULL,
            base_high integer NOT NULL,
            alt_low integer NOT NULL,
            alt_high integer NOT NULL,
            _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            _created_by user_profile DEFAULT NULL,
            _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            _updated_by user_profile DEFAULT NULL
          )
        `);
        await this.db.execute(
          sql`ALTER TABLE salary_config ADD COLUMN IF NOT EXISTS sub_dimension varchar(20) NOT NULL DEFAULT ''`,
        );
        await this.db.execute(sql`DROP INDEX IF EXISTS uniq_salary_config`);
        await this.db.execute(
          sql`CREATE UNIQUE INDEX uniq_salary_config ON salary_config (service_type, city_tier, area_type, sub_dimension)`,
        );
        await this.db.execute(
          sql`CREATE INDEX IF NOT EXISTS idx_salary_config_service ON salary_config (service_type)`,
        );
        this.logger.log(`${marker} DDL 完成`);
      } catch (ddlErr) {
        const ddlMsg = ddlErr instanceof Error ? ddlErr.message : String(ddlErr);
        this.logger.warn(`${marker} DDL 失败（表可能已通过 lark-cli 创建，继续 seed）: ${ddlMsg}`);
      }
    }

    // 方案 A backfill：旧 serviceType → 新（白班→白班保姆、育儿→育儿保姆）
    try {
      await this.db.execute(
        sql`UPDATE salary_config SET service_type = '白班保姆' WHERE service_type = '白班'`,
      );
      await this.db.execute(
        sql`UPDATE salary_config SET service_type = '育儿保姆' WHERE service_type = '育儿'`,
      );
      this.logger.log(`${marker} backfill 完成`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${marker} backfill 失败（不阻塞）: ${message}`);
    }

    // 差集补种（含老 6 条 subDimension='' 兼容 + 新 21 条 = 27 条）
    try {
      const seed = SchemaMigrationService.SALARY_CONFIG_SEED;
      let inserted = 0;
      let skipped = 0;
      for (const row of seed) {
        const existed = await this.db.execute<{ id: string }>(
          sql`SELECT id FROM salary_config
              WHERE service_type = ${row.serviceType}
                AND city_tier = ${row.cityTier}
                AND area_type = ${row.areaType}
                AND sub_dimension = ${row.subDimension}
              LIMIT 1`,
        );
        const existedRows = existed as unknown as Array<{ id: string }>;
        if (existedRows.length > 0) {
          skipped++;
          continue;
        }
        await this.db.execute(sql`
          INSERT INTO salary_config
            (service_type, city_tier, area_type, sub_dimension, base_low, base_high, alt_low, alt_high)
          VALUES
            (${row.serviceType}, ${row.cityTier}, ${row.areaType}, ${row.subDimension},
             ${row.baseLow}, ${row.baseHigh}, ${row.altLow}, ${row.altHigh})
        `);
        inserted++;
      }
      this.logger.log(
        `${marker} 完成 inserted=${inserted} skipped=${skipped} total=${seed.length}`,
      );
      this.salaryConfigMigrationCompleted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${marker} seed 失败（不阻塞）: ${message}`);
    }
  }

  // ==================== requirements.budget 列类型迁移 2026-09-05 ====================
  // 业务背景：需求采集只采"总预算"一个金额字段（README §5 定稿），后续要做 预算−2000 派生工资，
  // budget 必须是可计算的数值。旧列是 varchar(50)，历史值形如 "6000元"、"6000-8000元/月"、"大概6000"、"6000吧"。
  //
  // 迁移规则（与 chat.service.parseBudgetNumber 口径一致）：
  //   - 取第一个出现的数字（区间 6000-8000 → 6000，保守取下限）
  //   - 提不出数字（如 "面议"）→ NULL（视为未采集）
  //
  // 幂等：已是 integer 则跳过；失败不阻塞启动——列保持 varchar 时，
  // 新写入的数字参数会以文本形态落库（"6000"），后续重试迁移仍可正常转换。

  private static readonly BUDGET_MIGRATION_MARKER =
    '[schema-migration:requirements-budget-integer-2026-09-05]';

  private budgetColumnMigrationCompleted = false;

  async ensureBudgetColumnInteger(): Promise<void> {
    if (this.budgetColumnMigrationCompleted) return;
    const marker = SchemaMigrationService.BUDGET_MIGRATION_MARKER;

    try {
      const typeResult = await this.db.execute<{ data_type: string }>(
        sql`SELECT data_type FROM information_schema.columns
            WHERE table_name = 'requirements' AND column_name = 'budget' LIMIT 1`,
      );
      const typeRows = typeResult as unknown as Array<{ data_type: string }>;
      if (typeRows.length === 0) {
        this.logger.warn(`${marker} requirements.budget 列不存在，跳过（建表流程负责）`);
        return;
      }
      if (typeRows[0].data_type === 'integer') {
        this.logger.log(`${marker} budget 已是 integer，跳过`);
        this.budgetColumnMigrationCompleted = true;
        return;
      }

      this.logger.log(
        `${marker} budget 当前类型 ${typeRows[0].data_type}，开始 ALTER TYPE integer（历史值取第一个数字，区间取下限，无数字置 NULL）`,
      );
      await this.db.execute(sql`
        ALTER TABLE requirements
        ALTER COLUMN budget TYPE integer
        USING (substring(budget from '(\\d+)'))::integer
      `);
      this.logger.log(`${marker} ✓ ALTER 完成，budget 已转为 integer`);
      this.budgetColumnMigrationCompleted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `${marker} 迁移失败（不阻塞启动，下次重启自动重试）。可手动执行 SQL：` +
          `ALTER TABLE requirements ALTER COLUMN budget TYPE integer USING (substring(budget from '(\\d+)'))::integer; 错误：${message}`,
      );
    }
  }
}
