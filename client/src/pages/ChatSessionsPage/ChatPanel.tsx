import React, { useEffect, useRef, useState } from 'react';
import {
  Phone,
  MapPin,
  User,
  Headphones,
  Send,
  MessageSquare,
  Sparkles,
  FileText,
  AlertTriangle,
  ArrowRightLeft,
} from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Textarea } from '@client/src/components/ui/textarea';
import { Spinner } from '@client/src/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@client/src/components/ui/dialog';
import type {
  ChatSessionDetail,
  ChatMessage,
  ChatSessionStatus,
  ChatSessionMode,
  AgentRecord,
  AgentOnlineStatus,
} from '@shared/api.interface';
import { Image } from '@client/src/components/ui/image';
import { generateConfirmationCard, type ConfirmationCardResponse } from '@client/src/api/chat';
import { getAgentList, getOnlineAgents } from '@client/src/api/routing';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { formatRequirementFieldValue } from '@client/src/utils/requirement-format';
import RequirementForm from './RequirementForm';
import MessageBubble, { SWAN_AVATAR_URL, QuickReplyToolbar } from './ChatMessageBubble';

const SECONDARY_BTN_CLASS =
  'h-8 rounded-md px-3 text-[13px] bg-gray-100 text-gray-700 hover:bg-gray-200 border-0 shrink-0';

const STATUS_MAP: Record<
  ChatSessionStatus,
  { label: string; className: string }
> = {
  active: {
    label: '进行中',
    className: 'border-transparent bg-[#DCFCE7] text-[#059669]',
  },
  completed: {
    label: '已结束',
    className: 'border-transparent bg-[#F3F4F6] text-gray-600',
  },
};

const MODE_MAP: Record<ChatSessionMode, { label: string; className: string }> = {
  ai: { label: 'AI 自动', className: 'bg-blue-100 text-blue-700' },
  human: { label: '人工接管', className: 'bg-orange-100 text-orange-700' },
};

interface ChatPanelProps {
  detail: ChatSessionDetail | null;
  loading: boolean;
  isManager: boolean;
  actionLoading: boolean;
  suggestionLoading: boolean;
  suggestionText: string | null;
  onTakeover: () => void;
  onRelease: () => void;
  onReassign: (targetAgentId: string) => void;
  onSendAgentMessage: (content: string) => void;
  onRequestSuggestions: () => void;
}

