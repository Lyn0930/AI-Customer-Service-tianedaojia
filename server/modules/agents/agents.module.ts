import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AgentDispatchService } from './agent-dispatch.service';
import { AgentsAutomationService } from './agents.automation';
import { AgentSkillsSyncService } from './agent-skills-sync.service';

@Module({
  controllers: [AgentsController],
  providers: [
    AgentsService,
    AgentDispatchService,
    AgentsAutomationService,
    AgentSkillsSyncService,
  ],
  exports: [AgentDispatchService, AgentsService, AgentSkillsSyncService],
})
export class AgentsModule {}
