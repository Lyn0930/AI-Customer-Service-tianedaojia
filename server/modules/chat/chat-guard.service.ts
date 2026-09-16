import { Injectable, Logger } from '@nestjs/common';
import { isFieldCollected } from '../automation/requirement-templates';
import {
  buildGuardQuestionTriggers,
  buildGuardImperativeTriggers,
  GUARD_FIELDS,
} from '../automation/requirement-fields.config';

/* ============ 回复校验器 v2（阶段二） ============ */

const SENSITIVE_WORDS: string[] = [
  '治疗', '治愈', '根治', '疗效', '包治', '偏方', '祖传', '特效',
  '无效退款', '假一赔十', '零风险', '绝对安全', '国家认证', '行业第一', '唯一指定',
];

export interface SensitiveWordHit {
  word: string;
  index: number;
}

export function findSensitiveWords(response: string): SensitiveWordHit[] {
  const hits: SensitiveWordHit[] = [];
  for (const word of SENSITIVE_WORDS) {
    const idx: number = response.indexOf(word);
    if (idx >= 0) {
      hits.push({ word, index: idx });
    }
  }
  return hits;
}

export interface ValidateContextV2 {
  sessionMode: string;
}

export interface ValidateResultV2 {
  blocked: boolean;
  reason: 'transfer_promise' | 'absolute_promise' | 'sensitive_word' | null;
  patchedText?: string;
}

@Injectable()
export class ChatGuardService {
  private readonly logger = new Logger(ChatGuardService.name);


  /**
   * 月休问题专项检测：按5种情况分类处理
   * 1. 标准答案(4天/2天) → 不转人工，让AI记录并继续
   * 2. 非标答案(其他天数/无月休) → 转人工，reason=restDaysOverride
   * 3. 困惑(必须二选一吗/只能选这两个吗) → 解释后转人工，reason=restDaysOverride
   * 4. 找人工/不满 → 由关键词检测处理，此处不处理
   * 5. 无关 → 不转人工，让AI拉回主题
   *
   * 2026-08-16 林琳 16:58 拍板：钟点工场景（isZhongdian=true）下"无月休"不触发转人工
   *   - 钟点工 bot 提问是"无月休、月休2天、或月休4天"3 选项，不是"X天还是Y天"二选一
   *   - isRestDaysQuestion 本身就返回 false（"无月休、月休2天"不匹配"X天还是Y天"正则）
   *   - 这里加 isZhongdian 防御性 return，进一步确保即使未来 prompt 改了也不会误触发
   */
  public checkRestDaysResponse(
    lastBotMessage: string,
    customerReply: string,
    isZhongdian: boolean = false,
  ): { shouldTransfer: boolean; reason?: string; message?: string } {
    // 2026-08-16 林琳 16:58 拍板：钟点工场景下不拦截，让 AI 正常继续采 8 字段
    if (isZhongdian) {
      return { shouldTransfer: false };
    }
    const isRestDaysQuestion = /月休/.test(lastBotMessage)
      && /\d+\s*天.*?还是.*?\d+\s*天/.test(lastBotMessage);
    if (!isRestDaysQuestion) {
      return { shouldTransfer: false };
    }

    const restDaysMatch = lastBotMessage.match(/(\d+)\s*天.*?还是.*?(\d+)\s*天/);
    if (!restDaysMatch) {
      return { shouldTransfer: false };
    }

    // 1. 标准答案：4天/2天/两天/四天 → 不转人工
    const standardAnswers = [
      restDaysMatch[1] + '天', restDaysMatch[2] + '天',
      '两天', '四天',
    ];
    if (standardAnswers.some((kw) => customerReply.includes(kw))) {
      return { shouldTransfer: false };
    }

    // 2. 非标答案：含具体天数 → 先说明要点再转人工
    const dayMatch = customerReply.match(/(\d+)\s*天/);
    if (dayMatch) {
      const days = dayMatch[1];
      const isMoreThanStandard = Number(days) > 4;
      const salaryNote = isMoreThanStandard
        ? `月休增加意味着阿姨实际工作日减少，薪资会相应做调整（通常是在基础薪资上按天折算，多休${Number(days) - 4}天相应扣减），具体金额可以根据您选定的阿姨等级来算`
        : '休息天数减少涉及薪资上浮，具体金额可以根据您选定的阿姨等级来算';
      const scopeNote = isMoreThanStandard
        ? '大部分阿姨更倾向于月休4天的安排，选择这个天数的话可选阿姨范围会相对窄一些，不过我们会尽量帮您匹配合适的人选'
        : '愿意多上班的阿姨也不少，我们会尽快帮您匹配合适的人选';
      const message = `可以的~跟您说明一下：咱们行业标准的月休一般是4天，住家保姆的服务周期是按整月计算的。薪资方面：${salaryNote}。匹配范围：${scopeNote}。我帮您转接顾问详细沟通，专员马上为您服务~`;
      return {
        shouldTransfer: true,
        reason: 'restDaysOverride',
        message,
      };
    }

    // 2b. 非标答案：无月休/不休息 → 转人工
    if (/无月休|不休息|无休|没有月休|不休/.test(customerReply)) {
      return {
        shouldTransfer: true,
        reason: 'restDaysOverride',
        message: '无月休涉及薪资调整，我帮您转顾问详细沟通哦~',
      };
    }

    // 3. 困惑：必须二选一吗/只能选这两个吗 → 解释要点后转人工
    if (/必须|二选一|只能选|一定要|为什么/.test(customerReply)) {
      return {
        shouldTransfer: true,
        reason: 'restDaysOverride',
        message: '可以的~不是必须的哦，咱们行业标准的月休一般是4天。如果您希望其他天数，薪资会相应做调整（通常是在基础薪资上按天折算），可选阿姨范围也会相应变化。我帮您转接顾问详细沟通，专员马上为您服务~',
      };
    }

    // 5. 无关回答 → 不转人工，让AI拉回主题
    return { shouldTransfer: false };
  }

