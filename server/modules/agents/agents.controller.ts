import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import type {
  AgentListResponse,
  CreateAgentRequest,
  AgentRecord,
  DispatchRunResponse,
  SetAgentOnlineRequest,
  SetAgentOnlineResponse,
} from '@shared/api.interface';
import { AgentsService } from './agents.service';
import { AgentDispatchService } from './agent-dispatch.service';

@Controller('api/agents')
export class AgentsController {
  constructor(
    private readonly agentsService: AgentsService,
    private readonly dispatchService: AgentDispatchService,
  ) {}

  @Get()
  async list(): Promise<AgentListResponse> {
    const items = await this.agentsService.list();
    return { items, total: items.length };
  }

  @Post()
  async create(@Body() dto: CreateAgentRequest): Promise<AgentRecord> {
    return this.agentsService.create(dto);
  }

  @Patch(':id/online')
  async setOnline(
    @Param('id') id: string,
    @Body() body: SetAgentOnlineRequest,
  ): Promise<SetAgentOnlineResponse> {
    if (!body.online && !body.force) {
      const activeLeadCount: number = await this.dispatchService.countActiveLeadsForAgent(id);
      if (activeLeadCount > 0) {
        return { success: false, needConfirm: true, activeLeadCount };
      }
    }
    await this.agentsService.setOnline(id, Boolean(body.online));
    if (body.online) {
      void this.dispatchService.triggerFullCheck();
    }
    return { success: true };
  }

  @Post('dispatch/run')
  async runDispatch(): Promise<DispatchRunResponse> {
    const { reassigned, newlyAssigned } = await this.dispatchService.runFullCheck();
    return { reassignedCount: reassigned, assignedCount: newlyAssigned };
  }

  @Post(':id/respond/:leadId')
  async respond(
    @Param('id') agentId: string,
    @Param('leadId') leadId: string,
  ): Promise<{ success: boolean }> {
    const ok = await this.dispatchService.agentRespond(leadId, agentId);
    return { success: ok };
  }
}
