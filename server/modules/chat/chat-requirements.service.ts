import { Injectable, Logger, forwardRef, Inject, NotFoundException } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase, CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc, sql, type SQL } from 'drizzle-orm';
import { requirements, chatMessages, leads, chatSessions } from '@server/database/schema';
import { RequirementCollectionService } from '../automation/requirement-collection.service';
import { AiConfigService } from '../admin/ai-config.service';
import { NotifyService } from '../notify/notify.service';
import { LeadGradingService } from '../leads/lead-grading.service';
import { ChatTransferService } from './chat-transfer.service';
import { ChatSessionService } from './chat-session.service';
import { normalizeStream } from './stream-utils';
import { normalizeServiceType, normalizeServiceSubType, chineseServiceType, getServiceTypeLabel, isRequirementCompleteForTransfer, isZhujiaRequiredFieldsComplete, isZhongdianRequiredFieldsComplete, isValidBaomuType, getDefaultServiceHours } from '../automation/requirement-templates';
import { normalizeFieldByKey, unionMergeMultiValue } from './lead-field-normalizer';
import {
  RequirementDeltaService,
  type FieldDeltaSource,
  type FieldDeltaChange,
} from '../leads/requirement-delta.service';
import {
  REQUIREMENT_FIELDS,
  FIELD_KEYS,
  FIELD_LABELS,
} from '../automation/requirement-fields.config';
import {
  REQUIREMENT_EXTRACTION_PLUGIN_ID,
  REQUIREMENT_EXTRACTION_ACTION_KEY,
  REQUIREMENT_EXTRACTION_INTERVAL,
  FIELDS_START_MARKER,
  FIELDS_END_MARKER,
  SUMMARY_PLUGIN_ID,
  SUMMARY_ACTION_KEY,
  detectServiceTypeFromText,
  detectAreaFromText,
} from './chat.prompt';
import type {
  Requirement,
  RequirementStatus,
  CollectionProgress,
} from '@shared/api.interface';

/** AI 需求提取返回的结构（字段全为 string | null） */
interface ExtractedRequirement {
  service_type: string | null;
  service_items: string | null;
  service_hours: string | null;
  household_size: string | null;
  area: string | null;
  elderly_care: string | null;
  child_care: string | null;
  rest_days: string | null;
  start_time: string | null;
  service_address: string | null;
  helper_requirements: string | null;
  dietary_preferences: string | null;
  budget: string | null;
  special_requirements: string | null;
}

/**
 * AI 增强字段结构：每个字段带 status / confidence / source 三个元数据
 *
 * 为什么需要：
 *   - status：采集状态（clear/vague/none），AI 判断该问什么、全齐转人工、进度面板都依赖它
 *   - confidence：置信度（0~1），参与写入判定：≥ 0.5 才写库
 *   - source：来源证据（客户原话引用），可追溯、方便调试审核
 *
 * 2026-09-12 按《AI 客服智能路由与需求采集需求方案》§5.5 调整：
 *   - confidence < 0.5 的字段不写入 requirements（宁缺勿错，下一轮追问补齐）
 *   - status/confidence/source 为过程数据，判定后丢弃，不落库元数据（field_metadata 列停用不删）
 */
interface EnrichedField {
  value: string | null;
  status: 'clear' | 'vague' | 'none';
  confidence: number;
  source: string | null;
}

type EnrichedRequirement = Record<keyof ExtractedRequirement, EnrichedField>;

/** 写入库的最低置信度（文档 §5.5：低置信度宁缺勿错，下一轮追问补齐） */
const MIN_FIELD_CONFIDENCE = 0.5;

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
export class ChatRequirementsService {
  private readonly logger = new Logger(ChatRequirementsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly requirementCollectionService: RequirementCollectionService,
    private readonly requirementDeltaService: RequirementDeltaService,
    private readonly aiConfigService: AiConfigService,
    private readonly capabilityService: CapabilityService,
    private readonly notifyService: NotifyService,
    @Inject(forwardRef(() => LeadGradingService))
    private readonly leadGradingService: LeadGradingService,
    @Inject(forwardRef(() => ChatTransferService))
    private readonly chatTransferService: ChatTransferService,
    @Inject(forwardRef(() => ChatSessionService))
    private readonly chatSessionService: ChatSessionService,
  ) {}

