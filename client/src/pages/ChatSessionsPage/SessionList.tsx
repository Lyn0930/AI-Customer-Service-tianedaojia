import React, { useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { MessageSquare, Search } from 'lucide-react';

import { Input } from '@client/src/components/ui/input';
import { Spinner } from '@client/src/components/ui/spinner';
import { Button } from '@client/src/components/ui/button';
import type { ChatSessionListItem } from '@shared/api.interface';

const TAG_CLASS = 'inline-flex items-center h-5 px-1.5 rounded text-xs shrink-0';

const formatTime = (iso: string): string => {
  const d = dayjs(iso);
  const now = dayjs();
  if (d.isSame(now, 'day')) return d.format('HH:mm');
  if (d.isSame(now.subtract(1, 'day'), 'day'))
    return `昨天 ${d.format('HH:mm')}`;
  return d.format('MM-DD HH:mm');
};

interface SessionCardProps {
  item: ChatSessionListItem;
  selected: boolean;
  onClick: () => void;
}

const SessionCard: React.FC<SessionCardProps> = ({ item, selected, onClick }) => {
  const phone = item.lead?.phoneNumber;
  const name = item.lead?.customerName;
  const primary: string = phone || name || '未知客户';
  const showPhoneFirst = Boolean(phone);
  const previewBase: string = item.lastMessage?.content ?? '暂无消息';
  const preview: string =
    showPhoneFirst && name ? `${name} · ${previewBase}` : previewBase;
  const isC1Urgent: boolean =
    item.lead?.leadGrade === 'C1' && item.lead?.urgencyLevel === 'high';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative w-full h-[72px] px-4 py-3 overflow-hidden text-left border-b border-[#F3F4F6] transition-colors ${
        selected ? 'bg-[#EFF6FF]' : 'hover:bg-[#F9FAFB]'
      }`}
    >
      {selected && (
        <span className="absolute left-0 top-0 h-full w-[3px] bg-[#2563EB]" />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-[#111827] truncate">
              {primary}
            </span>
            {item.mode === 'human' ? (
              <span className={`${TAG_CLASS} bg-[#EFF6FF] text-[#2563EB]`}>
                人工
              </span>
            ) : (
              <span className={`${TAG_CLASS} bg-[#F3F4F6] text-[#6B7280]`}>
                AI
              </span>
            )}
            {isC1Urgent && (
              <span className={`${TAG_CLASS} bg-[#FEE2E2] text-[#EF4444]`}>
                C1高情绪
              </span>
            )}
          </div>
          <div className="mt-1">
            <span className="text-[13px] text-[#6B7280] truncate block">
              {preview}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className="text-xs text-[#9CA3AF] leading-[18px]">
            {formatTime(item.startedAt)}
          </span>
          {item.unread && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-[9px] text-[11px] font-bold text-white bg-[#EF4444]">
              新
            </span>
          )}
        </div>
      </div>
    </button>
  );
};

interface SessionListProps {
  sessions: ChatSessionListItem[];
  selectedId: string | null;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onRetry: () => void;
}

const SessionList: React.FC<SessionListProps> = ({
  sessions,
  selectedId,
  loading,
  error,
  onSelect,
  onRetry,
}) => {
  const [keyword, setKeyword] = useState<string>('');

  const filtered: ChatSessionListItem[] = useMemo(() => {
    const kw: string = keyword.trim().toLowerCase();
    if (!kw) return sessions;
    return sessions.filter((item: ChatSessionListItem) => {
      const phone: string = (item.lead?.phoneNumber ?? '').toLowerCase();
      const name: string = (item.lead?.customerName ?? '').toLowerCase();
      return phone.includes(kw) || name.includes(kw);
    });
  }, [sessions, keyword]);

  if (loading && sessions.length === 0) {
    return (
      <div className="flex items-center justify-center h-32">
        <Spinner className="w-5 h-5 text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-32 text-gray-500 text-sm">
        <span className="mb-2">{error}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="p-3 bg-white shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[#9CA3AF]" />
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索客户"
            className="h-9 rounded-lg border-transparent bg-[#F3F4F6] pl-8"
          />
        </div>
      </div>
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-32 text-gray-400 text-sm">
          <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
          {sessions.length === 0 ? '暂无会话记录' : '无匹配会话'}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {filtered.map((item: ChatSessionListItem) => (
            <SessionCard
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onClick={() => onSelect(item.id)}
            />
          ))}
        </div>
      )}
    </>
  );
};

export default SessionList;