  /**
   * 月休非标早拦截（2026-08-15 P0 修复 v2 配套）
   *
   * 与 checkRestDaysResponse 区别：
   *   - checkRestDaysResponse 依赖 lastBotMessage（要求 bot 问过"X天还是Y天"），
   *     处理"bot问月休 4/2 → 客户答 6 天"这个特定场景
   *   - detectNonStandardRestDays 不依赖 lastBotMessage，只看 customer 消息，
   *     处理"客户说月休 6 天但 bot 上轮问的是其他事（如老人/小孩）"这种更常见场景
   *
   * 命中条件（满足任一即返回）：
   *   1. 含"月休 X 天"且 X != 4 → 非标答案
   *   2. 含"无月休/不休息/无休/没有月休/不休" → 0 天
   *
   * 用途：在 transfer 关键词/frustration/checkRestDaysResponse 之前先拦截，
   *   避免 AI persona 自主决策走"月休 6 天 → 转人工"造成后续 30s 静默
   *
   * 2026-08-16 林琳 16:58 拍板：钟点工场景（isZhongdian=true）跳过这个早拦截
   *   - 钟点工"无月休"是正常选项，不应被"涉及薪资调整"模板中断 AI 采字段流程
   *   - 让 AI 正常继续采 8 字段
   * 2026-08-16 林琳 19:44 拍板：钟点工+无月休 8 字段全齐**不**走转人工
   *   - 钟点工"无月休"是合法选项，客户工作忙不需要阿姨休息，不需人工对接
   *   - 8 字段全齐+月休2天/4天 → 仍走转人工（由 chat.service.ts:generateAiReplyForSession 的护栏处理）
   */
  public detectNonStandardRestDays(
    customerReply: string,
    isZhongdian: boolean = false,
  ): { reason: string; message: string } | null {
    // 2026-08-16 林琳 16:58 拍板：钟点工场景下不拦截，让 AI 正常继续采 8 字段
    if (isZhongdian) {
      return null;
    }
    // 1. 含"月休 X 天"且 X != 4
    const restDaysMatch = customerReply.match(/月休\s*(\d+)\s*天/);
    if (restDaysMatch) {
      const days = Number(restDaysMatch[1]);
      if (days === 4) return null; // 标准答案不拦截
      // 非标答案
      const isMoreThanStandard = days > 4;
      const salaryNote = isMoreThanStandard
        ? `月休增加意味着阿姨实际工作日减少，薪资会相应做调整（通常是在基础薪资上按天折算，多休${days - 4}天相应扣减），具体金额可以根据您选定的阿姨等级来算`
        : '休息天数减少涉及薪资上浮，具体金额可以根据您选定的阿姨等级来算';
      const scopeNote = isMoreThanStandard
        ? '大部分阿姨更倾向于月休4天的安排，选择这个天数的话可选阿姨范围会相对窄一些，不过我们会尽量帮您匹配合适的人选'
        : '愿意多上班的阿姨也不少，我们会尽快帮您匹配合适的人选';
      return {
        reason: 'restDaysOverride',
        message: `可以的~跟您说明一下：咱们行业标准的月休一般是4天，住家保姆的服务周期是按整月计算的。薪资方面：${salaryNote}。匹配范围：${scopeNote}。顾问稍后会跟您详细确认其他需求哈~`,
      };
    }
    // 2. 无月休/不休息
    if (/月休.*?(无|不|没|没有)|不休息|无月休|无休|没有月休|月休.*?0\s*天|月休.*?零\s*天/.test(customerReply)) {
      return {
        reason: 'restDaysOverride',
        message: '可以的~无月休涉及薪资调整，咱们顾问稍后会跟您详细确认其他需求哈~',
      };
    }
    return null;
  }

