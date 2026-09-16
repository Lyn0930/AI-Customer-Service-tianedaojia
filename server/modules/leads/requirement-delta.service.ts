import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { requirementFieldDelta } from '@server/database/schema';

/**
 * 需求字段变更审计流水（文档 §5.5 三层存储之「delta 日志」层）
 *
 * 消息表记对话过程、requirements 表记当前值，本服务记每一次字段变更
 * （谁/什么来源、从什么值改成什么值），供运营追溯字段被改坏的场景。
 * 写入是 best-effort：审计失败不阻塞主链路。
 */

export type FieldDeltaSource =
  | 'ai_extract'       // AI [[FIELDS]] 提取（saveParsedFields）
  | 'realtime_detect'  // 实时正则检测（runRealtimeFieldDetection）
  | 'form_card'        // 飞书表单卡提交
  | 'agent_edit';      // 运营/客服后台修改

export interface FieldDeltaChange {
  fieldKey: string;
  oldValue: string | null;
  newValue: string | null;
}

@Injectable()
export class RequirementDeltaService {
  private readonly logger = new Logger(RequirementDeltaService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  /**
   * 记录字段变更（仅记录真正发生变化的字段：old !== new）
   *
   * @param params.leadId 线索 ID
   * @param params.source 变更来源
   * @param params.changes 字段变更候选列表（新旧值均为写入后的有效值）
   * @param params.sessionId / messageId 可选溯源字段
   */
  async recordDeltas(params: {
    leadId: string;
    source: FieldDeltaSource;
    changes: FieldDeltaChange[];
    sessionId?: string | null;
    messageId?: string | null;
  }): Promise<void> {
    const effective: FieldDeltaChange[] = params.changes.filter(
      (change: FieldDeltaChange) =>
        (change.oldValue ?? '') !== (change.newValue ?? ''),
    );
    if (effective.length === 0) return;

    try {
      await this.db.insert(requirementFieldDelta).values(
        effective.map((change: FieldDeltaChange) => ({
          leadId: params.leadId,
          sessionId: params.sessionId ?? null,
          messageId: params.messageId ?? null,
          fieldKey: change.fieldKey,
          oldValue: change.oldValue ?? null,
          newValue: change.newValue ?? null,
          changeSource: params.source,
        })),
      );
    } catch (err) {
      this.logger.warn(
        `字段变更日志写入失败（不阻塞）: lead=${params.leadId.slice(0, 8)} ` +
        `source=${params.source} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
