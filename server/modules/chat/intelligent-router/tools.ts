import { Logger } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { ChatPricingService } from '../chat-pricing.service';
import type { ChatTransferService } from '../chat-transfer.service';
import { feeQuoteLogs } from '@server/database/schema';
import type { Lead } from '@shared/api.interface';
import { INTERMEDIARY_FEE_YUAN } from '@server/common/constants/fees';

const feeLogger = new Logger('FeeInfoTool');

export interface ToolContext {
  requirement: {
    serviceType?: string | null;
    area?: string | null;
    serviceAddress?: string | null;
  } | null | undefined;
  serviceCity?: string | null;
  /** 客户当前消息原文（泛称澄清判断兼做原话兜底） */
  currentMessage?: string;
  historyMessages?: Array<{ role: string; content: string }>;
  /** 会话 ID（转人工等副作用工具需要） */
  sessionId?: string | null;
  /** 关联的 lead 对象（转人工需要） */
  lead?: Lead | null;
  /** LLM 语义层识别出的服务类型（阶段三，正则未命中时由路由层注入） */
  llmDetectedServiceType?: string | null;
  /** fee_info 命中时客户原话里的费用别称（正则层注入，合规日志用） */
  matchedAlias?: string | null;
  /** 转人工原因（路由层按意图注入，缺省'客户申请转人工'） */
  transferReason?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  execute: (ctx: ToolContext) => Promise<string>;
}

/** 服务范围标准化回复 */
const SERVICE_SCOPE_RESPONSE = `咱们天鹅到家提供多种家政服务，主要包括：

🏠 **住家保姆**：24小时住家服务，负责家务、做饭、照顾老人或孩子，可带睡
☀️ **白班保姆**：每日8-9小时白班服务，做家务、做饭、照顾老人或接送孩子，不过夜
🍼 **育儿保姆**：专注宝宝照顾，包括辅食制作、启蒙引导、洗衣洗澡，可带睡
👴 **养老护工**：专业老人照护，包括生活照料、康复护理、陪伴就医等
🧹 **钟点保姆**：按小时上门，做家务、做饭、保洁等，灵活安排
👩 **菲式保姆**：高端家政服务，擅长收纳整理、西餐制作、儿童教育等

您看您主要需要哪方面的服务呢？我可以给您详细介绍～`;

/**
 * 中介费常量 —— 全公司统一，无地区/用户/套餐差异。
 * 更改需走财务审批流程。
 */
export { INTERMEDIARY_FEE_YUAN } from '@server/common/constants/fees';

/**
 * fee_info 定稿文案（2026-09-12 业务确认免审）：
 * 中介费 = 0，不收客户中介费；服务费/信息费/介绍费等别称一律按中介费处理。
 */
const FEE_INFO_FINAL_REPLY =
  '我们这边是不收阿姨费用的，所以一般是按咱们的预算或市场价匹配';

const TRANSFER_COMFORT_REPLY = '好的～马上为您转接人工客服，由专员为您详细解答，请稍等～';

/**
 * 服务类型修饰词 → 服务类型映射：客户原话命中即视为类型明确。
 * 注意不能复用 detectServiceTypeFromText：裸'保姆/阿姨'会被其默认映射为住家保姆，
 * 与泛称澄清需求相悳。
 */
const SPECIFIC_TYPE_MODIFIERS: Array<{ keyword: string; type: string }> = [
  { keyword: '住家', type: '住家保姆' },
  { keyword: '白班', type: '白班保姆' },
  { keyword: '育儿嫂', type: '育儿保姆' },
  { keyword: '育儿', type: '育儿保姆' },
  { keyword: '小时工', type: '钟点工' },
  { keyword: '钟点', type: '钟点工' },
  { keyword: '护工', type: '护工' },
  { keyword: '菲式', type: '菲式保姆' },
];

/**
 * 构建工具注册表（共 4 个工具）
 *
 * 工具列表：
 *   1. queryMarketPrice   查询市场价（总花费 = 工资行情 = 总预算，无中介费）
 *   2. transferToHuman    转人工（客户主动 / 涉费砍价 / 月休非标）
 *   3. queryServiceScope  查询服务范围
 *   4. queryFeeInfo       查询收费/中介费（定稿文案：不收阿姨费用）
 */
