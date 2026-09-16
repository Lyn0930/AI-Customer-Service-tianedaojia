/**
 * 钟点工保姆 8 字段采集 - 单元测试（2026-08-16 林琳 16:11 拍板）
 *
 * 林琳 8 字段：家庭情况、房屋面积、休息天数、到岗时间、服务地址、阿姨要求、做饭口味、薪资预算
 *   - 加 serviceType 自动采集 = 9 字段总数
 *   - 阶段 1（5 字段）：3 必填（restDays/startTime/serviceAddress）+ 工作内容 2 选 1+（householdSize/area）
 *   - 阶段 2（3 单独项）：helperRequirements + dietaryPreferences + budget
 *   - 关键区别于 BAOMU：去掉 elderlyCare（钟点工时间短，不照护老人）
 *
 * 跑法：
 *   npx tsx scripts/test-zhongdian-template.ts
 */

import {
  isZhongdianRequiredFieldsComplete,
  isZhongdianAllFieldsComplete,
  getTemplate,
  getServiceTypeLabel,
  normalizeServiceSubType,
} from '../server/modules/automation/requirement-templates';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertTrue(actual: boolean, caseName: string, msg: string): void {
  if (actual) {
    passed++;
    console.log(`  ✓ ${caseName}: ${msg}`);
  } else {
    failed++;
    const failMsg = `${caseName}: ${msg} (actual=${actual})`;
    failures.push(failMsg);
    console.log(`  ✗ ${failMsg}`);
  }
}

function assertFalse(actual: boolean, caseName: string, msg: string): void {
  assertTrue(!actual, caseName, `${msg} (actual=${actual})`);
}

function assertEquals<T>(actual: T, expected: T, caseName: string, msg: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passed++;
    console.log(`  ✓ ${caseName}: ${msg}`);
  } else {
    failed++;
    const failMsg = `${caseName}: ${msg} (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`;
    failures.push(failMsg);
    console.log(`  ✗ ${failMsg}`);
  }
}

console.log('========================================');
console.log('  钟点工保姆 8 字段采集单测');
console.log('========================================\n');

// ====================================================
// Case 1: ZHONGDIAN_TEMPLATE 字段列表（9 字段，不含 elderlyCare）
// ====================================================
console.log('[Case 1] ZHONGDIAN_TEMPLATE 字段列表（9 字段，不含 elderlyCare）');
{
  const tpl = getTemplate('钟点工');
  const keys = tpl.map((f) => f.key);
  const expectedKeys = [
    'serviceType',
    'householdSize',
    'area',
    'restDays',
    'startTime',
    'serviceAddress',
    'helperRequirements',
    'dietaryPreferences',
    'budget',
  ];
  assertEquals(keys, expectedKeys, 'Case 1.1', '字段顺序 = 林琳 8 字段 + serviceType');
  assertFalse(keys.includes('elderlyCare'), 'Case 1.2', '钟点工模板不含 elderlyCare（林琳 8/16 16:11 决策）');
  assertEquals(tpl.length, 9, 'Case 1.3', '总字段数 = 9');
  console.log();
}

// ====================================================
// Case 2: getServiceTypeLabel 钟点工返回"钟点工保姆"
// ====================================================
console.log('[Case 2] getServiceTypeLabel 钟点工返回"钟点工保姆"');
{
  assertEquals(getServiceTypeLabel('钟点工'), '钟点工保姆', 'Case 2.1', '中文输入 → 钟点工保姆');
  assertEquals(getServiceTypeLabel('钟点工保姆'), '钟点工保姆', 'Case 2.2', '中文 + 保姆 → 钟点工保姆');
  assertEquals(getServiceTypeLabel('zhongdian'), '钟点工保姆', 'Case 2.3', 'pinyin 输入 → 钟点工保姆');
  assertEquals(getServiceTypeLabel('小时工'), '通用', 'Case 2.4', '"小时工"未在 subType 映射 → fallback 默认（注意：normalizeServiceSubType 没配小时工，走 baomu）');
  console.log();
}

