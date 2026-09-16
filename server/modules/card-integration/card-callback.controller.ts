import {
  Controller,
  Post,
  Body,
  Headers,
  Logger,
  BadRequestException,
  Inject,
} from '@nestjs/common';
import { DRIZZLE_DATABASE, type PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { sql, type SQL } from 'drizzle-orm';
import { CardSignatureService } from './card-signature.service';
import { CardIntegrationService } from './card-integration.service';

/**
 * 飞书卡片回调控制器
 *
 * 端点：POST /api/lark/card-callback
 *
 * 处理两种请求：
 * 1. URL 验证（url_verification）：飞书后台配置回调地址时的 challenge 校验
 * 2. 卡片动作触发（card.action.triggered）：用户提交卡片表单时的回调
 *
 * 签名校验：使用 CardSignatureService 验证请求签名，防止伪造回调
 */
@Controller('api/lark/card-callback')
export class CardCallbackController {
  private readonly logger = new Logger(CardCallbackController.name);

  constructor(
    private readonly signatureService: CardSignatureService,
    private readonly cardIntegrationService: CardIntegrationService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  @Post()
  async handleCallback(
    @Headers('x-lark-request-timestamp') timestamp: string,
    @Headers('x-lark-request-nonce') nonce: string,
    @Headers('x-lark-signature') signature: string,
    @Body() body: any,
  ): Promise<any> {
    // 1. 签名校验（challenge 请求也校验）
    // 注意：body 已经被 NestJS 解析成对象了，需要重新序列化成字符串
    // 飞书签名用的是原始 body，这里用 JSON.stringify 近似，key 顺序可能不同
    // 生产环境建议用 raw body，此处先兼容处理
    const rawBody = JSON.stringify(body);

    if (!this.signatureService.verify(timestamp, nonce, signature, rawBody)) {
      this.logger.warn('卡片回调签名校验失败，拒绝处理');
      throw new BadRequestException('Invalid signature');
    }

    // 2. URL 验证（challenge）
    if (body.type === 'url_verification') {
      this.logger.log('收到飞书卡片回调 URL 验证请求');
      return {
        challenge: body.challenge,
      };
    }

    // 3. 卡片动作触发
    if (body.type === 'card.action.triggered') {
      return this.handleCardAction(body);
    }

    this.logger.warn(`未知的卡片回调类型: ${body.type}`);
    return { code: 0, msg: 'ok' };
  }

  /**
   * 处理卡片动作（用户提交表单）
   */
  private async handleCardAction(body: any): Promise<any> {
    const event = body.event || {};
    const action = event.action || {};
    const actionValue = action.value || {};
    const formValue = event.form_value || {};
    const operator = event.operator || {};

    const actionType = actionValue.action;
    const leadId = formValue.lead_id || actionValue.lead_id;

    this.logger.log(
      `收到卡片动作: action=${actionType}, leadId=${leadId}, ` +
      `operator=${operator.open_id || 'unknown'}`,
    );

    if (actionType === 'submit_requirement') {
      await this.handleRequirementSubmit(leadId, formValue);
      // 返回成功卡片（飞书会用此卡片替换原卡片）
      return this.cardIntegrationService.getSuccessCard();
    }

    this.logger.warn(`未知的卡片动作类型: ${actionType}`);
    return { code: 0, msg: 'ok' };
  }

  /**
   * 处理需求提交：将表单数据写入 requirements 表
   *
   * 使用 ON CONFLICT (lead_id) DO UPDATE 实现 upsert
   * 老值优先（COALESCE + NULLIF），避免卡片提交覆盖 AI 已采集的更完整信息
   */
  private async handleRequirementSubmit(
    leadId: string,
    formValue: Record<string, string>,
  ): Promise<void> {
    if (!leadId) {
      this.logger.warn('需求提交缺少 lead_id，跳过');
      return;
    }

    // 字段映射：camelCase (表单) → snake_case (DB)
    const FIELD_MAP: Array<[string, string]> = [
      ['serviceType', 'service_type'],
      ['area', 'area'],
      ['householdSize', 'household_size'],
      ['restDays', 'rest_days'],
      ['startTime', 'start_time'],
      ['serviceAddress', 'service_address'],
      ['hasPet', 'has_pet'],
      ['helperRequirements', 'helper_requirements'],
    ];

    const insertCols: SQL[] = [sql`lead_id`];
    const insertVals: SQL[] = [sql`${leadId}`];
    const updateParts: SQL[] = [];

    for (const [camel, snake] of FIELD_MAP) {
      const val = formValue[camel];
      if (val && val.trim() !== '') {
        const trimmed = val.trim();
        insertCols.push(sql`${sql.raw(snake)}`);
        insertVals.push(sql`${trimmed}`);
        // 老值优先：COALESCE + NULLIF 把空串转成 NULL
        updateParts.push(
          sql`${sql.raw(snake)} = COALESCE(NULLIF(requirements.${sql.raw(snake)}, ''), EXCLUDED.${sql.raw(snake)})`,
        );
      }
    }

    if (insertCols.length === 1) {
      this.logger.warn(`lead=${leadId} 卡片提交无有效字段，跳过`);
      return;
    }

    try {
      await this.db.execute(
        sql`INSERT INTO requirements (${sql.join(insertCols, sql`, `)}, status)
            VALUES (${sql.join(insertVals, sql`, `)}, 'collecting')
            ON CONFLICT (lead_id) DO UPDATE SET ${sql.join(updateParts, sql`, `)}`,
      );

      this.logger.log(
        `lead=${leadId} 卡片需求已入库，字段数: ${updateParts.length}`,
      );
    } catch (error) {
      this.logger.error(
        `卡片需求入库失败 lead=${leadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 驼峰转下划线
   */
  private camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
  }
}
