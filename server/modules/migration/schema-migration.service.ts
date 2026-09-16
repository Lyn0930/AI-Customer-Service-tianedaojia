import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { DRIZZLE_DATABASE } from '@lark-apaas/fullstack-nestjs-core';
import { SWAN_PERSONA } from '../chat/chat.prompt';

/**
 * 一次性 schema 迁移：补齐 commit a994ed5 引入但未在数据库执行的 6 个 leads 列 +
 * 8/16 跨渠道归一（commit 2a71348）需要的 cross_channel_history 列和 idx_leads_phone_number 索引。
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

  private static readonly MIGRATION_MARKER = '[schema-migration:leads-cross-channel-2026-08-16]';

  // 2026-08-16 林琳 20:53 拍板·钟点工保姆 5+1 步分阶段采集：service_items / service_hours 两列
  // - service_items: chip 5+1 选中的工作内容（做饭/洗衣/打扫卫生/买菜/接送孩子/自定义）
  // 2026-08-22 林琳拍板：service_items / service_hours 从 collectedFields JSON 迁回独立列
  //   走 IF NOT EXISTS 幂等 DDL，失败 catch + warn，不阻塞启动
  private static readonly REQUIREMENTS_MIGRATION_MARKER = '[schema-migration:requirements-zhongdian-fields-2026-08-22]';

  private static readonly EXPECTED_REQUIREMENTS_COLUMNS: ReadonlyArray<{
    name: string;
    ddl: string;
    type: 'column';
  }> = [
    {
      name: 'service_items',
      ddl: 'ALTER TABLE requirements ADD COLUMN IF NOT EXISTS service_items text',
      type: 'column',
    },
    {
      name: 'service_hours',
      ddl: 'ALTER TABLE requirements ADD COLUMN IF NOT EXISTS service_hours varchar(50)',
      type: 'column',
    },
    {
      // 2026-08-22 v1.1：新增 has_pet 字段（是否有宠物，影响阿姨匹配）
      // - IF NOT EXISTS + fail-safe 模式，失败打 error 日志不阻塞业务
      name: 'has_pet',
      ddl: 'ALTER TABLE requirements ADD COLUMN IF NOT EXISTS has_pet varchar(100)',
      type: 'column',
    },
  ];

  private static readonly EXPECTED_LEADS_COLUMNS: ReadonlyArray<{
    name: string;
    ddl: string;
    type: 'column' | 'index';
  }> = [
    // ===== 跨渠道归一 8/16（leads.service.mergeOrCreateByPhone 依赖） =====
    {
      name: 'cross_channel_history',
      ddl: "ALTER TABLE leads ADD COLUMN IF NOT EXISTS cross_channel_history jsonb NOT NULL DEFAULT '[]'::jsonb",
      type: 'column',
    },
    {
      name: 'idx_leads_phone_number',
      ddl: 'CREATE INDEX IF NOT EXISTS idx_leads_phone_number ON leads (phone_number)',
      type: 'index',
    },
    // ===== 历史 6 列（commit a994ed5 8/14 routing） =====
    {
      name: 'pending_assignment_until',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS pending_assignment_until timestamptz(3)',
      type: 'column',
    },
    {
      name: 'routing_attempts',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS routing_attempts integer NOT NULL DEFAULT 0',
      type: 'column',
    },
    {
      name: 'last_routing_at',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS last_routing_at timestamptz(3)',
      type: 'column',
    },
    {
      name: 'escalated_to_supervisor',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS escalated_to_supervisor boolean NOT NULL DEFAULT false',
      type: 'column',
    },
    {
      name: 'supervisor_notified_at',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS supervisor_notified_at timestamptz(3)',
      type: 'column',
    },
    {
      name: 'fallback_notified_at',
      ddl: 'ALTER TABLE leads ADD COLUMN IF NOT EXISTS fallback_notified_at timestamptz(3)',
      type: 'column',
    },
    // 2026-08-25 v4 修复：leads 表加 service_type 列，供开场白 willPushFormCard 判断
    // 渠道表单进来的 lead 必须有 serviceType，否则开场白走老模板（从头问服务类型）
    {
      name: 'service_type',
      ddl: "ALTER TABLE leads ADD COLUMN IF NOT EXISTS service_type varchar(50) NOT NULL DEFAULT ''",
      type: 'column',
    },
      ];

  // ===== requirements 表 2026-08-16 钟点工 5+1 步分阶段采集 =====
  // 2026-08-16 林琳 20:53 拍板：service_items / service_hours 改存到 collectedFields JSON，
  //   **不再**新增列（原因：production DB user role 无 ALTER 权限，DDL 42501 失败 → INSERT 500）。
  // private static readonly EXPECTED_REQUIREMENTS_COLUMNS: ReadonlyArray<{
  //   name: string;
  //   ddl: string;
  //   type: 'column' | 'index';
  // }> = [
  //   { name: 'service_items', ddl: '...', type: 'column' },
  //   { name: 'service_hours', ddl: '...', type: 'column' },
  // ];

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

  private static readonly PERSONA_SYNC_MARKER =
    '[persona-sync:swan-persona-2026-09-14]';
  private personaSyncCompleted = false;

  private completed = false;
  private requirementsColumnsCompleted = false;

  /** 最近一次 ensureLeadsRoutingColumns 的逐列尝试结果（暴露到 dashboard debug 面板）。 */
  public lastAttempt: Array<{ name: string; status: 'ok' | 'fail' | 'skip'; error?: string }> = [];

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /** Nest 启动钩子：自动跑 leads 列补齐 + skill_tag 数据迁移 + salary_config 表/列/seed。
   *  in-memory 短路 flag 保证只跑一次；任意一步失败都不阻塞其它步骤与启动。
   *  8/16 备注：每次启动**重置**所有 completed 标志 — 解决 miaoda 平台 hot-reload 时
   *  onModuleInit 不重跑、DDL 不生效的问题（即使代码改完部署，旧实例还卡在 completed=true）。
   *  DDL 用 IF NOT EXISTS 幂等，重复跑安全；性能损耗在启动时一次性，可忽略。 */
  async onModuleInit(): Promise<void> {
    this.completed = false;
    this.skillDataMigrationCompleted = false;
    this.salaryConfigMigrationCompleted = false;
    this.personaSyncCompleted = false;
    // 2026-08-22 林琳拍板：service_items / service_hours 从 JSON 迁回独立列
    //   走 IF NOT EXISTS 幂等 DDL，失败 catch + warn，不阻塞启动
    this.requirementsColumnsCompleted = false;
    await this.ensureLeadsRoutingColumns();
    await this.ensureRequirementsZhongdianColumns();
    await this.ensureAgentSkillsTagMigration();
    await this.ensureSalaryConfigTableAndSeed();
    await this.ensureSwanPersonaSynced();
  }

  /** 幂等：每次调用都跑探测 + IF NOT EXISTS DDL；失败不抛、不重试。
   *  8/16 修改：去掉 `if (this.completed) return;` 短路 —
   *  解决 miaoda 平台 hot-reload 时即使部署新代码，进程不重启导致 completed flag 卡在 true、DDL 不跑的问题。
   *  性能损耗：每次调用多 1 个 information_schema.columns SELECT + 1 个 pg_indexes SELECT +
   *            N 个 ALTER/CREATE INDEX IF NOT EXISTS（DB 端快速判断 exists 跳过）。 */
  async ensureLeadsRoutingColumns(): Promise<void> {
    // 每次重试前清空，UI 面板只显示最近一次的结果
    this.lastAttempt = [];

    try {
      const total = SchemaMigrationService.EXPECTED_LEADS_COLUMNS.length;
      const columns = SchemaMigrationService.EXPECTED_LEADS_COLUMNS.filter((c) => c.type === 'column');
      const indexes = SchemaMigrationService.EXPECTED_LEADS_COLUMNS.filter((c) => c.type === 'index');

      // 探测：列走 information_schema.columns，索引走 pg_indexes
      const [columnResult, indexResult] = await Promise.all([
        columns.length > 0
          ? this.db.execute<{ column_name: string }>(
              sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'leads'`,
            )
          : Promise.resolve([]),
        indexes.length > 0
          ? this.db.execute<{ indexname: string }>(
              sql`SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'leads'`,
            )
          : Promise.resolve([]),
      ]);

      const presentColumns = new Set(
        (columnResult as unknown as { column_name: string }[]).map((r) => r.column_name),
      );
      const presentIndexes = new Set(
        (indexResult as unknown as { indexname: string }[]).map((r) => r.indexname),
      );

      const missing: Array<{ name: string; ddl: string; type: 'column' | 'index' }> = [];
      for (const col of SchemaMigrationService.EXPECTED_LEADS_COLUMNS) {
        const present = col.type === 'column' ? presentColumns.has(col.name) : presentIndexes.has(col.name);
        if (present) {
          this.lastAttempt.push({ name: col.name, status: 'skip' });
        } else {
          missing.push(col);
        }
      }

      if (missing.length === 0) {
        this.logger.log(
          `${SchemaMigrationService.MIGRATION_MARKER} 全部 ${total} 列/索引已存在，跳过迁移`,
        );
        this.completed = true;
        return;
      }

      this.logger.log(
        `${SchemaMigrationService.MIGRATION_MARKER} 缺失 ${missing.length}/${total} 列，开始迁移: ${missing
          .map((m) => m.name)
          .join(', ')}`,
      );

      for (const col of missing) {
        try {
          await this.db.execute(sql.raw(col.ddl));
          this.lastAttempt.push({ name: col.name, status: 'ok' });
          // 按类型输出对应成功 log（用户期望：「ALTER 成功: cross_channel_history」
          // 和「CREATE INDEX 成功: idx_leads_phone_number」）
          if (col.type === 'column') {
            this.logger.log(`${SchemaMigrationService.MIGRATION_MARKER} ALTER 成功: ${col.name}`);
          } else {
            this.logger.log(`${SchemaMigrationService.MIGRATION_MARKER} CREATE INDEX 成功: ${col.name}`);
          }
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

  // ==================== requirements 表 2026-08-22 钟点工字段迁为独立列迁移 ====================
  // 2026-08-22 林琳拍板：service_items / service_hours 从 collectedFields JSON 迁为独立列
  //   走 IF NOT EXISTS 幂等 DDL，失败 catch + warn，不阻塞启动
  async ensureRequirementsZhongdianColumns(): Promise<void> {
    const marker = SchemaMigrationService.REQUIREMENTS_MIGRATION_MARKER;
    try {
      const total = SchemaMigrationService.EXPECTED_REQUIREMENTS_COLUMNS.length;

      // 探测：走 information_schema.columns
      const columnResult = await this.db.execute<{ column_name: string }>(
        sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'requirements'`,
      );

      const presentColumns = new Set(
        (columnResult as unknown as { column_name: string }[]).map((r) => r.column_name),
      );

      const missing: Array<{ name: string; ddl: string }> = [];
      for (const col of SchemaMigrationService.EXPECTED_REQUIREMENTS_COLUMNS) {
        if (presentColumns.has(col.name)) {
          this.logger.log(`${marker} 列已存在，跳过: ${col.name}`);
        } else {
          missing.push(col);
        }
      }

      if (missing.length === 0) {
        this.logger.log(`${marker} 全部 ${total} 列已存在，跳过迁移`);
        this.requirementsColumnsCompleted = true;
        return;
      }

      this.logger.log(
        `${marker} 缺失 ${missing.length}/${total} 列，开始迁移: ${missing.map((m) => m.name).join(', ')}`,
      );

      for (const col of missing) {
        try {
          await this.db.execute(sql.raw(col.ddl));
          this.logger.log(`${marker} ALTER 成功: ${col.name}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(`${marker} ALTER 失败: ${col.name} — ${message}（不阻塞启动）`);
        }
      }

      this.requirementsColumnsCompleted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${marker} 迁移失败（不阻塞启动）: ${message}`);
    }
  }

  // ==================== swan_persona 强制同步 ====================
  /** 每次启动把代码里的 SWAN_PERSONA 强制 UPSERT 到 ai_configs 表（代码为唯一事实源）。
   *  历史：旧实现按 v4 标记（"表单 + 对话混合采集"）探测跳过，代码后续新增段落不再同步，
   *       DB 覆盖行停在旧版导致「费用口径兜底」等段运行时缺失（2026-09-14 排查确认并修复）。
   *  语义：后台 AI 配置 tab 仍可临时改 swan_persona 作为热修通道，下次进程启动会被代码版覆盖。
   *  幂等：ON CONFLICT 单语句；失败 catch + warn，不阻塞启动（getPersonaWithQa 无 DB 行时回退代码版）。 */
  async ensureSwanPersonaSynced(): Promise<void> {
    const marker = SchemaMigrationService.PERSONA_SYNC_MARKER;
    try {
      await this.db.execute(sql`
        INSERT INTO ai_configs (config_key, config_value, config_type, description)
        VALUES ('swan_persona', ${SWAN_PERSONA}, 'text', '天鹅到家 AI 客服 persona（代码为唯一事实源，每次部署自动覆盖）')
        ON CONFLICT (config_key) DO UPDATE
        SET config_value = EXCLUDED.config_value,
            description = EXCLUDED.description,
            _updated_at = CURRENT_TIMESTAMP
      `);
      this.logger.log(`${marker} swan_persona 已与代码版同步（强制覆盖）`);
      this.personaSyncCompleted = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`${marker} 失败（不阻塞启动）: ${message}`);
    }
  }
}
