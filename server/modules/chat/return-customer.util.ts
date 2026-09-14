/**
 * 老客回归检测 - 纯函数工具（2026-08-16 新增）
 *
 * 业务背景：
 * 客户用同一手机号二次咨询时，AI 开场白不能机械地"请告诉我您需要什么服务"，
 * 应该主动复述他之前留过的信息，让他确认 — 既显得贴心，又避免重复填表。
 *
 * 适用场景：
 * - leads.cross_channel_history 中已有 ≥ 1 条历史（同手机号归一后追加）
 * - chat 不会写 history（只有 form 提交会追加），所以 history 里的每条都是"过去的"
 * - 倒数第 1 条 = 最近一次留资 = "上次的"咨询
 * - 用"上次咨询距今多少天"决定走场景 A（相近时间，< 30 天）还是 B（≥ 30 天）
 *
 * 阈值可配：环境变量 RETURN_CUSTOMER_THRESHOLD_DAYS，默认 30 天
 *
 * 设计原则：
 * - 纯函数不依赖 DB，便于单测
 * - 列出实际采集到的字段（不编造）
 * - < 7 天的"极近期"用更亲切的口吻（"没收到回复又来了"）
 * - ≥ 30 天的用"软化确认"（"如果有变动，告诉我"）
 */

import { getServiceTypeLabel } from '../automation/requirement-templates';

export interface ReturnCustomerHistoryEntry {
  channel?: string;
  source?: string;
  serviceCity?: string;
  customerName?: string;
  createdAt?: string;
}

export interface ReturnCustomerRequirementSnapshot {
  serviceType?: string | null;
  householdSize?: string | null;
  area?: string | null;
  serviceAddress?: string | null;
  restDays?: string | null;
  startTime?: string | null;
  budget?: number | null;
  serviceDuration?: string | null;
  workMode?: string | null;
  elderlyCare?: string | null;
  dietaryPreferences?: string | null;
  helperRequirements?: string | null;
  specialRequirements?: string | null;
  familyInfo?: string | null;
}

export interface ReturnCustomerLeadSnapshot {
  serviceCity?: string | null;
  phoneNumber?: string | null;
  customerName?: string | null;
}

export type ReturnCustomerScenario = 'A_recent' | 'B_old' | 'C_secondary';

export interface ReturnCustomerContext {
  scenario: ReturnCustomerScenario;
  previousEntry: {
    channel: string;
    source: string;
    serviceCity: string | null;
    submittedAt: Date;
    daysSince: number;
  };
  allHistoryCount: number;
  lead: ReturnCustomerLeadSnapshot;
  requirement: ReturnCustomerRequirementSnapshot | null;
  displayServiceType: string | null;
  formattedWhen: string;
  channelLabel: string;
  thresholdDays: number;
  /** 是否有过 completed/signed 订单（成交过 = 真老客） */
  hasCompletedOrder: boolean;
  /** 当前 lead 的分级（A/B/C/D/E），用于决定走哪条分支 */
  leadGrade: string | null;
}

/** 渠道 / 来源显示名映射（与 shared/channels.ts 的 SOURCE_LABELS 一致） */
const SOURCE_LABELS: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  seo: 'SEO',
  meituan: '美团',
  dianping: '大众点评',
  app: '自有APP',
  miniapp: '小程序',
  website: '官网',
  openapi: 'API推送',
  bitable_form: '飞书表单',
  chat: '在线咨询',
  phone: '电话',
  manual: '手动录入',
};

/**
 * 服务类型直接显示名（覆盖 requirement-templates.getServiceTypeLabel 的 alias 缺口）
 *
 * getServiceTypeLabel 对 "住家保姆/白班保姆/育儿保姆/钟点工保姆/护工保姆" 这类带"保姆"后缀的形式
 * 会落到 "default" → "通用" 兜底（因为 SERVICE_TYPE_ALIASES 只覆盖了不带"保姆"的形式）。
 * 老客回归场景要直白显示客户原意，所以用这张完整映射。
 */
const SERVICE_TYPE_DISPLAY: Record<string, string> = {
  baomu: '保姆',
  住家: '住家保姆',
  住家保姆: '住家保姆',
  zhujia: '住家保姆',
  白班: '白班保姆',
  白班保姆: '白班保姆',
  baiban: '白班保姆',
  钟点: '钟点工',
  钟点工: '钟点工',
  钟点工保姆: '钟点工',
  zhongdian: '钟点工',
  育儿: '育儿嫂',
  育儿嫂: '育儿嫂',
  育儿保姆: '育儿嫂',
  yuer: '育儿嫂',
  养老: '护工',
  养老保姆: '护工',
  养老陪护: '护工',
  护工: '护工',
  护工保姆: '护工',
  yanglao: '护工',
  菲式: '菲式保姆',
  菲式保姆: '菲式保姆',
  菲佣: '菲式保姆',
  feishi: '菲式保姆',
  月嫂: '月嫂',
  '26天月嫂': '月嫂',
  yuesao: '月嫂',
  '26day_yuesao': '月嫂',
  baojie: '保洁',
  保洁: '保洁',
  清洁: '保洁',
  日常保洁: '保洁',
  深度保洁: '保洁',
};

