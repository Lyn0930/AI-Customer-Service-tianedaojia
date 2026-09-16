import {
  Injectable,
  Inject,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
  CapabilityService,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq, asc } from 'drizzle-orm';
import { qaEntries } from '@server/database/schema';
import { AiConfigService } from './ai-config.service';
import { RequirementCollectionService } from '../automation/requirement-collection.service';
import { normalizeStream } from '../chat/stream-utils';
import {
  AI_REPLY_ACTION_KEY,
  AI_REPLY_PLUGIN_ID,
  SWAN_PERSONA,
  detectServiceTypeFromText,
} from '../chat/chat.prompt';
import type {
  QAEntry,
  CreateQAEntryRequest,
  UpdateQAEntryRequest,
  TestChatRequest,
  TestChatResponse,
  Requirement,
} from '@shared/api.interface';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
    private readonly aiConfigService: AiConfigService,
    private readonly requirementCollectionService: RequirementCollectionService,
  ) {}

  // ============ QA 知识库 CRUD ============

  async listQa(category?: string): Promise<QAEntry[]> {
    const conditions = [];
    if (category) {
      conditions.push(eq(qaEntries.category, category));
    }

    const query = conditions.length > 0
      ? this.db.select().from(qaEntries).where(conditions[0]).orderBy(asc(qaEntries.sortOrder))
      : this.db.select().from(qaEntries).orderBy(asc(qaEntries.sortOrder));

    const rows = await query;
    return rows.map((r) => this.mapQaEntry(r));
  }

  async createQa(data: CreateQAEntryRequest): Promise<QAEntry> {
    const rows = await this.db
      .insert(qaEntries)
      .values({
        question: data.question,
        answer: data.answer,
        category: data.category ?? 'general',
        sortOrder: data.sortOrder ?? 0,
      })
      .returning();

    this.aiConfigService['qaCache'] = null;
    return this.mapQaEntry(rows[0]);
  }

  async updateQa(id: string, data: UpdateQAEntryRequest): Promise<QAEntry> {
    const updateData: Record<string, unknown> = {};
    if (data.question !== undefined) updateData.question = data.question;
    if (data.answer !== undefined) updateData.answer = data.answer;
    if (data.category !== undefined) updateData.category = data.category;
    if (data.enabled !== undefined) updateData.enabled = data.enabled;
    if (data.sortOrder !== undefined) updateData.sortOrder = data.sortOrder;

    const rows = await this.db
      .update(qaEntries)
      .set(updateData)
      .where(eq(qaEntries.id, id))
      .returning();

    if (rows.length === 0) {
      throw new NotFoundException('QA 条目不存在');
    }

    this.aiConfigService['qaCache'] = null;
    return this.mapQaEntry(rows[0]);
  }

  async deleteQa(id: string): Promise<void> {
    const rows = await this.db
      .delete(qaEntries)
      .where(eq(qaEntries.id, id))
      .returning({ id: qaEntries.id });

    if (rows.length === 0) {
      throw new NotFoundException('QA 条目不存在');
    }

    this.aiConfigService['qaCache'] = null;
  }

  // ============ 测试客服 ============

  async testChat(data: TestChatRequest): Promise<TestChatResponse> {
    const persona = await this.aiConfigService.getPersonaWithQa(SWAN_PERSONA);
    const pluginId = await this.aiConfigService.getConfigWithDefault(
      'ai_reply_plugin_id',
      AI_REPLY_PLUGIN_ID,
    );

    const conversationHistory = (data.history ?? [])
      .map((m) => `${m.role === 'customer' ? '雇主' : '小书'}: ${m.content}`)
      .join('\n')
      || '（暂无历史对话，这是第一条消息）';

    const detectedType = detectServiceTypeFromText(data.message);
    const mockRequirement: Requirement | null = detectedType
      ? {
          id: '',
          leadId: '',
          serviceType: detectedType,
          householdSize: null,
          area: null,
          elderlyCare: null,
          restDays: null,
          startTime: null,
          serviceAddress: null,
          helperRequirements: null,
          dietaryPreferences: null,
          budget: null,
          specialRequirements: null,
          serviceItems: null,
          serviceHours: null,
          hasPet: null,
          source: null,
          cardSubmittedAt: null,
          childCare: null,
          aiSummary: null,
          status: 'collecting',
          createdAt: '',
          updatedAt: '',
        }
      : null;

    let reply = '';
    try {
      const streamResult = await this.capabilityService
        .load(pluginId)
        .callStream(AI_REPLY_ACTION_KEY, {
          persona,
          conversation_history: conversationHistory,
          collected_requirements: this.requirementCollectionService.buildGuidancePrompt(
            detectedType,
            mockRequirement,
          ),
          latest_customer_message: data.message,
        });

      const stream = normalizeStream(streamResult);
      for await (const chunk of stream) {
        const chunkContent = (chunk as { content?: string }).content;
        if (chunkContent) {
          reply += chunkContent;
        }
      }
    } catch (error) {
      this.logger.error(
        `测试聊天 AI 回复失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      reply = '抱歉，AI 回复失败，请检查插件配置是否正确。';
    }

    return { reply };
  }

  // ============ 映射 ============

  private mapQaEntry(row: typeof qaEntries.$inferSelect): QAEntry {
    return {
      id: row.id,
      question: row.question,
      answer: row.answer,
      category: row.category,
      enabled: row.enabled,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
