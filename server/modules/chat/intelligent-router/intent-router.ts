import { Injectable } from '@nestjs/common';
import { ChatPricingService } from '../chat-pricing.service';

/**
 * 意图类型（阶段二收尾 · 2026-09-12 口径）
 *
 * 优先级从高到低：
 *   1. transfer_human    转人工（强意图：明确要求 / 投诉 / 涉费砍价）
 *   2. fee_info          收费/中介费（4 个别称任一命中即直出「不收阿姨费用」定稿文案）
 *   3. nonstandard_rest  月休非标（月休 1/3/5/6 天等 → 转人工沟通）
 *   4. market_price      价格查询（含模糊钱问法，一律按总账直答）
 *   5. service_scope     服务范围（咨询类）
 */
export type IntentType =
  | 'market_price'
  | 'transfer_human'
  | 'service_scope'
  | 'fee_info'
  | 'nonstandard_rest';

export interface IntentResult {
  intent: IntentType;
  toolName: string;
  priority: number;
  /** fee_info 命中时客户原话里的费用别称（中介费/服务费/信息费/介绍费等） */
  matchedAlias?: string;
  /** 转人工类意图的业务原因（路由层注入工具上下文） */
  transferReason?: string;
}

const INTENT_TOOL_MAP: Record<IntentType, string> = {
  market_price: 'queryMarketPrice',
  transfer_human: 'transferToHuman',
  service_scope: 'queryServiceScope',
  fee_info: 'queryFeeInfo',
  nonstandard_rest: 'transferToHuman',
};

// 意图优先级：数字越小优先级越高
// fee_info 高于 market_price：客户说出「中介费/服务费/信息费/介绍费」任一别称即判公司收费，
// 避免「信息费大概多少」这类句子被价格正则（大概多少）抢先带走（改动包边界对照表）
const INTENT_PRIORITY: Record<IntentType, number> = {
  transfer_human: 1,
  fee_info: 2,
  nonstandard_rest: 3,
  market_price: 4,
  service_scope: 5,
};

export const NONSTANDARD_REST_TRANSFER_REASON =
  '月休非标需求（客户要求非标准月休天数），转人工沟通';

/** 转人工意图关键词（强意图，命中即转） */
const TRANSFER_HUMAN_PATTERNS = [
  /转人工|转接人工|找人工|找客服|人工客服|人工顾问/,
  /我要.*?人.*?接|帮我.*?转.*?人|给我.*?接.*?人/,
  /你们有人吗|有没有真人|是机器人吗|是AI吗|是智能客服吗/,
  /投诉|举报|我要投诉|我要举报/,
  /你们经理|你们主管|你们负责人/,
  // 涉费砍价/售后（边界分流表：中介费能便宜吗 / 能退吗 → 转人工）
  /(中介费|服务费|信息费|介绍费).{0,8}(便宜|优惠|打折|减免|能退|退款|退钱)/,
];

/** 标准月休选项：无月休（钟点工）/ 月休 2 天 / 月休 4 天；其余天数均非标 */
const STANDARD_REST_DAYS: ReadonlySet<number> = new Set([2, 4]);

