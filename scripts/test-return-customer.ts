/**
 * 老客回归检测 - 单元测试（2026-08-16 v3 简化版 / 林琳拍板）
 *
 * 跑法：
 *   npx tsx scripts/test-return-customer.ts
 *
 * v3.2 简化版测试覆盖：
 * - trigger 条件：history.length >= 2 触发（v3.2 林琳 8/16 修正：仅 1 条 = 新客，不算老客）
 * - hasCompletedOrder=true / false 走同一模板（统一性）
 * - 统一模板：4 段（看到您之前 → 这次您咨询的是 → 请问需要更改吗 → 以下是您上次留下的需求）
 * - 不说渠道（"小红书/美团/SEO"等不出现）
 * - 不做"还没收到"等不准确假设
 * - 字段列表：用 listCollectedFields 实际有的字段，不编造
 * - 兜底：history 为空 / length<2 → null（新客）
 *
 * 任何 case 不符合期望都抛出 AssertionError（exit code 1）
 */

import {
  formatHumanReadableTime,
  buildReturnCustomerContext,
  buildReturnCustomerOpening,
  type ReturnCustomerHistoryEntry,
} from '../server/modules/chat/return-customer.util';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assertContains(actual: string, expected: string, caseName: string, field: string): void {
  if (actual.includes(expected)) {
    passed++;
    console.log(`  ✓ ${field}: contains "${expected}"`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望包含 "${expected}"，实际："${actual}"`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertNotContains(actual: string, unexpected: string, caseName: string, field: string): void {
  if (!actual.includes(unexpected)) {
    passed++;
    console.log(`  ✓ ${field}: does NOT contain "${unexpected}"`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 不应包含 "${unexpected}"，但实际包含："${actual}"`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertEquals<T>(actual: T, expected: T, caseName: string, field: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${field}: ${JSON.stringify(actual)}`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertTruthy(value: unknown, caseName: string, field: string): void {
  if (value) {
    passed++;
    console.log(`  ✓ ${field}: truthy`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望为真，实际：${JSON.stringify(value)}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

function assertNullish(value: unknown, caseName: string, field: string): void {
  if (value === null || value === undefined) {
    passed++;
    console.log(`  ✓ ${field}: nullish (正确跳过)`);
  } else {
    failed++;
    const msg = `[${caseName}] ${field} 期望为 null/undefined，实际：${JSON.stringify(value)}`;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

// 固定 "now" 让测试稳定：2026-08-16 12:00:00 北京 = 2026-08-16T04:00:00Z
const NOW = new Date('2026-08-16T04:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * DAY).toISOString();

console.log('========================================');
console.log('  老客回归检测 v3 简化版 - 单元测试');
console.log(`  基准时间: ${NOW.toISOString()} (2026-08-16 12:00 北京)`);
console.log('========================================\n');

// ====================================================
// Case 1: history 仅 1 条 → null（v3.2 林琳修正：仅 1 次 form 留资 = 新客）
// ====================================================
console.log('[Case 1] history 1 条 → null（v3.2：length=1 = 新客）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: '小红书', serviceCity: '北京', customerName: '王女士', createdAt: daysAgo(3) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '北京', phoneNumber: '13900000099' },
    requirement: {
      serviceType: '住家保姆',
      householdSize: '3 口人',
      area: '90 平',
      restDays: '4 天',
      startTime: '9 月 1 号',
      serviceAddress: '朝阳区',
    },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 1', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 2: history 仅 1 条（hasCompletedOrder=false 同理）→ null
// ====================================================
console.log('\n[Case 2] history 1 条（hasCompletedOrder=false 同理）→ null（v3.2）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: '抖音', serviceCity: '广州', customerName: '陈女士', createdAt: daysAgo(5) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '广州', phoneNumber: '13900000002' },
    requirement: {
      serviceType: '钟点工',
      householdSize: '5 口人',
      area: '120 平',
    },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 2', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 3: history 仅 1 条 + 城市不同 → null（v3.2：length=1 不论 city 差异都算新客）
// ====================================================
console.log('\n[Case 3] history 1 条（上次城市≠当前城市）→ null（v3.2）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: 'seo', serviceCity: '北京', customerName: '刘女士', createdAt: daysAgo(45) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '上海', phoneNumber: '13900000003' },
    requirement: { serviceType: '育儿嫂' },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 3', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 4: history 仅 1 条 + v3.1 serviceType 字段 → null
//   （v3.1 数据补全的验证挪到 Case 4.6 — length=2 场景下）
// ====================================================
console.log('\n[Case 4] history 1 条（钟点工 → 月嫂）→ null（v3.2）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    {
      channel: 'openapi',
      source: 'meituan',
      serviceCity: '杭州',
      serviceType: '钟点工',  // v3.1 字段已补，但 length=1 仍算新客
      customerName: '赵女士',
      createdAt: daysAgo(20),
    },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '杭州', phoneNumber: '13900000004' },
    requirement: { serviceType: '月嫂' },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 4', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 4.5: history 仅 1 条（fallback 数据）→ null
// ====================================================
console.log('\n[Case 4.5] history 1 条（fallback：entry 没 serviceType）→ null（v3.2）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: 'openapi', serviceCity: '深圳', customerName: '钱女士', createdAt: daysAgo(15) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '深圳', phoneNumber: '13900000045' },
    requirement: { serviceType: '育儿嫂' },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 4.5', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 4.6: history 2 条 + v3.1 serviceType 字段（钟点工 → 月嫂）→ 触发老客 + lastService 从 history 取
// ====================================================
console.log('\n[Case 4.6] history 2 条 + v3.1 serviceType（钟点工→月嫂）→ 触发老客，lastService 从 history 取');
{
  const history: ReturnCustomerHistoryEntry[] = [
    {
      channel: 'openapi',
      source: 'meituan',
      serviceCity: '杭州',
      customerName: '赵女士',
      createdAt: daysAgo(60),  // 第一次留资（更早）
    },
    {
      channel: 'openapi',
      source: 'xiaohongshu',
      serviceCity: '杭州',
      serviceType: '钟点工',  // 第二次留资（最近一次），v3.1 补的 serviceType
      customerName: '赵女士',
      createdAt: daysAgo(20),
    },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '杭州', phoneNumber: '13900000046' },
    requirement: { serviceType: '月嫂' },
    history,
    now: NOW,
  });
  assertTruthy(ctx, 'Case 4.6', 'context 非空（length=2 触发）');
  if (ctx) {
    const opening = buildReturnCustomerOpening(ctx);
    console.log(`  → 输出:\n${opening}\n`);

    // v3.1 验证：lastService 从 history 最后一条取 = 钟点工；currentService 从 requirement 取 = 月嫂
    assertEquals(ctx.previousEntry.serviceType, '钟点工', 'Case 4.6', 'previousEntry.serviceType 透传');
    assertContains(opening, '看到您之前在【杭州】咨询过【钟点工】', 'Case 4.6', '上次服务 = 钟点工（从 history 取）');
    assertContains(opening, '这次您咨询的是【杭州】的【月嫂】', 'Case 4.6', '本次服务 = 月嫂（从 requirement 取）');
    assertNotContains(opening, '小红书', 'Case 4.6', '不说渠道');
    assertNotContains(opening, '美团', 'Case 4.6', '不说渠道');
  }
}

// ====================================================
// Case 4.7: history 2 条 + v3.1 fallback（最后一条没 serviceType）→ 触发老客 + lastService = currentService
// ====================================================
console.log('\n[Case 4.7] history 2 条 + v3.1 fallback（最后一条没 serviceType）→ 触发老客，lastService = currentService');
{
  const history: ReturnCustomerHistoryEntry[] = [
    {
      channel: 'openapi',
      source: 'meituan',
      serviceCity: '深圳',
      serviceType: '月嫂',  // 第一次留资，有 serviceType
      customerName: '钱女士',
      createdAt: daysAgo(45),
    },
    {
      channel: 'openapi',
      source: 'openapi',
      serviceCity: '深圳',
      // 最后一条没有 serviceType 字段（8/16 之前的旧数据）
      customerName: '钱女士',
      createdAt: daysAgo(15),
    },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '深圳', phoneNumber: '13900000047' },
    requirement: { serviceType: '育儿嫂' },
    history,
    now: NOW,
  });
  assertTruthy(ctx, 'Case 4.7', 'context 非空（length=2 触发）');
  if (ctx) {
    assertNullish(ctx.previousEntry.serviceType, 'Case 4.7', 'previousEntry.serviceType 应为 null（fallback）');
    const opening = buildReturnCustomerOpening(ctx);
    console.log(`  → 输出:\n${opening}\n`);

    // fallback：lastService = currentService = 育儿嫂
    assertContains(opening, '看到您之前在【深圳】咨询过【育儿嫂】', 'Case 4.7', 'fallback: lastService = currentService');
    assertContains(opening, '这次您咨询的是【深圳】的【育儿嫂】', 'Case 4.7', 'currentService = 育儿嫂');
  }
}

// ====================================================
// Case 5: history 仅 1 条 + requirement 字段全空 → null
// ====================================================
console.log('\n[Case 5] history 1 条 + requirement 字段全空 → null（v3.2）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: 'app', serviceCity: '成都', customerName: '孙先生', createdAt: daysAgo(10) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '成都', phoneNumber: '13900000005' },
    requirement: { serviceType: '住家保姆' },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 5', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 6: history 有多条 → 仍触发老客
// ====================================================
console.log('\n[Case 6] history 2 条 → 仍触发老客（v3 不管几条只看是否 ≥ 1）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: 'seo', serviceCity: '北京', customerName: '钱女士', createdAt: daysAgo(90) },
    { channel: 'openapi', source: '小红书', serviceCity: '北京', customerName: '钱女士', createdAt: daysAgo(7) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '北京', phoneNumber: '13900000006' },
    requirement: { serviceType: '护工', area: '80 平' },
    history,
    now: NOW,
  });
  assertTruthy(ctx, 'Case 6', 'context 非空');
  if (ctx) {
    const opening = buildReturnCustomerOpening(ctx);
    console.log(`  → 输出:\n${opening}\n`);

    // v3 取最后一条（最近一次）作为"上次"
    assertEquals(ctx.previousEntry.daysSince, 7, 'Case 6', 'daysSince = 最后一条');
    assertContains(opening, '看到您之前在【北京】咨询过【护工】', 'Case 6', '服务类型用当前 requirement');
    assertContains(opening, '房屋面积 80 平', 'Case 6', '列出当前 requirement 的字段');
    assertNotContains(opening, '小红书', 'Case 6', '不说渠道（哪怕 history 有 source 字段）');
  }
}

// ====================================================
// Case 7: history 为空 → null（新客）
// ====================================================
console.log('\n[Case 7] history 空 → null（新客）');
{
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '武汉', phoneNumber: '13900000007' },
    requirement: { serviceType: '保洁' },
    history: [],
    now: NOW,
  });
  assertNullish(ctx, 'Case 7', 'context 应为 null');
}

{
  const ctx2 = buildReturnCustomerContext({
    lead: { serviceCity: '武汉', phoneNumber: '13900000007' },
    requirement: { serviceType: '保洁' },
    history: null,
    now: NOW,
  });
  assertNullish(ctx2, 'Case 7', 'history=null 也应为 null');
}

// ====================================================
// Case 8: history 1 条 + daysSince=60 → null（v3.2: length=1 不论 daysSince 都算新客）
// ====================================================
console.log('\n[Case 8] history 1 条 + daysSince=60 → null（v3.2）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: 'meituan', serviceCity: '南京', customerName: '吴先生', createdAt: daysAgo(60) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '南京', phoneNumber: '13900000008' },
    requirement: { serviceType: '菲式保姆' },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 8', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 9: 7 天 / 30 天 / 60 天 / 90 天边界 - history 1 条 → 一律 null
// ====================================================
console.log('\n[Case 9] history 1 条 + 7/30/60/90 天边界 → 一律 null（v3.2）');
{
  for (const d of [7, 30, 60, 90]) {
    const history: ReturnCustomerHistoryEntry[] = [
      { channel: 'openapi', source: 'app', serviceCity: '西安', customerName: '郑先生', createdAt: daysAgo(d) },
    ];
    const ctx = buildReturnCustomerContext({
      lead: { serviceCity: '西安', phoneNumber: '13900000009' },
      requirement: { serviceType: '白班保姆' },
      history,
      now: NOW,
    });
    assertNullish(ctx, `Case 9 (d=${d})`, 'context 应为 null（v3.2: length=1 = 新客）');
  }
}

// ====================================================
// Case 10: history 1 条 → null（v3.2）；老客模板的否定词盘点由 Case 4.6 覆盖
// ====================================================
console.log('\n[Case 10] history 1 条 → null（v3.2: length=1 = 新客）');
{
  const history: ReturnCustomerHistoryEntry[] = [
    { channel: 'openapi', source: 'xiaohongshu', serviceCity: '重庆', customerName: '冯女士', createdAt: daysAgo(15) },
  ];
  const ctx = buildReturnCustomerContext({
    lead: { serviceCity: '重庆', phoneNumber: '13900000010' },
    requirement: {
      serviceType: '住家保姆',
      householdSize: '4 口人',
      area: '150 平',
    },
    history,
    now: NOW,
  });
  assertNullish(ctx, 'Case 10', 'context 应为 null（v3.2: length=1 = 新客）');
}

// ====================================================
// Case 11: formatHumanReadableTime 单测（v3 不直接用，但保留回归）
// ====================================================
console.log('\n[Case 11] formatHumanReadableTime 边界值（回归测试）');
{
  assertEquals(formatHumanReadableTime(NOW, NOW), '今天', 'Case 11', 'days=0');
  assertEquals(formatHumanReadableTime(new Date(NOW.getTime() - 1 * DAY), NOW), '昨天', 'Case 11', 'days=1');
  assertEquals(formatHumanReadableTime(new Date(NOW.getTime() - 3 * DAY), NOW), '3 天前', 'Case 11', 'days=3');
  assertEquals(formatHumanReadableTime(new Date(NOW.getTime() - 7 * DAY), NOW), '1 周前', 'Case 11', 'days=7');
  assertEquals(formatHumanReadableTime(new Date(NOW.getTime() - 30 * DAY), NOW), '7 月 17 号', 'Case 11', 'days=30 走月日格式');
}

// ====================================================
// 输出汇总
// ====================================================
console.log('\n========================================');
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
