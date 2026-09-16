import { Injectable, Logger } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import { AiConfigService } from '../../admin/ai-config.service';
import type { LlmIntentResult, LlmIntentType, NormalizedLlmIntent } from './llm-intent.types';

/**
 * LLM 语义意图分类服务（阶段三 · 核心层）
 *
 * 职责：
 *   - 调用 text-to-json 插件做语义级意图识别
 *   - 置信度校验 + 结果归一化
 *   - 白名单校验（防止 AI 输出不在枚举里的值）
 *
 * 与正则路由的关系：
 *   - 正则路由是第一层：快、确定、零成本，但覆盖有限
 *   - LLM 语义层是第二层：慢、有成本、但能覆盖长尾问法
 *   - 正则没命中时才调 LLM（避免不必要的 token 消耗）
 */

// 插件实例 ID（用户在妙搭后台创建后替换）
export const LLM_INTENT_PLUGIN_ID = 'customer_service_intent_classifier_1';
export const LLM_INTENT_ACTION_KEY = 'textToJson';

// 合法意图枚举（用于白名单校验；4 值，fee_info 归 L1 正则，模糊钱问法归 market_price）
const VALID_INTENTS: LlmIntentType[] = [
  'market_price',
  'transfer_human',
  'service_scope',
  'none',
];

// 默认置信度阈值：低于此值 → 当没识别，放行给自由回复
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

@Injectable()
export class LlmIntentService {
  private readonly logger = new Logger(LlmIntentService.name);

  constructor(
    private readonly capabilityService: CapabilityService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  /**
   * 对单条消息做 LLM 语义意图分类
   *
   * @param content 客户消息内容
   * @param conversationContext 最近几轮对话上下文（可选，帮助理解歧义）
   * @returns 归一化的分类结果；如果置信度太低或解析失败，返回 null（= 没识别，放行）
   */
  async classify(
    content: string,
    conversationContext?: string,
  ): Promise<NormalizedLlmIntent | null> {
    const pluginId = await this.aiConfigService
      .getConfigWithDefault('llm_intent_plugin_id', LLM_INTENT_PLUGIN_ID)
      .catch(() => LLM_INTENT_PLUGIN_ID);

    const threshold = await this.aiConfigService
      .getConfigWithDefault('llm_intent_confidence_threshold', String(DEFAULT_CONFIDENCE_THRESHOLD))
      .then((v) => Number(v) || DEFAULT_CONFIDENCE_THRESHOLD)
      .catch(() => DEFAULT_CONFIDENCE_THRESHOLD);

    try {
      const raw = (await this.capabilityService
        .load(pluginId)
        .call(LLM_INTENT_ACTION_KEY, {
          customer_message: content,
          conversation_context: conversationContext ?? '',
        })) as LlmIntentResult;

      return this.normalizeResult(raw, threshold, content);
    } catch (err) {
      // LLM 调用失败不阻塞主流程——当没识别，放行给自由回复
      this.logger.warn(
        `[LLM_INTENT] 调用失败，放行: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 归一化 + 校验 LLM 返回结果
   *   - 意图白名单校验（不在枚举里 → 当 none 处理）
   *   - 置信度阈值判断
   *   - 字段类型安全转换
   */
  private normalizeResult(
    raw: LlmIntentResult,
    threshold: number,
    originalContent: string,
  ): NormalizedLlmIntent | null {
    // 1. 意图白名单校验
    const intent = raw.intent?.trim().toLowerCase() as LlmIntentType;
    if (!VALID_INTENTS.includes(intent)) {
      this.logger.warn(
        `[LLM_INTENT] AI 输出了未知意图 "${raw.intent}"，按 none 处理。消息前50字: ${originalContent.slice(0, 50)}`,
      );
      return null;
    }

    // 2. none 意图 → 直接返回 null（放行）
    if (intent === 'none') {
      return null;
    }

    // 3. 置信度校验
    const confidence = Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < threshold) {
      this.logger.log(
        `[LLM_INTENT] 置信度 ${confidence?.toFixed?.(2) ?? 'N/A'} 低于阈值 ${threshold}，放行。` +
        ` 意图=${intent}，消息前50字: ${originalContent.slice(0, 50)}`,
      );
      return null;
    }

    // 4. 归一化返回
    const result: NormalizedLlmIntent = {
      intent,
      confidence,
      serviceType: raw.service_type?.trim() || null,
      keyPhrase: raw.key_phrase?.trim() || '',
    };

    this.logger.log(
      `[LLM_INTENT] 命中: intent=${intent} confidence=${confidence.toFixed(2)}` +
      ` serviceType=${result.serviceType ?? '-'} keyPhrase="${result.keyPhrase.slice(0, 30)}"`,
    );

    return result;
  }
}
