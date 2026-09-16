import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import { User, Send, AlertCircle, Headphones } from 'lucide-react';

import { Button } from '@client/src/components/ui/button';
import { Textarea } from '@client/src/components/ui/textarea';
import { Spinner } from '@client/src/components/ui/spinner';
import {
  getCustomerChat,
  getCustomerMessages,
  sendCustomerMessage,
  transferToHuman,
} from '@client/src/api/chat';
import type { ChatMessage, ChatSessionMode } from '@shared/api.interface';
import { Image } from '@client/src/components/ui/image';
import RequirementForm from '@client/src/pages/ChatSessionsPage/RequirementForm';

const POLL_INTERVAL = 2000;
const TYPING_DELAY = 1000;

const SWAN_AVATAR_URL = '/spark/app/app_17buybqcty0/runtime/api/v1/storage/object/bucket_aadkpgd7eesiq_static/static%2Faadkpw3e3oehg_ve_miaoda';

const formatTime = (iso: string): string => dayjs(iso).format('HH:mm');

interface MessageBubbleProps {
  message: ChatMessage;
  // 2026-08-16 林琳 16:33 拍板：钟点工问"做哪些事"时附 chip 选项
  onChipClick?: (chipText: string) => void;
  // 上一条客户消息内容（用于判断是否已经答过"做哪些事"）
  previousCustomerContent?: string;
  // 已选过的 chip 文本（用于去重 / 显示已选）
  selectedChips?: string[];
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message,
  onChipClick,
  previousCustomerContent,
  selectedChips = [],
}) => {
  const isBot = message.role === 'bot';
  const isAgent = message.role === 'agent';

  // 2026-08-16 林琳 16:33 + 20:53：识别"做哪些事"/"负责哪些事"关键词，触发 chip 渲染
  // 触发条件：
  //   1. bot 消息
  //   2. 内容含"做哪些事"/"负责哪些事"/"想阿姨做"等主流问法
  //   3. 上一条客户消息没采到 serviceItems（关键词没匹配到）
  //   4. 必须是最后一条 bot 消息（不在历史消息里渲染）
  const shouldShowChips = isBot && onChipClick && (() => {
    if (!/做哪些事|做哪些|想阿姨做|阿姨做哪些|负责哪些事|做哪些家|做哪些家务|主要想让阿姨负责/.test(message.content)) {
      return false;
    }
    if (!previousCustomerContent) return true;
    // 客户没在最近消息里提到 5 项预设 / 自定义 → 还需采集
    const keywords = ['做饭', '洗衣', '打扫', '买菜', '接送', '擦玻璃', '整理', '熨烫', '陪护', '照顾'];
    return !keywords.some((kw) => previousCustomerContent.includes(kw));
  })();

  return (
    <div
      className={`flex items-start gap-2.5 ${isBot || isAgent ? 'justify-start' : 'justify-end'}`}
    >
      {(isBot || isAgent) && (
        <Image
          src={SWAN_AVATAR_URL}
          alt="小书"
          className={`w-9 h-9 rounded-full shrink-0 object-cover border-0 outline-none shadow-none bg-transparent ${isAgent ? '' : ''}`}
        />
      )}
      <div
        className={`flex flex-col ${isBot || isAgent ? 'items-start' : 'items-end'} max-w-[70%]`}
      >
        {isAgent && (
          <span className="text-xs text-green-600 mb-0.5 px-1">客服</span>
        )}
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm break-words shadow-sm ${
            isAgent
              ? 'bg-green-50 border border-green-200 text-green-800 rounded-tl-sm'
              : isBot
                ? 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm'
                : 'bg-primary text-primary-foreground rounded-tr-sm'
          }`}
        >
          {message.content}
        </div>
        {/* 2026-08-16 林琳 16:33：钟点工 chip 选项（5 项预设 + 1 自定义） */}
        {shouldShowChips && (
          <WorkChips onSelect={onChipClick!} selectedChips={selectedChips} />
        )}
        <span className="text-xs text-gray-400 mt-1 px-1">
          {formatTime(message.createdAt)}
        </span>
      </div>
      {!isBot && !isAgent && (
        <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center shrink-0 shadow-sm">
          <User className="w-5 h-5 text-gray-500" />
        </div>
      )}
    </div>
  );
};

/**
 * 钟点工"做哪些事"快捷选项（5 项预设 + 1 自定义）
 * 2026-08-16 林琳 16:33 拍板
 * - 5 项预设：做饭 / 洗衣 / 打扫卫生 / 买菜 / 接送孩子
 * - 1 个"+ 自定义"按钮：点击展开 input 输入框
 * - 多选：客户可点多个 chip，最后点"确定"一次性发送（"做饭、洗衣、擦玻璃"）
 */
const WORK_CHIP_PRESETS = ['做饭', '洗衣', '打扫卫生', '买菜', '接送孩子'];

const WorkChips: React.FC<{
  onSelect: (text: string) => void;
  selectedChips: string[];
}> = ({ onSelect, selectedChips }) => {
  const [selected, setSelected] = useState<string[]>(selectedChips);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [customValue, setCustomValue] = useState('');

  const handlePresetClick = (chip: string) => {
    setSelected((prev) =>
      prev.includes(chip) ? prev.filter((c) => c !== chip) : [...prev, chip],
    );
  };

  const handleCustomSubmit = () => {
    const v = customValue.trim();
    if (!v) return;
    setSelected((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setCustomValue('');
    setShowCustomInput(false);
  };

  const handleConfirm = () => {
    if (selected.length === 0) return;
    // 拼接成"做饭、洗衣、擦玻璃"格式发给 AI
    onSelect(selected.join('、'));
    setSelected([]);
    setShowCustomInput(false);
    setCustomValue('');
  };

  return (
    <div className="mt-2 flex flex-col gap-2 w-full">
      <div className="flex flex-wrap gap-1.5">
        {WORK_CHIP_PRESETS.map((chip) => {
          const isSelected = selected.includes(chip);
          return (
            <button
              key={chip}
              type="button"
              onClick={() => handlePresetClick(chip)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
                isSelected
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-white text-gray-700 border-gray-300 hover:border-primary hover:text-primary'
              }`}
            >
              {chip}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setShowCustomInput((v) => !v)}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
            showCustomInput
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-white text-gray-700 border-dashed border-gray-400 hover:border-primary hover:text-primary'
          }`}
        >
          + 自定义
        </button>
      </div>
      {showCustomInput && (
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCustomSubmit();
              }
            }}
            placeholder="输入阿姨需要做的事（如：擦玻璃）"
            className="flex-1 px-3 py-1.5 rounded-lg text-xs border border-gray-300 focus:outline-none focus:border-primary"
            maxLength={20}
          />
          <button
            type="button"
            onClick={handleCustomSubmit}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            添加
          </button>
        </div>
      )}
      {selected.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">已选：{selected.join('、')}</span>
          <button
            type="button"
            onClick={handleConfirm}
            className="px-3 py-1 rounded-lg text-xs font-medium bg-primary text-primary-foreground hover:opacity-90"
          >
            发送给 AI
          </button>
          <button
            type="button"
            onClick={() => setSelected([])}
            className="px-3 py-1 rounded-lg text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            清空
          </button>
        </div>
      )}
    </div>
  );
};

const TypingIndicator: React.FC = () => (
  <div className="flex items-start gap-2.5 justify-start">
    <Image
      src={SWAN_AVATAR_URL}
      alt="小书"
      className="w-9 h-9 rounded-full shrink-0 object-cover border-0 outline-none shadow-none bg-transparent"
    />
    <div className="bg-white border border-gray-200 rounded-2xl rounded-tl-sm px-4 py-3 shadow-sm">
      <div className="flex items-center gap-1">
        <span
          className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"
          style={{ animationDelay: '0ms', animationDuration: '1s' }}
        />
        <span
          className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"
          style={{ animationDelay: '150ms', animationDuration: '1s' }}
        />
        <span
          className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"
          style={{ animationDelay: '300ms', animationDuration: '1s' }}
        />
      </div>
    </div>
  </div>
);

const WaitingIndicator: React.FC = () => (
  <div className="flex items-center justify-center gap-2 py-3 text-sm text-orange-500">
    <AlertCircle className="w-4 h-4" />
    <span>正在为您转接人工客服，请稍候...</span>
  </div>
);

/**
 * "续聊"提示气泡（2026-08-16 新增）
 *
 * 触发条件：session.startedAt 距今 > 2 小时 且 当前有历史消息
 * 作用：客户退出后再次回到 chat，看到"以上是您 X 月 X 号的对话"提示
 * 设计：纯客户端判断，不写库，不污染 DB
 */
const RESUME_THRESHOLD_HOURS = 2;
const SessionResumeBanner: React.FC<{ startedAt: string | null; hasMessages: boolean }> = ({
  startedAt,
  hasMessages,
}) => {
  if (!startedAt || !hasMessages) return null;
  const startTime = new Date(startedAt).getTime();
  if (Number.isNaN(startTime)) return null;
  const hoursAgo = (Date.now() - startTime) / (1000 * 60 * 60);
  if (hoursAgo <= RESUME_THRESHOLD_HOURS) return null;

  const whenText = dayjs(startedAt).format('M 月 D 号 HH:mm');
  return (
    <div className="flex justify-center">
      <div className="bg-gray-100 border border-gray-200 rounded-lg px-4 py-2 text-xs text-gray-500 text-center max-w-[80%]">
        以上是您 {whenText} 的对话记录，可以接着聊～
      </div>
    </div>
  );
};

const CustomerChatPage: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const [sessionMode, setSessionMode] = useState<ChatSessionMode>('ai');
  const [sessionStartedAt, setSessionStartedAt] = useState<string | null>(null);
  const [agentConnected, setAgentConnected] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [submittedFormIds, setSubmittedFormIds] = useState<Set<string>>(new Set());

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionEndedRef = useRef(false);

  const pollMessages = useCallback(async () => {
    if (sessionEndedRef.current) return;
    try {
      const result = await getCustomerMessages(token, lastMessageIdRef.current);
      if (result.mode !== sessionMode) {
        setSessionMode(result.mode);
        if (result.mode === 'ai') {
          setAgentConnected(false);
        }
      }
      if (result.messages.length > 0) {
        setMessages((prev: ChatMessage[]) => {
          const existingIds = new Set(prev.map((m: ChatMessage) => m.id));
          const newMsgs = result.messages.filter((m: ChatMessage) => !existingIds.has(m.id));
          if (newMsgs.length === 0) return prev;
          return [...prev, ...newMsgs];
        });
        lastMessageIdRef.current = result.messages[result.messages.length - 1].id;
        const hasAgentMsg = result.messages.some(
          (m: ChatMessage) => m.role === 'agent',
        );
        if (hasAgentMsg) {
          setAgentConnected(true);
          setIsTyping(false);
        }
        const hasBotReply = result.messages.some(
          (m: ChatMessage) => m.role === 'bot' || m.role === 'agent',
        );
        if (hasBotReply) {
          setIsTyping(false);
          if (typingTimerRef.current) {
            clearTimeout(typingTimerRef.current);
            typingTimerRef.current = null;
          }
        }
      }
    } catch {
      // 静默处理轮询错误
    }
  }, [token, sessionMode]);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      try {
        const data = await getCustomerChat(token);
        if (cancelled) return;
        setMessages(data.messages);
        if (data.messages.length > 0) {
          lastMessageIdRef.current = data.messages[data.messages.length - 1].id;
        }
        setSessionMode(data.session.mode);
        // 2026-08-16 增量：记下 session.startedAt，用于判断"续聊"提示
        setSessionStartedAt(data.session.startedAt);
        if (data.session.mode === 'human') {
          setAgentConnected(
            data.messages.some((m: ChatMessage) => m.role === 'agent'),
          );
        }
        if (data.session.status === 'completed') {
          sessionEndedRef.current = true;
        }
        setLoading(false);
      } catch (err: any) {
        if (cancelled) return;
        const status = err?.response?.status;
        if (status === 404) {
          setError('链接无效或已过期');
        } else {
          setError('加载失败，请重试');
        }
        setLoading(false);
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (loading || error) return;

    pollTimerRef.current = setInterval(pollMessages, POLL_INTERVAL);

    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [loading, error, pollMessages]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  // 2026-08-16 林琳 16:33：跟踪最近客户消息内容，用于 MessageBubble 判断是否还显示 chip
  const lastCustomerContent = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'customer') return messages[i].content;
    }
    return undefined;
  }, [messages]);

  const handleTransfer = useCallback(async () => {
    if (transferring || sessionMode === 'human') return;
    setTransferring(true);
    try {
      await transferToHuman(token);
      setSessionMode('human');
      if (typingTimerRef.current) {
        clearTimeout(typingTimerRef.current);
      }
      setIsTyping(false);
    } catch {
      // 转人工失败静默处理
    } finally {
      setTransferring(false);
    }
  }, [token, transferring, sessionMode]);

  // 2026-08-16 林琳 16:33：handleSend 接受可选 override 文本，用于 chip 选中后直接发送
  const handleSend = useCallback(async (overrideText?: string) => {
    const content = (overrideText ?? inputValue).trim();
    if (!content || sending) return;

    setSending(true);
    setInputValue('');

    try {
      const newMsg = await sendCustomerMessage(token, { content });
      setMessages((prev: ChatMessage[]) =>
        prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg],
      );
      lastMessageIdRef.current = newMsg.id;

      if (sessionMode === 'ai') {
        if (typingTimerRef.current) {
          clearTimeout(typingTimerRef.current);
        }
        typingTimerRef.current = setTimeout(() => {
          setIsTyping(true);
        }, TYPING_DELAY);
      }
    } catch {
      setInputValue(content);
    } finally {
      setSending(false);
    }
  }, [inputValue, sending, token, sessionMode]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isWaitingForAgent = sessionMode === 'human' && !agentConnected;

  if (loading) {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-gray-50">
        <Spinner className="w-8 h-8 text-primary mb-3" />
        <span className="text-gray-500 text-sm">正在连接...</span>
      </div>
    );
  }

  if (error) {
    const isInvalidLink = error === '链接无效或已过期';
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center bg-gray-50">
        <AlertCircle className="w-12 h-12 text-gray-400 mb-3" />
        <span className="text-gray-500 text-sm">{error}</span>
        {!isInvalidLink && (
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-4 py-1.5 text-sm text-white bg-blue-500 rounded-lg hover:bg-blue-600"
          >
            重试
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 flex justify-center bg-gray-200">
      <div className="w-full max-w-lg h-full flex flex-col bg-gray-100 shadow-lg">
      {/* 顶部栏 */}
      <div className="flex items-center gap-3 px-4 py-3 bg-white border-b border-gray-200 shadow-sm shrink-0">
        <div
          className={`w-10 h-10 rounded-full shrink-0 overflow-hidden border-0 outline-none shadow-none bg-transparent ${
            agentConnected ? 'ring-2 ring-green-400' : ''
          }`}
        >
          <Image src={SWAN_AVATAR_URL} alt="小书" className="w-full h-full object-cover border-0 outline-none shadow-none bg-transparent" />
        </div>
        <div className="flex flex-col">
          <span className="font-semibold text-gray-900 text-sm">
            {agentConnected ? '人工客服' : '小书'}
          </span>
          <span className="text-xs text-gray-500">
            {agentConnected
              ? '专员正在为您服务'
              : isWaitingForAgent
                ? '正在转接人工客服...'
                : '金牌保姆推荐官'}
          </span>
        </div>
      </div>

      {/* 消息区域 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-400 text-sm">
            <Image src={SWAN_AVATAR_URL} alt="小书" className="w-12 h-12 mb-3 opacity-30 rounded-full border-0 outline-none shadow-none bg-transparent" />
            <span>开始与小书对话吧</span>
          </div>
        ) : (
          <>
            {/* 2026-08-16 续聊提示：session.startedAt 距今 > 2h 时顶部插入 system bubble */}
            <SessionResumeBanner startedAt={sessionStartedAt} hasMessages={messages.length > 0} />
            {messages.map((msg: ChatMessage, index: number) => {
              // form_card 类型消息：渲染需求表单
              if (msg.type === 'form_card' && msg.formCard) {
                // 判断表单是否已提交：跳过引导语消息后，还有后续消息就算提交了
                const hasGuidanceNext =
                  index + 1 < messages.length &&
                  messages[index + 1].role === 'bot' &&
                  messages[index + 1].content.includes('好嘞');
                const hasMsgAfterGuidance = hasGuidanceNext
                  ? index + 2 < messages.length
                  : index + 1 < messages.length;
                const isSubmitted = hasMsgAfterGuidance || submittedFormIds.has(msg.id);
                return (
                  <div
                    key={msg.id}
                    className="flex items-start gap-2.5 justify-start"
                    data-ai-section-type="card-form"
                  >
                    <Image
                      src={SWAN_AVATAR_URL}
                      alt="小书"
                      className="w-9 h-9 rounded-full shrink-0 object-cover border-0 outline-none shadow-none bg-transparent"
                    />
                    <RequirementForm
                      token={token}
                      serviceType={msg.formCard.serviceType}
                      submitted={isSubmitted}
                      onSubmitted={() =>
                        setSubmittedFormIds((prev) => new Set(prev).add(msg.id))
                      }
                    />
                  </div>
                );
              }
              return (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  onChipClick={handleSend}
                  previousCustomerContent={lastCustomerContent}
                  selectedChips={[]}
                />
              );
            })}
          </>
        )}
        {isTyping && <TypingIndicator />}
        {isWaitingForAgent && !isTyping && <WaitingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入区域 */}
      <div className="px-4 py-3 bg-white border-t border-gray-200 shrink-0">
        {agentConnected && (
          <div className="flex items-center gap-1.5 mb-2 px-1 text-xs text-green-600">
            <Headphones className="w-3.5 h-3.5" />
            <span>人工客服已接入，专员正在为您服务</span>
          </div>
        )}
        {isWaitingForAgent && (
          <div className="flex items-center gap-1.5 mb-2 px-1 text-xs text-orange-500">
            <Headphones className="w-3.5 h-3.5" />
            <span>正在为您转接人工客服，请稍候...</span>
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            value={inputValue}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
              setInputValue(e.target.value)
            }
            onKeyDown={handleKeyDown}
            placeholder="输入消息，Enter 发送，Shift+Enter 换行"
            className="min-h-[44px] max-h-32 resize-none field-sizing-none"
            rows={1}
            disabled={sending}
          />
          <Button
            size="icon"
            onClick={() => handleSend()}
            disabled={!inputValue.trim() || sending}
            className="shrink-0 h-11 w-11"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
};

export default CustomerChatPage;