function displayServiceTypeName(serviceType: string | null | undefined): string {
  if (!serviceType) return '';
  return SERVICE_TYPE_DISPLAY[serviceType] ?? getServiceTypeLabel(serviceType) ?? serviceType;
}

function getSourceLabel(source: string | undefined | null): string {
  if (!source) return '未知渠道';
  return SOURCE_LABELS[source] ?? source;
}

/**
 * 人类可读时间（"今天/昨天/3 天前/2 周前/8 月 12 号"）
 *
 * 设计：
 * - 同一天 → "今天"
 * - 昨天 → "昨天"
 * - < 7 天 → "X 天前"
 * - < 30 天 → "X 周前"（按整周）
 * - ≥ 30 天 → "M 月 D 号"（中文月日）
 */
export function formatHumanReadableTime(d: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - d.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.floor(diffMs / dayMs);

  if (days < 0) {
    // 未来时间（异常），用日期表达
    return `${d.getMonth() + 1} 月 ${d.getDate()} 号`;
  }
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? '1 周前' : `${weeks} 周前`;
  }
  return `${d.getMonth() + 1} 月 ${d.getDate()} 号`;
}

/**
 * 把历史数组 → 倒数第 1 条 = "上次的"咨询，返回天数差
 * 返回 null = 新客户（无历史） / 数据异常
 */
export function extractPreviousEntry(
  history: ReturnCustomerHistoryEntry[] | null | undefined,
  now: Date = new Date(),
  thresholdDays: number = 30,
): { previousEntry: ReturnCustomerHistoryEntry; submittedAt: Date; daysSince: number; allHistoryCount: number; scenario: ReturnCustomerScenario } | null {
  if (!Array.isArray(history) || history.length < 1) return null;

  // 倒数第 1 条 = 最近的留资（chat 不会追加 history，所以 history 里的每条都是"过去的"）
  const previousEntry = history[history.length - 1];
  if (!previousEntry?.createdAt) return null;

  const submittedAt = new Date(previousEntry.createdAt);
  if (Number.isNaN(submittedAt.getTime())) return null;

  const daysSince = Math.floor((now.getTime() - submittedAt.getTime()) / (24 * 60 * 60 * 1000));
  const scenario: ReturnCustomerScenario = daysSince < thresholdDays ? 'A_recent' : 'B_old';

  return { previousEntry, submittedAt, daysSince, allHistoryCount: history.length, scenario };
}

/**
 * 列出 requirement 里有值的字段（只列非空），用于场景 B 的"软化确认"
 */
function listCollectedFields(r: ReturnCustomerRequirementSnapshot | null | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (r.householdSize) out.push(`家庭情况 ${r.householdSize}`);
  if (r.area) out.push(`房屋面积 ${r.area}`);
  if (r.serviceAddress) out.push(`服务地址 ${r.serviceAddress}`);
  if (r.restDays) out.push(`月休 ${r.restDays}`);
  if (r.startTime) out.push(`到岗时间 ${r.startTime}`);
  if (r.budget) out.push(`薪资预算 ${r.budget}元`);
  if (r.serviceDuration) out.push(`服务周期 ${r.serviceDuration}`);
  if (r.workMode) out.push(`工作制 ${r.workMode}`);
  if (r.elderlyCare) out.push(`老人照护 ${r.elderlyCare}`);
  if (r.dietaryPreferences) out.push(`做饭口味 ${r.dietaryPreferences}`);
  if (r.helperRequirements) out.push(`阿姨要求 ${r.helperRequirements}`);
  if (r.specialRequirements) out.push(`特殊需求 ${r.specialRequirements}`);
  if (r.familyInfo) out.push(`补充信息 ${r.familyInfo}`);
  return out;
}

/**
 * 构造"老客回归"开场白
 *
 * 场景 A（< 30 天，成交过 / A 类）：强确认 + 复述历史字段
 *   - < 7 天：极近期 → "您 X 天前刚咨询过...是没收到回复又来了，还是这次想了解别的？"
 *   - 7-30 天：相近时间 → "您 X 月 X 号从【渠道】咨询过【城市】【服务】。这次是想找同样的，还是想了解别的？"
 *
 * 场景 B（≥ 30 天，成交过）：列出实际采集字段 + 软化确认
 *
 * 场景 C（二次咨询但未成交，2026-08-16 新增 / v2.1 修正：去掉 leadGrade='A' 判定）：弱确认
 *   - 客户之前咨询过但没成交过订单（v2.1 修正：不再用 leadGrade='A' 判定），不能直接当"老客"复述具体字段
 *   - 只简单告知"看到您之前咨询过"，让客户开口决定
 */
