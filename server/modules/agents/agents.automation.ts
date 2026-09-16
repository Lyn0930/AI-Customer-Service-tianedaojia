import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@lark-apaas/fullstack-nestjs-core';
import { AgentDispatchService } from './agent-dispatch.service';

@Automation()
export class AgentsAutomationService {
  private readonly logger = new Logger(AgentsAutomationService.name);

  constructor(private readonly dispatchService: AgentDispatchService) {}

  /** 定时兜底：超时转派 + pending 补派，与业务事件触发的检查幂等不冲突 */
  @BindTrigger('agent_dispatch_timeout_check')
  async dispatchTimeoutCheck(): Promise<void> {
    const { reassigned, newlyAssigned } = await this.dispatchService.runFullCheck();
    if (reassigned > 0) {
      this.logger.log(`超时转派 ${reassigned} 条线索`);
    }
    if (newlyAssigned > 0) {
      this.logger.log(`本轮补派 ${newlyAssigned} 条线索`);
    }
  }
}