const ChatPanel: React.FC<ChatPanelProps> = ({
  detail,
  loading,
  isManager,
  actionLoading,
  suggestionLoading,
  suggestionText,
  onTakeover,
  onRelease,
  onReassign,
  onSendAgentMessage,
  onRequestSuggestions,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [inputText, setInputText] = useState('');

  // 2026-08-16 19:35 林琳拍板：需求确认卡片
  const [cardModalOpen, setCardModalOpen] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardData, setCardData] = useState<ConfirmationCardResponse | null>(null);
  const [cardText, setCardText] = useState('');

  const [submittedFormIds, setSubmittedFormIds] = useState<Set<string>>(new Set());

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassignLoading, setReassignLoading] = useState(false);
  const [onlineAgentOptions, setOnlineAgentOptions] = useState<AgentRecord[]>([]);
  const [pickedAgentId, setPickedAgentId] = useState<string | null>(null);

  // 智能滚动：只在用户本来就停靠在底部时才跟随新消息；
  // 用户向上翻看历史时，新消息不会把视口拽回底部（不打断阅读、不影响输入）
  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setIsAtBottom(scrollHeight - scrollTop - clientHeight < 50);
  };

  useEffect(() => {
    if (scrollRef.current && isAtBottom) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [detail?.messages, loading, isAtBottom]);

  useEffect(() => {
    if (suggestionText) {
      setInputText(suggestionText);
    }
  }, [suggestionText]);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text) return;
    onSendAgentMessage(text);
    setInputText('');
  };

  // 2026-08-16 19:35 林琳拍板：生成需求确认卡片
  const handleGenerateCard = async () => {
    if (!detail?.id) return;
    setCardLoading(true);
    setCardModalOpen(true);
    try {
      const data = await generateConfirmationCard(detail.id);
      setCardData(data);
      setCardText(data.text);
    } catch (err) {
      logger.error('生成需求确认卡片失败', String(err));
      setCardData(null);
      setCardText('');
    } finally {
      setCardLoading(false);
    }
  };

  const handleInsertCardToInput = () => {
    const text = cardText.trim();
    if (!text) return;
    setInputText(text);
    setCardModalOpen(false);
  };

  const handlePickQuickReply = (content: string) => {
    setInputText(content);
  };

  const handleOpenReassign = async () => {
    setReassignOpen(true);
    setPickedAgentId(null);
    setReassignLoading(true);
    try {
      const [agentRes, online] = await Promise.all([getAgentList(), getOnlineAgents()]);
      const onlineIds = new Set(online.map((o: AgentOnlineStatus) => o.assigneeId));
      setOnlineAgentOptions(
        agentRes.items.filter(
          (a: AgentRecord) => onlineIds.has(a.id) && a.id !== detail?.lead?.assigneeId,
        ),
      );
    } catch (err) {
      logger.error('加载在线经纪人失败', String(err));
      setOnlineAgentOptions([]);
    } finally {
      setReassignLoading(false);
    }
  };

  const handleConfirmReassign = () => {
    if (!pickedAgentId) return;
    setReassignOpen(false);
    onReassign(pickedAgentId);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner className="w-6 h-6 text-gray-400" />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <MessageSquare className="w-12 h-12 mb-3 opacity-40" />
        <span>请从左侧选择一个会话查看详情</span>
      </div>
    );
  }

  const lead = detail.lead;
  const statusInfo = STATUS_MAP[detail.status] ?? STATUS_MAP.completed;
  const modeInfo = MODE_MAP[detail.mode] ?? MODE_MAP.ai;
  const isHumanMode = detail.mode === 'human';
  const canOperate = !isManager;

  return (
    <div className="flex flex-col h-full">
      <div className="h-14 px-4 border-b border-[#E5E7EB] bg-white">
        <div className="flex h-full items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-base font-bold text-[#111827] shrink-0">
              {lead?.phoneNumber ?? '—'}
            </span>
            <div className="flex items-center gap-2 text-[13px] text-[#6B7280] min-w-0">
              <span className="flex items-center gap-1 truncate">
                <User className="w-3 h-3" />
                {lead?.customerName ?? '未知客户'}
              </span>
              {detail.transferredBy ? (
                <span
                  className={`shrink-0 px-2 py-0.5 rounded-full text-xs font-medium ${
                    detail.transferredBy === 'agent'
                      ? 'bg-[#EFF6FF] text-[#2563EB]'
                      : 'bg-[#FFF7ED] text-[#F59E0B]'
                  }`}
                >
                  {detail.transferredBy === 'agent' ? '人工转接' : 'AI 转接'}
                </span>
              ) : null}
              <span className="flex items-center gap-1 truncate">
                <MapPin className="w-3 h-3" />
                {lead?.serviceCity ?? '—'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge className={modeInfo.className}>{modeInfo.label}</Badge>
            <Badge className={statusInfo.className}>{statusInfo.label}</Badge>
            {canOperate &&
              (isHumanMode ? (
                <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleOpenReassign}
                  disabled={actionLoading}
                  className="h-8 text-gray-700 hover:bg-gray-100"
                >
                  <ArrowRightLeft className="w-3.5 h-3.5" />
                  转接
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRelease}
                  disabled={actionLoading}
                  className="h-8 text-gray-700 hover:bg-gray-100"
                >
                  释放回 AI
                </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onTakeover}
                  disabled={actionLoading}
                  className="h-8 text-gray-700 hover:bg-gray-100"
                >
                  <Headphones className="w-3.5 h-3.5" />
                  接管
                </Button>
              ))}
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-4 bg-gray-50"
      >
        {(detail.messages ?? []).length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">
            暂无聊天记录
          </div>
        ) : (
          detail.messages.map((msg: ChatMessage, index: number) => {
            if (msg.type === 'form_card' && msg.formCard) {
              const isSubmitted = submittedFormIds.has(msg.id) || Boolean(detail.requirement?.cardSubmittedAt);
              return (
                <div
                  key={msg.id}
                  className="flex items-start gap-2 justify-start"
                  data-ai-section-type="card-form"
                >
                  <Image
                    src={SWAN_AVATAR_URL}
                    alt="小书"
                    className="w-8 h-8 rounded-full shrink-0 object-cover border-0 outline-none shadow-none bg-transparent"
                  />
                  <RequirementForm
                    sessionId={detail.id}
                    serviceType={msg.formCard.serviceType}
                    submitted={isSubmitted}
                    onSubmitted={() =>
                      setSubmittedFormIds((prev) => new Set(prev).add(msg.id))
                    }
                  />
                </div>
              );
            }
            return <MessageBubble key={msg.id} message={msg} />;
          })
        )}
      </div>

      {canOperate && isHumanMode && (
        <>
          <div className="h-10 px-4 border-t border-[#E5E7EB] bg-white flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onRequestSuggestions}
              disabled={suggestionLoading}
              className={SECONDARY_BTN_CLASS}
            >
              <Sparkles className={`w-3.5 h-3.5 ${suggestionLoading ? 'animate-spin' : ''}`} />
              AI建议
            </Button>
            <QuickReplyToolbar onPick={handlePickQuickReply} />
            <Button
              size="sm"
              className="h-8 rounded-md px-3 text-[13px] shrink-0"
              onClick={handleGenerateCard}
              disabled={cardLoading || !detail?.id}
              title="生成需求确认卡片（发给客户让他再次确认之前沟通的所有需求）"
            >
              {cardLoading ? (
                <Spinner className="w-3.5 h-3.5 mr-1" />
              ) : (
                <FileText className="w-3.5 h-3.5 mr-1" />
              )}
              生成确认卡片
            </Button>
          </div>
          <div className="px-4 py-3 border-t border-[#E5E7EB] bg-white">
            <div className="rounded-lg border border-[#E5E7EB] focus-within:border-[#2563EB] focus-within:ring-1 focus-within:ring-[#2563EB] transition-colors">
              <Textarea
                placeholder="输入消息..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={handleKeyDown}
                className="min-h-[72px] max-h-[200px] border-0 p-3 text-sm resize-none focus-visible:ring-0 focus-visible:ring-offset-0"
              />
              <div className="flex items-center justify-between px-3 pb-2">
                <span className="text-xs text-gray-400">
                  Enter 发送 · Shift+Enter 换行
                </span>
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={actionLoading || !inputText.trim()}
                  title="发送"
                  className="h-8 w-8 rounded-full bg-[#2563EB] text-white hover:bg-[#1D4ED8] disabled:bg-[#D1D5DB] disabled:cursor-not-allowed shrink-0"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </div>
        </>
      )}

      {isManager && (
        <div className="px-4 py-2 border-t border-gray-200 bg-gray-50 text-center text-xs text-gray-400">
          管理者模式下为只读，无法操作会话
        </div>
      )}

      {/* 2026-08-16 19:35 林琳拍板：需求确认卡片模态框（发给客户让他再次确认） */}
      <Dialog open={cardModalOpen} onOpenChange={setCardModalOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="w-4 h-4" />
              需求确认卡片
              {cardData?.serviceTypeLabel && (
                <Badge variant="secondary" className="ml-2 text-xs">
                  {cardData.serviceTypeLabel}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              AI 基于已采集需求生成的结构化文本，客服可编辑后插入到输入框发送
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-3 py-2">
            {cardLoading && (
              <div className="text-center text-sm text-gray-500 py-8">
                <Spinner className="w-5 h-5 mx-auto mb-2" />
                正在生成...
              </div>
            )}

            {!cardLoading && !cardData && (
              <div className="text-center text-sm text-red-500 py-8">
                生成失败，请稍后重试
              </div>
            )}

            {!cardLoading && cardData && (
              <>
                {cardData.canSend ? (
                  <div className="text-xs text-green-600 bg-green-50 px-3 py-2 rounded">
                    ✓ 必填项已全部采集，可放心发给客户
                  </div>
                ) : (
                  <div className="text-xs text-orange-700 bg-orange-50 px-3 py-2 rounded flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <div>
                      必填项未采：
                      {(cardData.missingRequired ?? []).map((label, i) => (
                        <span key={label} className="font-medium">
                          {i > 0 && '、'}
                          {label}
                        </span>
                      ))}
                      <span className="block mt-1 text-orange-600">
                        仍可发送（由客服判断是否需要先补采）
                      </span>
                    </div>
                  </div>
                )}

                <div>
                  <div className="text-xs text-gray-500 mb-1.5">
                    卡片内容（可编辑）：
                  </div>
                  <Textarea
                    value={cardText}
                    onChange={(e) => setCardText(e.target.value)}
                    className="min-h-[260px] text-sm font-mono leading-relaxed"
                    placeholder="卡片内容"
                  />
                </div>

                <div>
                  <div className="text-xs text-gray-500 mb-1.5">
                    字段预览（共 {(cardData.fields ?? []).length} 项）：
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {(cardData.fields ?? []).map((f) => (
                      <div
                        key={f.key}
                        className={`text-xs px-2 py-1.5 rounded border ${
                          f.filled
                            ? 'border-green-200 bg-green-50 text-green-800'
                            : f.required
                              ? 'border-orange-200 bg-orange-50 text-orange-800'
                              : 'border-gray-200 bg-gray-50 text-gray-500'
                        }`}
                      >
                        <div className="font-medium">
                          {f.label}
                          {f.required && <span className="text-red-500 ml-0.5">*</span>}
                          {!f.filled && (
                            <span className="ml-1 text-orange-600">（未提供）</span>
                          )}
                        </div>
                        {f.filled && (
                          <div className="truncate text-gray-700 mt-0.5">
                            {formatRequirementFieldValue(f.key, f.value) ?? ''}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                取消
              </Button>
            </DialogClose>
            <Button
              size="sm"
              onClick={handleInsertCardToInput}
              disabled={!cardText.trim() || cardLoading}
            >
              插入到输入框
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>转接会话</DialogTitle>
            <DialogDescription>选择一位在线经纪人接管当前会话</DialogDescription>
          </DialogHeader>
          <div className="max-h-60 overflow-y-auto space-y-1.5">
            {reassignLoading ? (
              <div className="flex justify-center py-6">
                <Spinner className="w-5 h-5 text-gray-400" />
              </div>
            ) : onlineAgentOptions.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">暂无其他在线经纪人</p>
            ) : (
              onlineAgentOptions.map((a: AgentRecord) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setPickedAgentId(a.id)}
                  className={`w-full flex items-center justify-between rounded-md border px-3 py-2 text-sm ${
                    pickedAgentId === a.id
                      ? 'border-orange-400 bg-orange-50 text-orange-700'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <span>{a.name}</span>
                  <span className="text-xs text-gray-400">{a.city || '--'}</span>
                </button>
              ))
            )}
          </div>
          <DialogFooter className="gap-2">
            <DialogClose asChild>
              <Button variant="ghost" size="sm">取消</Button>
            </DialogClose>
            <Button size="sm" disabled={!pickedAgentId || actionLoading} onClick={handleConfirmReassign}>
              确认转接
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ChatPanel;
