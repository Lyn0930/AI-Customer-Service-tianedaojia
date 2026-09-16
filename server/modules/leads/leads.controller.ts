import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { LeadStatus, PoolListParams, RegradeRequest, UpdateRequirementRequest } from '@shared/api.interface';
import { LeadsService } from './leads.service';
import { NotifyService } from '../notify/notify.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { BitableFormLeadDto } from './dto/bitable-form.dto';
import { PhoneLeadDto } from './dto/phone-lead.dto';
import { QueryLeadsDto } from './dto/query-leads.dto';
import { generateCaptcha } from './captcha.util';
import { SmsService } from '../sms/sms.service';

/**
 * 线索内部接口（需登录态）
 */
@Controller('api/leads')
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @NeedLogin()
  @Get()
  async list(@Req() req: Request, @Query() query: QueryLeadsDto) {
    const page = query.page ? parseInt(query.page, 10) || 1 : 1;
    const pageSize = query.pageSize ? parseInt(query.pageSize, 10) || 10 : 10;
    const userId = (req as any).userContext?.userId;
    const assigneeId = query.role === 'agent' && userId ? userId : query.assigneeId;
    return this.leadsService.list({
      status: query.status as LeadStatus | undefined,
      serviceCity: query.serviceCity,
      keyword: query.keyword,
      assigneeId,
      leadGrade: query.leadGrade,
      urgencyLevel: query.urgencyLevel,
      page,
      pageSize,
    });
  }

  @Get('stats')
  async getStats() {
    return this.leadsService.getStats();
  }

  @NeedLogin()
  @Get('pool')
  async getPoolLeads(@Query() query: QueryLeadsDto) {
    const page = query.page ? parseInt(query.page, 10) || 1 : 1;
    const pageSize = query.pageSize ? parseInt(query.pageSize, 10) || 10 : 10;
    const params: PoolListParams = { page, pageSize };
    if (query.serviceCity) params.serviceCity = query.serviceCity;
    if (query.keyword) params.keyword = query.keyword;
    return this.leadsService.getPoolLeads(params);
  }

  @NeedLogin()
  @Post('auto-assign')
  async autoAssign() {
    return this.leadsService.autoAssignPool();
  }

  @NeedLogin()
  @Post('recycle')
  async recycle() {
    return this.leadsService.recycleStaleLeads();
  }

  @NeedLogin()
  @Post('repair-grades')
  async repairGrades() {
    return this.leadsService.repairMissingGrades();
  }

  @Get(':id/requirements')
  async getRequirements(@Param('id') id: string) {
    return this.leadsService.getRequirementsByLeadId(id);
  }

  @NeedLogin()
  @Patch(':id/requirements')
  async updateRequirements(
    @Param('id') id: string,
    @Body() body: UpdateRequirementRequest,
  ) {
    return this.leadsService.updateRequirement(id, body);
  }

  @NeedLogin()
  @Patch(':id/assign')
  async assignLead(@Param('id') id: string, @Body() body: { assigneeId: string }) {
    return this.leadsService.assignLead(id, body.assigneeId);
  }

  @NeedLogin()
  @Post(':id/claim')
  async claimLead(@Req() req: Request, @Param('id') id: string) {
    const userId = (req as any).userContext?.userId;
    return this.leadsService.claimLead(id, userId);
  }

  @NeedLogin()
  @Post('phone')
  async createFromPhone(@Req() req: Request, @Body() dto: PhoneLeadDto) {
    const lead = await this.leadsService.create({
      channel: 'phone',
      phoneNumber: dto.phoneNumber,
      customerName: dto.customerName,
      serviceCity: dto.serviceCity ?? '',
      source: dto.source ?? '电话',
      serviceType: dto.serviceType,
      leadSourceDetail: dto.notes,
    });
    return lead;
  }

  @Get(':id/grade-history')
  async getGradeHistory(@Param('id') id: string) {
    return this.leadsService.getGradeHistory(id);
  }

  @NeedLogin()
  @Post(':id/regrade')
  async regrade(@Param('id') id: string, @Body() body: RegradeRequest) {
    await this.leadsService.regrade(id, body.grade, body.reason);
    return this.leadsService.getById(id);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.leadsService.getById(id);
  }
}

/**
 * 线索外部推送接口（OpenAPI，无需登录）
 */
@Controller('openapi/leads')
export class LeadsOpenApiController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly notifyService: NotifyService,
    private readonly smsService: SmsService,
  ) {}

  @Post()
  async create(@Body() dto: CreateLeadDto) {
    const channel = dto.channel ?? 'openapi';
    if (channel === 'openapi') {
      await this.smsService.verifyCode(dto.phoneNumber, dto.smsCode!);
    }
    const lead = await this.leadsService.create(dto);
    await this.notifyService.notifyNewLead(lead, dto.serviceType);
    return lead;
  }

  @Post('bitable-form')
  async createFromBitableForm(@Body() dto: BitableFormLeadDto) {
    const lead = await this.leadsService.create({
      channel: 'bitable_form',
      phoneNumber: dto['电话'],
      customerName: dto['客户姓名'],
      serviceCity: dto['城市'] ?? '',
      source: dto['来源'] ?? '飞书表单',
      serviceType: dto['服务类型'],
      leadSourceDetail: '飞书多维表格表单',
    });
    return lead;
  }
}

/**
 * 浏览器端公开线索创建（无需登录）
 *
 * 2026-08-13 改造：所有渠道（小红书/抖音/美团/SEO/自有 APP 等）走这同一个表单。
 * 短信服务暂未接入 → 不校验 smsCode，传 manual 跳过验证。
 * 后续接入阿里云短信后，参照 LeadsOpenApiController.create() 加回 verifyCode 即可。
 */
@Controller('api/public/leads')
export class PublicLeadsController {
  constructor(
    private readonly leadsService: LeadsService,
    private readonly notifyService: NotifyService,
  ) {}

  @Post()
  async create(@Body() dto: CreateLeadDto) {
    const lead = await this.leadsService.create(dto);
    await this.notifyService.notifyNewLead(lead, dto.serviceType);
    return lead;
  }
}

/**
 * 公开图形验证码端点（无需登录）
 */
@Controller('api/public/captcha')
export class CaptchaController {
  @Get()
  generate() {
    return generateCaptcha();
  }
}
