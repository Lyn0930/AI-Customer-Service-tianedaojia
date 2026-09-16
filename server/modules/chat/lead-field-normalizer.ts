/**
 * 需求字段归一化工具（2026-08-29 字段标准化 v2，林琳拍板）
 *
 * 核心原则：数据库存结构化值，前端展示时再美化；枚举值用中文存储；
 * 卡片路径和对话路径统一格式。
 *
 * - householdSize：纯阿拉伯数字字符串（"三口"→"3"）
 * - area：纯数字字符串，单位固定平米（"120平"→"120"）
 * - budget：JSON 对象字符串 { min, max }，单位元/月（"5000-6000"→'{"min":5000,"max":6000}'）
 * - elderlyCare：5 值枚举（不需要/提到了/能自理/半自理/不能自理）
 * - startTime：5 档枚举（尽快到岗/一周内到岗/两周内到岗/一个月内到岗/时间还不确定）
 * - dietaryPreferences：文本去口语化（"喜欢吃粤菜"→"粤菜"）
 *
 * 所有函数解析失败时原样返回，绝不丢信息。
 */

import {
  chineseToNumber,
  parseBudgetRange,
  normalizeBudget,
  type BudgetRange,
} from '../../../shared/budget-format';

// budget 解析已统一到 shared，此处 re-export 保持旧引用路径兼容（2026-09-16）
export { chineseToNumber, parseBudgetRange, normalizeBudget };
export type { BudgetRange };

/** 家庭人口：纯阿拉伯数字字符串（"三口"→"3"、"4 口人"→"4"） */
export function normalizeHouseholdSize(value: string | null): string | null {
  if (!value) return value;
  const v = value.trim();
  const arabic = v.match(/(\d+)\s*口/u);
  if (arabic) return arabic[1];
  const chinese = v.match(/([零一二两三四五六七八九十]+)\s*口/u);
  if (chinese) {
    const n = chineseToNumber(chinese[1]);
    if (n) return String(n);
  }
  const bare = v.match(/(\d+)/u);
  if (bare) return bare[1];
  const bareCn = v.match(/([零一二两三四五六七八九十]+)/u);
  if (bareCn) {
    const n = chineseToNumber(bareCn[1]);
    if (n) return String(n);
  }
  return value;
}

/** 房屋面积：纯数字字符串，单位固定平米（"120平"→"120"、"150 平米"→"150"） */
export function normalizeArea(value: string | null): string | null {
  if (!value) return value;
  const v = value.trim();
  const withUnit = v.match(/(\d+(?:\.\d+)?)\s*(?:㎡|平米|平方米|平)/u);
  if (withUnit) return withUnit[1];
  const bare = v.match(/(\d+(?:\.\d+)?)/u);
  if (bare) return bare[1];
  return value;
}

const ELDERLY_CARE_LEVELS = ['不能自理', '半自理', '能自理'];
const ELDERLY_NOT_NEEDED_PATTERN =
  /不需要|不用照顾|无需照顾|没有老人|无老人|不用管老人|没有需要照顾/u;

/** 老人照护：5 值枚举（不需要/提到了/能自理/半自理/不能自理） */
export function normalizeElderlyCare(value: string | null): string | null {
  if (!value) return value;
  const v = value.trim();
  for (const level of ELDERLY_CARE_LEVELS) {
    if (v.includes(level)) return level;
  }
  if (v === '不需要' || ELDERLY_NOT_NEEDED_PATTERN.test(v)) return '不需要';
  if (v === '提到了') return '提到了';
  if (/老人|长辈|父母|照顾/u.test(v)) return '提到了';
  return value;
}

const START_TIME_ENUM = [
  '尽快到岗',
  '一周内到岗',
  '两周内到岗',
  '一个月内到岗',
  '时间还不确定',
] as const;