// ====================================================
// Case 3: 阶段 1（5 字段）采齐判断 isZhongdianRequiredFieldsComplete
// ====================================================
console.log('[Case 3] 阶段 1 采齐：3 必填 + 工作内容 2 选 1+');
{
  // 3.1 全空 → false
  assertFalse(
    isZhongdianRequiredFieldsComplete({}),
    'Case 3.1',
    '全空 → false',
  );
  // 3.2 只有 restDays/startTime/serviceAddress，缺工作内容 → false
  assertFalse(
    isZhongdianRequiredFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
    }),
    'Case 3.2',
    '3 必填齐 + 无工作内容 → false（必填齐但工作内容缺）',
  );
  // 3.3 3 必填 + householdSize → true
  assertTrue(
    isZhongdianRequiredFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
    }),
    'Case 3.3',
    '3 必填 + householdSize → true',
  );
  // 3.4 3 必填 + area → true
  assertTrue(
    isZhongdianRequiredFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      area: '90平',
    }),
    'Case 3.4',
    '3 必填 + area → true',
  );
  // 3.5 3 必填 + 两工作内容都有 → true
  assertTrue(
    isZhongdianRequiredFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      area: '90平',
    }),
    'Case 3.5',
    '3 必填 + 双工作内容 → true',
  );
  // 3.6 缺 serviceAddress → false
  assertFalse(
    isZhongdianRequiredFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      householdSize: '3口人',
    }),
    'Case 3.6',
    '缺 serviceAddress → false',
  );
  // 3.7 关键：elderlyCare 不参与钟点工工作内容判定
  assertFalse(
    isZhongdianRequiredFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      elderlyCare: '老人80岁', // 有 elderlyCare 但钟点工不应采
    }),
    'Case 3.7',
    '只有 elderlyCare + 3 必填 → false（钟点工不采 elderlyCare）',
  );
  console.log();
}

// ====================================================
// Case 4: 阶段 2（8 字段全齐）判断 isZhongdianAllFieldsComplete
// ====================================================
console.log('[Case 4] 阶段 2 采齐：5 字段 + 3 单独项 = 8 字段');
{
  // 4.1 阶段 1 都没齐 → false
  assertFalse(
    isZhongdianAllFieldsComplete({}),
    'Case 4.1',
    '阶段 1 没齐 → false',
  );
  // 4.2 阶段 1 齐 + 3 单独项缺 → false
  assertFalse(
    isZhongdianAllFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
    }),
    'Case 4.2',
    '阶段 1 齐 + 3 单独项缺 → false',
  );
  // 4.3 阶段 1 齐 + helperRequirements → false（少 2 项）
  assertFalse(
    isZhongdianAllFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      helperRequirements: '40-50岁',
    }),
    'Case 4.3',
    '阶段 1 齐 + 1 单独项 → false',
  );
  // 4.4 阶段 1 齐 + 2 单独项 → false
  assertFalse(
    isZhongdianAllFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      helperRequirements: '40-50岁',
      dietaryPreferences: '不吃辣',
    }),
    'Case 4.4',
    '阶段 1 齐 + 2 单独项 → false',
  );
  // 4.5 阶段 1 齐 + 3 单独项齐 → true
  assertTrue(
    isZhongdianAllFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      helperRequirements: '40-50岁',
      dietaryPreferences: '不吃辣',
      budget: '5000',
    }),
    'Case 4.5',
    '阶段 1 齐 + 3 单独项齐 → true（钟点工 8 字段全齐）',
  );
  // 4.6 阶段 1 用 area（无 householdSize） + 3 单独项 → true
  assertTrue(
    isZhongdianAllFieldsComplete({
      restDays: '4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      area: '90平',
      helperRequirements: '40-50岁',
      dietaryPreferences: '不吃辣',
      budget: '5000',
    }),
    'Case 4.6',
    '阶段 1 用 area（无 householdSize）+ 3 单独项齐 → true',
  );
  console.log();
}

// ====================================================
// Case 5: normalizeServiceSubType 钟点工归一
// ====================================================
console.log('[Case 5] normalizeServiceSubType 钟点工归一');
{
  assertEquals(normalizeServiceSubType('钟点工'), 'zhongdian', 'Case 5.1', '钟点工 → zhongdian');
  assertEquals(normalizeServiceSubType('钟点工保姆'), 'zhongdian', 'Case 5.2', '钟点工保姆 → zhongdian');
  assertEquals(normalizeServiceSubType('钟点'), 'zhongdian', 'Case 5.3', '钟点 → zhongdian');
  assertEquals(normalizeServiceSubType('zhongdian'), 'zhongdian', 'Case 5.4', 'zhongdian → zhongdian');
  assertEquals(normalizeServiceSubType('住家'), 'zhujia', 'Case 5.5', '住家 → zhujia（不串号到 zhongdian）');
  assertEquals(normalizeServiceSubType(null), null, 'Case 5.6', 'null → null');
  console.log();
}

