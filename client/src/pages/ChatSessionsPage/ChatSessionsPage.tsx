import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@client/src/components/ui/button';
import {
  getChatSessions,
  getChatSessionDetail,
  takeoverSession,
  releaseSession,
  reassignSession,
  sendAgentMessage,
  getReplySuggestions,
} from '@client/src/api/chat';
import { useRole } from '@client/src/hooks/useRole';
import { useChatEvents } from './useChatEvents';
import type { ChatSessionListItem, ChatSessionDetail } from '@shared/api.interface';

import SessionList from './SessionList';
import ChatPanel from './ChatPanel';
import ContextPanel from './ContextPanel';

const ChatSessionsPage: React.FC = () => {
  const { role } = useRole();
  const isManager = role === 'manager';

  const [sessions, setSessions] = useState<ChatSessionListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChatSessionDetail | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionLoading, setSuggestionLoading] = useState(false);
  const [suggestionText, setSuggestionText] = useState<string | null>(null);
  const [sseConnected, setSseConnected] = useState(false);

  const fetchSessions = useCallback(async () => {
    setListLoading(true);
    setError(null);
    try {
      const res = await getChatSessions({ page: 1, pageSize: 50, all: isManager });
      if (!res || !Array.isArray(res.items)) {
        setError('加载会话列表失败');
        return;
      }
      setSessions(res.items);
      if (res.items.length > 0 && !selectedId) {
        setSelectedId(res.items[0].id);
      }
    } catch {
      setError('加载会话列表失败');
    } finally {
      setListLoading(false);
    }
  }, [selectedId, isManager]);

  const fetchDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setSuggestions([]);
    setSuggestionText(null);
    try {
      const res = await getChatSessionDetail(id, isManager);
      setDetail(res);
    } catch {
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [isManager]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  useEffect(() => {
    if (selectedId) {
      fetchDetail(selectedId);
    } else {
      setDetail(null);
    }
  }, [selectedId, fetchDetail]);

  // SSE：实时事件驱动刷新（主通道）
  useChatEvents(
    (event) => {
      if (event.type === 'session.created') {
        // 2026-08-15 新增：弹 toast 提示客服有新线索分配
        const leadName = (event.session as any)?.lead?.customerName
          ?? (event.session as any)?.lead?.phoneNumber
          ?? '新客户';
        toast.success(`新线索分配：${leadName}`, {
          description: '已添加到「我的会话」列表，请尽快回复',
        });
        fetchSessions();
        if (selectedId && event.session?.id === selectedId) {
          fetchDetail(selectedId);
        }
      } else if (event.type === 'session.updated') {
        fetchSessions();
        if (selectedId && event.session?.id === selectedId) {
          fetchDetail(selectedId);
        }
      } else if (event.type === 'message.created') {
        fetchSessions();
        if (selectedId && event.sessionId === selectedId) {
          fetchDetail(selectedId);
        }
      }
    },
    setSseConnected,
  );

  // 兜底 1：窗口聚焦时拉一次（用户从其他 tab 切回来时补齐期间可能漏掉的事件）
  useEffect(() => {
    const onFocus = () => {
      fetchSessions();
      if (selectedId) fetchDetail(selectedId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [selectedId, fetchSessions, fetchDetail]);

  // 兜底 2：SSE 断开超过 30s 时，慢轮询拉一次（直到 SSE 恢复）。SSE 正常时绝不轮询。
  useEffect(() => {
    if (sseConnected) return;
    const timer = setInterval(() => {
      fetchSessions();
      if (selectedId) fetchDetail(selectedId);
    }, 30000);
    return () => clearInterval(timer);
  }, [sseConnected, selectedId, fetchSessions, fetchDetail]);

  const handleSelect = (id: string) => {
    setSelectedId(id);
  };

  const handleRefresh = () => {
    fetchSessions();
    if (selectedId) {
      fetchDetail(selectedId);
    }
  };

  const handleTakeover = async () => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await takeoverSession(selectedId);
      toast.success('已接管会话');
      fetchSessions();
      await fetchDetail(selectedId);
    } catch {
      toast.error('接管失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRelease = async () => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await releaseSession(selectedId);
      toast.success('已释放回 AI');
      fetchSessions();
      await fetchDetail(selectedId);
    } catch {
      toast.error('释放失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReassign = async (targetAgentId: string) => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await reassignSession(selectedId, targetAgentId);
      toast.success('已转接');
      fetchSessions();
      await fetchDetail(selectedId);
    } catch {
      toast.error('转接失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleSendAgentMessage = async (content: string) => {
    if (!selectedId) return;
    setActionLoading(true);
    try {
      await sendAgentMessage(selectedId, content);
      await fetchDetail(selectedId);
    } catch {
      toast.error('发送失败');
    } finally {
      setActionLoading(false);
    }
  };

  const handleRequestSuggestions = async () => {
    if (!selectedId) return;
    setSuggestionLoading(true);
    setSuggestions([]);
    try {
      const res = await getReplySuggestions(selectedId);
      setSuggestions(res.suggestions);
      if (res.suggestions.length === 0) {
        toast.info('AI 暂未生成建议，请稍后再试');
      }
    } catch {
      toast.error('AI 建议获取失败');
    } finally {
      setSuggestionLoading(false);
    }
  };

  const handleSuggestionClick = (text: string) => {
    setSuggestionText(text);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-bold text-gray-800">
            {isManager ? '全部会话监控' : '我的会话监控'}
          </h1>
          <span
            className={`flex items-center gap-1.5 text-xs ${
              sseConnected ? 'text-green-600' : 'text-gray-400'
            }`}
            title={sseConnected ? '实时连接已建立' : '实时连接断开，将使用慢轮询兜底'}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                sseConnected ? 'bg-green-500' : 'bg-gray-300'
              }`}
            />
            {sseConnected ? '实时' : '轮询'}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={listLoading}>
          <RefreshCw className={`w-4 h-4 ${listLoading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-[280px] border-r border-gray-200 bg-white flex flex-col overflow-hidden shrink-0">
          <SessionList
            sessions={sessions}
            selectedId={selectedId}
            loading={listLoading}
            error={error}
            onSelect={handleSelect}
            onRetry={fetchSessions}
          />
        </div>

        <div className="flex-1 bg-white min-w-0">
          <ChatPanel
            detail={detail}
            loading={detailLoading}
            isManager={isManager}
            actionLoading={actionLoading}
            suggestionLoading={suggestionLoading}
            suggestionText={suggestionText}
            onTakeover={handleTakeover}
            onRelease={handleRelease}
          onReassign={handleReassign}
            onSendAgentMessage={handleSendAgentMessage}
            onRequestSuggestions={handleRequestSuggestions}
          />
        </div>

        <div className="w-80 border-l border-gray-200 bg-white shrink-0 overflow-hidden">
          <ContextPanel
            sessionId={selectedId}
            isManager={isManager}
            suggestions={suggestions}
            suggestionLoading={suggestionLoading}
            onSuggestionClick={handleSuggestionClick}
          />
        </div>
      </div>
    </div>
  );
};

export default ChatSessionsPage;