export function buildReturnCustomerOpening(ctx: ReturnCustomerContext): string {
  const city = ctx.lead.serviceCity || '您所在城市';
  const svc = ctx.displayServiceType || '家政服务';
  const when = ctx.formattedWhen;
  const ch = ctx.channelLabel;

  if (ctx.scenario === 'C_secondary') {
    // 二次咨询但未成交：弱确认，不复述具体字段
    return [
      `您好～看到您 ${when}从【${ch}】咨询过【${city}】的【${svc}】。`,
      '',
      '上次没有匹配到合适的阿姨吗？这次是想继续上次的需求，还是有别的需要？',
    ].join('\n');
  }

  if (ctx.scenario === 'A_recent') {
    if (ctx.previousEntry.daysSince < 7) {
      // 极近期：< 7 天
      return [
        `您好～我看到您 ${when}从【${ch}】咨询过【${city}】的【${svc}】，还没收到合适的阿姨匹配对吗？`,
        '',
        '这次是想了解同样的事，还是有别的需要？',
      ].join('\n');
    }
    // 7-30 天：标准 A
    return [
      `您好～看到您 ${when}从【${ch}】咨询过【${city}】的【${svc}】服务。`,
      '',
      '这次是想找同样的，还是想了解别的？',
    ].join('\n');
  }

  // 场景 B：≥ 30 天
  const fields = listCollectedFields(ctx.requirement);
  if (fields.length === 0) {
    // 没采集到详细字段，给轻量确认
    return [
      `您好～您之前 ${when}从【${ch}】在【${city}】咨询过【${svc}】服务。`,
      '',
      '这次是想找同样的，还是想了解别的？',
    ].join('\n');
  }

  // 列出字段 + 软化确认
  return [
    `您好～您之前 ${when}从【${ch}】在【${city}】咨询过【${svc}】服务，当时记录了：${fields.join('、')}。`,
    '',
    '这些信息还是一样的吗？如果有变动（比如搬家、家里多了人/少了人），告诉我就行～',
  ].join('\n');
}

/**
 * 把 lead + requirement + history 打包成 ReturnCustomerContext（供 chat.service.ts 调用）
 *
 * 决策矩阵（2026-08-16 v2.1 修正）：
 * - hasCompletedOrder=true → 场景 A_recent（< 阈值天）/ B_old（≥ 阈值天）"强老客"分支
 * - 否则但 history 有 ≥ 1 条 → 场景 C_secondary（二次咨询但未成交）"弱老客"分支
 * - 否则 → null（新客户）
 */
export function buildReturnCustomerContext(params: {
  lead: ReturnCustomerLeadSnapshot;
  requirement: ReturnCustomerRequirementSnapshot | null;
  history: ReturnCustomerHistoryEntry[] | null | undefined;
  thresholdDays?: number;
  now?: Date;
  hasCompletedOrder?: boolean;
  leadGrade?: string | null;
}): ReturnCustomerContext | null {
  const threshold = params.thresholdDays ?? Number(process.env.RETURN_CUSTOMER_THRESHOLD_DAYS ?? 30);
  const now = params.now ?? new Date();
  const hasCompletedOrder = params.hasCompletedOrder ?? false;
  const leadGrade = params.leadGrade ?? null;

  const extracted = extractPreviousEntry(params.history, now, threshold);
  if (!extracted) return null;

  // 二次咨询但非成交/非 A 类 → 场景 C（弱确认，不复述具体字段）
  const isStrongCustomer = hasCompletedOrder;  // v2.1: 去掉 leadGrade='A' 判定，仅靠 hasCompletedOrder
  let scenario: ReturnCustomerScenario = extracted.scenario;
  if (!isStrongCustomer) {
    scenario = 'C_secondary';
  }

  const displayServiceType = params.requirement?.serviceType
    ? displayServiceTypeName(params.requirement.serviceType)
    : null;

  return {
    scenario,
    previousEntry: {
      channel: extracted.previousEntry.channel ?? 'unknown',
      source: extracted.previousEntry.source ?? extracted.previousEntry.channel ?? 'unknown',
      serviceCity: extracted.previousEntry.serviceCity ?? null,
      submittedAt: extracted.submittedAt,
      daysSince: extracted.daysSince,
    },
    allHistoryCount: extracted.allHistoryCount,
    lead: params.lead,
    requirement: params.requirement,
    displayServiceType,
    formattedWhen: formatHumanReadableTime(extracted.submittedAt, now),
    channelLabel: getSourceLabel(extracted.previousEntry.source ?? extracted.previousEntry.channel),
    thresholdDays: threshold,
    hasCompletedOrder,
    leadGrade,
  };
}
