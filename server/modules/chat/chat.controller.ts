import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  BadRequestException,
  Sse,
} from '@nestjs/common';
import { Observable, finalize } from 'rxjs';
import { map } from 'rxjs/operators';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { ChatService } from './chat.service';
import { ChatEventBus } from './chat-event-bus.service';
import { ChatRequirementsService } from './chat-requirements.service';
import type {
  ChatSessionListResponse,
  ChatSessionDetail,
  CustomerChatInfo,
  CustomerPollResult,
  ChatMessage,
  ChatSession,
  SendMessageRequest,
  ReassignSessionRequest,
  TransferRequest,
  ReplySuggestion,
  HandoffSummary,
  CollectionProgress,
  FormSubmitRequest,
  FormSubmitResponse,
} from '@shared/api.interface';

/**
 * 运营端 - 会话管理
 */
@Controller('api/chat')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly chatEventBus: ChatEventBus,
    private readonly chatRequirementsService: ChatRequirementsService,
  ) {}

  @Get('sessions')
  async getSessions(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('all') all?: string,
  ): Promise<ChatSessionListResponse> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.getSessionList({
      status,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      userId,
      all: all === 'true',
    });
  }

  @Get('sessions/:id')
  async getSessionDetail(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('all') all?: string,
  ): Promise<ChatSessionDetail> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.getSessionDetail(id, userId, all === 'true');
  }

  /**
   * SSE 实时事件流
   * - 客户端：new EventSource('/api/chat/events')
   * - 浏览器自动重连，无需前端额外处理
   * - 服务端 25s 心跳防代理/网关闲置切断
   * - 仅推送与该 userId 相关的会话事件 + 池子里未分配的人工会话
   */
  @NeedLogin()
  @Sse('events')
  streamEvents(@Req() req: Request): Observable<MessageEvent> {
    const userId = (req as any).userContext?.userId as string;
    if (!userId) {
      throw new BadRequestException('未识别用户');
    }

    return this.chatEventBus.registerUser(userId).pipe(
      map(
        (event) =>
          ({
            data: JSON.stringify(event),
            type: event.type,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          }) as unknown as MessageEvent,
      ),
      finalize(() => {
        // 连接断开时清理订阅（浏览器断网/关 tab）
        this.chatEventBus.unregisterUser(userId);
      }),
    );
  }

  @NeedLogin()
  @Post('sessions/:id/takeover')
  async takeoverSession(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<ChatSession> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.takeoverSession(id, userId);
  }

  @NeedLogin()
  @Post('sessions/:id/reassign')
  async reassignSession(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: ReassignSessionRequest,
  ): Promise<ChatSession> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.reassignSession(id, body.targetAgentId, userId);
  }

  @NeedLogin()
  @Post('sessions/:id/release')
  async releaseSession(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<ChatSession> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.releaseSession(id, userId);
  }

  @NeedLogin()
  @Post('sessions/:id/messages')
  async sendAgentMessage(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { content: string },
  ): Promise<ChatMessage> {
    if (!body.content || !body.content.trim()) {
      throw new BadRequestException('消息内容不能为空');
    }
    const userId = (req as any).userContext?.userId;
    return this.chatService.sendAgentMessage(id, body.content.trim(), userId);
  }

  @NeedLogin()
  @Post('sessions/:id/suggestions')
  async getReplySuggestions(
    @Param('id') id: string,
  ): Promise<ReplySuggestion> {
    const suggestions = await this.chatService.generateReplySuggestions(id);
    return { suggestions };
  }

  @Get('sessions/:id/handoff-summary')
  async getHandoffSummary(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('all') all?: string,
  ): Promise<HandoffSummary> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.getHandoffSummaryWithAuth(id, userId, all === 'true');
  }

  @Get('sessions/:id/progress')
  async getCollectionProgress(
    @Param('id') id: string,
  ): Promise<CollectionProgress> {
    return this.chatService.getCollectionProgress(id);
  }

  /**
   * 生成需求确认卡片（结构化文本，客服发给客户用）
   * 2026-08-16 林琳 19:35 拍板：
   *   - 必填项齐就能生成（前端按 canSend 控制按钮 enabled）
   *   - 形态：结构化文本（每项一行"label：value"），客服可编辑后发送
   *
   * 返回：
   *   - canSend: 必填项是否全齐
   *   - text: 结构化文本（默认填到前端 textarea）
   *   - fields: 字段详情（key/label/value/required/filled）
   *   - missingRequired: 必填项未采的 label 列表
   *   - serviceTypeLabel: 服务类型中文名
   */
  /**
   * 2026-08-29 字段标准化 v2：存量需求数据批量归一化（一次性运维接口）
   */
  @NeedLogin()
  @Post('requirements/normalize-legacy')
  async normalizeLegacyRequirements(): Promise<{ total: number; updated: number }> {
    return this.chatRequirementsService.normalizeExistingRequirements();
  }

  @NeedLogin()
  @Post('sessions/:id/form-submit')
  async submitForm(
    @Param('id') id: string,
    @Body() body: FormSubmitRequest,
  ): Promise<FormSubmitResponse> {
    return this.chatService.submitFormAndContinue(id, body);
  }

  @NeedLogin()
  @Post('sessions/:id/confirmation-card')
  async generateConfirmationCard(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{
    canSend: boolean;
    text: string;
    fields: Array<{ key: string; label: string; value: string; required: boolean; filled: boolean }>;
    missingRequired: string[];
    serviceTypeLabel: string;
  }> {
    const userId = (req as any).userContext?.userId;
    return this.chatService.generateConfirmationCard(id, userId);
  }
}

/**
 * 客户端 - 匿名访问（通过 chatToken）
 */
@Controller('api/public/chat')
export class CustomerChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get(':token')
  async getOrCreateSession(
    @Param('token') token: string,
  ): Promise<CustomerChatInfo> {
    return this.chatService.getOrCreateSessionByToken(token);
  }

  @Get(':token/messages')
  async getMessages(
    @Param('token') token: string,
    @Query('afterId') afterId?: string,
  ): Promise<CustomerPollResult> {
    return this.chatService.getMessagesByToken(token, afterId);
  }

  @Post(':token/messages')
  async sendMessage(
    @Param('token') token: string,
    @Body() body: SendMessageRequest,
  ): Promise<ChatMessage> {
    if (!body.content || !body.content.trim()) {
      throw new BadRequestException('消息内容不能为空');
    }
    return this.chatService.sendCustomerMessage(token, body.content.trim());
  }

  @Post(':token/transfer')
  async transferToHuman(
    @Param('token') token: string,
    @Body() body: TransferRequest,
  ): Promise<{ success: boolean }> {
    await this.chatService.transferToHuman(token, body.reason);
    return { success: true };
  }

  @Post(':token/form-submit')
  async submitFormByToken(
    @Param('token') token: string,
    @Body() body: FormSubmitRequest,
  ): Promise<FormSubmitResponse> {
    return this.chatService.submitFormByToken(token, body);
  }
}
