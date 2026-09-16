import { parseBudgetNumber, scoreUrgency } from '../../server/modules/leads/lead-grading.util';

describe('parseBudgetNumber（字段标准化 v2：JSON 区间预算）', () => {
  it('新格式 JSON 区间取上限', () => {
    expect(parseBudgetNumber('{"min":5000,"max":6500}')).toBe(6500);
  });

  it('新格式单值区间', () => {
    expect(parseBudgetNumber('{"min":8000,"max":8000}')).toBe(8000);
  });

  it('兼容旧文本单值', () => {
    expect(parseBudgetNumber('8000')).toBe(8000);
  });

  it('兼容旧文本区间取上限', () => {
    expect(parseBudgetNumber('5000-6000')).toBe(6000);
  });

  it('非法值返回 null', () => {
    expect(parseBudgetNumber('')).toBeNull();
    expect(parseBudgetNumber(null)).toBeNull();
    expect(parseBudgetNumber('面议')).toBeNull();
  });
});

describe('scoreUrgency（start_time 五档枚举兼容）', () => {
  it('尽快到岗 → 3', () => {
    expect(scoreUrgency('尽快到岗')).toBe(3);
  });

  it('一周内到岗 → 3', () => {
    expect(scoreUrgency('一周内到岗')).toBe(3);
  });

  it('两周内到岗 → 2', () => {
    expect(scoreUrgency('两周内到岗')).toBe(2);
  });

  it('一个月内到岗 → 1', () => {
    expect(scoreUrgency('一个月内到岗')).toBe(1);
  });

  it('不确定 → 1', () => {
    expect(scoreUrgency('不确定')).toBe(1);
  });

  it('空值 → 1', () => {
    expect(scoreUrgency(null)).toBe(1);
  });
});
