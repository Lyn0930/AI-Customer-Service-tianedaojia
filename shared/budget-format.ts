/**
 * budget 字段统一解析模块（2026-09-16 统一到 shared，单一事实源）
 *
 * budget 在库里统一存归一化 JSON 区间串：'{"min":5000,"max":6000}'（varchar）。
 * 本模块承接此前三处独立实现：
 *   - server/modules/chat/lead-field-normalizer.ts（parseBudgetRange 全量版）
 *   - server/modules/chat/chat.service.ts（formatBudgetForDisplay 内联版）
 *   - client/src/utils/requirement-format.ts（parseBudgetRange JSON-only 版）
 *
 * 所有函数解析失败时不丢信息（原样返回或返回 null），绝不编造。
 */

export interface BudgetRange {
  min: number;
  max: number;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const CN_NUMBER_PATTERN = /^[零一二两三四五六七八九十百千万]+$/u;

/** 中文数字转阿拉伯数字，支持 一~十、百/千/万 组合及"一万二"式尾随简写；解析失败返回 null */
export function chineseToNumber(text: string): number | null {
  const s = text.trim();
  if (!s || !CN_NUMBER_PATTERN.test(s)) return null;
  let total = 0;
  let section = 0;
  let current = 0;
  let lastBigUnit = 0;
  for (const ch of s) {
    if (CN_DIGITS[ch] !== undefined) {
      current = CN_DIGITS[ch];
    } else if (CN_UNITS[ch] !== undefined) {
      if (current === 0 && ch === '十') current = 1;
      section += current * CN_UNITS[ch];
      current = 0;
      lastBigUnit = 0;
    } else if (ch === '万') {
      total += (section + current) * 10000;
      section = 0;
      current = 0;
      lastBigUnit = 10000;
    }
  }
  if (current > 0 && lastBigUnit >= 1000 && section === 0) {
    current *= lastBigUnit / 10;
  }
  const result = total + section + current;
  return result > 0 ? result : null;
}

/** 解析金额数值（含万/千单位、中文数字），失败返回 null */
function parseMoneyAmount(token: string): number | null {
  const t = token.trim();
  if (!t) return null;
  const cn = t.match(/^([零一二两三四五六七八九十百千万]+)\s*(万|千|块|元)?$/u);
  if (cn) {
    const base = chineseToNumber(cn[1]);
    if (base === null) return null;
    if (cn[2] === '万') return base * 10000;
    return base;
  }
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(万|千|百|块|元|\/月)?$/u);
  if (!m) return null;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (m[2] === '万') return Math.round(num * 10000);
  if (m[2] === '千') return Math.round(num * 1000);
  if (m[2] === '百') return Math.round(num * 100);
  return Math.round(num);
}

/**
 * 解析预算为区间。输入可以是：
 * - 已归一化的 JSON 字符串 '{"min":7000,"max":7000}'
 * - 旧文本："预算 7000"、"5000-6000"、"5000到6000"、"八千块"、"1.2万"（历史行兼容）
 * 解析失败返回 null。
 */
export function parseBudgetRange(budget: string | null | undefined): BudgetRange | null {
  if (!budget) return null;
  const v = budget.trim();
  if (v.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(v);
      if (
        parsed && typeof parsed === 'object' &&
        typeof (parsed as BudgetRange).min === 'number' &&
        typeof (parsed as BudgetRange).max === 'number'
      ) {
        const range = parsed as BudgetRange;
        return {
          min: Math.min(range.min, range.max),
          max: Math.max(range.min, range.max),
        };
      }
    } catch {
      // 落到文本解析
    }
  }

  const rangeMatch = v.match(
    /(\d+(?:\.\d+)?)\s*(万|千)?\s*[-~～至到]\s*(\d+(?:\.\d+)?)\s*(万|千)?/u,
  );
  if (rangeMatch) {
    const min = parseMoneyAmount(`${rangeMatch[1]}${rangeMatch[2] ?? ''}`);
    const max = parseMoneyAmount(`${rangeMatch[3]}${rangeMatch[4] ?? ''}`);
    if (min !== null && max !== null) {
      return { min: Math.min(min, max), max: Math.max(min, max) };
    }
  }

  const cnAmount = v.match(/([零一二两三四五六七八九十百千万]+)\s*(?:万|千|块|元|块钱)?/u);
  if (cnAmount && CN_NUMBER_PATTERN.test(cnAmount[1])) {
    const n = parseMoneyAmount(cnAmount[1]);
    if (n !== null) return { min: n, max: n };
  }

  const arabicAmount = v.match(/(\d+(?:\.\d+)?)\s*(万|千|百)?/u);
  if (arabicAmount) {
    const n = parseMoneyAmount(`${arabicAmount[1]}${arabicAmount[2] ?? ''}`);
    if (n !== null) return { min: n, max: n };
  }

  return null;
}

/** 预算：归一化为 JSON 区间字符串；解析失败原样返回 */
export function normalizeBudget(value: string | null): string | null {
  if (!value) return value;
  const range = parseBudgetRange(value);
  if (!range) return value;
  return JSON.stringify(range);
}

/**
 * 线索分级取数：取区间上限 max 与市场价比对（宁高勿低）。
 * 合理性上界 100000（超出视为解析异常，返回 null）。
 */
export function parseBudgetNumber(budget: string | null): number | null {
  if (!budget) return null;
  const range = parseBudgetRange(budget);
  if (range && range.max > 0 && range.max < 100000) return range.max;
  return null;
}

/**
 * 展示格式化：'{"min":7000,"max":7000}' → "7000元/月"；
 * 区间 → "5000-6000元/月"；可解析的旧文本（"6000左右"）→ "6000元/月"；
 * 不可解析（"面议"）→ 原样返回；空值 → null。
 */
export function formatBudgetRange(budget: string | null | undefined): string | null {
  if (!budget) return null;
  const range = parseBudgetRange(budget);
  if (!range) return budget.trim();
  if (range.min === range.max) return `${range.min}元/月`;
  return `${range.min}-${range.max}元/月`;
}
