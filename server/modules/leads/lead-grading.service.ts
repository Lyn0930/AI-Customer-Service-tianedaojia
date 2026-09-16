import { Injectable, Inject, Logger, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc, and } from 'drizzle-orm';
import {
  leads, leadGradeHistory, requirements,
  chatMessages, chatSessions, salaryConfig,
} from '@server/database/schema';
import { RoutingService } from '../routing/routing.service';
import { GRADE_E_KEYWORDS } from '../chat/chat.prompt';
import {
  parseBudgetNumber, scoreUrgency, scoreClarity,
  getCityTier, mapSalaryServiceType, HIGH_EMOTION_KEYWORDS,
} from './lead-grading.util';
import type { GradeHistory, GradeTransitionTrigger } from '@shared/api.interface';

const VALID_GRADES = ['A', 'B', 'B_PRICE', 'C1', 'C2', 'D'];

const GRADE_CHANGE_DEDUP_MS = 5_000;
const CONTEXT_WINDOW_SIZE = 10;
const MIN_CUSTOMER_MESSAGES_FOR_D = 2;

/**
 * 线索分级服务（2026-08-28 按 README 第八章重构为 6 档）
 *
 * 档位：A（优质≥6分）/ B（<6分）/ B_PRICE（预算严重偏离，AI 培育）
 *      C1（客户主动转人工，按情绪排序）/ C2（待采集）/ D（无效丢弃）
 *
 * A/B 判定代码化三维度（各 1-3 分）：
 *   预算匹配度（查 salary_config 正常价/偏低价区间）
 *   时间紧迫度（解析 start_time）
 *   需求明确度（11 个采集字段有值比例）
 */
