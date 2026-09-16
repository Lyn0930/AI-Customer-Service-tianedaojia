import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import {
  AI_REPLY_ACTION_KEY,
  AI_REPLY_PLUGIN_ID,
  SWAN_PERSONA,
} from '@server/modules/chat/chat.prompt';
import {
  LLM_INTENT_ACTION_KEY,
  LLM_INTENT_PLUGIN_ID,
  LlmIntentService,
} from '@server/modules/chat/llm-intent/llm-intent.service';
import { normalizeStream } from '@server/modules/chat/stream-utils';
import { IntelligentRouterService } from '@server/modules/chat/intelligent-router/intelligent-router.service';
import type { ToolContext } from '@server/modules/chat/intelligent-router/tools';
import type {
  AiTestKind,
  AiTestRequest,
  AiTestResponse,
  L2TestRequest,
  L2TestResponse,
  RouteTestRequest,
  RouteTestResponse,
} from '@shared/api.interface';

const EMPTY_CONTEXT_PLACEHOLDER = '（无）';

const JSON_FORMAT_INSTRUCTION =
  '只输出 JSON，不要任何其他文字。格式：\n' +
  '{"intent":"枚举之一","confidence":0~1}\n' +
  '客户这句是在问价格，intent 填 market_price。';

const CAT_PERSONA = "你是一只猫，每句话结尾加'喵'";

const BUDGET_CALIBER_PERSONA =
  '你是家政客服系统"小书"，负责与客户对话并采集需求。\n\n' +
  '【预算采集规则】（2026-09-04 定稿 · 纯一刀切 · 无引导无例外）\n' +
  '当客户提到预算 / 打算花多少钱 / 能承受多少价位 / 或直接报了一个金额数字时：\n' +
  '1. 抄数不心算：客户报的预算数字原样记入系统的预算字段，不做任何加减换算、不擅自四舍五入。\n' +
  '2. 一律当总价直存（零分支）：客户报的金额 = 他要付的总价 → 原样写进预算字段。' +
  '无论客户怎么说——"我预算 6000""总共 8000 全部算上""大概一个月花 7000 请个阿姨"、' +
  '没上下文的一句"就 6000 吧"、甚至明说"每月付给阿姨的工资 5500 元 / 阿姨月薪 5500 / 阿姨到手 5500"——' +
  '一律按总价直接记，不追问、不猜口径。' +
  '严禁：追问"这是工资还是总价"、引导补报总预算、自作主张扣 2000、因"听起来像工资"就留空或交人工。\n' +
  '3. 只记录、不承诺：不说"这个预算能请到 XX 阿姨 / 够用了"。能否匹配以顾问按系统匹配和阿姨实际报价为准。\n' +
  '4. 异常别慌：预算 ≤ 2000 或明显离谱，正常记录并交顾问处理，不当面质疑、不嘲讽客户。\n' +
  '5. 对客话术红线：不主动提中介费，客户没问就不提。只有客户主动问起（如"这钱含中介费吗 / 阿姨到手多少"），' +
  '才用定稿口径作答：我们这边是不收阿姨费用的，所以一般是按咱们的预算或市场价匹配（总花费 = 阿姨工资行情 = 总预算，无中介费差额）。\n\n' +
  '回复要求：简洁口语化，一两句话即可。';

const ENUM_LOCK_PLATFORM_NOTE =
  '平台能力核实：不存在运行时 response_format / json_schema 参数' +
  '（生文与 textToJson 通道均不支持运行时传任意 JSON Schema）。' +
  '枚举锁死由「插件实例创建时固定字段 schema」机制提供：本测试复用 ' +
  'customer_service_intent_classifier_1 实例（意图分类器-L2），其 intent 字段描述锁定 4 个枚举值' +
  '（transfer_human / market_price / service_scope / none，' +
  'fee_info 归 L1 正则层，模糊钱问法归 market_price 按总账直答）。';

@Injectable()
export class AiTestService {
  private readonly logger = new Logger(AiTestService.name);

  constructor(
    private readonly capabilityService: CapabilityService,
    private readonly intelligentRouterService: IntelligentRouterService,
    private readonly llmIntentService: LlmIntentService,
  ) {}

