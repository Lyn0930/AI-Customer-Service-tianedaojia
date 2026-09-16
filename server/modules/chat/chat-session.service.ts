import { Injectable, Logger, NotFoundException, ForbiddenException, forwardRef, Inject } from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase, CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import { eq, desc, and, count, gt, inArray, isNull } from 'drizzle-orm';
import { leads, chatSessions, chatMessages, requirements } from '@server/database/schema';
import { NotifyService } from '../notify/notify.service';
import { ChatEventBus } from './chat-event-bus.service';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { LeadGradingService } from '../leads/lead-grading.service';
import { ChatRequirementsService } from './chat-requirements.service';
import { normalizeServiceType, normalizeServiceSubType, chineseServiceType, getServiceTypeLabel, getTemplate, OPENING_MESSAGES, DEFAULT_OPENING_MESSAGE } from '../automation/requirement-templates';
import { normalizeStream } from './stream-utils';
import { normalizeSource, sanitizeCity, normalizeLead } from '@shared/channels';
import {
  SWAN_PERSONA,
  MAX_HISTORY_MESSAGES,
  OPENING_MESSAGES_BY_SERVICE,
} from './chat.prompt';
import type {
  ChatSession,
  ChatMessage,
  ChatSessionListItem,
  ChatSessionListResponse,
  ChatSessionDetail,
  CustomerChatInfo,
  CustomerPollResult,
  Lead,
  LeadSource,
  Requirement,
  ChatSessionMode,
  ChatSessionStatus,
  TransferSource,
  RequirementStatus,
} from '@shared/api.interface';