@Injectable()
export class LeadGradingService {
  private readonly logger = new Logger(LeadGradingService.name);
  private readonly recentTransitions = new Map<string, { grade: string; at: number }>();

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(forwardRef(() => RoutingService))
    private readonly routingService: RoutingService,
  ) {}

  async updateGrade(
    leadId: string,
    newGrade: string,
    reason: string,
    triggeredBy: GradeTransitionTrigger,
    options?: { confidence?: number; leadScore?: number | null; urgencyLevel?: string | null },
  ): Promise<void> {
    const cached = this.recentTransitions.get(leadId);
    const now = Date.now();
    if (cached && cached.grade === newGrade && now - cached.at < GRADE_CHANGE_DEDUP_MS) {
      return;
    }

    const [lead] = await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return;

    const oldGrade = lead.leadGrade;
    if (oldGrade === newGrade && !options) {
      this.recentTransitions.set(leadId, { grade: newGrade, at: now });
      return;
    }

    const updateData: Record<string, unknown> = {
      leadGrade: newGrade,
      gradeReason: reason,
    };
    if (options?.confidence !== undefined) {
      updateData.gradeConfidence = options.confidence.toString();
    }
    if (options?.leadScore !== undefined) {
      updateData.leadScore = options.leadScore;
    }
    if (options?.urgencyLevel !== undefined) {
      updateData.urgencyLevel = options.urgencyLevel;
    }

    await this.db.update(leads).set(updateData).where(eq(leads.id, leadId));
    this.recentTransitions.set(leadId, { grade: newGrade, at: now });

    if (oldGrade !== newGrade) {
      await this.db.insert(leadGradeHistory).values({
        leadId,
        oldGrade: oldGrade,
        newGrade,
        reason: reason.slice(0, 200),
        triggeredBy,
      });
      this.logger.log(
        `线索 ${leadId} 分级变更: ${oldGrade ?? 'null'} → ${newGrade} (${triggeredBy}) ${reason}`,
      );
      this.routingService
        .handleGradeChange(leadId, oldGrade, newGrade)
        .catch((err: unknown) => {
          this.logger.warn(
            `分级变更触发重新分配失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  /**
   * 客户消息触发的分级检测：D 关键词（3 层豁免）+ 全量重算
   */
  async checkGradeTransition(leadId: string, userMessage: string): Promise<void> {
    const [lead] = await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return;

    if (GRADE_E_KEYWORDS.some((kw) => userMessage.includes(kw)) && lead.leadGrade !== 'D') {
      const lastBotAskedRequirement = await this.checkIfAnsweringRequirementQuestion(lead.id);
      const recentContext = await this.getRecentContext(lead.id);
      const exempted = lastBotAskedRequirement
        || this.hasPositiveSignalInContext(recentContext)
        || recentContext.customerCount < MIN_CUSTOMER_MESSAGES_FOR_D;
      if (!exempted) {
        await this.updateGrade(leadId, 'D', `无效关键词命中: ${userMessage.slice(0, 50)}`, 'ai');
        return;
      }
    }

    await this.recomputeGrade(leadId);
  }

  /**
   * 按 README 8.6 流程全量重算分级：
   * D 保留 → 已转人工 C1（情绪分级）→ 已采集完 A/B/B_PRICE（三维度）→ 其余 C2
   */
  async recomputeGrade(leadId: string): Promise<void> {
    const [lead] = await this.db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) return;
    if (lead.leadGrade === 'D' || lead.status === 'closed') return;

    const [req] = await this.db
      .select()
      .from(requirements)
      .where(eq(requirements.leadId, leadId))
      .limit(1);

    const [humanSession] = await this.db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.leadId, leadId), eq(chatSessions.mode, 'human')))
      .limit(1);

    if (humanSession) {
      const emotion = await this.detectEmotion(leadId);
      await this.updateGrade(leadId, 'C1',
        `客户主动转人工，AI情绪${emotion.level}${emotion.reason ? `：${emotion.reason}` : ''}`,
        'system', {
          urgencyLevel: emotion.level,
        });
      return;
    }

    if (lead.status === 'collected' && req?.serviceType) {
      const salaryRows = await this.db
        .select({ baseLow: salaryConfig.baseLow, altLow: salaryConfig.altLow })
        .from(salaryConfig)
        .where(and(
          eq(salaryConfig.serviceType, mapSalaryServiceType(req.serviceType)),
          eq(salaryConfig.cityTier, getCityTier(lead.serviceCity)),
        ));

      const budgetNum = parseBudgetNumber(req.budget);
      let budgetScore: 1 | 2 | 3 = 2;
      if (salaryRows.length > 0) {
        const minBaseLow = Math.min(...salaryRows.map((r) => r.baseLow));
        const minAltLow = Math.min(...salaryRows.map((r) => r.altLow));
        if (budgetNum !== null && minAltLow > 0 && budgetNum < minAltLow) {
          await this.updateGrade(leadId, 'B_PRICE',
            `预算${budgetNum}低于偏低价下限${minAltLow}，AI培育不转人工`, 'system',
            { leadScore: null });
          return;
        }
        budgetScore = budgetNum !== null && budgetNum >= minBaseLow ? 3 : 2;
      }

      const urgencyScore = scoreUrgency(req.startTime);
      const clarity = scoreClarity(req);
      const total = budgetScore + urgencyScore + clarity.score;
      const grade = total >= 6 ? 'A' : 'B';
      await this.updateGrade(leadId, grade,
        `预算${budgetScore}+紧迫${urgencyScore}+明确${clarity.score}(${clarity.filled}/11字段)=${total}分`,
        'system', { leadScore: total });
      return;
    }

    await this.updateGrade(leadId, 'C2', 'AI未走完采集，继续采集', 'system');
  }

  /**
   * C1 情绪分级（README 8.3）：AI 分析客户最后 1-3 条消息的措辞语气，
   * AI 调用失败时降级为关键词匹配，保证分级流程不阻塞。
   */
  private async detectEmotion(leadId: string): Promise<{ level: string; reason: string }> {
    const rows = await this.db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(and(eq(chatSessions.leadId, leadId), eq(chatMessages.role, 'customer')))
      .orderBy(desc(chatMessages.createdAt))
      .limit(3);
    const messages = rows.reverse().map((m) => m.content);
    const content = messages.join('\n');

    if (content.trim()) {
      const aiResult = await this.routingService.classifyC1Emotion(content);
      if (aiResult) {
        return { level: aiResult.level, reason: aiResult.reason };
      }
      this.logger.warn(`线索 ${leadId} C1情绪 AI 判断失败，降级关键词匹配`);
    }

    const hit = messages.some((m) => HIGH_EMOTION_KEYWORDS.some((kw) => m.includes(kw)));
    return {
      level: hit ? 'high' : 'medium',
      reason: hit ? '关键词命中愤怒/催促措辞' : '',
    };
  }

  private hasPositiveSignalInContext(ctx: { customerMessages: { content: string }[] }): boolean {
    const POSITIVE = ['还需要', '还在找', '急需', '尽快', '匹配', '推荐', '想要', '打算'];
    return ctx.customerMessages.some((m) => POSITIVE.some((kw) => m.content.includes(kw)));
  }

  private async getRecentContext(leadId: string): Promise<{
    customerMessages: { content: string }[];
    customerCount: number;
  }> {
    const rows = await this.db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(CONTEXT_WINDOW_SIZE);
    const customerMessages = rows.reverse().filter((m) => m.role === 'customer');
    return { customerMessages, customerCount: customerMessages.length };
  }

  private async checkIfAnsweringRequirementQuestion(leadId: string): Promise<boolean> {
    const rows = await this.db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .innerJoin(chatSessions, eq(chatMessages.sessionId, chatSessions.id))
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(CONTEXT_WINDOW_SIZE);
    const lastBot = rows.find((m) => m.role === 'bot');
    if (!lastBot) return false;
    const REQUIREMENT_QUESTION_KEYWORDS = [
      '老人', '照护', '陪护', '做饭', '口味', '面积', '多大', '几口',
      '月休', '休息', '到岗', '什么时候', '地址', '哪个区', '街道',
      '预算', '薪资', '多少', '要求', '特殊要求', '保洁', '频次',
      '孩子', '宝宝', '预产期', '几号', '住家', '白班',
    ];
    return REQUIREMENT_QUESTION_KEYWORDS.some((kw) => lastBot.content.includes(kw));
  }

  async getGradeHistory(leadId: string): Promise<GradeHistory[]> {
    const rows = await this.db
      .select()
      .from(leadGradeHistory)
      .where(eq(leadGradeHistory.leadId, leadId))
      .orderBy(desc(leadGradeHistory.createdAt));

    return rows.map((row) => ({
      id: row.id,
      leadId: row.leadId,
      oldGrade: row.oldGrade,
      newGrade: row.newGrade,
      reason: row.reason,
      triggeredBy: row.triggeredBy as GradeTransitionTrigger,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async regrade(leadId: string, grade: string, reason: string): Promise<void> {
    if (!VALID_GRADES.includes(grade)) {
      throw new Error(`无效的分级: ${grade}`);
    }
    await this.updateGrade(leadId, grade, reason || '手动改级', 'manual', { confidence: 1 });
  }
}
