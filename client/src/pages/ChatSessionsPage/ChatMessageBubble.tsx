import React, { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { User, Headphones, Zap, Settings2, X, Plus, Trash2 } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Textarea } from '@client/src/components/ui/textarea';
import { Image } from '@client/src/components/ui/image';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@client/src/components/ui/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import type { ChatMessage } from '@shared/api.interface';
import { useCurrentUserProfile } from '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile';
import { loadQuickReplies, saveQuickReplies } from './quickReplies';

export const SWAN_AVATAR_URL =
  '/spark/app/app_17buybqcty0/runtime/api/v1/storage/object/bucket_aadkpgd7eesiq_static/static%2Faadkpw3e3oehg_ve_miaoda';

const SECONDARY_BTN_CLASS =
  'h-8 rounded-md px-3 text-[13px] bg-gray-100 text-gray-700 hover:bg-gray-200 border-0 shrink-0';

export const formatTime = (iso: string): string => {
  const d = dayjs(iso);
  const now = dayjs();
  if (d.isSame(now, 'day')) return d.format('HH:mm');
  if (d.isSame(now.subtract(1, 'day'), 'day'))
    return `昨天 ${d.format('HH:mm')}`;
  return d.format('MM-DD HH:mm');
};

interface MessageBubbleProps {
  message: ChatMessage;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const isBot = message.role === 'bot';
  const isAgent = message.role === 'agent';
  const isRight = isAgent;

  return (
    <div
      className={`flex items-start gap-2 ${isRight ? 'justify-end' : 'justify-start'}`}
    >
      {!isRight && (
        isBot ? (
          <Image
            src={SWAN_AVATAR_URL}
            alt="小书"
            className="w-8 h-8 rounded-full shrink-0 object-cover border-0 outline-none shadow-none bg-transparent"
          />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
            <User className="w-4 h-4 text-gray-500" />
          </div>
        )
      )}
      <div className={`flex flex-col ${isRight ? 'items-end' : 'items-start'} max-w-[70%]`}>
        {isAgent && (
          <span className="text-xs text-[#9CA3AF] mb-0.5">客服</span>
        )}
        <div
          className={`px-3 py-2 text-sm break-words ${
            isAgent
              ? 'bg-[#2563EB] text-white rounded-xl rounded-tr-[4px]'
              : isBot
                ? 'bg-[#F3F4F6] text-[#1F2937] rounded-xl rounded-tl-[4px]'
                : 'bg-white border border-[#E5E7EB] text-gray-800 rounded-lg'
          }`}
        >
          {message.content}
        </div>
        <span className="text-xs text-[#9CA3AF] mt-1">{formatTime(message.createdAt)}</span>
      </div>
      {isRight && (
        <div className="w-8 h-8 rounded-full bg-green-100 flex items-center justify-center shrink-0">
          <Headphones className="w-4 h-4 text-green-600" />
        </div>
      )}
    </div>
  );
};

export default MessageBubble;

interface QuickReplyToolbarProps {
  onPick: (content: string) => void;
}

export const QuickReplyToolbar: React.FC<QuickReplyToolbarProps> = ({ onPick }) => {
  const userInfo = useCurrentUserProfile();
  const userId = userInfo?.user_id;
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [manageOpen, setManageOpen] = useState(false);
  const [newReplyDraft, setNewReplyDraft] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingDraft, setEditingDraft] = useState('');

  useEffect(() => {
    setQuickReplies([...(loadQuickReplies(userId) ?? [])]);
  }, [userId]);

  const persist = (next: string[]) => {
    setQuickReplies(next);
    saveQuickReplies(userId, next);
  };

  const handlePickQuickReply = (content: string) => {
    onPick(content);
  };

  const handleDeleteQuickReply = (idx: number) => {
    persist(quickReplies.filter((_, i) => i !== idx));
  };

  const handleAddQuickReply = () => {
    const draft = newReplyDraft.trim();
    if (!draft) return;
    persist([...quickReplies, draft]);
    setNewReplyDraft('');
  };

  const handleStartEdit = (idx: number) => {
    setEditingIndex(idx);
    setEditingDraft(quickReplies[idx]);
  };

  const handleSaveEdit = () => {
    if (editingIndex === null) return;
    const draft = editingDraft.trim();
    if (!draft) return;
    const next = quickReplies.slice();
    next[editingIndex] = draft;
    persist(next);
    setEditingIndex(null);
    setEditingDraft('');
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className={SECONDARY_BTN_CLASS}
            title="插入常用语（填入输入框，可修改后发送）"
          >
            <Zap className="w-3.5 h-3.5" />
            常用语
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80 max-h-96 overflow-y-auto">
          {(quickReplies ?? []).length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-400 text-center">
              还没有常用语，点右边的"管理"加一条
            </div>
          ) : (
            quickReplies.map((content, idx) => (
              <DropdownMenuItem
                key={idx}
                onClick={() => handlePickQuickReply(content)}
                className="py-2"
              >
                <span className="text-sm whitespace-pre-wrap line-clamp-3">
                  {content}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover open={manageOpen} onOpenChange={setManageOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 text-gray-500 hover:bg-gray-100"
            title="管理我的常用语"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-96 p-0">
          <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
            <span className="text-sm font-medium">管理我的常用语</span>
            <button
              type="button"
              onClick={() => setManageOpen(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-4 py-3 max-h-80 overflow-y-auto space-y-2">
            {(quickReplies ?? []).length === 0 ? (
              <div className="text-xs text-gray-400 text-center py-6">
                还没有常用语，在下方添加第一条
              </div>
            ) : (
              quickReplies.map((content, idx) =>
                editingIndex === idx ? (
                  <div
                    key={idx}
                    className="border border-blue-200 rounded-md p-2 bg-blue-50"
                  >
                    <Textarea
                      value={editingDraft}
                      onChange={(e) => setEditingDraft(e.target.value)}
                      className="min-h-[60px] text-sm"
                    />
                    <div className="flex justify-end gap-2 mt-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingIndex(null);
                          setEditingDraft('');
                        }}
                      >
                        取消
                      </Button>
                      <Button size="sm" onClick={handleSaveEdit}>
                        保存
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    key={idx}
                    className="group flex items-start gap-2 p-2 border border-gray-200 rounded-md hover:border-gray-300"
                  >
                    <span className="flex-1 text-sm whitespace-pre-wrap">
                      {content}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleStartEdit(idx)}
                      className="text-xs text-blue-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title="编辑"
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteQuickReply(idx)}
                      className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      title="删除"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ),
              )
            )}
          </div>
          <div className="px-4 py-3 border-t border-gray-200 space-y-2">
            <Textarea
              placeholder="新常用语内容（Enter 添加，Shift+Enter 换行）"
              value={newReplyDraft}
              onChange={(e) => setNewReplyDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleAddQuickReply();
                }
              }}
              className="min-h-[60px] text-sm"
            />
            <Button
              size="sm"
              onClick={handleAddQuickReply}
              disabled={!newReplyDraft.trim()}
              className="w-full"
            >
              <Plus className="w-3.5 h-3.5" />
              添加常用语
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
};