function inferUrgencyLevel(startTime: string | null): string {
  if (!startTime) return 'low';
  const date = new Date(startTime);
  if (isNaN(date.getTime())) return 'low';
  const diffDays = (date.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  if (diffDays <= 7) return 'high';
  if (diffDays <= 30) return 'medium';
  return 'low';
}

@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly capabilityService: CapabilityService,
    private readonly notifyService: NotifyService,
    private readonly chatEventBus: ChatEventBus,
    private readonly agentDispatchService: AgentDispatchService,
    @Inject(forwardRef(() => LeadGradingService))
    private readonly leadGradingService: LeadGradingService,
    @Inject(forwardRef(() => ChatRequirementsService))
    private readonly chatRequirementsService: ChatRequirementsService,
  ) {}


  /**
   * 运营端 - 会话列表
   */
  async getSessionList(params: {
    status?: string;
    page?: number;
    pageSize?: number;
    userId: string;
    all?: boolean;
  }): Promise<ChatSessionListResponse> {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize =
      params.pageSize && params.pageSize > 0 ? params.pageSize : 10;
    const offset = (page - 1) * pageSize;

    // 构建查询条件
    const conditions = [];

    if (!params.all) {
      // 客服模式：查当前客服负责的线索 + 未分配但处于人工模式的会话
      const userLeads = await this.db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.assigneeId, params.userId));

      const userLeadIds = userLeads.map((l) => l.id);

      // 未分配且有人工模式活跃会话的线索（转人工后无人接入的会话）
      const unassignedHumanLeads = await this.db
        .select({ leadId: chatSessions.leadId })
        .from(chatSessions)
        .innerJoin(leads, eq(leads.id, chatSessions.leadId))
        .where(
          and(
            isNull(leads.assigneeId),
            eq(chatSessions.mode, 'human'),
            eq(chatSessions.status, 'active'),
          ),
        );

      const allLeadIds = [
        ...userLeadIds,
        ...unassignedHumanLeads.map((s) => s.leadId),
      ];

      if (allLeadIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }

      conditions.push(inArray(chatSessions.leadId, allLeadIds));
    }
    if (params.status) {
      conditions.push(eq(chatSessions.status, params.status));
    }
    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const sessions = await this.db
      .select()
      .from(chatSessions)
      .where(whereClause)
      .orderBy(desc(chatSessions.updatedAt))
      .limit(pageSize)
      .offset(offset);

    const totalResult = await this.db
      .select({ value: count() })
      .from(chatSessions)
      .where(whereClause);
    const total = Number(totalResult[0]?.value ?? 0);

    if (sessions.length === 0) {
      return { items: [], total, page, pageSize };
    }

    // 批量查 lead
    const sessionLeadIds = sessions.map((s) => s.leadId);
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(inArray(leads.id, sessionLeadIds));
    const leadMap = new Map<string, Lead>();
    for (const l of leadRows) {
      leadMap.set(l.id, this.mapLead(l));
    }

    // 批量查 lastMessage：取每个 session 最新一条消息
    const sessionIds = sessions.map((s) => s.id);
    const allMessages = await this.db
      .select()
      .from(chatMessages)
      .where(inArray(chatMessages.sessionId, sessionIds))
      .orderBy(desc(chatMessages.createdAt));

    const lastMessageMap = new Map<string, ChatMessage>();
    const messageCountMap = new Map<string, number>();
    for (const m of allMessages) {
      const mapped = this.mapMessage(m);
      if (!lastMessageMap.has(m.sessionId)) {
        lastMessageMap.set(m.sessionId, mapped);
      }
      messageCountMap.set(
        m.sessionId,
        (messageCountMap.get(m.sessionId) ?? 0) + 1,
      );
    }

    const items: ChatSessionListItem[] = sessions.map((s) => {
      const lastMessage = lastMessageMap.get(s.id);
      // 未读 = 最新一条消息是客户发的（agent 还没回）
      // 用于工作台列表显示"待回复"红点
      const unread = Boolean(lastMessage && lastMessage.role === 'customer');
      return {
        ...this.mapSession(s),
        lead: leadMap.get(s.leadId),
        lastMessage,
        messageCount: messageCountMap.get(s.id) ?? 0,
        unread,
      };
    });

    return { items, total, page, pageSize };
  }



  /**
   * 运营端 - 会话详情
   */
  async getSessionDetail(sessionId: string, userId: string, all = false): Promise<ChatSessionDetail> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    const messageRows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, sessionId))
      .orderBy(chatMessages.createdAt);

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    if (
      !all &&
      leadRows.length > 0 &&
      leadRows[0].assigneeId !== userId &&
      !(leadRows[0].assigneeId === null && session.mode === 'human')
    ) {
      throw new ForbiddenException('无权查看此会话');
    }

    const requirementRows = session.leadId
      ? await this.chatRequirementsService.getRequirementByLeadId(session.leadId)
      : null;

    return {
      ...this.mapSession(session),
      messages: messageRows.map((m) => this.mapMessage(m)),
      lead: leadRows.length > 0 ? this.mapLead(leadRows[0]) : undefined,
      requirement: requirementRows,
    };
  }



  /**
   * 客户端 - 通过 chatToken 获取或创建会话
   */
  async getOrCreateSessionByToken(token: string): Promise<CustomerChatInfo> {
    // 查找 lead by chatToken
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.chatToken, token))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException('无效的访问链接');
    }

    const lead = leadRows[0];

    // 查找是否已有 active 会话
    const existingSessions = await this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.leadId, lead.id),
          eq(chatSessions.status, 'active'),
        ),
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    let session: typeof chatSessions.$inferSelect;
    let isNewSession = false;

    if (existingSessions.length > 0) {
      session = existingSessions[0];
    } else {
      // 创建新会话
      isNewSession = true;
      const created = await this.db
        .insert(chatSessions)
        .values({
          leadId: lead.id,
          status: 'active',
        })
        .returning();
      session = created[0];
    }

    // 查询消息
    const messageRows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, session.id))
      .orderBy(chatMessages.createdAt);

    // 新会话发送开场白
    // 2026-08-24 林琳 C 版本：开场白 = 复述需求（城市·服务类型）+ 引导填表
    //   - 服务类型已确认 → 立即推 form_card，intro 用 C 版本（短、直接、引导填表）
    //   - 服务类型未确认 → 用旧版 intro + followUp
    if (isNewSession) {
      const existingReq = await this.chatRequirementsService.getRequirementByLeadId(lead.id);

      // 先判断是否要推 form_card（服务类型已确认）
      // 优先级：requirements.serviceType > leads.serviceType（Drizzle ORM，列已存在）
      const leadServiceType: string | null = lead.serviceType ?? null;
      const rawServiceType = existingReq?.serviceType || leadServiceType || null;
      const willPushFormCard = !!rawServiceType;

      let opening: { intro: string; followUp: string | null };
      if (willPushFormCard) {
        // C 版本开场白：复述需求 + 引导填表（短、直接）
        const serviceTypeLabel = getServiceTypeLabel(rawServiceType!);
        const city = lead.serviceCity || '';
        const cityPart = city ? `${city}·` : '';
        opening = {
          intro: `您好，我是天鹅到家家政顾问小书。已收到您的需求：${cityPart}${serviceTypeLabel}。为了更快帮您匹配合适的阿姨，请先填写一下基本信息～`,
          followUp: null, // form_card 替代 followUp
        };
      } else {
        // 服务类型未确认：走旧版逻辑
        opening = await this.buildOpeningMessage(lead, existingReq);
      }

      // 1) 立即发送 intro
      const introMsg = await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: opening.intro,
      }).returning();
      const introMapped = this.mapMessage(introMsg[0]);

      // 1.5) 服务类型已确认 → 立即推送 form_card（表单 + 对话混合采集）
      if (willPushFormCard) {
        // 确保 requirements 记录存在，否则表单提交 UPDATE 会 404
        const serviceTypeLabel = getServiceTypeLabel(rawServiceType!);
        await this.chatRequirementsService.upsertServiceType(lead.id, serviceTypeLabel);
        const formCardContent = JSON.stringify({
          type: 'form_card',
          serviceType: serviceTypeLabel,
          formName: 'live_in_nanny_demand',
        });
        await this.db.insert(chatMessages).values({
          sessionId: session.id,
          role: 'bot',
          content: formCardContent,
        });
        this.logger.log(
          `[开场白] 推送 form_card: lead=${lead.id} serviceType=${serviceTypeLabel}`,
        );
      }

      // 2) 延迟 800ms 发送 followUp（如果有）
      // 用 setTimeout 而非 await setTimeout：不能让 intro 入库后等 800ms 才返回
      // 注意：form_card 模式下 followUp = null，不会走这里
      if (opening.followUp) {
        setTimeout(async () => {
          try {
            const followUpMsg = await this.db.insert(chatMessages).values({
              sessionId: session.id,
              role: 'bot',
              content: opening.followUp!,
            }).returning();
            const followUpMapped = this.mapMessage(followUpMsg[0]);
            // 推 SSE 让前端实时看到 followUp
            if (lead.assigneeId) {
              this.chatEventBus.emitToUser(lead.assigneeId, {
                type: 'message.created' as const,
                sessionId: session.id,
                message: followUpMapped,
              });
            }
            this.logger.log(
              `开场白 followUp 延迟 800ms 发送: lead=${lead.id} serviceType=${existingReq?.serviceType ?? 'unknown'}`,
            );
          } catch (err) {
            this.logger.error(
              `开场白 followUp 发送失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }, 800);
      }

      // 重新查询消息（含开场白 intro）
      const messagesWithOpening = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, session.id))
        .orderBy(chatMessages.createdAt);

      return {
        session: this.mapSession(session),
        messages: messagesWithOpening.map((m) => this.mapMessage(m)),
      };
    }

    return {
      session: this.mapSession(session),
      messages: messageRows.map((m) => this.mapMessage(m)),
    };
  }



  /**
   * 客户端 - 获取消息列表（支持 afterId 轮询），同时返回会话状态
   */
  async getMessagesByToken(
    token: string,
    afterId?: string,
  ): Promise<CustomerPollResult> {
    const sessionInfo = await this.findSessionByToken(token);
    if (!sessionInfo) {
      throw new NotFoundException('无效的访问链接或无活跃会话');
    }

    let messageRows;
    if (afterId) {
      const afterMessage = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.id, afterId))
        .limit(1);

      if (afterMessage.length === 0) {
        messageRows = await this.db
          .select()
          .from(chatMessages)
          .where(eq(chatMessages.sessionId, sessionInfo.id))
          .orderBy(chatMessages.createdAt);
      } else {
        const afterCreatedAt = afterMessage[0].createdAt;
        messageRows = await this.db
          .select()
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.sessionId, sessionInfo.id),
              gt(chatMessages.createdAt, afterCreatedAt),
            ),
          )
          .orderBy(chatMessages.createdAt);
      }
    } else {
      messageRows = await this.db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.sessionId, sessionInfo.id))
        .orderBy(chatMessages.createdAt);
    }

    return {
      messages: messageRows.map((m) => this.mapMessage(m)),
      mode: sessionInfo.mode as ChatSessionMode,
      status: sessionInfo.status as ChatSessionStatus,
    };
  }





  /**
   * 构建开场白：3 级优先级（2026-08-27 移除数据库配置层与渠道表单短开场白层）
   *
   * 优先级：
   *   1. 源码 OPENING_MESSAGES_BY_SERVICE（按 rawServiceType，6 段）
   *   2. 源码 OPENING_MESSAGES（按 normalizeServiceType，5 段 baomu/yuesao/yanglao/yuer/baojie）
   *   3. 动态拼接（基于 serviceCity + serviceType 复述表单信息）
   *
   * 月嫂（26day_yuesao / yuesao）由第 1/2 级模板覆盖。
   * 老客回归检测、数据库配置层、渠道表单短开场白层已于 2026-08-27 移除。
   */
  public async buildOpeningMessage(
    lead: typeof leads.$inferSelect,
    existingReq: { serviceType?: string | null } | null,
  ): Promise<{ intro: string; followUp: string | null }> {
    const rawServiceType = existingReq?.serviceType ?? null;
    const displayServiceType = rawServiceType
      ? ({
          zhujia: '住家保姆', baiban: '白班保姆', yuer: '育儿保姆',
          '住家': '住家保姆', '白班': '白班保姆', '育儿': '育儿保姆',
          zhongdian: '钟点工保姆', '钟点': '钟点工保姆', '钟点工': '钟点工保姆',
          feishi: '菲式保姆', '菲式': '菲式保姆', '菲佣': '菲式保姆',
          '26day_yuesao': '26天月嫂', '月嫂': '26天月嫂',
          yanglao: '护工保姆', '养老': '护工保姆', '护工': '护工保姆',
          baojie: '保洁', '保洁': '保洁',
        } as Record<string, string>)[rawServiceType] ?? getServiceTypeLabel(rawServiceType)
      : null;

    // 1) chat.prompt.ts 的 6 段按 serviceType 模板（含月嫂兜底）
    // rawServiceType 可能是中文（form 留资 cnServiceType 写库, since 160cbc6）也可能是 pinyin
    // 统一转 pinyin 再查 OPENING_MESSAGES_BY_SERVICE（key = zhongdian/baiban/zhujia/yuer/yanglao/feishi/26day_yuesao）
    const pinyinServiceType = rawServiceType ? normalizeServiceSubType(rawServiceType) : null;
    if (pinyinServiceType && OPENING_MESSAGES_BY_SERVICE[pinyinServiceType]) {
      return OPENING_MESSAGES_BY_SERVICE[pinyinServiceType];
    }

    // 2) requirement-templates.ts 的 5 段按 normalizeServiceType 模板（单条消息）
    const normalizedKey = normalizeServiceType(rawServiceType);
    if (normalizedKey && normalizedKey !== 'default' && OPENING_MESSAGES[normalizedKey]) {
      return { intro: OPENING_MESSAGES[normalizedKey], followUp: null };
    }

    // 3) 兜底：复述表单已有信息 + 抛出关键疑问让客户回应
    const parts: string[] = [
      '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～',
      '',
    ];

    if (displayServiceType) {
      // 已有服务类型：复述 + 抛出关键疑问
      parts.push(
        `收到您的需求啦～您选择的是【${displayServiceType}】，具体价格会根据您所在的城市调整，【客服后续会给准确报价】。\n\n请问您家里几口人？主要想阿姨负责哪些事呢？`,
      );
    } else {
      // 没有服务类型：先问服务类型
      parts.push('请问您需要哪种【服务类型】呢？咱们这边有钟点工保姆、白班保姆、住家保姆、育儿保姆、护工保姆、菲式保姆等可选～');
    }

    return { intro: parts.join('\n'), followUp: null };
  }



  /**
   * 通过 token 获取或创建会话 + lead 信息
   */
  public async getOrCreateSessionAndLead(
    token: string,
  ): Promise<{ session: ChatSession; lead: Lead }> {
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.chatToken, token))
      .limit(1);

    if (leadRows.length === 0) {
      throw new NotFoundException('无效的访问链接');
    }
    const lead = this.mapLead(leadRows[0]);

    // 查找活跃会话
    const existingSessions = await this.db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.leadId, lead.id),
          eq(chatSessions.status, 'active'),
        ),
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    let session: ChatSession;
    if (existingSessions.length > 0) {
      session = this.mapSession(existingSessions[0]);
    } else {
      // 创建新会话 + 开场白
      // 2026-08-16 林琳 17:26 重构：开场白 = intro + 延迟 800ms 发送 followUp
      const created = await this.db
        .insert(chatSessions)
        .values({ leadId: lead.id, status: 'active' })
        .returning();
      session = this.mapSession(created[0]);

      const existingReq = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
      const opening = await this.buildOpeningMessage(leadRows[0], existingReq);
      await this.db.insert(chatMessages).values({
        sessionId: session.id,
        role: 'bot',
        content: opening.intro,
      });
      if (opening.followUp) {
        setTimeout(async () => {
          try {
            const followUpMsg = await this.db.insert(chatMessages).values({
              sessionId: session.id,
              role: 'bot',
              content: opening.followUp!,
            }).returning();
            const followUpMapped = this.mapMessage(followUpMsg[0]);
            if (lead.assigneeId) {
              this.chatEventBus.emitToUser(lead.assigneeId, {
                type: 'message.created' as const,
                sessionId: session.id,
                message: followUpMapped,
              });
            }
          } catch (err) {
            this.logger.error(
              `开场白 followUp 发送失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }, 800);
      }
    }

    return { session, lead };
  }



  /**
   * 通过 token 找到活跃会话（不创建）
   */
  public async findSessionByToken(
    token: string,
  ): Promise<{ id: string; mode: string; status: string } | null> {
    const leadRows = await this.db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.chatToken, token))
      .limit(1);

    if (leadRows.length === 0) return null;

    const sessionRows = await this.db
      .select({ id: chatSessions.id, mode: chatSessions.mode, status: chatSessions.status })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.leadId, leadRows[0].id),
          eq(chatSessions.status, 'active'),
        ),
      )
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);

    if (sessionRows.length === 0) return null;
    return sessionRows[0];
  }



  /**
   * 会话转线索：从聊天上下文创建新线索（channel=chat）
   * 当 AI 识别到服务意图且获取到手机号时调用
   */
  async createLeadFromChat(params: {
    phoneNumber: string;
    serviceCity?: string;
    customerName?: string;
    serviceType?: string;
  }): Promise<{ session: ChatSession; lead: Lead }> {
    const normalized = normalizeLead({
      channel: 'chat',
      phoneNumber: params.phoneNumber,
      serviceCity: params.serviceCity ?? '',
      customerName: params.customerName,
      source: '在线咨询',
      serviceType: params.serviceType,
    });
    const serviceType = normalized.serviceType;

    const [row] = await this.db
      .insert(leads)
      .values({
        serviceCity: normalized.serviceCity,
        phoneNumber: normalized.phoneNumber,
        customerName: normalized.customerName,
        source: normalized.source,
        phoneVerified: normalized.phoneVerified,
        channel: normalized.channel,
      })
      .returning();

    if (serviceType) {
      await this.db.insert(requirements).values({
        leadId: row.id,
        serviceType,
        status: 'collecting',
      });
    }

    try {
      await this.agentDispatchService.assignLeadIfEligible(row.id, '会话转线索派单');
    } catch (error) {
      this.logger.error(
        `会话转线索派单失败: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }

    const [updated] = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, row.id))
      .limit(1);

    const lead = this.mapLead(updated);

    const created = await this.db
      .insert(chatSessions)
      .values({ leadId: lead.id, status: 'active' })
      .returning();
    const session = this.mapSession(created[0]);

    const existingReq = await this.chatRequirementsService.getRequirementByLeadId(lead.id);
    // 2026-08-16 林琳 17:26 重构：开场白 = intro + 延迟 800ms 发送 followUp
    const opening = await this.buildOpeningMessage(updated, existingReq);
    await this.db.insert(chatMessages).values({
      sessionId: session.id,
      role: 'bot',
      content: opening.intro,
    });
    if (opening.followUp) {
      setTimeout(async () => {
        try {
          const followUpMsg = await this.db.insert(chatMessages).values({
            sessionId: session.id,
            role: 'bot',
            content: opening.followUp!,
          }).returning();
          const followUpMapped = this.mapMessage(followUpMsg[0]);
          if (lead.assigneeId) {
            this.chatEventBus.emitToUser(lead.assigneeId, {
              type: 'message.created' as const,
              sessionId: session.id,
              message: followUpMapped,
            });
          }
        } catch (err) {
          this.logger.error(
            `开场白 followUp 发送失败: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }, 800);
    }

    return { session, lead };
  }



  /**
   * 运营端 - 客服接管会话（AI → 人工）
   * 兼做「claim」动作：未分配且 human 模式的会话，第一个点接管的客服把它认领走
   */
  async takeoverSession(sessionId: string, userId: string): Promise<ChatSession> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    // 校验归属 / claim
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    if (leadRows.length > 0) {
      const lead = leadRows[0];
      if (lead.assigneeId !== null && lead.assigneeId !== userId) {
        throw new ForbiddenException('无权操作此会话');
      }
      // claim：会话是 unassigned + human 模式时，第一个接管的客服把它认领掉
      if (lead.assigneeId === null && session.mode === 'human') {
        await this.db
          .update(leads)
          .set({ assigneeId: userId })
          .where(and(eq(leads.id, lead.id), isNull(leads.assigneeId)));
        this.logger.log(`客服 ${userId} 认领会话 ${sessionId}（lead ${lead.id}）`);
      }
    }

    const [updated] = await this.db
      .update(chatSessions)
      .set({ mode: 'human' })
      .where(eq(chatSessions.id, sessionId))
      .returning();

    await this.db.insert(chatMessages).values({
      sessionId,
      role: 'bot',
      content: '客服已接入，专员正在为您服务~',
    });

    this.logger.log(`客服 ${userId} 接管会话 ${sessionId}`);

    // SSE：推 session.updated 给接管者（让其它 tab 实时看到 mode 切换 + 接管成功）
    try {
      this.chatEventBus.emitToUser(userId, {
        type: 'session.updated',
        session: this.mapSession(updated),
      });
    } catch (err) {
      this.logger.warn(`SSE emit takeoverSession 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapSession(updated);
  }

  /**
   * 运营端 - 释放会话回 AI（人工 → AI）
   */
  async releaseSession(sessionId: string, userId: string): Promise<ChatSession> {
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

    if (leadRows.length > 0 && leadRows[0].assigneeId !== userId) {
      throw new ForbiddenException('无权操作此会话');
    }

    const [updated] = await this.db
      .update(chatSessions)
      .set({ mode: 'ai' })
      .where(eq(chatSessions.id, sessionId))
      .returning();

    await this.db.insert(chatMessages).values({
      sessionId,
      role: 'bot',
      content: '客服已退出，小书继续为您服务~',
    });

    this.logger.log(`客服 ${userId} 释放会话 ${sessionId} 回 AI`);

    // SSE：推 session.updated 给释放者
    try {
      this.chatEventBus.emitToUser(userId, {
        type: 'session.updated',
        session: this.mapSession(updated),
      });
    } catch (err) {
      this.logger.warn(`SSE emit releaseSession 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapSession(updated);
  }

  /**
   * 运营端 - 客服手动转接给其他在线经纪人
   */
  async reassignSession(
    sessionId: string,
    targetAgentId: string,
    userId: string,
  ): Promise<ChatSession> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, sessionRows[0].leadId))
      .limit(1);

    if (leadRows.length === 0 || leadRows[0].assigneeId !== userId) {
      throw new ForbiddenException('仅当前负责人可转接会话');
    }

    await this.agentDispatchService.manualReassign(leadRows[0].id, targetAgentId);

    const [updated] = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    this.logger.log(
      `客服 ${userId} 手动转接会话 ${sessionId} 给经纪人 ${targetAgentId}`,
    );

    try {
      this.chatEventBus.emitToUser(targetAgentId, {
        type: 'session.updated',
        session: this.mapSession(updated),
      });
    } catch (err) {
      this.logger.warn(`SSE emit reassignSession 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapSession(updated);
  }

  /**
   * 运营端 - 客服发送消息
   */
  async sendAgentMessage(sessionId: string, content: string, userId: string): Promise<ChatMessage> {
    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.id, sessionId))
      .limit(1);

    if (sessionRows.length === 0) {
      throw new NotFoundException('会话不存在');
    }

    const session = sessionRows[0];

    // 校验归属 / claim
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, session.leadId))
      .limit(1);

    if (leadRows.length > 0) {
      const lead = leadRows[0];
      if (lead.assigneeId !== null && lead.assigneeId !== userId) {
        throw new ForbiddenException('无权操作此会话');
      }
      // 防御性 claim：万一 UI 跳过接管直接发，human 模式 + 未分配就认领
      if (lead.assigneeId === null && session.mode === 'human') {
        await this.db
          .update(leads)
          .set({ assigneeId: userId })
          .where(and(eq(leads.id, lead.id), isNull(leads.assigneeId)));
        this.logger.log(`客服 ${userId} 发送时认领会话 ${sessionId}（lead ${lead.id}）`);
      }
    }

    const [msg] = await this.db
      .insert(chatMessages)
      .values({
        sessionId,
        role: 'agent',
        content,
      })
      .returning();

    this.logger.log(`客服 ${userId} 在会话 ${sessionId} 中发送消息`);

    // SSE：推 message.created 给该 agent（跨 tab 同步自己发的消息）
    try {
      this.chatEventBus.emitToUser(userId, {
        type: 'message.created',
        sessionId,
        message: this.mapMessage(msg),
      });
    } catch (err) {
      this.logger.warn(`SSE emit sendAgentMessage 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    return this.mapMessage(msg);


  }
  public mapLead(row: typeof leads.$inferSelect): Lead {
    return {
      id: row.id,
      serviceCity: sanitizeCity(row.serviceCity),
      phoneNumber: row.phoneNumber,
      customerName: row.customerName,
      source: normalizeSource(row.source) as Lead['source'],
      status: row.status as Lead['status'],
      chatToken: row.chatToken,
      assigneeId: row.assigneeId,
      bitableRecordId: row.bitableRecordId,
      assignedAt: row.assignedAt ? row.assignedAt.toISOString() : null,
      lastFollowedUpAt: row.lastFollowedUpAt ? row.lastFollowedUpAt.toISOString() : null,
      intent: row.intent,
      routingReason: row.routingReason,
      leadGrade: row.leadGrade,
      leadScore: row.leadScore ? Number(row.leadScore) : null,
      gradeReason: row.gradeReason,
      gradeConfidence: row.gradeConfidence ? Number(row.gradeConfidence) : null,
      budgetRange: row.budgetRange,
      serviceStartTime: row.serviceStartTime,
      serviceDuration: row.serviceDuration,
      specialRequirements: row.specialRequirements,
      familyInfo: row.familyInfo,
      urgencyLevel: row.urgencyLevel,
      phoneVerified: row.phoneVerified,
      leadSourceDetail: row.leadSourceDetail,
      channel: row.channel as Lead['channel'],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };


  }
  public mapSession(row: typeof chatSessions.$inferSelect): ChatSession {
    return {
      id: row.id,
      leadId: row.leadId,
      status: row.status as ChatSession['status'],
      mode: (row.mode ?? 'ai') as ChatSessionMode,
      transferReason: row.transferReason ?? null,
      transferredBy: (row.transferredBy ?? null) as TransferSource | null,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };


  }
  public mapMessage(row: typeof chatMessages.$inferSelect): ChatMessage {
    const content = row.content;
    if (content.startsWith('{"type":"form_card"')) {
      try {
        const parsed = JSON.parse(content) as {
          type: string;
          serviceType: string;
          formName: string;
        };
        if (parsed.type === 'form_card') {
          return {
            id: row.id,
            sessionId: row.sessionId,
            role: row.role as ChatMessage['role'],
            content: '',
            type: 'form_card',
            formCard: {
              serviceType: parsed.serviceType,
              formName: parsed.formName,
            },
            createdAt: row.createdAt.toISOString(),
          };
        }
      } catch {
        // JSON 解析失败，按普通文本处理
      }
    }
    return {
      id: row.id,
      sessionId: row.sessionId,
      role: row.role as ChatMessage['role'],
      content: row.content,
      type: 'text',
      createdAt: row.createdAt.toISOString(),
    };
  }
  public mapRequirement(
    row: typeof requirements.$inferSelect,
  ): Requirement {
    return {
      id: row.id,
      leadId: row.leadId,
      serviceType: row.serviceType,
      householdSize: row.householdSize,
      area: row.area,
      elderlyCare: row.elderlyCare,
      restDays: row.restDays,
      startTime: row.startTime,
      serviceAddress: row.serviceAddress,
      helperRequirements: row.helperRequirements,
      dietaryPreferences: row.dietaryPreferences,
      budget: row.budget,
      specialRequirements: row.specialRequirements,
      serviceItems: row.serviceItems,
      serviceHours: row.serviceHours,
      hasPet: row.hasPet,
      source: row.source,
      cardSubmittedAt: row.cardSubmittedAt,
      childCare: row.childCare,
      aiSummary: row.aiSummary,
      status: row.status as RequirementStatus,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ============================================================
  // 2026-08-15 客服新线索分配通知（接通 notify service + 实时推送）
  // 由 routing.service.ts 在 retryPendingAssignmentsForAgent 抢单成功后调用


  /**
   * 客服新线索分配：飞书 IM 卡片 + SSE 实时推送 + 列表角标
   * @param assigneeId 客服 userId
   * @param lead 已分配的 lead（必含 chatSession，便于 SSE event 携带）
   */
  async notifyAgentOfNewAssignment(
    assigneeId: string,
    leadId: string,
  ): Promise<void> {
    // 1. 取 lead 详情 + session
    const leadRows = await this.db
      .select()
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (leadRows.length === 0) {
      this.logger.warn(`notifyAgentOfNewAssignment: lead=${leadId} 不存在`);
      return;
    }
    const lead = this.mapLead(leadRows[0]);

    const sessionRows = await this.db
      .select()
      .from(chatSessions)
      .where(eq(chatSessions.leadId, leadId))
      .orderBy(desc(chatSessions.createdAt))
      .limit(1);
    if (sessionRows.length === 0) {
      this.logger.warn(`notifyAgentOfNewAssignment: lead=${leadId} 没有 session`);
      return;
    }
    const session = this.mapSession(sessionRows[0]);

    // 2. 飞书 IM 通知（不发到运营群，直接发到客服个人 userId）
    await this.notifyService
      .notifyAgentNewLead(assigneeId, lead, session)
      .catch((err) =>
        this.logger.warn(
          `notifyAgentNewLead 失败 agent=${assigneeId} lead=${leadId}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );

    // 3. SSE 实时推送（客服工作台列表自动刷新 + 弹 toast）
    this.chatEventBus.emitToUser(assigneeId, {
      type: 'session.created',
      session,
    });
    this.logger.log(
      `notifyAgentOfNewAssignment: agent=${assigneeId} lead=${leadId} IM 通知 + SSE 推送已发`,
    );
  }

}