  /** L2 分类器直测（工单 Part 5 验收入口）：绕过 L1 正则/FAQ，直接调分类实例 */
  async runL2Test(req: L2TestRequest): Promise<L2TestResponse> {
    const message: string = (req.message ?? '').trim();
    if (!message) {
      throw new BadRequestException('消息不能为空');
    }
    const result = await this.llmIntentService.classify(
      message,
      req.conversationContext?.trim() || EMPTY_CONTEXT_PLACEHOLDER,
    );
    if (!result) {
      return { hit: false, intent: null, confidence: null, serviceType: null, keyPhrase: null };
    }
    return {
      hit: true,
      intent: result.intent,
      confidence: result.confidence,
      serviceType: result.serviceType,
      keyPhrase: result.keyPhrase,
    };
  }

  async runRouteTest(req: RouteTestRequest): Promise<RouteTestResponse> {
    const message: string = (req.message ?? '').trim();
    if (!message) {
      throw new BadRequestException('消息不能为空');
    }
    const context: ToolContext = {
      requirement: { serviceType: req.serviceType ?? null },
      currentMessage: message,
      historyMessages: [],
      sessionId: null,
      lead: null,
    };
    const result = await this.intelligentRouterService.tryRoute(
      message,
      context,
      '[route_test]',
    );
    return {
      handled: result.handled,
      intent: result.intent,
      reply: result.reply,
    };
  }

  async runTest(req: AiTestRequest): Promise<AiTestResponse> {
    const input: string = (req.input ?? '').trim();
    if (!input) {
      throw new BadRequestException('输入文字不能为空');
    }
    if (req.test === 'independent') {
      return this.runTextGenerate('independent', '你是测试助手', input);
    }
    if (req.test === 'json_format') {
      return this.runTextGenerate(
        'json_format',
        `你是测试助手。\n${JSON_FORMAT_INSTRUCTION}`,
        input,
      );
    }
    if (req.test === 'instruction') {
      return this.runTextGenerate('instruction', CAT_PERSONA, '你是谁');
    }
    if (req.test === 'enum_lock') {
      return this.runEnumLock(input);
    }
    if (req.test === 'budget_caliber') {
      return this.runTextGenerate('budget_caliber', BUDGET_CALIBER_PERSONA, input);
    }
    if (req.test === 'swan_reply') {
      return this.runTextGenerate('swan_reply', SWAN_PERSONA, input);
    }
    throw new BadRequestException(`未知测试类型: ${String(req.test)}`);
  }

  private async runTextGenerate(
    test: AiTestKind,
    systemPrompt: string,
    userMessage: string,
  ): Promise<AiTestResponse> {
    try {
      const streamResult: unknown = await this.capabilityService
        .load(AI_REPLY_PLUGIN_ID)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona: systemPrompt,
          conversation_history: EMPTY_CONTEXT_PLACEHOLDER,
          collected_requirements: EMPTY_CONTEXT_PLACEHOLDER,
          latest_customer_message: userMessage,
        });

      let raw = '';
      const stream = normalizeStream(streamResult);
      for await (const chunk of stream) {
        const chunkContent = (chunk as { content?: string }).content;
        if (chunkContent) {
          raw += chunkContent;
        }
      }
      return { test, raw, systemPrompt, userMessage };
    } catch (error) {
      const detail: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`AI 实测[${test}]调用失败: ${detail}`);
      return {
        test,
        raw: '',
        error: error instanceof Error ? error.message : String(error),
        systemPrompt,
        userMessage,
      };
    }
  }

  private async runEnumLock(input: string): Promise<AiTestResponse> {
    const systemPrompt: string =
      '走 textToJson 实例 schema 锁：intent 只能是 market_price / transfer_human / ' +
      'service_scope / none 之一（4 值，fee_info 归 L1 正则，模糊钱问法归 market_price 按总账答），confidence 限 0~1';
    try {
      const rawResult: unknown = await this.capabilityService
        .load(LLM_INTENT_PLUGIN_ID)
        .call(LLM_INTENT_ACTION_KEY, {
          customer_message: input,
          conversation_context: EMPTY_CONTEXT_PLACEHOLDER,
        });
      const structured: Record<string, unknown> | null =
        rawResult && typeof rawResult === 'object'
          ? (rawResult as Record<string, unknown>)
          : null;
      return {
        test: 'enum_lock',
        raw: JSON.stringify(rawResult, null, 2),
        systemPrompt,
        userMessage: input,
        structured,
        platformNote: ENUM_LOCK_PLATFORM_NOTE,
      };
    } catch (error) {
      const detail: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`AI 实测[enum_lock]调用失败: ${detail}`);
      return {
        test: 'enum_lock',
        raw: '',
        error: error instanceof Error ? error.message : String(error),
        systemPrompt,
        userMessage: input,
        structured: null,
        platformNote: ENUM_LOCK_PLATFORM_NOTE,
      };
    }
  }
}
