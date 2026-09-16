import { formatBudgetRange, parseBudgetNumber } from '../../shared/budget-format';

describe('formatBudgetRange（shared 统一展示格式化）', () => {
  it('JSON 单值区间 → 单值展示', () => {
    expect(formatBudgetRange('{"min":7000,"max":7000}')).toBe('7000元/月');
  });

  it('JSON 区间 → 区间展示', () => {
    expect(formatBudgetRange('{"min":5000,"max":6000}')).toBe('5000-6000元/月');
  });

  it('可解析旧文本 → 格式化展示（新行为）', () => {
    expect(formatBudgetRange('6000左右')).toBe('6000元/月');
  });

  it('不可解析文本原样返回', () => {
    expect(formatBudgetRange('面议')).toBe('面议');
  });

  it('空值返回 null', () => {
    expect(formatBudgetRange(null)).toBeNull();
    expect(formatBudgetRange('')).toBeNull();
  });
});

describe('parseBudgetNumber（分级取数走 shared）', () => {
  it('JSON 区间取上限', () => {
    expect(parseBudgetNumber('{"min":5000,"max":6500}')).toBe(6500);
  });

  it('超合理性上界返回 null', () => {
    expect(parseBudgetNumber('200000')).toBeNull();
  });
});
