import { Injectable, Logger, NotFoundException, ForbiddenException, forwardRef, Inject } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc, and, count, sql } from 'drizzle-orm';
import { leads, chatSessions, chatMessages } from '@server/database/schema';
import { NotifyService } from '../notify/notify.service';
import { ChatEventBus } from './chat-event-bus.service';
import { RoutingService } from '../routing/routing.service';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { ReplyLearningService } from './reply-learning.service';
import { ChatSessionService } from './chat-session.service';
import { LeadGradingService } from '../leads/lead-grading.service';
import { ChatRequirementsService } from './chat-requirements.service';
import { sanitizeCity, normalizeSource } from '@shared/channels';
import {
  TRANSFER_KEYWORDS,
  TRANSFER_MESSAGE,
  NO_AGENT_ONLINE_MESSAGE,
  FRUSTRATION_KEYWORDS,
} from './chat.prompt';
import type {
  Lead,
  LeadSource,
  TransferSource,
  HandoffSummary,
} from '@shared/api.interface';

@Injectable()
export class ChatTransferService {
  private readonly logger = new Logger(ChatTransferService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notifyService: NotifyService,
    private readonly chatEventBus: ChatEventBus,
    @Inject(forwardRef(() => RoutingService))
    private readonly routingService: RoutingService,
    private readonly agentDispatchService: AgentDispatchService,
    private readonly replyLearningService: ReplyLearningService,
    @Inject(forwardRef(() => ChatSessionService))
    private readonly chatSessionService: ChatSessionService,
    @Inject(forwardRef(() => LeadGradingService))
    private readonly leadGradingService: LeadGradingService,
    @Inject(forwardRef(() => ChatRequirementsService))
    private readonly chatRequirementsService: ChatRequirementsService,
  ) {}


