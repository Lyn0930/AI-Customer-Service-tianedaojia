/**
 * 住家保姆 5+3 字段 2 阶段采集 - 单元测试
 * - 2026-08-16 v1: 5 字段（3 单独项归人工）
 * - 2026-08-16 v2 (当前): 5 字段 + 3 单独项 = 8 字段，由 AI 分 2 阶段采集
 *
 * 跑法：
 *   npx tsx scripts/test-zhujia-one-shot.ts
 *
 * 设计：
 * - 直接调 requirement-templates 的纯函数（不依赖 @nestjs/common / 不启动 server）
 * - 覆盖：5 字段采齐 / 8 字段采齐 / zhujia 模板（10 字段含 3 单独项）/ label / 归一化
 * - buildGuidancePrompt 的 zhujia 2 阶段分支测试放到 chat.e2e.test.ts（需要 server 上下文）
 * - 任何 case 不符合期望都抛出 AssertionError（exit code 1）
 */

import {
  isZhujiaRequiredFieldsComplete,
  isZhujiaAllFieldsComplete,
  isZhujiaOneShotComplete, // alias of isZhujiaRequiredFieldsComplete（兼容旧 API）
  getTemplate,
  getServiceTypeLabel,
  normalizeServiceSubType,
} from '../server/modules/automation/requirement-templates';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertEquals<T>(actual: T, expected: T, caseName: string, field: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${field}: equals ${JSON.stringify(expected)}`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertFalse(actual: boolean, caseName: string, field: string): void {
  if (!actual) {
    passed++;
    console.log(`  ✓ ${field}: false（期望 false）`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望 false，实际 true`;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

function assertTrue(actual: boolean, caseName: string, field: string): void {
  if (actual) {
    passed++;
    console.log(`  ✓ ${field}: true（期望 true）`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望 true，实际 false`;
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

console.log('='.repeat(70));
console.log('  住家保姆 5+3 字段 2 阶段采集 - 单元测试（v2 2026-08-16 林琳拍板加回 3 单独项）');
console.log('='.repeat(70));

// ============================
// 第 1 组：isZhujiaRequiredFieldsComplete（阶段 1：5 字段采齐）
// ============================
console.log('\n[1] isZhujiaRequiredFieldsComplete - 阶段 1 5 字段采齐判断');
console.log('-'.repeat(70));

// Case 1: 全字段都填 → true
assertTrue(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区玉桥街道',
    householdSize: '5口',
  }),
  '1.全字段都填',
  'stage1Done',
);

// Case 2: 只有 restDays + startTime + serviceAddress，缺工作内容 → false
assertFalse(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区',
  }),
  '2.缺工作内容',
  'stage1Done',
);

// Case 3: 工作内容 3 选 1：只填 area → true（工作内容任一就算）
assertTrue(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休2天',
    startTime: '随时',
    serviceAddress: '朝阳区',
    area: '120平',
  }),
  '3.工作内容只填 area',
  'stage1Done',
);

// Case 4: 工作内容 3 选 1：只填 elderlyCare → true
assertTrue(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休4天',
    startTime: '下周',
    serviceAddress: '海淀区',
    elderlyCare: '不需要老人照护',
  }),
  '4.工作内容只填 elderlyCare',
  'stage1Done',
);

// Case 5: 缺 restDays → false
assertFalse(
  isZhujiaRequiredFieldsComplete({
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
  }),
  '5.缺 restDays',
  'stage1Done',
);

// Case 6: 缺 startTime → false
assertFalse(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休4天',
    serviceAddress: '通州区',
    householdSize: '5口',
  }),
  '6.缺 startTime',
  'stage1Done',
);

// Case 7: 缺 serviceAddress → false
assertFalse(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    householdSize: '5口',
  }),
  '7.缺 serviceAddress',
  'stage1Done',
);

// Case 8: 全空 → false
assertFalse(isZhujiaRequiredFieldsComplete(null), '8.全空', 'stage1Done');

// Case 9: 部分填 + 空字符串字段 → false（空串不算）
assertFalse(
  isZhujiaRequiredFieldsComplete({
    restDays: '',
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
  }),
  '9.restDays 是空串',
  'stage1Done',
);

// Case 10: 林琳原话场景——客户一条短信全答："5口 250平 不需要 4天 一周之内 通州区玉桥街道"
assertTrue(
  isZhujiaRequiredFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区玉桥街道',
    householdSize: '5口',
    area: '250平',
    elderlyCare: '不需要老人照护',
  }),
  '10.林琳原话一条短信全答',
  'stage1Done',
);

// ============================
// 第 2 组：isZhujiaAllFieldsComplete（阶段 2：8 字段全齐 = 转人工）
// ============================
console.log('\n[2] isZhujiaAllFieldsComplete - 阶段 2 8 字段全齐判断（v2 新增）');
console.log('-'.repeat(70));

// Case 11: 8 字段全齐 → true
assertTrue(
  isZhujiaAllFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区玉桥街道',
    householdSize: '5口',
    helperRequirements: '5年以上经验',
    dietaryPreferences: '清淡',
    budget: '7000-8000',
  }),
  '11.8 字段全齐',
  'allDone',
);

// Case 12: 5 字段齐但 3 单独项未填 → false（关键 v2 差异：v1 这里会返回 true）
assertFalse(
  isZhujiaAllFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区玉桥街道',
    householdSize: '5口',
  }),
  '12.5 字段齐但 3 单独项未填',
  'allDone',
);

// Case 13: 5 字段齐 + helperRequirements/dietaryPreferences 已采，缺 budget → false
assertFalse(
  isZhujiaAllFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
    helperRequirements: '5年以上经验',
    dietaryPreferences: '清淡',
  }),
  '13.缺 budget',
  'allDone',
);

// Case 14: 5 字段齐 + helperRequirements 已采，缺 dietaryPreferences + budget → false
assertFalse(
  isZhujiaAllFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
    helperRequirements: '5年以上经验',
  }),
  '14.缺 dietaryPreferences + budget',
  'allDone',
);

// Case 15: 5 字段齐 + 3 单独项只有 budget → false
assertFalse(
  isZhujiaAllFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
    budget: '7000',
  }),
  '15.只填 budget',
  'allDone',
);

// Case 16: 3 单独项全齐但 5 字段不齐 → false（阶段 1 必须先齐）
assertFalse(
  isZhujiaAllFieldsComplete({
    helperRequirements: '5年以上经验',
    dietaryPreferences: '清淡',
    budget: '7000',
  }),
  '16.5 字段不齐（阶段 1 未过）',
  'allDone',
);

// Case 17: 3 单独项用"无要求"也算已采（v2 关键：负面回复兜底）
assertTrue(
  isZhujiaAllFieldsComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
    helperRequirements: '无要求',
    dietaryPreferences: '无要求',
    budget: '待定',
  }),
  '17.3 单独项用"无要求"兜底',
  'allDone',
);

// Case 18: 全空 → false
assertFalse(isZhujiaAllFieldsComplete(null), '18.全空', 'allDone');

// ============================
// 第 3 组：isZhujiaOneShotComplete（兼容旧 API，等价于 isZhujiaRequiredFieldsComplete）
// ============================
console.log('\n[3] isZhujiaOneShotComplete - 兼容旧 API（5 字段语义）');
console.log('-'.repeat(70));

assertEquals(
  isZhujiaOneShotComplete,
  isZhujiaRequiredFieldsComplete,
  '19.alias 同函数',
  'ref',
);
assertTrue(
  isZhujiaOneShotComplete({
    restDays: '月休4天',
    startTime: '一周之内',
    serviceAddress: '通州区',
    householdSize: '5口',
  }),
  '20.5 字段齐 → true（v1 行为，保留兼容）',
  'completed',
);

// ============================
// 第 4 组：getTemplate（zhujia 走自己的 10 字段模板）
// ============================
console.log('\n[4] getTemplate - zhujia 走 10 字段模板（含 3 单独项，v2 加回）');
console.log('-'.repeat(70));

// Case 21: zhujia → ZHUJIA_TEMPLATE（10 字段：5 + 3 单独项）
const zhujiaTpl = getTemplate('zhujia');
assertEquals(zhujiaTpl.length, 10, '21.zhujia 模板字段数 = 10（5 + 3 单独项）', 'tpl.length');
assertEquals(zhujiaTpl[0].key, 'serviceType', '21.zhujia 模板首字段', 'tpl[0].key');

// Case 22: v2 加回 3 单独项（v1 去除，v2 加回）
const zhujiaKeys = zhujiaTpl.map((f) => f.key);
assertTrue(zhujiaKeys.includes('budget'), '22.v2 加回 budget', 'has budget');
assertTrue(zhujiaKeys.includes('helperRequirements'), '22.v2 加回 helperRequirements', 'has helper');
assertTrue(zhujiaKeys.includes('dietaryPreferences'), '22.v2 加回 dietaryPreferences', 'has diet');

// Case 23: zhujia 模板**含** 5 字段核心
assertTrue(zhujiaKeys.includes('restDays'), '23.zhujia 模板含 restDays', 'has restDays');
assertTrue(zhujiaKeys.includes('startTime'), '23.zhujia 模板含 startTime', 'has startTime');
assertTrue(zhujiaKeys.includes('serviceAddress'), '23.zhujia 模板含 serviceAddress', 'has serviceAddress');
assertTrue(zhujiaKeys.includes('householdSize'), '23.zhujia 模板含 householdSize（工作内容）', 'has householdSize');
assertTrue(zhujiaKeys.includes('area'), '23.zhujia 模板含 area（工作内容）', 'has area');
assertTrue(zhujiaKeys.includes('elderlyCare'), '23.zhujia 模板含 elderlyCare（工作内容）', 'has elderlyCare');

// Case 24: 中文"住家保姆"也走 ZHUJIA_TEMPLATE
const zhujiaTpl2 = getTemplate('住家保姆');
assertEquals(zhujiaTpl2.length, 10, '24.中文"住家保姆"走 10 字段模板', 'tpl.length');

// Case 25: baomu 还是走 BAOMU_TEMPLATE（10 字段，不动）
const baomuTpl = getTemplate('baomu');
assertEquals(baomuTpl.length, 10, '25.baomu 保持 10 字段（不归 zhujia）', 'tpl.length');

// Case 26: baiban 走 BAOMU_TEMPLATE（10 字段）
const baibanTpl = getTemplate('baiban');
assertEquals(baibanTpl.length, 10, '26.baiban 走 baomu 模板', 'tpl.length');

// ============================
// 第 5 组：getServiceTypeLabel（zhujia 显示"住家保姆"）
// ============================
console.log('\n[5] getServiceTypeLabel - zhujia 显示"住家保姆"');
console.log('-'.repeat(70));

assertEquals(getServiceTypeLabel('zhujia'), '住家保姆', '27.zhujia pinyin', 'label');
assertEquals(getServiceTypeLabel('住家'), '住家保姆', '28.中文"住家"', 'label');
assertEquals(getServiceTypeLabel('住家保姆'), '住家保姆', '29.中文"住家保姆"', 'label');
assertEquals(getServiceTypeLabel('baomu'), '保姆', '30.baomu 仍显示保姆', 'label');
assertEquals(getServiceTypeLabel('baiban'), '保姆', '31.baiban 仍走 baomu 标签', 'label');

// ============================
// 第 6 组：normalizeServiceSubType
// ============================
console.log('\n[6] normalizeServiceSubType - 子类型归一');
console.log('-'.repeat(70));

assertEquals(normalizeServiceSubType('zhujia'), 'zhujia', '32.zhujia pinyin', 'subType');
assertEquals(normalizeServiceSubType('住家保姆'), 'zhujia', '33.中文"住家保姆"', 'subType');
assertEquals(normalizeServiceSubType('住家'), 'zhujia', '34.中文"住家"', 'subType');
assertEquals(normalizeServiceSubType('baiban'), 'baiban', '35.baiban pinyin', 'subType');
assertEquals(normalizeServiceSubType('白班保姆'), 'baiban', '36.中文"白班保姆"', 'subType');
assertEquals(normalizeServiceSubType('钟点工'), 'zhongdian', '37.中文"钟点工"', 'subType');

// ============================
// 总结
// ============================
console.log('\n' + '='.repeat(70));
console.log(`  测试结果: ${passed} passed / ${failed} failed`);
console.log('='.repeat(70));

if (failed > 0) {
  console.log('\n失败明细:');
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}

console.log('\n所有 5+3 字段 2 阶段采集测试通过 ✅');
process.exit(0);
