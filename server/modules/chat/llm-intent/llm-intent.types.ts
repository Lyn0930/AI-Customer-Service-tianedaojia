/**
 * LLM 语义意图分类 —— 类型定义
 *
 * 阶段三核心：在正则意图路由之上加一层 LLM 语义检测，
 * 用来捕获正则漏掉的长尾问法。
 *
 * 设计原则：
 *   - 输出严格结构化（走 text-to-json 插件通道）
 *   - 置信度低于阈值 → 当没识别，放行给自由回复
 *   - none 意图 → 都不是，不硬猜
 */

/** L2 意图枚举（4 值；2026-09-12 定稿：fee_info 归 L1 正则，模糊钱问法归 market_price 按总账直答） */
export type LlmIntentType =
  | 'market_price'      // 问请阿姨要花多少钱（含模糊钱问法，一律按总账答）
  | 'transfer_human'    // 转人工
  | 'service_scope'     // 服务范围
  | 'none';             // 都不是 / 拿不准 / FAQ 类话题 / fee_info 4 别称

/** LLM 意图分类结果（与插件 outputSchema 对应，字段类型均为插件支持的原生类型） */
export interface LlmIntentResult {
  /** 识别出的意图：market_price / transfer_human / service_scope / none（4 值） */
  intent: string;
  /** 置信度 0~1，低于阈值当没识别 */
  confidence: number;
  /** 匹配的服务类型（如"住家保姆"、"育儿嫂"），没有则空字符串 */
  service_type: string;
  /** 关键匹配短语（AI 认为最能代表意图的原话片段），用于自学习闭环 */
  key_phrase: string;
}

/** 归一化后的分类结果（代码层使用） */
export interface NormalizedLlmIntent {
  intent: LlmIntentType;
  confidence: number;
  serviceType: string | null;
  keyPhrase: string;
}