  /**
   * 获取 lead 对应的 requirement
   */
  public async getRequirementByLeadId(
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
   * 底层统一入口：需求字段全齐后自动转人工（2026-08-29 下沉重构）
   *
   * 所有需求写入路径（extractAndSaveRequirements / mergeRequirementFields /
   * saveParsedFields / 实时字段检测）写入成功后统一调用，替代原先散落在
   * chat.service 两处改写 LLM 回复文本的护栏。
   *
   * 规则：
   *   - 住家：8 字段全齐；钟点工：9 字段全齐；其他类型：服务类型+地址+预算 3 项齐
   *   - 钟点工+无月休：不转人工（林琳 8/16 19:44 拍板）
   *   - 会话已是 human 模式：幂等跳过（doTransferToHuman 内部也有守卫）
   */
  public async autoTransferIfFieldsComplete(leadId: string): Promise<boolean> {
    const requirement = await this.getRequirementByLeadId(leadId);
    if (!requirement?.serviceType) return false;

    if (!isRequirementCompleteForTransfer(requirement)) return false;

    // 钟点工+无月休是 8/16 19:44 林琳拍板的例外：字段全齐也不转人工
    const subType = normalizeServiceSubType(requirement.serviceType);
    if (subType === 'zhongdian' && requirement.restDays === '无月休') {
      this.logger.log(`线索 ${leadId.slice(0, 8)} 钟点工+无月休，字段全齐但不转人工`);
      return false;
    }

    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(desc(chatSessions.startedAt))
      .limit(1);
    const sessionRow = sessionRows[0];
    if (!sessionRow || sessionRow.mode === 'human') return false;

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    const lead = leadRows.length > 0 ? this.chatSessionService.mapLead(leadRows[0]) : null;

    this.logger.log(`线索 ${leadId.slice(0, 8)} 需求字段全齐（${subType}），底层自动转人工`);
    await this.chatTransferService.doTransferToHuman(
      sessionRow.id,
      '需求采集完成',
      'auto',
      lead,
      '您的情况我都记下了~ 这边为您转接专员，由专员为您详细确认~',
    );
    return true;
  }

  /**
   * 将 DB 行映射为 Requirement 对象
   */
  public mapRequirement(
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
      specialRequirements: row.specialRequirements,
      serviceItems: row.serviceItems,
      serviceHours: row.serviceHours,
      hasPet: row.hasPet,
      source: row.source,
      cardSubmittedAt: row.cardSubmittedAt,
      childCare: row.childCare,
      aiSummary: row.aiSummary,
      status: row.status as RequirementStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * 快速写入服务类型（关键词识别后调用）
   */
  public async upsertServiceType(
    leadId: string,
    serviceType: string,
  ): Promise<void> {
    // v6 重构：6 种保姆类型白名单校验
    // - 不在白名单 → 整条 requirements 记录删除
    // - 白班/住家 → 自动填充默认 service_hours
    if (!isValidBaomuType(serviceType)) {
      await this.db.delete(requirements).where(eq(requirements.leadId, leadId));
      return;
    }
    const defaultHours = getDefaultServiceHours(serviceType);

    // 2026-08-15：用 ON CONFLICT DO UPDATE 走 anon 合法路径（service_type 不空，COALESCE 总是用 EXCLUDED）
    if (defaultHours) {
      await this.db.execute(sql`
        INSERT INTO requirements (lead_id, service_type, service_hours, status)
        VALUES (${leadId}, ${serviceType}, ${defaultHours}, 'collecting')
        ON CONFLICT (lead_id) DO UPDATE SET
          service_type = EXCLUDED.service_type,
          service_hours = COALESCE(NULLIF(EXCLUDED.service_hours, ''), requirements.service_hours)
      `);
    } else {
      await this.db.execute(sql`
        INSERT INTO requirements (lead_id, service_type, status) VALUES (${leadId}, ${serviceType}, 'collecting')
        ON CONFLICT (lead_id) DO UPDATE SET service_type = EXCLUDED.service_type
      `);
    }
  }

  /**
   * 调用 AI 提取结构化需求并 upsert 到 requirements 表
   */
  public async extractAndSaveRequirements(
    leadId: string,
    sessionId: string,
    skipAutoTransfer = false,
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

    // 判定核心字段是否完成（2026-08-29 统一下沉到 isRequirementCompleteForTransfer）：
    //   - 住家 8 字段 / 钟点工 9 字段 / 育儿 3 字段+照顾小孩 / 其他类型 服务类型+地址+预算
    //   - 注：钟点工+无月休时 isCompleted 仍为 true（8/16 19:44 拍板"无月休不转人工"由 autoTransferIfFieldsComplete 根据 restDays 决定）
    const isCompleted = isRequirementCompleteForTransfer({
      serviceType: result.service_type,
      householdSize: result.household_size,
      area: result.area,
      elderlyCare: result.elderly_care,
      childCare: result.child_care,
      restDays: result.rest_days,
      startTime: result.start_time,
      serviceAddress: result.service_address,
      helperRequirements: result.helper_requirements,
      dietaryPreferences: result.dietary_preferences,
      budget: result.budget,
      serviceItems: result.service_items,
      serviceHours: result.service_hours,
    });

    const status: RequirementStatus = isCompleted ? 'completed' : 'collecting';

    // v6 重构：6 种保姆类型白名单校验
    // - service_type 不在白名单 → 整条 requirements 记录删除
    // - 白班/住家保姆 → 自动填充默认 service_hours
    const normalizedServiceType = result.service_type ? chineseServiceType(normalizeServiceSubType(result.service_type)) : null;
    if (normalizedServiceType && !isValidBaomuType(normalizedServiceType)) {
      await this.db.delete(requirements).where(eq(requirements.leadId, leadId));
      return;
    }
    const defaultHours = normalizedServiceType ? getDefaultServiceHours(normalizedServiceType) : null;
    const finalServiceHours = result.service_hours ?? defaultHours;

    // 2026-08-29 字段标准化 v2：DB 存结构化值（家庭人口/面积纯数字、预算 JSON 区间、老人照护/到岗时间枚举、口味去口语化）
    const normHouseholdSize = normalizeFieldByKey('householdSize', result.household_size);
    const normArea = normalizeFieldByKey('area', result.area);
    const normElderlyCare = normalizeFieldByKey('elderlyCare', result.elderly_care);
    const normStartTime = normalizeFieldByKey('startTime', result.start_time);
    const normDietaryPreferences = normalizeFieldByKey('dietaryPreferences', result.dietary_preferences);
    const normBudget = normalizeFieldByKey('budget', result.budget);
    // 累加型字段 union 合并（2026-09-02 改用 unionMergeMultiValue，支持子串包含去重：
    //   "有经验"覆盖"经验"、"爱吃辣"覆盖"辣"）：AI 提取可能漏提部分内容，
    //   直接 COALESCE 会覆盖掉实时检测/之前提取已采到的多值。
    const existingReq = await this.getRequirementByLeadId(leadId);
    const mergedHelperRequirements: string | null = existingReq
      ? unionMergeMultiValue(existingReq.helperRequirements, result.helper_requirements)
      : (result.helper_requirements ?? null);
    const mergedDietaryPreferences: string | null = existingReq
      ? unionMergeMultiValue(existingReq.dietaryPreferences, normDietaryPreferences)
      : normDietaryPreferences;
    // 2026-08-29 service_items 仅钟点工采集：已知非钟点工不再写入（历史数据保留）
    const serviceItemsToStore =
      normalizedServiceType && normalizeServiceSubType(normalizedServiceType) !== 'zhongdian'
        ? null
        : (result.service_items ?? null);

    // upsert requirements — merge 模式：不覆盖已有值，只填充新值
    // 2026-08-15：用 INSERT ... ON CONFLICT (lead_id) DO UPDATE 走 anon 合法路径
    // （anon 没有 UPDATE 政策，UPDATE 会静默 0 行；ON CONFLICT DO UPDATE 走 INSERT WITH CHECK=true 永远 pass）
    // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
    await this.db.execute(sql`
      INSERT INTO requirements (
        lead_id, service_type, household_size, area, elderly_care, child_care, rest_days, start_time,
        service_address, helper_requirements, dietary_preferences, budget,
        special_requirements, service_items, service_hours, has_pet, status
      ) VALUES (
        ${leadId},
        ${normalizedServiceType},
        ${normHouseholdSize ?? null},
        ${normArea ?? null},
        ${normElderlyCare ?? null},
        ${result.child_care ?? null},
        ${result.rest_days ?? null},
        ${normStartTime ?? null},
        ${result.service_address ?? null},
         ${mergedHelperRequirements ?? null},
         ${mergedDietaryPreferences ?? null},
        ${normBudget ?? null},
        ${result.special_requirements ?? null},
        ${serviceItemsToStore},
        ${finalServiceHours ?? null},
        ${(result as any).has_pet ?? null},
        ${status}
      )
      ON CONFLICT (lead_id) DO UPDATE SET
        -- 2026-09-14 移植收平：老值优先，只填空不覆盖（与 mergeRequirementFields 语义统一）。
        -- COALESCE(requirements.X, NULLIF(EXCLUDED.X, ''))：老值非空保老值，老值空才填新值；
        -- NULLIF 把新值 '' 转 NULL，防空字符串钉住行。
        service_type = COALESCE(requirements.service_type, NULLIF(EXCLUDED.service_type, '')),
        household_size = COALESCE(requirements.household_size, NULLIF(EXCLUDED.household_size, '')),
        area = COALESCE(requirements.area, NULLIF(EXCLUDED.area, '')),
        elderly_care = COALESCE(requirements.elderly_care, NULLIF(EXCLUDED.elderly_care, '')),
        child_care = COALESCE(requirements.child_care, NULLIF(EXCLUDED.child_care, '')),
        rest_days = COALESCE(requirements.rest_days, NULLIF(EXCLUDED.rest_days, '')),
        start_time = COALESCE(requirements.start_time, NULLIF(EXCLUDED.start_time, '')),
        service_address = COALESCE(requirements.service_address, NULLIF(EXCLUDED.service_address, '')),
        helper_requirements = COALESCE(requirements.helper_requirements, NULLIF(EXCLUDED.helper_requirements, '')),
        dietary_preferences = COALESCE(requirements.dietary_preferences, NULLIF(EXCLUDED.dietary_preferences, '')),
        budget = COALESCE(requirements.budget, NULLIF(EXCLUDED.budget, '')),
        special_requirements = COALESCE(requirements.special_requirements, NULLIF(EXCLUDED.special_requirements, '')),
        service_items = COALESCE(requirements.service_items, NULLIF(EXCLUDED.service_items, '')),
        service_hours = COALESCE(requirements.service_hours, NULLIF(EXCLUDED.service_hours, '')),
        has_pet = COALESCE(requirements.has_pet, NULLIF(EXCLUDED.has_pet, '')),
        status = CASE WHEN requirements.status = 'completed' THEN requirements.status ELSE EXCLUDED.status END
    `);

    // 同步更新 leads 表：采集字段
    const normalizedType = result.service_type ? normalizeServiceType(result.service_type) : null;
    const urgencyLevel = result.start_time ? inferUrgencyLevel(result.start_time) : undefined;
    await this.db
      .update(leads)
      .set({
        budgetRange: sql`COALESCE(${leads.budgetRange}, NULLIF(${normBudget ?? null}, ''))`,
        serviceStartTime: sql`COALESCE(${leads.serviceStartTime}, NULLIF(${result.start_time ?? null}, ''))`,
        specialRequirements: sql`COALESCE(${leads.specialRequirements}, NULLIF(${result.special_requirements ?? null}, ''))`,
        ...(urgencyLevel !== undefined ? { urgencyLevel } : {}),
        ...(isCompleted ? { status: 'collected', intent: normalizedType } : {}),
      })
      .where(eq(leads.id, leadId));

    this.leadGradingService.recomputeGrade(leadId).catch((err: unknown) => {
      this.logger.warn(
        `分级重算失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

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

    }

    if (!skipAutoTransfer) {
      try {
        await this.autoTransferIfFieldsComplete(leadId);
      } catch (err) {
        this.logger.error(
          `字段全齐自动转人工失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }



  /**
   * 从 AI 合并回复中解析结构化字段（增强版：value + status + confidence + source）
   *
   * 支持两种格式（自动识别）：
   *   1. 增强格式（新）：每个字段是 { value, status, confidence, source } 对象
   *   2. 简单格式（旧，兼容）：每个字段是 string | null
   *
   * 无论哪种格式，都统一返回 { reply, fields, enrichedFields }
   *   - fields: 简单值格式（ExtractedRequirement），用于写入 DB
   *   - enrichedFields: 增强格式（含 status/confidence/source），用于日志、调试、置信度判断
   *
   * @param fullResponse AI 完整回复文本
   */
  public parseFieldsFromAiReply(fullResponse: string): {
    reply: string;
    fields: ExtractedRequirement | null;
    enrichedFields: EnrichedRequirement | null;
  } {
    const startIdx = fullResponse.indexOf(FIELDS_START_MARKER);
    const endIdx = fullResponse.indexOf(FIELDS_END_MARKER);

    // 没有字段标记 → 原样返回
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return { reply: fullResponse, fields: null, enrichedFields: null };
    }

    const reply = fullResponse.slice(0, startIdx).trim();
    const jsonStr = fullResponse.slice(startIdx + FIELDS_START_MARKER.length, endIdx).trim();

    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

      // 检测格式：第一个字段的值是对象还是字符串
      const firstKey = Object.keys(parsed)[0];
      const isEnriched = firstKey && typeof parsed[firstKey] === 'object' && parsed[firstKey] !== null && 'value' in (parsed[firstKey] as object);

      // 从配置生成 snake_case 字段键列表（只含有独立 DB 列的字段 + JSON 存储的也一起解析）
      const fieldKeys = FIELD_KEYS.map((k) => REQUIREMENT_FIELDS[k].dbColumn) as Array<keyof ExtractedRequirement>;

      // 动态构建初始 fields 对象
      const fields: ExtractedRequirement = {} as ExtractedRequirement;
      for (const key of fieldKeys) {
        (fields as any)[key] = null;
      }

      const enrichedFields: EnrichedRequirement = {} as EnrichedRequirement;

      for (const key of fieldKeys) {
        const raw = parsed[key];

        if (isEnriched && raw && typeof raw === 'object' && 'value' in raw) {
          // 增强格式：value + status + confidence + source
          const obj = raw as Partial<EnrichedField>;
          const val = obj.value ?? null;
          fields[key] = (val === '' || val === undefined) ? null : String(val);

          const status = (obj.status === 'clear' || obj.status === 'vague' || obj.status === 'none')
            ? obj.status
            : (val && val !== '' ? 'clear' : 'none');
          const confidence = typeof obj.confidence === 'number' ? obj.confidence : (val ? 0.8 : 0);
          const source = obj.source ?? null;

          enrichedFields[key] = {
            value: fields[key],
            status,
            confidence,
            source: typeof source === 'string' ? source : null,
          };
        } else {
          // 简单格式（兼容旧版）
          const val = (raw === null || raw === undefined || raw === '') ? null : String(raw);
          fields[key] = val;

          // 简单格式下，根据值推断 status，confidence 给默认值、source 为 null
          const status: 'clear' | 'vague' | 'none' = val ? 'clear' : 'none';
          enrichedFields[key] = {
            value: val,
            status,
            confidence: val ? 0.8 : 0,
            source: null,
          };
        }
      }

      const nonNullCount = Object.values(fields).filter((v) => v).length;
      const clearCount = Object.values(enrichedFields).filter((f) => f.status === 'clear').length;
      const vagueCount = Object.values(enrichedFields).filter((f) => f.status === 'vague').length;
      const vagueFields = Object.entries(enrichedFields)
        .filter(([, f]) => f.status === 'vague')
        .map(([k]) => k)
        .join(', ');
      this.logger.log(
        `AI 合并字段解析成功（${isEnriched ? '增强格式' : '简单格式'}）: ` +
        `${nonNullCount} 个有值（clear=${clearCount}, vague=${vagueCount}${vagueFields ? ': ' + vagueFields : ''}）`,
      );

      return { reply, fields, enrichedFields };
    } catch (err) {
      this.logger.warn(
        `AI 合并字段解析失败: ${err instanceof Error ? err.message : String(err)}，JSON 片段: ${jsonStr.slice(0, 100)}`,
      );
      // 解析失败时，把字段部分也从回复里去掉（避免客户看到 JSON）
      return { reply, fields: null, enrichedFields: null };
    }
  }

  /**
   * 字段提取完整性校验：AI 提取结果可能丢失方向词、限定词等关键信息，
   * 用代码正则做兜底校验，发现信息丢失就用客户原话覆盖。
   *
   * 校验字段：
   *   - dietaryPreferences（做饭口味）：方向词丢失检测（爱吃辣≠辣）
   *   - helperRequirements（阿姨要求）：限定词丢失检测（有照顾小孩经验≠经验）
   *
   * 2026-08-31 林琳反馈：AI 提取丢信息太严重，逐个修太慢，加代码层校验兜底。
   *
   * @param enrichedFields AI 提取的增强格式字段
   * @param customerMessage 客户原话（最近一条客户消息）
   * @returns 修正后的 enrichedFields（原地修改并返回）
   */
  public validateFieldExtraction(
    enrichedFields: EnrichedRequirement,
    customerMessage: string,
  ): EnrichedRequirement {
    const msg = customerMessage.trim();
    if (!msg) return enrichedFields;

    // ========== 1. 做饭口味：方向词丢失检测 ==========
    const dietaryField = enrichedFields.dietary_preferences;
    if (dietaryField && dietaryField.value && dietaryField.status === 'clear') {
      const extracted = dietaryField.value.trim();
      // 方向词：客户原话里有但提取结果里没有 → 信息丢了
      const DIRECTION_WORDS = [
        '爱吃', '喜欢吃', '偏爱吃', '爱喝', '好这口', '好这一口',
        '不吃', '忌', '不喜欢', '吃不了', '不能吃', '不要', '少',
        '偏好', '喜欢', '爱',
      ];
      // 口味核心词（有方向歧义的，比如"辣"可以是爱吃也可以是不吃）
      // 注意：菜系名（粤菜/川菜等）不放这里——没有方向歧义，"喜欢吃粤菜"→"粤菜"不算丢信息
      const TASTE_WORDS = [
        '辣', '清淡', '重口', '重口味', '咸', '甜', '酸', '苦', '鲜',
        '微辣', '中辣', '特辣', '麻辣', '酸辣', '甜辣',
        '生冷', '油腻',
      ];

      const msgHasDirection = DIRECTION_WORDS.some((w) => msg.includes(w));
      const msgHasTaste = TASTE_WORDS.some((w) => msg.includes(w));
      const extractedHasDirection = DIRECTION_WORDS.some((w) => extracted.includes(w));

      // 原话有方向词+口味词，但提取结果没有方向词 → 方向丢了，用原话覆盖
      if (msgHasDirection && msgHasTaste && !extractedHasDirection) {
        const cleaned = this.cleanFieldValue(msg);
        this.logger.warn(
          `做饭口味方向丢失，用原话覆盖: AI="${extracted}" → 原话="${cleaned}"`,
        );
        dietaryField.value = cleaned;
        dietaryField.source = 'code_validation_override';
      }
    }

    // ========== 2. 阿姨要求：限定词丢失检测 ==========
    const helperField = enrichedFields.helper_requirements;
    if (helperField && helperField.value && helperField.status === 'clear') {
      const extracted = helperField.value.trim();
      // 具体限定词（有实际含义的要求）
      const SPECIFIC_WORDS = [
        '照顾小孩', '带娃', '看孩子', '看小孩', '育婴', '月嫂', '早教', '辅导作业',
        '照顾老人', '陪护老人', '护理', '老人', '病人', '卧床', '不能自理',
        '做饭好吃', '会做饭', '做饭', '厨艺',
        '打扫卫生', '保洁', '收拾家务', '做家务', '家务',
        '开车', '会开车',
        '学历', '大专', '本科', '高中', '初中',
        '方言', '普通话', '会说',
        '属相', '属', '星座',
        '身高', '体重',
        '省份', '哪里人', '本地人', '外地',
        '养宠物', '宠物',
      ];
      // 泛化词（单独出现几乎没有信息量）
      const GENERIC_WORDS = [
        '经验', '有经验', '经验丰富',
        '年轻', '勤快', '勤劳', '干净', '爱干净',
        '脾气好', '有耐心', '干活麻利', '手脚麻利', '手脚快', '手脚勤快',
        '老实', '人品好', '踏实', '靠谱', '和善', '性格好', '性格温和', '温和', '善良',
      ];

      const msgHasSpecific = SPECIFIC_WORDS.some((w) => msg.includes(w));
      const extractedHasSpecific = SPECIFIC_WORDS.some((w) => extracted.includes(w));
      const extractedHasGeneric = GENERIC_WORDS.some((w) => extracted.includes(w));

      // 原话有具体限定词，但提取结果只有泛词、没有具体词 → 限定信息丢了，用原话覆盖
      if (msgHasSpecific && !extractedHasSpecific && extractedHasGeneric) {
        const cleaned = this.cleanFieldValue(msg);
        this.logger.warn(
          `阿姨要求限定词丢失，用原话覆盖: AI="${extracted}" → 原话="${cleaned}"`,
        );
        helperField.value = cleaned;
        helperField.source = 'code_validation_override';
      }
    }

    return enrichedFields;
  }

  /**
   * 清洗字段值：去掉句尾语气词、首尾标点、多余空格
   * 保留核心语义，不做过度归一化（方向词、限定词都保留）
   */
  private cleanFieldValue(value: string): string {
    let v = value.trim();
    // 去掉首尾标点
    v = v.replace(/^[，。！？、；：""''（）【】\s]+/, '').replace(/[，。！？、；：""''（）【】\s]+$/, '');
    // 去掉句尾语气词（的/了/啊/吧/呀/呢/哦/哈/啦/噢/嗯/呗）
    // 只去掉句尾单个语气词，避免把"的"作为结构助词时误删
    v = v.replace(/(的|了|啊|吧|呀|呢|哦|哈|啦|噢|嗯|呗|嘛|哟)$/, '');
    // 合并连续空格
    v = v.replace(/\s+/g, ' ').trim();
    return v;
  }

  /**
   * 将 AI 合并回复中解析出的字段写入 requirements 表
   *
   * 写入策略：
   *   - 走 mergeRequirementFields 路径（老值优先，新值不覆盖已有非空值）
   *   - status=none 的字段跳过（value 为 null）
   *   - confidence < 0.5 的字段跳过（宁缺勿错，下一轮追问补齐）
   *   - status/confidence/source 为过程数据，判定后丢弃，不落库元数据（文档 §5.5）
   *
   * @param leadId
   * @param enrichedFields 增强格式字段（value + status + confidence + source）
   */
  public async saveParsedFields(
    leadId: string,
    enrichedFields: EnrichedRequirement,
  ): Promise<void> {
    const updates = new Map<string, string>();
    const skippedNone: string[] = [];
    const skippedLowConfidence: string[] = [];

    // 从配置生成 snake_case → camelCase 映射
    const fieldMap: Array<[keyof EnrichedRequirement, string]> = FIELD_KEYS.map(
      (k) => [REQUIREMENT_FIELDS[k].dbColumn as keyof EnrichedRequirement, k],
    );

    for (const [snake, camel] of fieldMap) {
      const field = enrichedFields[snake];
      if (!field || field.status === 'none' || !field.value) {
        skippedNone.push(snake);
        continue;
      }
      if (field.confidence < MIN_FIELD_CONFIDENCE) {
        skippedLowConfidence.push(`${snake}(${field.confidence})`);
        continue;
      }
      updates.set(camel, field.value.trim());
    }

    if (updates.size === 0) {
      return;
    }

    this.logger.log(
      `合并字段写入 DB: ${updates.size} 个字段写入，` +
      `${skippedNone.length} 个无值跳过，` +
      `${skippedLowConfidence.length} 个低置信度跳过[${skippedLowConfidence.join(',')}]`,
    );

    const existing = await this.getRequirementByLeadId(leadId);
    await this.mergeRequirementFields(leadId, existing, updates, 'ai_extract');
  }

  /**
   * 轻量级实时字段检测：从最近对话中用正则提取已答字段
   * 避免因 AI 提取失败导致 guidance prompt 信息过期
   */
  public detectFieldsFromConversation(
    messages: typeof chatMessages.$inferSelect[],
  ): Map<string, string> {
    const updates = new Map<string, string>();
    const recentCustomerMsgs = messages
      .filter((m) => m.role === 'customer')
      .slice(-8)
      .map((m) => m.content);
    const text = recentCustomerMsgs.join('\n');
    this.logger.log(`实时字段检测扫描文本: ${text.slice(0, 100)}`);

    // ===== 快字段 1：家庭人口 =====
    const householdMatch = text.match(/([\d一二三四五六七八九十两]+)\s*口/);
    if (householdMatch) updates.set('householdSize', householdMatch[1] + '口');

    // ===== 快字段 2：房屋面积 =====
    const areaMatch = text.match(/([\d一二三四五六七八九十百]+)\s*平/);
    if (areaMatch) updates.set('area', areaMatch[1] + '平');

    // ===== 快字段 3：月休天数 =====
    if (/没有休息|不休息|无休|无月休|无休息|不休|不休假|没有月休|月休无|月休不|月不休|全月无休|全月不休息|整月无休|整月不休息|月休\s*[0零]\s*天|零月休|0月休|不月休|不月休天/.test(text)) {
      updates.set('restDays', '无月休');
    } else {
      const restMatch = text.match(/月休\s*[\d一二三四五六七八九十两零]+\s*天|[\d一二三四五六七八九十两零]+\s*天休息|休息\s*[\d一二三四五六七八九十两零]+\s*天|[\d一二三四五六七八九十两零]+\s*月\s*休/);
      if (restMatch) {
        let normalized: string;
        if (/^月休/.test(restMatch[0])) {
          normalized = restMatch[0];
        } else if (restMatch[0].includes('月休')) {
          const num = restMatch[0].replace(/\s*月\s*休/, '').trim();
          normalized = `月休${num}天`;
        } else {
          normalized = `月休${restMatch[0].replace(/^休息/, '').replace(/天休息$/, '天')}`;
        }
        if (/^月休\s*[0零]\s*天$/.test(normalized) || /^0月休$/.test(normalized) || /^月休零$/.test(normalized)) {
          updates.set('restDays', '无月休');
        } else {
          updates.set('restDays', normalized);
        }
      } else {
        const isZhujiaContext = /住家|24\s*小时|全天/.test(text);
        const looseMatch = text.match(/(?<![到大中小半\d\.])([\d一二两])\s*天(?![到至之])/);
        if (isZhujiaContext && looseMatch) {
          updates.set('restDays', `月休${looseMatch[1]}天`);
        }
      }
    }

    // ===== 快字段 4：工作时长（住家/白班） =====
    if (/24\s*小时|二十四小时|全天|住家|整月|整月住家/.test(text)) {
      updates.set('serviceHours', '24小时');
    } else if (/8\s*小时|八小时|白班|非住家|不住家|仅白天|白天班|白班制/.test(text)) {
      updates.set('serviceHours', '8小时');
    }

    // ===== 弱化字段：阿姨要求（只留 5 个最高频核心词） =====
    // 长尾要求（年龄/籍贯/证书/短语类）交给 AI 提取 + 转人工前全量提取，实时检测只做高频词快采。
    const helperCoreKeywords = ['有经验', '做饭好吃', '勤快', '干净', '年轻'];
    const helperHits = helperCoreKeywords.filter((kw: string) => text.includes(kw));
    if (helperHits.length > 0) updates.set('helperRequirements', helperHits.join('、'));

    return updates;
  }

  /**
   * 轻量级实时字段检测：从最近对话中用正则提取已答字段
   * 封装成可复用方法，让"AI 主流程"和"人工接管后仍采集"两条路径共享同一份逻辑
   * 2026-08-16 19:31 林琳反馈：转人工后需求采集进度面板不更新，根因是 hasAgentReply 块 return 跳过了实时提取
   *
   * @param leadId 线索 ID
   * @param historyMessages 倒序前 limit 过的 chatMessages（detectFieldsFromConversation 内部 .slice(-8) customer）
   * @param logPrefix 日志前缀（默认空，AI 模式可省，人工模式加 [人工模式] 便于排查）
   * @returns 更新后的 requirement（无变化或异常时返回 null，调用方自行决定是否覆盖 reqForGuidance）
   */
  public async runRealtimeFieldDetection(
    leadId: string,
    historyMessages: typeof chatMessages.$inferSelect[],
    logPrefix: string = '',
  ): Promise<Requirement | null> {
    const prefix = logPrefix ? `${logPrefix} ` : '';
    try {
      const realtimeUpdates = this.detectFieldsFromConversation(historyMessages);
      if (realtimeUpdates.size > 0) {
        this.logger.log(`${prefix}实时字段检测到: ${[...realtimeUpdates.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
        const existing = await this.getRequirementByLeadId(leadId);
        await this.mergeRequirementFields(leadId, existing, realtimeUpdates, 'realtime_detect');
        return await this.getRequirementByLeadId(leadId);
      } else {
        this.logger.log(`${prefix}实时字段检测: 无匹配`);
      }
    } catch (err) {
      this.logger.warn(`${prefix}实时字段检测异常: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
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
  public async mergeRequirementFields(
    leadId: string,
    existing: Requirement | null,
    updates: Map<string, string>,
    changeSource: FieldDeltaSource = 'ai_extract',
  ): Promise<void> {
    if (updates.size === 0) return;

    // 2026-08-29 字段标准化 v2：写库前统一归一化（对话路径/实时检测路径共用此入口）
    for (const key of [...updates.keys()]) {
      updates.set(key, normalizeFieldByKey(key, updates.get(key)!));
    }

    // 2026-09-01 累加型字段合并：helperRequirements / dietaryPreferences 是多值累加字段，
    //   不能用 COALESCE 先写优先——客户分次发多条，后续消息里的内容会被丢弃。
    //   修法：先从 DB 读旧值，和新值做 union 合并（去重），再写回。
    const ACCUMULATIVE_FIELDS = new Set(['helperRequirements', 'dietaryPreferences']);
    if (existing) {
      const existingMap: Record<string, string | null> = {
        helperRequirements: existing.helperRequirements,
        dietaryPreferences: existing.dietaryPreferences,
      };
      for (const key of [...updates.keys()]) {
        if (!ACCUMULATIVE_FIELDS.has(key)) continue;
        const oldVal = existingMap[key] ?? '';
        const newVal = updates.get(key) ?? '';
        if (!oldVal) continue;
        if (oldVal === newVal) continue;
        const oldItems = oldVal.split(/[、,，]/).map((s: string) => s.trim()).filter(Boolean);
        const newItems = newVal.split(/[、,，]/).map((s: string) => s.trim()).filter(Boolean);
        const merged = [...new Set([...oldItems, ...newItems])];
        updates.set(key, merged.join('、'));
      }
    }

    // 2026-08-29 service_items 仅钟点工采集：已知非钟点工时丢弃该字段（历史数据保留，新数据不写）
    const currentServiceType = updates.get('serviceType') ?? existing?.serviceType ?? null;
    const currentSubType = currentServiceType ? normalizeServiceSubType(currentServiceType) : null;
    if (currentSubType !== null && currentSubType !== 'zhongdian' && updates.has('serviceItems')) {
      updates.delete('serviceItems');
    }

    // 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列
    //   所有字段统一走 ON CONFLICT upsert 路径，不再有 JSON 分支
    // 字段映射：camelCase (TS) → snake_case (DB)
    const COL_MAP: Array<[string, string]> = FIELD_KEYS
      .filter((k) => k !== 'serviceType')  // serviceType 不走 ON CONFLICT 批量更新（单独处理）
      .map((k) => [k, REQUIREMENT_FIELDS[k].dbColumn]);

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
        updateParts.push(
          sql`${sql.raw(snake)} = COALESCE(NULLIF(requirements.${sql.raw(snake)}, ''), EXCLUDED.${sql.raw(snake)})`,
        );
      }
    }

    // 2026-09-12 起 field_metadata 不再写入（status/confidence/source 为过程数据，判定后丢弃）；
    //   列与存量数据保留，未来如需低置信度审计再启用。
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
      // delta 日志：记录本次真正发生变化的字段（按 COALESCE 老值优先语义算有效新值）
      const oldRow: Record<string, string | null> = (existing ?? {}) as Record<string, string | null>;
      const deltaChanges: FieldDeltaChange[] = [];
      for (const camel of updates.keys()) {
        if (camel === 'serviceType') continue; // serviceType 单独写入路径，不走此 upsert 列
        const oldVal: string | null = oldRow[camel] ?? null;
        const effectiveNew: string = oldVal && oldVal.trim() !== '' ? oldVal : updates.get(camel)!;
        deltaChanges.push({ fieldKey: camel, oldValue: oldVal, newValue: effectiveNew });
      }
      void this.requirementDeltaService.recordDeltas({
        leadId,
        source: changeSource,
        changes: deltaChanges,
      });
      try {
        await this.autoTransferIfFieldsComplete(leadId);
      } catch (err) {
        this.logger.warn(
          `字段全齐自动转人工失败（不阻塞主流程）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
  public summarizeRequirement(req: Requirement | null): string {
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
    if (req.budget) parts.push(`预算: ${req.budget}`);
    return parts.length > 0 ? parts.join('; ') : '暂无已收集的需求信息';
  }

  /**
   * 2026-08-29 字段标准化 v2：存量需求数据批量归一化（一次性运维接口）
   * 对 6 个标准化字段逐行归一化，仅更新有变化的行。
   */
  public async normalizeExistingRequirements(): Promise<{ total: number; updated: number }> {
    const rows = await this.db.select().from(requirements);
    let updated = 0;
    for (const row of rows) {
      const patch: Partial<typeof requirements.$inferInsert> = {};
      const candidates: Array<[string, string | null]> = [
        ['householdSize', row.householdSize],
        ['area', row.area],
        ['budget', row.budget],
        ['elderlyCare', row.elderlyCare],
        ['startTime', row.startTime],
        ['dietaryPreferences', row.dietaryPreferences],
      ];
      for (const [key, value] of candidates) {
        if (typeof value !== 'string') continue;
        const normalized = normalizeFieldByKey(key, value);
        if (normalized !== value) {
          (patch as Record<string, string | null>)[key] = normalized;
        }
      }
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = new Date();
        await this.db
          .update(requirements)
          .set(patch)
          .where(eq(requirements.id, row.id));
        updated += 1;
      }
    }
    this.logger.log(`存量需求数据归一化完成: total=${rows.length} updated=${updated}`);
    return { total: rows.length, updated };
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

}
