import { Injectable, Logger } from '@nestjs/common';
import { FeishuService } from './feishu.service';

/**
 * 飞书交互卡片集成服务
 *
 * 负责：
 * 1. 生成需求采集卡片的 JSON 模板（getCardTemplate）
 * 2. 通过飞书 IM 通道发送交互卡片给用户（sendCardToUser）
 *
 * 卡片字段与 requirements 表对齐：
 * - lead_id（隐藏字段，用于关联线索）
 * - serviceType（服务类型：钟点工/白班/住家/育儿/护工/菲式）
 * - area（面积）
 * - householdSize（家庭人口）
 * - restDays（月休天数）
 * - startTime（上岗时间）
 * - serviceAddress（服务地址）
 * - hasPet（是否有宠物）
 * - helperRequirements（对保姆的要求）
 */
@Injectable()
export class CardIntegrationService {
  private readonly logger = new Logger(CardIntegrationService.name);

  constructor(private readonly feishuService: FeishuService) {}

  /**
   * 生成需求采集卡片模板
   * @param leadId 线索ID（隐藏字段，提交时带回）
   * @param serviceType 预填的服务类型（可选）
   */
  getCardTemplate(leadId: string, serviceType?: string): Record<string, any> {
    return {
      config: {
        wide_screen_mode: true,
        enable_forward: true,
      },
      header: {
        template: 'blue',
        title: {
          tag: 'plain_text',
          content: '📋 需求信息采集',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '请填写您的服务需求，提交后我们将为您匹配最合适的家政人员。',
          },
        },
        {
          tag: 'hr',
        },
        // 隐藏字段：lead_id（用 disabled input 携带）
        {
          tag: 'input',
          label: '线索ID',
          disabled: true,
          name: 'lead_id',
          required: false,
          default_value: leadId,
          placeholder: '系统自动生成',
        },
        // 服务类型
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: '请选择服务类型',
          },
          name: 'serviceType',
          required: true,
          label: '服务类型',
          options: [
            { text: { tag: 'plain_text', content: '钟点工保姆' }, value: '钟点工保姆' },
            { text: { tag: 'plain_text', content: '白班保姆' }, value: '白班保姆' },
            { text: { tag: 'plain_text', content: '住家保姆' }, value: '住家保姆' },
            { text: { tag: 'plain_text', content: '育儿保姆' }, value: '育儿保姆' },
            { text: { tag: 'plain_text', content: '护工保姆' }, value: '护工保姆' },
            { text: { tag: 'plain_text', content: '菲式保姆' }, value: '菲式保姆' },
          ],
          initial_option: serviceType
            ? { text: { tag: 'plain_text', content: serviceType }, value: serviceType }
            : undefined,
        },
        // 面积
        {
          tag: 'input',
          label: '房屋面积',
          name: 'area',
          required: false,
          placeholder: '如：80平米',
        },
        // 家庭人口
        {
          tag: 'input',
          label: '家庭人口',
          name: 'householdSize',
          required: false,
          placeholder: '如：3口人',
        },
        // 月休天数
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: '请选择月休天数',
          },
          name: 'restDays',
          required: false,
          label: '月休天数',
          options: [
            { text: { tag: 'plain_text', content: '4天' }, value: '4天' },
            { text: { tag: 'plain_text', content: '2天' }, value: '2天' },
            { text: { tag: 'plain_text', content: '无月休' }, value: '无月休' },
          ],
        },
        // 上岗时间
        {
          tag: 'input',
          label: '上岗时间',
          name: 'startTime',
          required: false,
          placeholder: '如：尽快 / 9月1日',
        },
        // 服务地址
        {
          tag: 'input',
          label: '服务地址',
          name: 'serviceAddress',
          required: false,
          placeholder: '请填写详细地址',
        },
        // 是否有宠物
        {
          tag: 'select_static',
          placeholder: {
            tag: 'plain_text',
            content: '请选择',
          },
          name: 'hasPet',
          required: false,
          label: '家中是否有宠物',
          options: [
            { text: { tag: 'plain_text', content: '没有' }, value: '没有' },
            { text: { tag: 'plain_text', content: '猫' }, value: '猫' },
            { text: { tag: 'plain_text', content: '狗' }, value: '狗' },
            { text: { tag: 'plain_text', content: '其他' }, value: '其他' },
          ],
        },
        // 对保姆的要求
        {
          tag: 'textarea',
          label: '对保姆的要求',
          name: 'helperRequirements',
          required: false,
          placeholder: '如：做饭好吃、有育儿经验、性格温和等',
          max_length: 500,
        },
        {
          tag: 'hr',
        },
        // 提交按钮
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '提交需求',
              },
              type: 'primary',
              value: {
                action: 'submit_requirement',
                lead_id: leadId,
              },
            },
          ],
        },
      ],
    };
  }

  /**
   * 生成提交成功后的回执卡片
   */
  getSuccessCard(): Record<string, any> {
    return {
      config: {
        wide_screen_mode: true,
      },
      header: {
        template: 'green',
        title: {
          tag: 'plain_text',
          content: '✅ 需求已提交',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: '您的需求信息已成功提交，我们会尽快为您匹配合适的家政人员，请耐心等待~',
          },
        },
      ],
    };
  }

  /**
   * 发送交互卡片给飞书用户
   *
   * 通过飞书 IM 消息接口（im/v1/messages）发送 interactive 类型消息。
   * 使用租户级 access token 调用。
   *
   * @param receiveId 接收者ID（open_id / user_id / email / chat_id）
   * @param receiveIdType 接收者ID类型：open_id / user_id / email / chat_id
   * @param cardJson 卡片 JSON
   */
  async sendCardToUser(
    receiveId: string,
    receiveIdType: 'open_id' | 'user_id' | 'email' | 'chat_id',
    cardJson: Record<string, any>,
  ): Promise<boolean> {
    if (receiveIdType !== 'open_id') {
      this.logger.warn(`仅支持 open_id 类型，收到 ${receiveIdType}，跳过`);
      return false;
    }

    const messageId = await this.feishuService.sendInteractiveCard(receiveId, cardJson);
    return messageId !== null;
  }
}
