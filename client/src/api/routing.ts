import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  AgentSkill,
  AgentWorkload,
  AgentListResponse,
  CreateAgentSkillRequest,
  UpdateAgentSkillRequest,
  RoutingResult,
  AgentOnlineState,
  AgentOnlineStatus,
} from '@shared/api.interface';

export async function getAgentSkills(): Promise<AgentSkill[]> {
  const res = await axiosForBackend({
    url: '/api/agent-skills',
    method: 'GET',
  });
  return res.data;
}

export async function createAgentSkill(
  data: CreateAgentSkillRequest,
): Promise<AgentSkill> {
  const res = await axiosForBackend({
    url: '/api/agent-skills',
    method: 'POST',
    data,
  });
  return res.data;
}

export async function updateAgentSkill(
  id: string,
  data: UpdateAgentSkillRequest,
): Promise<AgentSkill> {
  const res = await axiosForBackend({
    url: `/api/agent-skills/${id}`,
    method: 'PATCH',
    data,
  });
  return res.data;
}

export async function deleteAgentSkill(id: string): Promise<void> {
  await axiosForBackend({
    url: `/api/agent-skills/${id}`,
    method: 'DELETE',
  });
}

export async function getAgentWorkloads(): Promise<AgentWorkload[]> {
  const res = await axiosForBackend({
    url: '/api/agents/workload',
    method: 'GET',
  });
  return res.data;
}

export async function sendHeartbeat(status: AgentOnlineState): Promise<void> {
  await axiosForBackend({
    url: '/api/agent/heartbeat',
    method: 'POST',
    data: { status },
  });
}

export async function getAgentList(): Promise<AgentListResponse> {
  const res = await axiosForBackend({
    url: '/api/agents',
    method: 'GET',
  });
  return res.data;
}

export async function getOnlineAgents(): Promise<AgentOnlineStatus[]> {
  const res = await axiosForBackend({
    url: '/api/agents/online',
    method: 'GET',
  });
  return res.data;
}