  /**
   * 客户端 - 客户主动请求转人工
   */
  async transferToHuman(token: string, reason?: string): Promise<void> {
    const sessionInfo = await this.chatSessionService.findSessionByToken(token);
    if (!sessionInfo) {
      throw new NotFoundException('无效的访问链接或无活跃会话');
    }

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, (await this.db.select().from(chatSessions).where(eq(chatSessions.id, sessionInfo.id)).limit(1))[0].leadId))
      .limit(1);

    const lead = leadRows.length > 0 ? this.chatSessionService.mapLead(leadRows[0]) : null;
    await this.doTransferToHuman(sessionInfo.id, reason ?? '客户申请转人工', 'customer', lead);
  }

  /**
   * 关键词检测：返回匹配的关键词，无匹配返回 null
   */
  autoDetectTransfer(content: string, keywords: string[]): string | null {
    for (const kw of keywords) {
      if (content.includes(kw)) return kw;
    }
    return null;
  }

  /**
   * 客户情绪升级 / 重复提问检测（2026-08-14 新增）
   *
   * 命中任一关键词即认为客户情绪升级，立即转人工，不再走 LLM 回复流程。
   * 关键词都是多字组合（见 FRUSTRATION_KEYWORDS），避免"急"等单字误伤。
   */
  detectFrustration(content: string): string | null {
    for (const kw of FRUSTRATION_KEYWORDS) {
      if (content.includes(kw)) return kw;
    }
    return null;
  }


  /**
   * 执行转人工（内部方法）：设 mode=human + 存转接信息 + 插 bot 提示消息 + 通知专员
   */
  public async doTransferToHuman(
    sessionId: string,
    reason: string,
    transferredBy: TransferSource,
    lead: Lead | null,
    customMessage?: string,
  ): Promise<void> {
    // 幂等保护：会话已转人工时跳过（底层全齐自动转 + AI 话术信号可能先后触发）
    const currentSessionRows = await this.db
      .select({ mode: chatSessions.mode, leadId: chatSessions.leadId })
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);
    if (currentSessionRows.length > 0 && currentSessionRows[0].mode === 'human') {
      this.logger.log(`会话 ${sessionId} 已处于人工模式，跳过重复转人工: ${reason}`);
      return;
    }

    let effectiveLead = lead;
    let assignedToAgent = false;

    if (lead) {
      try {
        const assignedAgentId = await this.agentDispatchService.assignLead(lead.id, `转人工:${reason}`);
        if (assignedAgentId) {
          effectiveLead = { ...lead, assigneeId: assignedAgentId };
          assignedToAgent = true;
          this.logger.log(`线索 ${lead.id} 转人工派单: ${assignedAgentId}`);
          if (transferredBy === 'customer') {
            await this.db
              .update(leads)
              .set({ originalAgentId: assignedAgentId })
              .where(eq(leads.id, lead.id));
            this.logger.log(`线索 ${lead.id} 客户主动转接，原经纪人更新为 ${assignedAgentId}`);
          }
        } else {
          this.logger.log(`线索 ${lead.id} 转人工但无客服在线，进入待分配`);
        }
      } catch (error) {
        this.logger.error(
          `转人工派单失败，沿用原分配: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 取消待追踪的模板使用（转人工 = 模板回答未被接受）
    await this.replyLearningService.cancelPendingUsage(sessionId);

    // 转人工前强制触发一次 AI 全量提取，确保需求数据完整：
    // 转人工后顾问看到的需求信息越全，沟通效率越高。
    // skipAutoTransfer=true：当前正处于转人工流程中，避免提取完成后再次触发自动转人工造成递归。
    // 提取失败不阻塞转人工。
    const transferLeadId: string | null =
      lead?.id ?? currentSessionRows[0]?.leadId ?? null;
    if (transferLeadId) {
      try {
        await this.chatRequirementsService.extractAndSaveRequirements(
          transferLeadId,
          sessionId,
          true,
        );
      } catch (err) {
        this.logger.warn(
          `转人工前AI提取失败（不阻塞转人工）: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 关键：无论是否分配到客服，都要切到 mode='human'
    // 否则客服的"我的会话"列表（按 mode='human' 过滤）永远看不到这条会话
    // 同时设置 endedAt 标记 AI 阶段结束，用于计算平均聊天时长等效率指标
    await this.db
      .update(chatSessions)
      .set({ mode: 'human', transferReason: reason, transferredBy, endedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(chatSessions.id, sessionId));

    if (assignedToAgent) {
      await this.db.insert(chatMessages).values({
        sessionId,
        role: 'bot',
        content: customMessage ?? TRANSFER_MESSAGE,
      });

      try {
        await this.notifyService.notifyTransferToAgent(sessionId, reason, transferredBy, effectiveLead);
      } catch (error) {
        this.logger.error(
          `转人工通知失败: ${JSON.stringify(error)}`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    } else {
      // 无客服在线：已切 mode='human'（上方 update），同时 selectAndAssign
      // 已经把 A/B 级线索放进 pending_assignment 队列（30s 缓冲）；
      // 客服上线时由 retryPendingAssignmentsForAgent 抢单分配。
      // 这里只补一条提示消息给客户。
      await this.db.insert(chatMessages).values({
        sessionId,
        role: 'bot',
        content: customMessage ?? NO_AGENT_ONLINE_MESSAGE,
      });
    }

    // SSE：转人工后给 assignee（或全池）推 session.updated，列表立即出现
    try {
      const finalSessionRows = await this.db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .limit(1);
      if (finalSessionRows.length > 0) {
        const event = {
          type: 'session.updated' as const,
          session: this.chatSessionService.mapSession(finalSessionRows[0]),
        };
        if (effectiveLead?.assigneeId) {
          this.chatEventBus.emitToUser(effectiveLead.assigneeId, event);
        } else {
          this.chatEventBus.emitToAll(event);
        }
      }
    } catch (err) {
      this.logger.warn(`SSE emit doTransferToHuman 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (effectiveLead) {
      this.leadGradingService.recomputeGrade(effectiveLead.id).catch((err: unknown) => {
        this.logger.warn(
          `转人工后分级重算失败: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }



  /**
   * 获取转接摘要（含权限校验）
   */
  async getHandoffSummaryWithAuth(sessionId: string, userId: string, all = false): Promise<HandoffSummary> {
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
        throw new ForbiddenException('无权查看此会话');
      }
    }

    return this.getHandoffSummary(sessionId);
  }

  /**
   * 获取转接摘要（客户画像 + 需求 + 转接信息）
   */
  async getHandoffSummary(sessionId: string): Promise<HandoffSummary> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    const lead = leadRows.length > 0 ? this.chatSessionService.mapLead(leadRows[0]) : null;
    const requirement = await this.chatRequirementsService.getRequirementByLeadId(session.leadId);

    const msgCountResult = await this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId));

    const customerMsgCountResult = await this.db
      .select({ value: count() })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.sessionId, sessionId),
          eq(chatMessages.role, 'customer'),
        ),
      );

    return {
      customerName: lead?.customerName ?? null,
      phoneNumber: lead?.phoneNumber ?? '',
      serviceCity: sanitizeCity(lead?.serviceCity ?? ''),
      source: normalizeSource(lead?.source ?? 'unknown') as LeadSource,
      leadStatus: lead?.status ?? 'new',
      intent: lead?.intent ?? null,
      routingReason: lead?.routingReason ?? null,
      transferReason: session.transferReason ?? null,
      transferredBy: (session.transferredBy ?? null) as TransferSource | null,
      requirements: requirement,
      messageCount: Number(msgCountResult[0]?.value ?? 0),
      customerMessageCount: Number(customerMsgCountResult[0]?.value ?? 0),
      sessionStartedAt: session.startedAt.toISOString(),
    };
  }


}
