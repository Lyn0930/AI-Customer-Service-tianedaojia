import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
  CapabilityService,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { chatMessages, chatSessions, leads } from '@server/database/schema';
import { normalizeStream } from '../chat/stream-utils';
import { SUMMARY_PLUGIN_ID, SUMMARY_ACTION_KEY } from '../chat/chat.prompt';
import type { ConversationSummaryResponse } from '@shared/api.interface';

const MIN_MESSAGES_FOR_SUMMARY = 4;

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
  ) {}

  async generateSummary(
    sessionId: string,
    userId: string,
    all = false,
  ): Promise<ConversationSummaryResponse> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    if (!all) {
      const leadRows = await this.db
        .select()
        .from(leads)
        .where(eq(leads.id, sessionRows[0].leadId))
        .limit(1);
      if (
        leadRows.length > 0 &&
        leadRows[0].assigneeId !== null &&
        leadRows[0].assigneeId !== userId
      ) {
        throw new ForbiddenException('无权操作此会话');
      }
    }

    const messages = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
      return { summary: '对话消息较少，暂无摘要' };
    }

    const conversationText = messages
      .map((m) => {
        const role =
          m.role === 'customer'
            ? '客户'
            : m.role === 'agent'
              ? '客服'
              : 'AI客服';
        return `${role}：${m.content}`;
      })
      .join('\n');

    const result = await this.capabilityService
      .load(SUMMARY_PLUGIN_ID)
      .callStream(SUMMARY_ACTION_KEY, {
        conversation_text: conversationText,
      });

    const stream = normalizeStream(result);

    let summary = '';
    for await (const chunk of stream) {
      summary += (chunk as { summary?: string }).summary ?? '';
    }

    this.logger.log(
      `会话 ${sessionId} 摘要生成完成，长度: ${summary.length}`,
    );
    return { summary };
  }
}
