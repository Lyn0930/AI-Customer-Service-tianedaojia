/**
 * 需求字段展示格式化
 * DB 存结构化值，展示层转自然语言。旧格式数据原样展示兜底。
 * budget 解析 / 格式化已统一到 @shared/budget-format（2026-09-16）。
 */
import { parseBudgetRange, formatBudgetRange } from '@shared/budget-format';

export { parseBudgetRange };
export type { BudgetRange } from '@shared/budget-format';
/** 旧名兼容：formatBudget = shared 的 formatBudgetRange */
export const formatBudget = formatBudgetRange;

/** "3" → "3 口人"；旧格式原样返回 */
export function formatHouseholdSize(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/u.test(v)) return `${v} 口人`;
  return value;
}

/** "120" → "120 平米"；旧格式原样返回 */
export function formatArea(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(?:\.\d+)?$/u.test(v)) return `${v} 平米`;
  return value;
}

/** 按字段名格式化（进度面板等通用渲染用） */
export function formatRequirementFieldValue(
  field: string,
  value: string | null | undefined,
): string | null {
  switch (field) {
    case 'householdSize':
      return formatHouseholdSize(value);
    case 'area':
      return formatArea(value);
    case 'budget':
      return formatBudgetRange(value);
    default:
      return value ?? null;
  }
}