// ====================================================
// Case 6: 回归 - 钟点工模板不被 zhujia 误命中
// ====================================================
console.log('[Case 6] 回归 - 钟点工模板不被 zhujia 误命中');
{
  const zhujiaTpl = getTemplate('住家');
  const zhongdianTpl = getTemplate('钟点工');
  // zhujia 模板有 elderlyCare，zhongdian 没有
  assertTrue(zhujiaTpl.some((f) => f.key === 'elderlyCare'), 'Case 6.1', '住家模板含 elderlyCare');
  assertFalse(zhongdianTpl.some((f) => f.key === 'elderlyCare'), 'Case 6.2', '钟点工模板不含 elderlyCare');
  // 字段总数不同
  assertEquals(zhujiaTpl.length, 10, 'Case 6.3', '住家模板 10 字段（含 3 单独项 helper/dietary/budget）');
  assertEquals(zhongdianTpl.length, 9, 'Case 6.4', '钟点工模板 9 字段（去 elderlyCare + 仍含 3 单独项）');
  // label 不同
  assertEquals(getServiceTypeLabel('住家'), '住家保姆', 'Case 6.5', '住家 label = 住家保姆');
  assertEquals(getServiceTypeLabel('钟点工'), '钟点工保姆', 'Case 6.6', '钟点工 label = 钟点工保姆');
  console.log();
}

// ====================================================
// Case 7: 无月休路径（2026-08-16 林琳 16:16 拍板 + 16:58 澄清）
// v1（16:16）：restDays="无月休" 时不算 completed（永远不转人工）
// v2（16:58 澄清）：restDays="无月休" 是合法选项之一，8 字段全齐后**正常**走转人工
//   - 钟点工"无月休"不作为"立即转人工"的触发原因（其他服务类型会）
//   - 但 8 字段全采齐后（含选了"无月休"）→ 正常转人工
// ====================================================
console.log('[Case 7] 无月休路径 - 林琳 8/16 16:16 拍板 + 16:58 澄清');
{
  // 7.1 阶段 1 齐（无月休）→ required OK（不卡客户）
  assertTrue(
    isZhongdianRequiredFieldsComplete({
      restDays: '无月休',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
    }),
    'Case 7.1',
    'restDays="无月休" + 3 必填 + 工作内容 → 阶段 1 采齐（不再问月休）',
  );
  // 7.2 阶段 2 全部齐 + restDays="无月休" → true（**正常**转人工，v2 修正）
  // 16:58 澄清：钟点工选了"无月休"是合法选项，8 字段采齐后照样转人工
  assertTrue(
    isZhongdianAllFieldsComplete({
      restDays: '无月休',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      helperRequirements: '40-50岁',
      dietaryPreferences: '不吃辣',
      budget: '5000',
    }),
    'Case 7.2',
    '8 字段全齐 + restDays="无月休" → completed（v2 正常转人工，林琳 16:58 澄清）',
  );
  // 7.3 阶段 2 全部齐 + restDays="月休2天" → true（正常转人工）
  assertTrue(
    isZhongdianAllFieldsComplete({
      restDays: '月休2天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      helperRequirements: '40-50岁',
      dietaryPreferences: '不吃辣',
      budget: '5000',
    }),
    'Case 7.3',
    '8 字段全齐 + restDays="月休2天" → completed（正常转人工）',
  );
  // 7.4 阶段 2 全部齐 + restDays="月休4天" → true（正常转人工）
  assertTrue(
    isZhongdianAllFieldsComplete({
      restDays: '月休4天',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      helperRequirements: '40-50岁',
      dietaryPreferences: '不吃辣',
      budget: '5000',
    }),
    'Case 7.4',
    '8 字段全齐 + restDays="月休4天" → completed（正常转人工）',
  );
  // 7.5 restDays 模板 question 措辞 = 林琳原话
  const tpl = getTemplate('钟点工');
  const restDaysField = tpl.find((f) => f.key === 'restDays');
  assertEquals(
    restDaysField?.question,
    '您想让阿姨月休几天呢？无月休、月休2天、或月休4天',
    'Case 7.5',
    '钟点工 restDays.question 措辞 = 林琳 16:16 原话（3 选项）',
  );
  // 7.6 8 字段全齐 + restDays="无月休" + 缺 helperRequirements → false（v2 仍要 8 字段全齐）
  assertFalse(
    isZhongdianAllFieldsComplete({
      restDays: '无月休',
      startTime: '9月1号',
      serviceAddress: '朝阳区',
      householdSize: '3口人',
      // helperRequirements 缺
      dietaryPreferences: '不吃辣',
      budget: '5000',
    }),
    'Case 7.6',
    '8 字段缺 1 项 + restDays="无月休" → false（仍要 8 字段全齐）',
  );
  console.log();
}

// ====================================================
// 输出汇总
// ====================================================
console.log('========================================');
console.log(`  测试结果汇总`);
console.log(`  通过: ${passed}  失败: ${failed}`);
if (failed > 0) {
  console.log(`\n  失败列表：`);
  failures.forEach((f) => console.log(`    - ${f}`));
  console.log('\n  ❌ 有 case 未通过');
  process.exit(1);
} else {
  console.log('\n  ✅ 全部通过');
  process.exit(0);
}
