import {
  chineseToNumber,
  normalizeHouseholdSize,
  normalizeArea,
  normalizeBudget,
  normalizeElderlyCare,
  normalizeStartTime,
  normalizeDietaryPreferences,
  parseBudgetRange,
} from '../../server/modules/chat/lead-field-normalizer';

describe('chineseToNumber', () => {
  it('支持一~十', () => {
    expect(chineseToNumber('一')).toBe(1);
    expect(chineseToNumber('二')).toBe(2);
    expect(chineseToNumber('三')).toBe(3);
    expect(chineseToNumber('四')).toBe(4);
    expect(chineseToNumber('五')).toBe(5);
    expect(chineseToNumber('六')).toBe(6);
    expect(chineseToNumber('七')).toBe(7);
    expect(chineseToNumber('八')).toBe(8);
    expect(chineseToNumber('九')).toBe(9);
    expect(chineseToNumber('十')).toBe(10);
  });

  it('支持组合与单位', () => {
    expect(chineseToNumber('十五')).toBe(15);
    expect(chineseToNumber('二十')).toBe(20);
    expect(chineseToNumber('八千')).toBe(8000);
    expect(chineseToNumber('一万')).toBe(10000);
    expect(chineseToNumber('一万二')).toBe(12000);
    expect(chineseToNumber('两')).toBe(2);
  });
});

describe('normalizeHouseholdSize', () => {
  it('中文数字转阿拉伯', () => {
    expect(normalizeHouseholdSize('三口')).toBe('3');
    expect(normalizeHouseholdSize('五口之家')).toBe('5');
  });
  it('阿拉伯数字去单位', () => {
    expect(normalizeHouseholdSize('4 口人')).toBe('4');
    expect(normalizeHouseholdSize('5 口人及以上')).toBe('5');
  });
  it('已归一化值不变', () => {
    expect(normalizeHouseholdSize('3')).toBe('3');
  });
  it('无法解析原样返回', () => {
    expect(normalizeHouseholdSize('不确定')).toBe('不确定');
    expect(normalizeHouseholdSize(null)).toBeNull();
  });
});

describe('normalizeArea', () => {
  it('提取数字忽略单位', () => {
    expect(normalizeArea('120平')).toBe('120');
    expect(normalizeArea('150 平米')).toBe('150');
    expect(normalizeArea('90㎡')).toBe('90');
    expect(normalizeArea('120.5 平方米')).toBe('120.5');
  });
  it('纯数字不变', () => {
    expect(normalizeArea('120')).toBe('120');
  });
});

describe('normalizeBudget / parseBudgetRange', () => {
  it('单个数字 min=max', () => {
    expect(normalizeBudget('预算 7000')).toBe('{"min":7000,"max":7000}');
    expect(parseBudgetRange('7000元/月')).toEqual({ min: 7000, max: 7000 });
  });
  it('区间解析', () => {
    expect(parseBudgetRange('5000-6000')).toEqual({ min: 5000, max: 6000 });
    expect(parseBudgetRange('5000到6000')).toEqual({ min: 5000, max: 6000 });
    expect(parseBudgetRange('6000~5000')).toEqual({ min: 5000, max: 6000 });
  });
  it('中文数字与万单位', () => {
    expect(parseBudgetRange('八千块')).toEqual({ min: 8000, max: 8000 });
    expect(parseBudgetRange('1.2万')).toEqual({ min: 12000, max: 12000 });
  });
  it('已归一化 JSON 幂等', () => {
    expect(normalizeBudget('{"min":5000,"max":6000}')).toBe('{"min":5000,"max":6000}');
  });
  it('无法解析原样返回', () => {
    expect(normalizeBudget('面议')).toBe('面议');
  });
});

describe('normalizeElderlyCare', () => {
  it('三档身体状况优先', () => {
    expect(normalizeElderlyCare('能自理')).toBe('能自理');
    expect(normalizeElderlyCare('半自理')).toBe('半自理');
    expect(normalizeElderlyCare('不能自理')).toBe('不能自理');
    expect(normalizeElderlyCare('老人能自理不需要照顾')).toBe('能自理');
  });
  it('明确不需要', () => {
    expect(normalizeElderlyCare('不需要')).toBe('不需要');
    expect(normalizeElderlyCare('家里没有老人')).toBe('不需要');
  });
  it('只提到没说细节归为提到了', () => {
    expect(normalizeElderlyCare('有个老人要照顾')).toBe('提到了');
    expect(normalizeElderlyCare('需要照顾老人')).toBe('提到了');
  });
});

describe('normalizeStartTime', () => {
  it('5 档枚举幂等', () => {
    expect(normalizeStartTime('尽快到岗')).toBe('尽快到岗');
    expect(normalizeStartTime('时间还不确定')).toBe('时间还不确定');
  });
  it('口语映射', () => {
    expect(normalizeStartTime('越快越好')).toBe('尽快到岗');
    expect(normalizeStartTime('一周内')).toBe('一周内到岗');
    expect(normalizeStartTime('半个月后')).toBe('两周内到岗');
    expect(normalizeStartTime('还没想好')).toBe('时间还不确定');
  });
  it('具体日期归入档位', () => {
    const inThreeDays = new Date(Date.now() + 3 * 86400000);
    const text = `${inThreeDays.getFullYear()}年${inThreeDays.getMonth() + 1}月${inThreeDays.getDate()}日`;
    expect(normalizeStartTime(text)).toBe('一周内到岗');
  });
});

describe('normalizeDietaryPreferences', () => {
  // 2026-08-31 林琳决策：方向信息比简洁更重要，保留原话不剥前缀，只做 trim/空值处理
  it('保留原话（含方向词）', () => {
    expect(normalizeDietaryPreferences('喜欢吃粤菜')).toBe('喜欢吃粤菜');
    expect(normalizeDietaryPreferences('口味偏清淡')).toBe('口味偏清淡');
    expect(normalizeDietaryPreferences('爱吃辣')).toBe('爱吃辣');
  });
  it('无前缀不变', () => {
    expect(normalizeDietaryPreferences('清淡')).toBe('清淡');
  });
});
