import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, and, desc } from 'drizzle-orm';
import { chatSessions, chatMessages, requirements } from '@server/database/schema';
import { LeadGradingService } from '../leads/lead-grading.service';

export interface TriggerContinueParams {
  leadId: string;
  openId: string;
  requirementId: string;
  trigger: string;
}

const PHASE2_FIELDS: string[] = [
  'helperRequirements',
  'dietaryPreferences',
  'budget',
];

const FIELD_QUESTIONS: Record<string, string> = {
  helperRequirements: '对阿姨有什么要求吗？比如年龄、经验、性格、地域等',
  dietaryPreferences: '做饭方面有什么口味偏好吗？比如清淡、辣、菜系等',
  budget: '您的薪资预算大概在什么范围呢？',
};

function isFieldCollected(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '' && value !== '不需要';
}

@Injectable()
export class AITriggerService {
  private readonly logger = new Logger(AITriggerService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(forwardRef(() => LeadGradingService))
    private readonly leadGradingService: LeadGradingService,
  ) {}

  async triggerContinue(params: TriggerContinueParams): Promise<void> {
    const { leadId, requirementId, trigger } = params;
    this.logger.log(`Triggering AI continue: leadId=${leadId}, requirementId=${requirementId}, trigger=${trigger}`);

    try {
      const reqRows = await this.db
        .select()
        .from(requirements)
        .where(eq(requirements.id, requirementId))
        .limit(1);
      const requirement = reqRows[0];
      if (!requirement) {
        this.logger.warn(`Requirement not found: ${requirementId}`);
        return;
      }

      const sessionRows = await this.db
        .select()
        .from(chatSessions)
        .where(and(eq(chatSessions.leadId, leadId), eq(chatSessions.status, 'active')))
        .orderBy(desc(chatSessions.createdAt))
        .limit(1);
      const session = sessionRows[0];
      if (!session) {
        this.logger.warn(`No active session for leadId: ${leadId}`);
        return;
      }

      const remainingFields = PHASE2_FIELDS.filter(
        (field) => !isFieldCollected((requirement as Record<string, unknown>)[field]),
      );

      let content: string;
      if (remainingFields.length === 0) {
        await this.db
          .update(requirements)
          .set({ status: 'completed' })
          .where(eq(requirements.id, requirementId));
        content = '您的需求信息已全部收集完毕，马上为您安排~';
      } else {
        const nextField = remainingFields[0];
        const nextQuestion = FIELD_QUESTIONS[nextField] || '还有什么需要补充的吗？';
        content = `收到啦～您的基本信息我都记下了。\n\n${nextQuestion}`;
      }

      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content,
      });

      this.leadGradingService.recomputeGrade(leadId).catch((err: unknown) => {
        this.logger.warn(
          `卡片提交后分级重算失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      this.logger.log('AI continue triggered successfully');
    } catch (error) {
      this.logger.error(`Failed to trigger AI continue: ${String(error)}`);
      throw error;
    }
  }
}