  /**
   * 二选一问题超范围检测 + 响应构建（5 个二选一，不转人工，复用「休6天」详细模板风格）
   *
   * 范围（5 个）：
   *   1. 住家/白班
   *   2. 26天/42天（月嫂）
   *   3. 日常保洁/深度保洁
   *   4. 住家育儿/白班育儿
   *   5. 住家照顾老人/白班陪护
   *
   * 行为（已确认方案 B + A，2026-08-13）：
   *   - 不再 doTransferToHuman
   *   - 复用「休6天」详细模板：先 acknowledge + 说明影响（薪资/范围） + re-ask 二选一
   *   - 月休问题（4天/2天，checkRestDaysResponse）保持原逻辑不变
   *
   * @returns 响应文案（null = 不触发超范围处理，让 AI 正常生成）
   */
  public buildTwoChoiceOutOfRangeResponse(lastBotMessage: string, customerReply: string): string | null {
    // 客户在提问而非回答（如"必须二选一吗"），不触发超范围
    if (/必须|二选一|能不能|可不可以|一定要|为什么|什么意思/.test(customerReply)) {
      return null;
    }

    const patterns: Array<{ test: RegExp; options: string[]; reask: string }> = [
      {
        test: /住家.*?还是.*?白班|白班.*?还是.*?住家/,
        options: ['住家', '白班'],
        reask: '咱们先确认是【住家】还是【白班】',
      },
      {
        test: /26天.*?还是.*?42天|42天.*?还是.*?26天/,
        options: ['26天', '42天'],
        reask: '咱们先确认是【26 天】还是【42 天】月嫂服务',
      },
      {
        test: /日常保洁.*?还是.*?深度保洁|深度保洁.*?还是.*?日常保洁/,
        options: ['日常保洁', '深度保洁', '日常', '深度'],
        reask: '咱们先确认是【日常保洁】还是【深度保洁】',
      },
      {
        test: /住家育儿.*?还是.*?白班育儿|白班育儿.*?还是.*?住家育儿/,
        options: ['住家育儿', '白班育儿', '住家', '白班'],
        reask: '咱们先确认是【住家育儿】还是【白班育儿】',
      },
      {
        test: /住家.*?照顾.*?老人.*?还是.*?白班.*?陪护|白班.*?陪护.*?还是.*?住家.*?照顾.*?老人/,
        options: ['住家', '白班'],
        reask: '咱们先确认是【住家照顾老人】还是【白班陪护】',
      },
    ];

    for (const p of patterns) {
      if (p.test.test(lastBotMessage)) {
        // 用户回答命中任一选项，不算超范围，让 AI 正常处理
        if (p.options.some((opt) => customerReply.includes(opt))) {
          return null;
        }
        // 用户答非所问：复用「休6天」详细模板，先 explain 影响再 re-ask，不转人工
        const impactNote = this.buildTwoChoiceImpactNote(customerReply);
        return `可以的~${impactNote}${p.reask}，顾问稍后会跟您详细确认其他需求哈~`;
      }
    }
    return null;
  }

