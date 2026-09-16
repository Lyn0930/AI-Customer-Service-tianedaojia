import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type {
  ChatMessage,
  ChatSession,
  ChatSessionDetail,
  ChatSessionListResponse,
  CustomerChatInfo,
  CustomerPollResult,
  SendMessageRequest,
  ReplySuggestion,
  HandoffSummary,
  CollectionProgress,
  FormSubmitRequest,
  FormSubmitResponse,
} from '@shared/api.interface';

export async function getChatSessions(
  params: { status?: string; page?: number; pageSize?: number; all?: boolean },
): Promise<ChatSessionListResponse> {
  const res = await axiosForBackend({
    url: '/api/chat/sessions',
    method: 'GET',
    params: { ...params, all: params.all ? 'true' : undefined },
  });
  return res.data;
}

export async function getChatSessionDetail(id: string, all = false): Promise<ChatSessionDetail> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${id}`,
    method: 'GET',
    params: all ? { all: 'true' } : {},
  });
  return res.data;
}

export async function getCustomerChat(token: string): Promise<CustomerChatInfo> {
  const res = await axiosForBackend({
    url: `/api/public/chat/${token}`,
    method: 'GET',
  });
  return res.data;
}

export async function getCustomerMessages(
  token: string,
  afterId?: string,
): Promise<CustomerPollResult> {
  const res = await axiosForBackend({
    url: `/api/public/chat/${token}/messages`,
    method: 'GET',
    params: afterId ? { afterId } : {},
  });
  return res.data;
}

export async function sendCustomerMessage(
  token: string,
  data: SendMessageRequest,
): Promise<ChatMessage> {
  const res = await axiosForBackend({
    url: `/api/public/chat/${token}/messages`,
    method: 'POST',
    data,
  });
  return res.data;
}

export async function takeoverSession(sessionId: string): Promise<ChatSession> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/takeover`,
    method: 'POST',
  });
  return res.data;
}

export async function reassignSession(
  sessionId: string,
  targetAgentId: string,
): Promise<ChatSession> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/reassign`,
    method: 'POST',
    data: { targetAgentId },
  });
  return res.data;
}

export async function releaseSession(sessionId: string): Promise<ChatSession> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/release`,
    method: 'POST',
  });
  return res.data;
}

export async function sendAgentMessage(
  sessionId: string,
  content: string,
): Promise<ChatMessage> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/messages`,
    method: 'POST',
    data: { content },
  });
  return res.data;
}

export async function transferToHuman(
  token: string,
  reason?: string,
): Promise<{ success: boolean }> {
  const res = await axiosForBackend({
    url: `/api/public/chat/${token}/transfer`,
    method: 'POST',
    data: { reason },
  });
  return res.data;
}

export async function getReplySuggestions(
  sessionId: string,
): Promise<ReplySuggestion> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/suggestions`,
    method: 'POST',
  });
  return res.data;
}

export async function getHandoffSummary(
  sessionId: string,
  all = false,
): Promise<HandoffSummary> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/handoff-summary`,
    method: 'GET',
    params: all ? { all: 'true' } : {},
  });
  return res.data;
}

export async function getCollectionProgress(
  sessionId: string,
): Promise<CollectionProgress> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/progress`,
    method: 'GET',
  });
  return res.data;
}

/**
 * 生成需求确认卡片（结构化文本，客服发给客户用）
 * 2026-08-16 林琳 19:35 拍板：
 *   - 必填项齐就能生成（canSend=true 表示完整可发；canSend=false 也可生成，由客服决定）
 *   - 形态：结构化文本（每项一行"label：value"），客服可编辑后发送
 */
export interface ConfirmationCardField {
  key: string;
  label: string;
  value: string;
  required: boolean;
  filled: boolean;
}

export interface ConfirmationCardResponse {
  canSend: boolean;
  text: string;
  fields: ConfirmationCardField[];
  missingRequired: string[];
  serviceTypeLabel: string;
}

export async function generateConfirmationCard(
  sessionId: string,
): Promise<ConfirmationCardResponse> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/confirmation-card`,
    method: 'POST',
  });
  return res.data;
}

export async function submitForm(
  sessionId: string,
  data: FormSubmitRequest,
): Promise<FormSubmitResponse> {
  const res = await axiosForBackend({
    url: `/api/chat/sessions/${sessionId}/form-submit`,
    method: 'POST',
    data,
  });
  return res.data;
}

export async function submitFormByToken(
  token: string,
  data: FormSubmitRequest,
): Promise<FormSubmitResponse> {
  const res = await axiosForBackend({
    url: `/api/public/chat/${token}/form-submit`,
    method: 'POST',
    data,
  });
  return res.data;
}
