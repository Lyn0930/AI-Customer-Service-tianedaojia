import { Injectable, Logger, forwardRef, Inject } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { AiConfigService } from '../../admin/ai-config.service';
import { ChatPricingService } from '../chat-pricing.service';
import { ChatTransferService } from '../chat-transfer.service';
import { IntentRouter, IntentType } from './intent-router';
import { buildToolRegistry, ToolContext, ToolDefinition } from './tools';
import { LlmIntentService } from '../llm-intent/llm-intent.service';
import { IntentDiscoveryService } from '../llm-intent/intent-discovery.service';
import type { NormalizedLlmIntent } from '../llm-intent/llm-intent.types';
import { FaqService, type FaqHit } from '../faq/faq.service';

export interface RouteResult {
  handled: boolean;
  intent: IntentType | null;
  reply: string;
}

interface RouterStats {
  oldPath: number;
  newPath: number;
  toolSuccess: number;
  toolFail: number;
  llmHit: number;       // LLM 语义层命中次数（正则没抓到的）
  llmMiss: number;      // LLM 语义层未命中（none 或低置信度）
  llmFail: number;      // LLM 调用失败次数
  faqHit: number;       // FAQ 内容层命中次数
}

@Injectable()
export class IntelligentRouterService {
  private readonly logger = new Logger(IntelligentRouterService.name);
  private readonly tools: Map<string, ToolDefinition>;
  private readonly stats: RouterStats = {
    oldPath: 0,
    newPath: 0,
    toolSuccess: 0,
    toolFail: 0,
    llmHit: 0,
    llmMiss: 0,
    llmFail: 0,
    faqHit: 0,
  };

  private readonly chatPricingService: ChatPricingService;

  constructor(
    private readonly intentRouter: IntentRouter,
    private readonly aiConfigService: AiConfigService,
    private readonly llmIntentService: LlmIntentService,
    private readonly intentDiscoveryService: IntentDiscoveryService,
    private readonly faqService: FaqService,
    chatPricingService: ChatPricingService,
    @Inject(forwardRef(() => ChatTransferService))
    chatTransferService: ChatTransferService,
    @Inject(DRIZZLE_DATABASE) db: PostgresJsDatabase,
  ) {
    this.chatPricingService = chatPricingService;
    this.tools = buildToolRegistry(chatPricingService, chatTransferService, db);
  }

  getStats(): RouterStats {
    return { ...this.stats };
  }

  /**
   * 问答意图探测（只检测不执行）
   *
   * form_card 推卡前调用：命中问答类意图（询价/收费/服务范围/转人工）则跳过推卡，
   * 交由路由层先回答客户问题（先答问题，再采需求）
   */
  hasQaIntent(content: string): boolean {
    return (
      this.intentRouter.detectIntent(content) !== null ||
      this.faqService.hasFaqHit(content)
    );
  }

  recordValidatorBlock(): void {
    this.logger.warn(
      `[dispatch] validatorBlocked total=${JSON.stringify(this.getStats())}`,
    );
  }