  /**
   * 构建二选一超范围时的影响说明（复用「休6天」模板风格）
   *
   * 优先级：
   *   1. 含 "X天" → 走「休6天」模板（薪资/范围影响）
   *   2. 无月休/不休息 → 简化说明
   *   3. 其他需求 → 通用 acknowledge
   */
  public buildTwoChoiceImpactNote(customerReply: string): string {
    // 1. 含具体天数（X天）→ 复用「休6天」模板
    const dayMatch = customerReply.match(/(\d+)\s*天/);
    if (dayMatch) {
      const days = Number(dayMatch[1]);
      if (days > 4) {
        return `跟您说明一下：月休增加意味着阿姨实际工作日减少，薪资会相应做调整（通常是在基础薪资上按天折算，多休${days - 4}天相应扣减），具体金额可以根据您选定的阿姨等级来算。匹配范围：大部分阿姨更倾向于月休4天的安排，不过我们会尽量帮您匹配合适的人选。`;
      } else if (days < 4) {
        return `跟您说明一下：休息天数减少涉及薪资上浮，具体金额可以根据您选定的阿姨等级来算。匹配范围：愿意多上班的阿姨也不少，我们会尽快帮您匹配合适的人选。`;
      }
    }
    // 2. 无月休/不休息
    if (/无月休|不休息|无休|没有月休|不休/.test(customerReply)) {
      return `无月休涉及薪资调整，`;
    }
    // 3. 通用 acknowledge
    return `关于您说的这些需求，咱们后续跟顾问详细确认。`;
  }

