import { Injectable, Logger } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { LlmIntentType } from './llm-intent.types';

/**
 * 自学习闭环 · 数据收集层（阶段三 · 最小闭环）
 *
 * 只收集"正则没抓到、但 LLM 判断出了意图"的消息——
 * 正则已经能抓的不重复收集，聚焦增量价值。
 *
 * 后续审核后台会基于这张表做：
 *   - 相同说法聚合计数
 *   - 人工审核（通过/驳回）
 *   - 审核通过后提炼关键词入库到正则关键词表
 *
 * 设计原则：
 *   - 轻量：只存必要字段，不存整段对话
 *   - 可聚合：key_phrase 用于聚合计数
 *   - 可追溯：存 message_id 和 session_id，需要时能回溯完整上下文
 */

export interface IntentDiscoveryRecord {
  id: number;
  intent: string;              // LLM 识别出的意图
  keyPhrase: string;           // 关键短语（用于聚合）
  messageContent: string;      // 客户消息原文
  serviceType: string | null;  // 识别出的服务类型
  confidence: number;          // LLM 置信度
  sessionId: string;           // 会话 ID
  messageId: string | null;    // 消息 ID（用于回溯）
  status: 'pending' | 'approved' | 'rejected'; // 审核状态
  createdAt: Date;
}

@Injectable()
export class IntentDiscoveryService {
  private readonly logger = new Logger(IntentDiscoveryService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 记录一条"正则漏了、LLM 抓到了"的发现
   *
   * @param intent LLM 识别出的意图
   * @param keyPhrase 关键短语（AI 认为最能代表意图的片段）
   * @param messageContent 完整消息内容
   * @param serviceType 识别出的服务类型
   * @param confidence LLM 置信度
   * @param sessionId 会话 ID
   * @param messageId 消息 ID
   */
  async recordDiscovery(
    intent: LlmIntentType,
    keyPhrase: string,
    messageContent: string,
    serviceType: string | null,
    confidence: number,
    sessionId: string,
    messageId: string | null,
  ): Promise<void> {
    try {
      // 用原始 SQL 插入，表结构由用户在妙搭后台创建
      // 表名：intent_discoveries
      await this.db.execute(sql`
        INSERT INTO intent_discoveries (
          intent, key_phrase, message_content, service_type, confidence,
          session_id, message_id, status
        ) VALUES (
          ${intent},
          ${keyPhrase || messageContent.slice(0, 50)},
          ${messageContent},
          ${serviceType ?? null},
          ${confidence},
          ${sessionId},
          ${messageId ?? null},
          'pending'
        )
      `);
      this.logger.log(
        `[DISCOVERY] 记录新发现: intent=${intent} confidence=${confidence.toFixed(2)}` +
        ` keyPhrase="${keyPhrase.slice(0, 30)}"`,
      );
    } catch (err) {
      // 记录失败不阻塞主流程——自学习是锦上添花，不是核心路径
      this.logger.warn(
        `[DISCOVERY] 记录失败（不阻塞主流程）: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 按意图 + 关键短语聚合统计（审核后台用）
   * 返回：每个 (intent, key_phrase) 组合的出现次数，按次数倒序
   */
  async getAggregatedPending(limit = 50): Promise<Array<{
    intent: string;
    keyPhrase: string;
    count: number;
    sampleMessage: string;
    lastSeen: Date;
  }>> {
    try {
      // db.execute 返回 postgres-js RowList（本身即行数组，无 .rows 属性）；
      // COUNT(*) 是 bigint，driver 返回字符串，需转 number
      const result = await this.db.execute(sql`
        SELECT
          intent,
          key_phrase as "keyPhrase",
          COUNT(*) as count,
          (SELECT message_content FROM intent_discoveries d2
           WHERE d2.intent = d1.intent AND d2.key_phrase = d1.key_phrase
           AND d2.status = 'pending'
           ORDER BY created_at DESC LIMIT 1) as "sampleMessage",
          MAX(created_at) as "lastSeen"
        FROM intent_discoveries d1
        WHERE status = 'pending'
        GROUP BY intent, key_phrase
        ORDER BY count DESC
        LIMIT ${limit}
      `);
      const rows: Array<Record<string, unknown>> = result as Array<Record<string, unknown>>;
      return rows.map((row: Record<string, unknown>) => ({
        intent: String(row.intent),
        keyPhrase: String(row.keyPhrase),
        count: Number(row.count),
        sampleMessage: String(row.sampleMessage ?? ''),
        lastSeen: row.lastSeen as Date,
      }));
    } catch (err) {
      this.logger.warn(`[DISCOVERY] 聚合查询失败: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
}
