import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { agents, agentSessions } from '@server/database/schema';
import type { AgentRecord, CreateAgentRequest } from '@shared/api.interface';
import { AgentSkillsSyncService } from './agent-skills-sync.service';

@Injectable()
export class AgentsService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly skillsSync: AgentSkillsSyncService,
  ) {}

  async list(): Promise<AgentRecord[]> {
    const rows = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        phone: agents.phone,
        city: agents.city,
        serviceTypes: agents.serviceTypes,
        skillTags: agents.skillTags,
        conversionRate: agents.conversionRate,
        maxLeads: agents.maxLeads,
        activeLeadsCount: agents.activeLeadsCount,
        isOnline: agentSessions.isOnline,
      })
      .from(agents)
      .leftJoin(agentSessions, eq(agentSessions.agentId, agents.id));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      city: row.city,
      serviceTypes: (row.serviceTypes as string[]) ?? [],
      skillTags: (row.skillTags as string[]) ?? [],
      conversionRate: row.conversionRate,
      maxLeads: row.maxLeads,
      activeLeadsCount: row.activeLeadsCount,
      isOnline: row.isOnline ?? false,
    }));
  }

  async create(dto: CreateAgentRequest): Promise<AgentRecord> {
    const inserted = await this.db
      .insert(agents)
      .values({
        name: dto.name,
        phone: dto.phone ?? null,
        city: dto.city,
        serviceTypes: dto.serviceTypes,
        skillTags: dto.skillTags ?? [],
        conversionRate: dto.conversionRate ?? 50,
        maxLeads: dto.maxLeads ?? 10,
        activeLeadsCount: 0,
      })
      .returning({ id: agents.id });

    await this.db.insert(agentSessions).values({
      agentId: inserted[0].id,
      isOnline: false,
    });

    await this.skillsSync.syncFromServiceTypes(inserted[0].id);

    const list = await this.list();
    return list.find((item) => item.id === inserted[0].id) as AgentRecord;
  }

  async setOnline(agentId: string, online: boolean): Promise<void> {
    const updated = await this.db
      .update(agentSessions)
      .set({ isOnline: online, lastHeartbeatAt: new Date() })
      .where(eq(agentSessions.agentId, agentId))
      .returning({ id: agentSessions.id });

    if (updated.length === 0) {
      const exists = await this.db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      if (exists.length === 0) {
        throw new NotFoundException(`经纪人 ${agentId} 不存在`);
      }
      await this.db.insert(agentSessions).values({ agentId, isOnline: online });
    }
  }
}