  async tryRoute(
    content: string,
    context: ToolContext,
    logTag: string,
  ): Promise<RouteResult> {
    const enabled = await this.aiConfigService
      .getConfigWithDefault('function_calling_router_enabled', '1')
      .catch(() => '1');
    if (enabled !== '1') {
      return { handled: false, intent: null, reply: '' };
    }

    // 第一层：正则意图路由（快、确定、零成本）
    const intentResult = this.intentRouter.detectIntent(content);
    if (intentResult) {
      // 混合意图（询价+其他问题/信息）走老路：工具只能答价格，
      // 其余部分需 LLM 接住，避免吞掉客户其他诉求
      if (this.chatPricingService.hasNonPriceContent(content)) {
        this.stats.oldPath += 1;
        this.logger.log(
          `[dispatch] 混合意图走老路（询价+其他内容）: ${logTag} content="${content.slice(0, 50)}"`,
        );
        return { handled: false, intent: null, reply: '' };
      }

      const tool = this.tools.get(intentResult.toolName);
      if (!tool) {
        this.logger.warn(
          `[dispatch] 意图命中但工具未注册: intent=${intentResult.intent} tool=${intentResult.toolName}`,
        );
        this.stats.oldPath += 1;
        return { handled: false, intent: null, reply: '' };
      }

      try {
        const enrichedContext: ToolContext = {
          ...context,
          ...(intentResult.matchedAlias
            ? { matchedAlias: intentResult.matchedAlias }
            : {}),
          ...(intentResult.transferReason
            ? { transferReason: intentResult.transferReason }
            : {}),
        };
        const reply = await tool.execute(enrichedContext);
        if (!reply) {
          throw new Error('tool returned empty reply');
        }
        this.stats.newPath += 1;
        this.stats.toolSuccess += 1;
        this.logger.log(
          `[dispatch] route=regex intent=${intentResult.intent} tool=${tool.name} ${logTag} stats=${JSON.stringify(this.getStats())}`,
        );
        return { handled: true, intent: intentResult.intent, reply };
      } catch (error) {
        this.stats.oldPath += 1;
        this.stats.toolFail += 1;
        this.logger.warn(
          `[dispatch] 工具执行失败回退老路: tool=${tool.name} ${logTag} err=${error instanceof Error ? error.message : String(error)}`,
        );
        return { handled: false, intent: null, reply: '' };
      }
    }

    // 第二层：FAQ 内容货架（内容型话题，命中触发词直接展示已审核文案，零成本）
    // 裁决：7 候选全部不进意图枚举，FAQ 层在意图之后、LLM 之前，接住中低频内容型问法；
    // 仅 status=published 条目参与匹配（未审核草稿/停用不上线）
    await this.faqService.ensureLoaded().catch((error: unknown) => {
      this.logger.warn(
        `[dispatch] FAQ 缓存刷新失败（不阻塞）: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const faqHit: FaqHit | null = this.faqService.matchFaq(content);
    if (faqHit) {
      this.stats.faqHit += 1;
      this.stats.toolSuccess += 1;
      this.logger.log(
        `[dispatch] route=faq topic=${faqHit.topic} word="${faqHit.matchedWord}" ${logTag} stats=${JSON.stringify(this.getStats())}`,
      );
      return { handled: true, intent: null, reply: faqHit.reply };
    }

    // 第三层：LLM 语义意图路由（慢、有成本、但覆盖长尾）
    // 正则与 FAQ 都没命中时才走 LLM，避免不必要的 token 消耗
    const llmEnabled = await this.aiConfigService
      .getConfigWithDefault('llm_intent_router_enabled', '0')
      .catch(() => '0');
    if (llmEnabled !== '1') {
      this.stats.oldPath += 1;
      return { handled: false, intent: null, reply: '' };
    }

    const llmResult = await this.tryLlmRoute(content, context, logTag);
    if (llmResult.handled) {
      return llmResult;
    }

    // 两层都没命中 → 放行给自由回复
    this.stats.oldPath += 1;
    return { handled: false, intent: null, reply: '' };
  }

  /**
   * LLM 语义路由：正则没命中时的 fallback
   *
   * 流程：
   *   1. 调 LLM 做语义分类
   *   2. 命中（置信度达标 + 不是 none）→ 映射到对应工具执行
   *   3. 记录发现（自学习闭环：正则漏了但 LLM 抓到了）
   *   4. 没命中 → 返回未处理
   */
  private async tryLlmRoute(
    content: string,
    context: ToolContext,
    logTag: string,
  ): Promise<RouteResult> {
    // 构造对话上下文（最近 3 轮，帮助 LLM 理解歧义）
    const historyMessages = context.historyMessages ?? [];
    const recentContext = historyMessages
      .slice(-6)
      .map((m: { role: string; content: string }) =>
        `${m.role === 'customer' ? '雇主' : '小书'}: ${m.content}`)
      .join('\n');

    let llmResult: NormalizedLlmIntent | null;
    try {
      llmResult = await this.llmIntentService.classify(content, recentContext);
    } catch (err) {
      this.stats.llmFail += 1;
      this.logger.warn(
        `[dispatch] LLM 意图分类失败（不阻塞）: ${logTag} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { handled: false, intent: null, reply: '' };
    }

    if (!llmResult) {
      this.stats.llmMiss += 1;
      return { handled: false, intent: null, reply: '' };
    }

    // LLM 命中 → 映射到工具
    this.stats.llmHit += 1;

    // 意图 → 工具名映射（与 tools.ts 中的工具名称保持一致）
    // fee_info 不在此映射：已由 L1 正则直出，L2 枚举不含该意图（4 值定稿）
    const intentToTool: Record<string, string> = {
      market_price: 'queryMarketPrice',
      transfer_human: 'transferToHuman',
      service_scope: 'queryServiceScope',
    };

    const toolName = intentToTool[llmResult.intent];
    if (!toolName) {
      this.logger.warn(
        `[dispatch] LLM 命中意图但无对应工具: intent=${llmResult.intent} ${logTag}`,
      );
      return { handled: false, intent: null, reply: '' };
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      this.logger.warn(
        `[dispatch] LLM 命中意图但工具未注册: intent=${llmResult.intent} tool=${toolName}`,
      );
      return { handled: false, intent: null, reply: '' };
    }

    // 执行工具
    try {
      // 如果 LLM 识别出了服务类型，注入到 context 里（价格工具会用到）
      const enrichedContext = llmResult.serviceType
        ? { ...context, llmDetectedServiceType: llmResult.serviceType }
        : context;

      const reply = await tool.execute(enrichedContext);
      if (!reply) {
        throw new Error('tool returned empty reply');
      }

      this.stats.toolSuccess += 1;
      this.logger.log(
        `[dispatch] route=llm intent=${llmResult.intent} tool=${toolName} ` +
        `confidence=${llmResult.confidence.toFixed(2)} ${logTag} ` +
        `stats=${JSON.stringify(this.getStats())}`,
      );

      // 自学习闭环：记录这条"正则漏了、LLM 抓到了"的发现
      // 异步执行，不阻塞回复
      this.intentDiscoveryService.recordDiscovery(
        llmResult.intent,
        llmResult.keyPhrase,
        content,
        llmResult.serviceType,
        llmResult.confidence,
        context.sessionId ?? '',
        null, // messageId 在上层才有，这里先留空
      ).catch(() => {
        // 记录失败不影响主流程
      });

      return { handled: true, intent: llmResult.intent as IntentType, reply };
    } catch (error) {
      this.stats.toolFail += 1;
      this.logger.warn(
        `[dispatch] LLM 路由工具执行失败: tool=${toolName} ${logTag} err=${error instanceof Error ? error.message : String(error)}`,
      );
      return { handled: false, intent: null, reply: '' };
    }
  }
}