/** 到岗时间：归一化为 5 档枚举（不存具体日期）；无法归类时原样返回 */
export function normalizeStartTime(value: string | null): string | null {
  if (!value) return value;
  const v = value.trim();
  if ((START_TIME_ENUM as readonly string[]).includes(v)) return v;

  if (/尽快|马上|立即|立刻|急需|越快越好|随时| asap/ui.test(v)) return '尽快到岗';
  if (/不确定|还没想好|还没定|再说|不着急|待定|看情况/u.test(v)) return '时间还不确定';

  const dateMatch = v.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/u)
    ?? v.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/u);
  if (dateMatch) {
    const now = new Date();
    const target = dateMatch.length === 4
      ? new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]))
      : new Date(now.getFullYear(), Number(dateMatch[1]) - 1, Number(dateMatch[2]));
    const days = (target.getTime() - now.getTime()) / 86400000;
    if (days <= 7) return '一周内到岗';
    if (days <= 14) return '两周内到岗';
    if (days <= 31) return '一个月内到岗';
    return '时间还不确定';
  }

  if (/一周内|7天内|七天|一个星期|本周|这周/u.test(v)) return '一周内到岗';
  if (/两周内|14天|十四天|半个月|两周后|下周后?$/u.test(v)) return '两周内到岗';
  if (/一个月内|一个月|30天|下个月|月底之前?$/u.test(v)) return '一个月内到岗';

  return value;
}

/** 饮食偏好：保留原始表达，不做前缀剥离
 *
 * 2026-08-31 林琳决策：方向信息比简洁更重要，"爱吃辣"不能剥成"辣"、
 *   "喜欢吃粤菜"也不用剥成"粤菜"——保留原话最准确，经纪人一眼就能看懂。
 * 只做 trim 和空值处理。
 */
export function normalizeDietaryPreferences(value: string | null): string | null {
  if (!value) return value;
  const v = value.trim();
  return v || value;
}

/** 按字段名归一化单个值；未知字段原样返回 */
export function normalizeFieldByKey(key: string, value: string | null): string | null {
  if (value === null || value === undefined) return value ?? null;
  switch (key) {
    case 'householdSize':
      return normalizeHouseholdSize(value);
    case 'area':
      return normalizeArea(value);
    case 'budget':
      return normalizeBudget(value);
    case 'elderlyCare':
      return normalizeElderlyCare(value);
    case 'startTime':
      return normalizeStartTime(value);
    case 'dietaryPreferences':
      return normalizeDietaryPreferences(value);
    default:
      return value;
  }
}

const NORMALIZABLE_KEYS = [
  'householdSize',
  'area',
  'budget',
  'elderlyCare',
  'startTime',
  'dietaryPreferences',
] as const;

/** 批量归一化字段对象（仅处理已知字段，其余原样保留） */
export function normalizeRequirementFields(
  fields: Record<string, string | null>,
): Record<string, string | null> {
  const result: Record<string, string | null> = { ...fields };
  for (const key of NORMALIZABLE_KEYS) {
    const value = result[key];
    if (typeof value === 'string') {
      try {
        result[key] = normalizeFieldByKey(key, value);
      } catch {
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * 多值字段合并（union 合并）
 *
 * 用于 AI 提取路径：AI 可能只提取到部分值（如只提取了"兰州人"但漏了"性格好"），
 * 如果直接用 COALESCE 写入会覆盖之前实时检测到的完整值。
 *
 * 合并规则：
 *  - 两边都为空 → 返回 null
 *  - 一边为空 → 返回非空的那边
 *  - 两边都有值 → 拆分数组 union 去重，用"、"拼接
 *  - 子串包含处理："有经验"包含"经验" → 保留"有经验"（更具体的）
 *
 * @param oldValue 旧值（DB 里的，可能是实时检测积累的）
 * @param newValue 新值（AI 刚提取的）
 * @returns 合并后的值，都为空则返回 null
 */
export function unionMergeMultiValue(
  oldValue: string | null | undefined,
  newValue: string | null | undefined,
): string | null {
  const oldStr = oldValue?.trim() ?? '';
  const newStr = newValue?.trim() ?? '';

  if (!oldStr && !newStr) return null;
  if (!oldStr) return newStr;
  if (!newStr) return oldStr;

  const split = (s: string): string[] =>
    s.split(/[、，,；;]/).map((x) => x.trim()).filter(Boolean);

  const oldItems = split(oldStr);
  const newItems = split(newStr);
  const merged: string[] = [];

  const allItems = [...oldItems, ...newItems];
  for (const item of allItems) {
    if (!item) continue;
    const alreadyCovered = merged.some(
      (existing) => existing.includes(item) && existing !== item,
    );
    if (alreadyCovered) continue;
    const idxToReplace = merged.findIndex(
      (existing) => item.includes(existing) && existing !== item,
    );
    if (idxToReplace >= 0) {
      merged[idxToReplace] = item;
      continue;
    }
    if (merged.includes(item)) continue;
    merged.push(item);
  }

  return merged.length > 0 ? merged.join('、') : null;
}