/** 中文数字 → 阿拉伯数字（月休天数场景只覆盖 1~10） */
const CN_NUM_MAP: Record<string, number> = {
  一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 服务范围/服务类型查询关键词 */
const SERVICE_SCOPE_PATTERNS = [
  /你们有什么服务|你们提供什么服务|都有什么服务|有哪些服务/,
  /服务范围|服务项目|服务内容|服务种类|业务范围/,
  /你们都做什么|你们能干什么|你们主要做什么/,
  /有哪些阿姨|有什么类型的阿姨|阿姨分几种/,
];

@Injectable()
export class IntentRouter {
  constructor(private readonly chatPricingService: ChatPricingService) {}

  /**
   * 检测用户消息的意图（支持多意图命中，按优先级返回最高的）
   *
   * 多意图优先级：转人工 > 收费（别称命中） > 月休非标 > 价格 > 服务范围
   */
  detectIntent(content: string): IntentResult | null {
    const hits: IntentResult[] = [];

    // 1. 转人工意图
    if (this.detectTransferHuman(content)) {
      hits.push({
        intent: 'transfer_human',
        toolName: INTENT_TOOL_MAP.transfer_human,
        priority: INTENT_PRIORITY.transfer_human,
      });
    }

    // 2. 价格查询意图（复用现有检测逻辑）
    if (this.chatPricingService.detectMarketPriceQuestion(content)) {
      hits.push({
        intent: 'market_price',
        toolName: INTENT_TOOL_MAP.market_price,
        priority: INTENT_PRIORITY.market_price,
      });
    }

    // 3. 收费/中介费意图（仅明确费用词）
    const feeAlias: string | null = this.detectFeeInfo(content);
    if (feeAlias) {
      hits.push({
        intent: 'fee_info',
        toolName: INTENT_TOOL_MAP.fee_info,
        priority: INTENT_PRIORITY.fee_info,
        matchedAlias: feeAlias,
      });
    }

    // 4. 月休非标（"月休 6 天"等 → 转人工沟通）
    if (this.detectNonStandardRest(content)) {
      hits.push({
        intent: 'nonstandard_rest',
        toolName: INTENT_TOOL_MAP.nonstandard_rest,
        priority: INTENT_PRIORITY.nonstandard_rest,
        transferReason: NONSTANDARD_REST_TRANSFER_REASON,
      });
    }

    // 5. 服务范围意图（放最后，最宽泛）
    if (this.detectServiceScope(content)) {
      hits.push({
        intent: 'service_scope',
        toolName: INTENT_TOOL_MAP.service_scope,
        priority: INTENT_PRIORITY.service_scope,
      });
    }

    // 6. 转人工类意图需携带业务原因（转人工关键词命中时工具层用默认原因）
    if (hits.length === 0) return null;

    // 按优先级排序，返回最高优先级的意图
    hits.sort((a, b) => a.priority - b.priority);
    return hits[0];
  }

  /** 转人工意图检测 */
  private detectTransferHuman(content: string): boolean {
    return TRANSFER_HUMAN_PATTERNS.some((p) => p.test(content));
  }

  /** 服务范围意图检测 */
  private detectServiceScope(content: string): boolean {
    return SERVICE_SCOPE_PATTERNS.some((p) => p.test(content));
  }

  /** 收费/中介费意图检测（仅明确费用词 + 明确问公司/平台）
   *
   *  判定规则（保守策略）：
   *  - 明确提到中介费/服务费/信息费/介绍费/管理费/佣金 → 直接命中（2026-09-12 起直出「不收阿姨费用」定稿文案）
   *  - 明确问"公司收多少""平台收多少" → 命中（返回「中介费」标准词）
   *  - 模糊钱问法（怎么收费/收费标准/费用多少）→ 不归此类，归 market_price 按总账直答
   *
   *  @returns 命中的费用别称；未命中返回 null
   */
  detectFeeInfo(content: string): string | null {
    const aliasPatterns: RegExp[] = [/中介费/, /中介費/, /服务费/, /信息费/, /介绍费/, /管理费/, /佣金/];
    for (const pattern of aliasPatterns) {
      const matched: RegExpMatchArray | null = content.match(pattern);
      if (matched) {
        return matched[0] === '中介費' ? '中介费' : matched[0];
      }
    }
    const companyFeePatterns: RegExp[] = [/公司收多少/, /平台收多少/];
    if (companyFeePatterns.some((p: RegExp) => p.test(content))) {
      return '中介费';
    }
    return null;
  }

  /** 月休非标检测：客户报的月休天数不在标准选项（无月休/2 天/4 天）内 → 转人工
   *
   *  只判显式数字型表达（月休 6 天 / 休息 1 天 / 6 天休息）；
   *  "无月休/不休息"是钟点工标准选项，不命中。
   */
  detectNonStandardRest(content: string): boolean {
    const patterns = [
      /月休\s*([\d一二三四五六七八九十两]+)\s*天/,
      /休息\s*([\d一二三四五六七八九十两]+)\s*天/,
      /([\d一二三四五六七八九十两]+)\s*天休息/,
      /([\d一二三四五六七八九十两]+)\s*个?月休/,
    ];
    for (const pattern of patterns) {
      const matched: RegExpMatchArray | null = content.match(pattern);
      if (!matched) continue;
      const raw: string = matched[1];
      const days: number = /^\d+$/.test(raw)
        ? parseInt(raw, 10)
        : [...raw].reduce<number>(
            (sum: number, ch: string) => sum * 10 + (CN_NUM_MAP[ch] ?? NaN),
            0,
          );
      if (Number.isFinite(days) && !STANDARD_REST_DAYS.has(days)) {
        return true;
      }
    }
    return false;
  }
}
