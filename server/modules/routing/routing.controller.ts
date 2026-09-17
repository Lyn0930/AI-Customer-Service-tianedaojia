import { Controller, Get, Post, Patch, Delete, Body, Param, Req } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { RoutingService } from './routing.service';
import type { CreateAgentSkillRequest, UpdateAgentSkillRequest, HeartbeatRequest } from '@shared/api.interface';
import type { Request } from 'express';

@Controller('api')
export class RoutingController {
  constructor(private readonly routingService: RoutingService) {}

  @Get('agent-skills')
  async listAgentSkills() {
    return this.routingService.getAgentSkills();
  }

  @NeedLogin()
  @Post('agent-skills')
  async createAgentSkill(@Body() body: CreateAgentSkillRequest) {
    return this.routingService.addAgentSkill(body);
  }

  @NeedLogin()
  @Patch('agent-skills/:id')
  async updateAgentSkill(
    @Param('id') id: string,
    @Body() body: UpdateAgentSkillRequest,
  ) {
    return this.routingService.updateAgentSkill(id, body);
  }

  @NeedLogin()
  @Delete('agent-skills/:id')
  async deleteAgentSkill(@Param('id') id: string) {
    await this.routingService.removeAgentSkill(id);
    return { success: true };
  }

  @Get('agents/workload')
  async listAgentWorkloads() {
    return this.routingService.getAllAgentWorkloads();
  }

  // ===== 2026-08-14 避免"无人管"3 层 - 第 2 层任务卡 =====
  @NeedLogin()
  @Get('leads/:id/task-card')
  async getLeadTaskCard(@Param('id') id: string) {
    return this.routingService.getLeadTaskCard(id);
  }

  @NeedLogin()
  @Post('agent/heartbeat')
  async heartbeat(@Req() req: Request, @Body() body: HeartbeatRequest) {
    const { userId } = req.userContext;
    await this.routingService.recordHeartbeat(userId, body.status);
    return { success: true };
  }

  @Get('agents/online')
  async listOnlineAgents() {
    return this.routingService.getOnlineAgents();
  }
}