  /**
   * ⚠️ 最后一道防线：把 LLM 输出中含"老人/照护/陪护"的疑问句剔除
   *
   * 注意：这是兜底护栏，不应作为主要解决手段。
   * 主要机制应该是：
   *   1. detectFieldsFromConversation 准确检测客户的否定/肯定回答并存入 elderlyCare
   *   2. isFieldCollected() 统一判断：任何明确回答（是/否/待定）都算已采集
   *   3. 引导 prompt 明确告诉 AI "客户说不需要也算已采集，不要重复问"
   *   4. stripReaskCollectedFields 通用护栏覆盖 elderlyCare 字段
   * 只有以上全部失效时，这里才兜底。
   */
  public stripElderlyQuestion(response: string): string {
    // 按 (text, delimiter) 配对处理，避免单步推进导致重复 push
    const parts = response.split(/([。！!~～\n？?])/);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i] ?? '';
      const delim = parts[i + 1] ?? '';
      const isQuestion = delim === '？' || delim === '?';
      const hasElderly = /(老人|照护|陪护|老人家|家中老人|老人照护)/.test(text);
      if (isQuestion && hasElderly) {
        // 跳过这一对（含问号的老人疑问句）
        continue;
      }
      kept.push(text);
      if (delim) kept.push(delim);
    }
    return kept.join('').trim();
  }

  /**
   * 把 LLM 输出中"已采集字段被再次询问"的句子整对剔除
   * 用于"服务类型/面积/月休/家庭人口/工作制/薪资预算已填但 LLM 又问"的通用护栏
   *
   * 工作原理：按 (text, delimiter) 配对切分整段 LLM 输出，
   * 识别"以 ？结尾 + 含已采集字段关键词"的整句（疑问句），或
   * 识别"含显式询问动词 + 已采集字段"的整句（陈述式请求），整对剔除。
   *
   * 两种剔除条件都覆盖：
   *   a) 疑问句：句子以 ？或 ? 结尾 + 含字段关键词
   *   b) 显式询问句：含"告诉我您要 / 您要选 / 想找哪种"等强询问语（不要求 ？结尾）
   *      例："告诉我您要哪一类" / "您想找哪种呢"——这些是典型的"礼貌式询问"陈述
   */
  public stripReaskCollectedFields(
    response: string,
    collected: {
      serviceType?: string | null;
      restDays?: string | null;
      area?: string | null;
      householdSize?: string | null;
      elderlyCare?: string | null;
      budget?: string | null;
      // 2026-08-16 23:04 林琳反馈死循环：AI 重新问"主要想让阿姨负责哪些事呢"——LLM 丢失字段状态
      //   扩 stripReaskCollectedFields 覆盖 serviceItems/serviceHours/startTime/serviceAddress/helperRequirements/dietaryPreferences 6 个字段
      //   原版覆盖 5 字段（serviceType/restDays/area/householdSize/budget），v6 重构删除 workMode
      serviceItems?: string | null;
      serviceHours?: string | null;
      startTime?: string | null;
      serviceAddress?: string | null;
      helperRequirements?: string | null;
      dietaryPreferences?: string | null;
    },
  ): string {
    // 字段 → 关键词列表。疑问句触发词 + 显式询问触发词分开
    // 疑问句触发词：句末是 ？/？时才生效（避免误伤正常陈述句）
    // 触发词从 requirement-fields.config.ts 单一数据源读取
    const questionTriggers = buildGuardQuestionTriggers();
    // 显式询问触发词：即使句末是 ~ 或 句号 也算"在问"（用于剥离"告诉我您要哪一类"这类礼貌式询问）
    const imperativeTriggers = buildGuardImperativeTriggers();

    // 用 isFieldCollected 统一判断：clear + vague 都算已采集，都不允许反复问
    const collectedFields = Object.keys(collected).filter((k) =>
      isFieldCollected(collected[k as keyof typeof collected]),
    );
    if (collectedFields.length === 0) return response;

    // 按 (text, delimiter) 配对处理
    const parts = response.split(/([。！!~～\n？?])/);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text = parts[i] ?? '';
      const delim = parts[i + 1] ?? '';
      const isQuestion = delim === '？' || delim === '?';

      // 检查是否命中任意已采集字段的"复问"模式
      let hitReask = false;
      for (const field of collectedFields) {
        const qRe = questionTriggers[field];
        const iRe = imperativeTriggers[field];
        // 条件 a：疑问句 + 疑问触发词
        if (isQuestion && qRe && qRe.test(text)) {
          hitReask = true;
          break;
        }
        // 条件 b：显式询问触发词（不要求 ？结尾）
        if (iRe && iRe.test(text)) {
          hitReask = true;
          break;
        }
      }

      if (hitReask) {
        // 跳过这一对（已采集字段又被问的整句）
        continue;
      }
      kept.push(text);
      if (delim) kept.push(delim);
    }
    return kept.join('').trim();
  }

  /**
   * 转人工承诺检测：AI 承诺“稍后会有专员联系您”这类不会真正触发的转人工承诺。
   * （带转接动词的由步骤 7 真实转接；这里只处理漏网的软承诺）
   * 命中时剔除含承诺的整句，避免客户空等。仅拦截 AI 模式回复。
   */
  public validateTransferPromise(
    response: string,
    sessionMode: string,
  ): { response: string; modified: boolean } {
    if (sessionMode !== 'ai') return { response, modified: false };
    const promiseRe: RegExp = /(?:稍后|一会儿|稍等后|很快|后续)(?:会)?(?:有|安排)?(?:专员|顾问|客服|人工).{0,8}(?:联系|跟进|对接|为您服务|沟通)/;
    if (!promiseRe.test(response)) return { response, modified: false };
    const parts: string[] = response.split(/([。！!~～\n])/);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text: string = parts[i] ?? '';
      const delim: string = parts[i + 1] ?? '';
      if (promiseRe.test(text)) continue;
      kept.push(text);
      if (delim) kept.push(delim);
    }
    const cleaned: string = kept.join('').trim();
    this.logger.warn(`[ValidatorV2] 剔除空转人工承诺: "${response.slice(0, 60)}"`);
    return { response: cleaned, modified: true };
  }

  /**
   * 绝对化用词替换：保证/百分百/一定能/最低价等承诺性和极限用词软化为留有余地的表达。
   */
  public validateAbsolutePromises(response: string): { response: string; modified: boolean } {
    const replacements: Array<[RegExp, string]> = [
      [/(百分百|100%)(?:的)?(?:能|可以|没问题|保证)/, '会尽力'],
      [/保证(?:能|可以)?/, '会尽力'],
      [/一定能|肯定能|必然能/, '会尽力'],
      [/绝对(?:可以|没问题|安全)/, '应该可以'],
      [/全网最低|最低价|最便宜|最优惠/, '很有竞争力'],
      [/行业第一|全国第一|第一名/, '行业前列'],
    ];
    let cleaned: string = response;
    let modified = false;
    for (const [re, to] of replacements) {
      const next: string = cleaned.replace(re, to);
      if (next !== cleaned) {
        cleaned = next;
        modified = true;
      }
    }
    return { response: cleaned, modified };
  }

  /**
   * 敏感词检测：医疗/绝对承诺/极限用词等高风险词，命中时剔除含敏感词的整句。
   * 全部被剔光时返回兑底句，避免空回复。
   */
  public validateSensitiveWords(response: string): { response: string; modified: boolean; hits: string[] } {
    const hits: SensitiveWordHit[] = findSensitiveWords(response);
    if (hits.length === 0) return { response, modified: false, hits: [] };
    const parts: string[] = response.split(/([。！!~～\n？?])/);
    const kept: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      const text: string = parts[i] ?? '';
      const delim: string = parts[i + 1] ?? '';
      if (SENSITIVE_WORDS.some((w: string) => text.includes(w))) continue;
      kept.push(text);
      if (delim) kept.push(delim);
    }
    const cleaned: string = kept.join('').trim()
      || '这个问题顾问稍后跟您详细说明~';
    this.logger.warn(
      `[ValidatorV2] 命中敏感词[${hits.map((h: SensitiveWordHit) => h.word).join(',')}] 已剔除: "${response.slice(0, 60)}"`,
    );
    return {
      response: cleaned,
      modified: true,
      hits: hits.map((h: SensitiveWordHit) => h.word),
    };
  }

  /**
   * 回复校验器 v2 统一入口：依次跑转人工承诺/绝对化用词/敏感词三项检测，
   * 返回首个命中项，由调用方按 reason 分支处理：
   *   transfer_promise → 触发真实转人工（不改写回复）
   *   absolute_promise → 用 patchedText 替换回复
   *   sensitive_word   → 调用方用兜底文案替换回复
   */
  public validateResponseV2(response: string, context: ValidateContextV2): ValidateResultV2 {
    const transfer = this.validateTransferPromise(response, context.sessionMode);
    if (transfer.modified) {
      return { blocked: true, reason: 'transfer_promise' };
    }

    const absolute = this.validateAbsolutePromises(response);
    if (absolute.modified) {
      return { blocked: true, reason: 'absolute_promise', patchedText: absolute.response };
    }

    const sensitive = this.validateSensitiveWords(response);
    if (sensitive.modified) {
      return { blocked: true, reason: 'sensitive_word' };
    }

    return { blocked: false, reason: null };
  }
}
