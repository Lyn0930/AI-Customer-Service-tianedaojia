import { Injectable, Logger } from '@nestjs/common';
import { CapabilityService } from '@lark-apaas/fullstack-nestjs-core';
import { AiConfigService } from '../admin/ai-config.service';
import type { Lead, TransferSource } from '@shared/api.interface';
import type { SendSwanHomeClueNotificationOneInput } from '@shared/plugin-types';

type FeishuMessageInput = Omit<SendSwanHomeClueNotificationOneInput, 'title'> & {
  title: { title: string };
};

const PLUGIN_INSTANCE_ID = 'send_swan_home_clue_notification_1';
const ACTION_KEY = 'send_feishu_message';
const DEFAULT_NOTIFICATION_RECEIVERS = ['1847292357012580'];

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);

  constructor(
    private readonly capabilityService: CapabilityService,
    private readonly aiConfigService: AiConfigService,
  ) {}

  private async getReceivers(): Promise<string[]> {
    const value = await this.aiConfigService.getConfig('notification_receivers');
    if (!value) return DEFAULT_NOTIFICATION_RECEIVERS;
    try {
      const parsed = JSON.parse(value) as string[];
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_NOTIFICATION_RECEIVERS;
    } catch {
      return DEFAULT_NOTIFICATION_RECEIVERS;
    }
  }

  /**
   * 通知运营人员：新线索接入
   * @param lead 新创建的线索
   * @param serviceType 服务类型（可选，钟点工/白班/住家/育儿/护工/菲式）
   */
  async notifyNewLead(lead: Lead, serviceType?: string): Promise<void> {
    const receivers = await this.getReceivers();
    const input: FeishuMessageInput = {
      title: { title: '新线索接入' },
      content: `城市: ${lead.serviceCity}\n电话: ${lead.phoneNumber}\n客户: ${lead.customerName || '未知'}\n来源: ${lead.source}\n服务类型: ${serviceType || '未填'}`,
      receiverUserList: receivers,
    };

    const sender = async () => {
      try {
        const result = await this.capabilityService
          .load(PLUGIN_INSTANCE_ID)
          .call(ACTION_KEY, input);

        if (!result || !(result as { success?: boolean }).success) {
          this.logger.warn(`新线索通知发送失败，leadId: ${lead.id}`);
        }
      } catch (error) {
        const stack = error instanceof Error ? error.stack ?? error.message : String(error);
        this.logger.warn(`新线索通知发送异常，leadId: ${lead.id}\n${stack}`);
      }
    };
    void sender();
  }

  /**
   * 通知运营人员：需求收集完成
   */
  async notifyRequirementsCollected(leadId: string): Promise<void> {
    const receivers = await this.getReceivers();
    const input: FeishuMessageInput = {
      title: { title: '需求收集完成' },
      content: `请查看线索详情\n线索ID: ${leadId}`,
      receiverUserList: receivers,
    };

    const sender = async () => {
      try {
        const result = await this.capabilityService
          .load(PLUGIN_INSTANCE_ID)
          .call(ACTION_KEY, input);

        if (!result || !(result as { success?: boolean }).success) {
          this.logger.warn(`需求收集完成通知发送失败，leadId: ${leadId}`);
        }
      } catch (error) {
        const stack = error instanceof Error ? error.stack ?? error.message : String(error);
        this.logger.warn(`需求收集完成通知发送异常，leadId: ${leadId}\n${stack}`);
      }
    };
    void sender();
  }

  /**
   * 通知专员：会话转人工
   */
  async notifyTransferToAgent(
    sessionId: string,
    reason: string,
    transferredBy: TransferSource,
    lead: Lead | null,
  ): Promise<void> {
    const receivers = await this.getReceivers();
    const sourceLabel = transferredBy === 'customer' ? '客户主动' : 'AI自动';
    const customerInfo = lead
      ? `城市: ${lead.serviceCity}\n电话: ${lead.phoneNumber}\n客户: ${lead.customerName || '未知'}\n来源: ${lead.source}`
      : '客户信息不可用';
    const input: FeishuMessageInput = {
      title: { title: '会话转人工' },
      content: `${sourceLabel}转人工\n转接原因: ${reason}\n${customerInfo}\n请及时前往工作台处理`,
      receiverUserList: receivers,
    };

    const sender = async () => {
      try {
        const result = await this.capabilityService
          .load(PLUGIN_INSTANCE_ID)
          .call(ACTION_KEY, input);

        if (!result || !(result as { success?: boolean }).success) {
          this.logger.warn(`转人工通知发送失败，sessionId: ${sessionId}`);
        }
      } catch (error) {
        const stack = error instanceof Error ? error.stack ?? error.message : String(error);
        this.logger.warn(`转人工通知发送异常，sessionId: ${sessionId}\n${stack}`);
      }
    };
    void sender();
  }

  /**
   * 2026-08-15 客服新线索分配：发飞书 IM 卡片给具体 agent（不发到运营群）
   * @param agentUserId 客服 userId
   * @param lead 已分配的 lead
   * @param session 关联的 chatSession（用于链接）
   */
  async notifyAgentNewLead(
    agentUserId: string,
    lead: Lead,
    session: { id: string; mode: string; startedAt: string },
  ): Promise<void> {
    if (!agentUserId) {
      this.logger.warn(`notifyAgentNewLead: agentUserId 为空，leadId=${lead.id}`);
      return;
    }
    const customerInfo = `城市: ${lead.serviceCity ?? '未知'}\n电话: ${lead.phoneNumber ?? '未知'}\n客户: ${lead.customerName || '未知'}\n来源: ${lead.source ?? '未知'}`;
    const input: FeishuMessageInput = {
      title: { title: '新线索分配给你了' },
      content: `${customerInfo}\n请尽快在工作台处理\n会话: ${session.id}`,
      receiverUserList: [agentUserId],
    };

    try {
      const result = await this.capabilityService
        .load(PLUGIN_INSTANCE_ID)
        .call(ACTION_KEY, input);

      if (!result || !(result as { success?: boolean }).success) {
        this.logger.warn(
          `客服新线索通知发送失败，agent=${agentUserId} lead=${lead.id}`,
        );
      } else {
        this.logger.log(
          `客服新线索通知发送成功，agent=${agentUserId} lead=${lead.id}`,
        );
      }
    } catch (error) {
      const stack = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.warn(`客服新线索通知发送异常，agent=${agentUserId} lead=${lead.id}\n${stack}`);
    }
  }
}