export function buildToolRegistry(
  chatPricingService: ChatPricingService,
  chatTransferService: ChatTransferService,
  db: PostgresJsDatabase,
): Map<string, ToolDefinition> {
  const registry = new Map<string, ToolDefinition>();

  registry.set('queryMarketPrice', {
    name: 'queryMarketPrice',
    description:
      '查询市场价：按客户的服务类型/城市档/面积从 salary_config 配置表读取价格区间，' +
      '优先读 requirements 结构化字段，读不到再从服务地址/客户原话提取。' +
      '服务类型为泛称（如只说"保姆"）时反问澄清，不默认住家保姆。',
    execute: async (ctx: ToolContext) => {
      const rawType: string = ctx.requirement?.serviceType?.trim() ?? '';
      const isGenericNanny: boolean =
        rawType === '保姆' || rawType === '阿姨' || rawType === '';

      // 泛称时兜底看客户原话是否带具体修饰词，带则直接报价（原话识别的类型同时作为
      // serviceType 传给报价服务，避免未采集分支回退成住家保姆默认报价）；
      // 纯泛称（无任何修饰词）才反问澄清，不猜测。
      const utterance: string = ctx.currentMessage ?? '';
      const matchedModifier: { keyword: string; type: string } | undefined =
        SPECIFIC_TYPE_MODIFIERS.find((m) => utterance.includes(m.keyword));
      // 阶段三：正则未命中走 LLM 时，路由层会注入 LLM 识别的服务类型，
      // 泛称且原话无修饰词时优先用它，没有才反问澄清
      const llmType: string = ctx.llmDetectedServiceType?.trim() ?? '';
      if (isGenericNanny && !matchedModifier && !llmType) {
        return (
          '您是想找哪种类型保姆呢？' +
          '不同类型的服务不一样，您说一下我给您准确的参考价～'
        );
      }

      const requirementForPricing =
        isGenericNanny && (matchedModifier || llmType)
          ? { ...ctx.requirement, serviceType: matchedModifier?.type ?? llmType }
          : ctx.requirement;
      return chatPricingService.buildMarketPriceCanonical(
        requirementForPricing,
        ctx.serviceCity,
        ctx.historyMessages,
      );
    },
  });

  registry.set('transferToHuman', {
    name: 'transferToHuman',
    description:
      '转人工：客户明确要求转人工、投诉、找真人客服时调用。执行 mode 切换、分配经纪人、发送通知。' +
      '幂等守卫：会话已是 human 模式则跳过。',
    execute: async (ctx: ToolContext) => {
      if (!ctx.sessionId || !ctx.lead) {
        throw new Error('transferToHuman: sessionId 和 lead 不能为空');
      }
      await chatTransferService.doTransferToHuman(
        ctx.sessionId,
        ctx.transferReason?.trim() || '客户申请转人工',
        'auto',
        ctx.lead,
        TRANSFER_COMFORT_REPLY,
      );
      return TRANSFER_COMFORT_REPLY;
    },
  });

  registry.set('queryServiceScope', {
    name: 'queryServiceScope',
    description:
      '查询服务范围：客户问"你们有什么服务"、"服务项目有哪些"、"阿姨分几种"等时调用，' +
      '返回标准化的服务类型列表及简介。',
    execute: async () => SERVICE_SCOPE_RESPONSE,
  });

  registry.set('queryFeeInfo', {
    name: 'queryFeeInfo',
    description:
      '查询收费/中介费：客户明确问"中介费多少"、"服务费怎么收"、"信息费多少"、"介绍费多少"等时调用。' +
      '2026-09-12 业务确认不收客户中介费（=0），命中别称直出定稿文案，每次命中落合规日志。' +
      '模糊钱问法（怎么收费/费用多少）归 market_price 按总账直答，不走本工具。',
    execute: async (ctx: ToolContext) => {
      const userAlias: string = ctx.matchedAlias?.trim() || '中介费';
      const reply: string = FEE_INFO_FINAL_REPLY;

      // 合规日志：每次报价必须有据可查；写库失败不阻塞回复主流程
      try {
        await db.insert(feeQuoteLogs).values({
          quotedAmount: INTERMEDIARY_FEE_YUAN,
          aliasUsed: userAlias,
          aliasNormalized: '中介费',
          serviceType: ctx.requirement?.serviceType ?? null,
          leadId: ctx.lead?.id ?? null,
          sessionId: ctx.sessionId ?? null,
          intentSource: ctx.matchedAlias ? 'regex' : 'llm',
        });
      } catch (error) {
        feeLogger.error(
          `[fee_info_quote] 合规日志写库失败: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      }

      return reply;
    },
  });

  return registry;
}
