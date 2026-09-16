/**
 * v3.3 新客 opening 命中 priority 2 单测
 *
 * 背景（2026-08-16 林琳反馈）："小书他现在已经不能根据我在表单里面填写的初步需求，给我针对性的开场白了"
 * 根因：160cbc6 之后 requirements.serviceType 存的是中文（cnServiceType），
 *      但 OPENING_MESSAGES_BY_SERVICE 的 key 是 pinyin → priority 2 永远不命中
 *      → 落到 priority 3 normalizeServiceType 把"住家"映射到 "baomu" → 5 段聚合版
 *
 * 修法：priority 2 之前先 normalizeServiceSubType 把中文 → pinyin
 *      测试核心：6 类服务的中文名 → pinyin → 6 段针对性模板 完整链路打通
 */

import {
  normalizeServiceSubType,
} from '../server/modules/automation/requirement-templates';
import {
  OPENING_MESSAGES_BY_SERVICE,
} from '../server/modules/chat/chat.prompt';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, caseName: string, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${caseName}: ${msg}`);
  } else {
    failed++;
    const failMsg = `${caseName}: ${msg}`;
    failures.push(failMsg);
    console.log(`  ✗ ${failMsg}`);
  }
}

console.log('========================================');
console.log('  v3.3 新客 opening priority 2 命中测试');
console.log('========================================\n');

// 模拟 buildOpeningMessage priority 2 修复后的查找逻辑
// 2026-08-16 林琳 17:26 重构：OPENING_MESSAGES_BY_SERVICE 的 value 是 { intro, followUp }
//   旧版是 string，新版是 OpeningMessage 对象；测试取 intro 验证
function lookupPriority2(rawServiceType: string | null | undefined): string | null {
  if (!rawServiceType) return null;
  const pinyin = normalizeServiceSubType(rawServiceType);
  if (pinyin && OPENING_MESSAGES_BY_SERVICE[pinyin]) {
    return OPENING_MESSAGES_BY_SERVICE[pinyin].intro;
  }
  return null;
}

// ====================================================
// Case 1-6: 6 类服务（林琳指定的）从 form 留资的中文名 → 命中 6 段针对性模板
// ====================================================
const cases = [
  { input: '钟点工保姆', expectedKey: 'zhongdian', label: '钟点工保姆' },
  { input: '白班保姆', expectedKey: 'baiban', label: '白班保姆' },
  { input: '住家保姆', expectedKey: 'zhujia', label: '住家保姆' },
  { input: '育儿保姆', expectedKey: 'yuer', label: '育儿保姆' },
  { input: '护工保姆', expectedKey: 'yanglao', label: '护工保姆' },
  { input: '菲式保姆', expectedKey: 'feishi', label: '菲式保姆' },
];

cases.forEach((c, i) => {
  const num = i + 1;
  console.log(`[Case ${num}] ${c.label}（form 留资中文名）`);

  // 第一步：中文 → pinyin
  const pinyin = normalizeServiceSubType(c.input);
  assert(pinyin === c.expectedKey, `Case ${num}.1`, `normalizeServiceSubType("${c.input}") = "${pinyin}"（期望 "${c.expectedKey}"）`);

  // 第二步：pinyin 命中 OPENING_MESSAGES_BY_SERVICE
  const template = lookupPriority2(c.input);
  assert(template !== null, `Case ${num}.2`, `lookupPriority2("${c.input}") 返回非 null`);

  // 第三步：模板内容里要带"【${c.label}】"针对性描述（不是聚合版）
  if (template) {
    assert(
      template.includes(`【${c.label}】`),
      `Case ${num}.3`,
      `模板含「【${c.label}】」标签（说明是针对性模板不是聚合版）`,
    );
    // 反向断言：不应该出现聚合版特征（"钟点工、白班、住家、育儿、护工、菲式保姆？"）
    assert(
      !template.includes('钟点工、白班、住家、育儿、护工、菲式保姆'),
      `Case ${num}.4`,
      `模板不是 5 段聚合版（说明 priority 3 没被错误命中）`,
    );
  }
  console.log();
});

// ====================================================
// Case 7: 防御性测试 - 直接用 pinyin key 也能命中（兼容老路径）
// ====================================================
console.log('[Case 7] 直接传 pinyin key 也应命中（兼容老路径）');
{
  const pinyinInputs = ['zhongdian', 'baiban', 'zhujia', 'yuer', 'yanglao', 'feishi'];
  pinyinInputs.forEach((p) => {
    const template = lookupPriority2(p);
    assert(template !== null, `Case 7.${p}`, `lookupPriority2("${p}") 返回非 null`);
  });
  console.log();
}

// ====================================================
// Case 8: 边界 - 月嫂/不识别值走 priority 3 兜底（不要 priority 2 误命中）
// ====================================================
console.log('[Case 8] 月嫂 / 不识别值不应 priority 2 误命中');
{
  // 月嫂 26day_yuesao / yuesao 在 OPENING_MESSAGES_BY_SERVICE 里没配（注释明确）
  // 应让 priority 3 normalizeServiceType 接管，priority 2 lookup 应返回 null
  const yuesao = lookupPriority2('月嫂');
  assert(yuesao === null, 'Case 8.1', 'lookupPriority2("月嫂") = null（让 priority 3 兜底）');

  const yuesao2 = lookupPriority2('26天月嫂');
  assert(yuesao2 === null, 'Case 8.2', 'lookupPriority2("26天月嫂") = null（让 priority 3 兜底）');

  // 未知值：应该 null
  const unknown = lookupPriority2('神秘服务');
  assert(unknown === null, 'Case 8.3', 'lookupPriority2("神秘服务") = null');
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
