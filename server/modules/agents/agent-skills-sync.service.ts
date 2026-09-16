import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { eq } from 'drizzle-orm';
import { agents, agentSkills } from '@server/database/schema';

@Injectable()
export class AgentSkillsSyncService {
  private readonly logger = new Logger(AgentSkillsSyncService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async syncFromServiceTypes(agentId: string): Promise<void> {
    const rows = await this.db
      .select({ serviceTypes: agents.serviceTypes })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (rows.length === 0) return;

    const types: string[] = Array.isArray(rows[0].serviceTypes)
      ? (rows[0].serviceTypes as string[])
      : [];

    await this.db
      .delete(agentSkills)
      .where(eq(agentSkills.assigneeId, agentId));

    if (types.length > 0) {
      await this.db
        .insert(agentSkills)
        .values(
          types.map((tag: string) => ({ assigneeId: agentId, skillTag: tag })),
        );
    }

    this.logger.log(
      `agent_skills synced for ${agentId}: ${types.join(',') || '(empty)'}`,
    );
  }
}
