import React, { useState, useEffect } from 'react';
import dayjs from 'dayjs';
import { Sparkles, Lightbulb, CheckCircle2 } from 'lucide-react';

import { Spinner } from '@client/src/components/ui/spinner';
import { getHandoffSummary, getCollectionProgress } from '@client/src/api/chat';
import { getSourceLabel } from '@shared/channels';
import { formatRequirementFieldValue } from '@client/src/utils/requirement-format';
import { generateSummary } from '@client/src/api/summary';
import type {
  HandoffSummary,
  CollectionProgress,
  CollectionProgressItem,
} from '@shared/api.interface';

const STATUS_LABELS: Record<string, string> = {
  new: '新线索',
  contacting: '联系中',
  chatting: '聊天中',
  collected: '已收集',
  closed: '已关闭',
};
const TRANSFER_LABELS: Record<string, string> = {
  customer: '客户主动',
  auto: 'AI自动',
  agent: '客服转接',
};

function formatDurationMinutes(totalMinutes: number): string {
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  const days: number = Math.floor(totalMinutes / 1440);
  const hours: number = Math.floor((totalMinutes % 1440) / 60);
  const minutes: number = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分钟`);
  return parts.join('');
}

const SectionTitle: React.FC<{ title: string }> = ({ title }) => (
  <div className="text-sm font-bold text-gray-700 border-b border-gray-100 pb-2 mb-3">{title}</div>
);

interface InfoRowProps { label: string; value: string | null | undefined; }

const InfoRow: React.FC<InfoRowProps> = ({ label, value }) => (
  <div className="flex items-center h-9">
    <span className="w-20 shrink-0 text-[13px] text-gray-500">{label}</span>
    <span className={`text-sm break-words ${value ? 'text-gray-900' : 'text-gray-300'}`}>{value || '--'}</span>
  </div>
);

interface ProgressRingProps { percent: number; collectedCount: number; totalCount: number; }

const ProgressRing: React.FC<ProgressRingProps> = ({ percent, collectedCount, totalCount }) => {
  const radius: number = 36;
  const circumference: number = 2 * Math.PI * radius;
  const color: string = percent >= 70 ? '#10B981' : '#F59E0B';
  const clamped: number = Math.min(Math.max(percent, 0), 100);
  return (
    <div className="relative w-20 h-20">
      <svg width={80} height={80} viewBox="0 0 80 80">
        <circle cx={40} cy={40} r={radius} fill="none" stroke="#F3F4F6" strokeWidth={8} />
        <circle cx={40} cy={40} r={radius} fill="none" stroke={color} strokeWidth={8}
          strokeLinecap="round" strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped / 100)} transform="rotate(-90 40 40)" />
        <text x={40} y={40} textAnchor="middle" dominantBaseline="central"
          className="fill-gray-900 text-sm font-bold">{collectedCount}/{totalCount}</text>
      </svg>
    </div>
  );
};

interface SuggestionItemProps { text: string; onClick: () => void; }

const SuggestionItem: React.FC<SuggestionItemProps> = ({ text, onClick }) => (
  <button type="button" onClick={onClick}
    className="w-full text-left p-2.5 rounded-lg border border-gray-200 bg-gray-50 hover:border-primary/40 hover:bg-primary/5 transition-colors group"
  >
    <div className="flex items-start gap-1.5">
      <Lightbulb className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
      <span className="text-xs text-gray-700 group-hover:text-primary">{text}</span>
    </div>
  </button>
);

interface ContextPanelProps {
  sessionId: string | null;
  isManager: boolean;
  suggestions: string[];
  suggestionLoading: boolean;
  onSuggestionClick: (text: string) => void;
}

const ContextPanel: React.FC<ContextPanelProps> = ({
  sessionId, isManager, suggestions, suggestionLoading, onSuggestionClick,
}) => {
  const [summary, setSummary] = useState<HandoffSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [progress, setProgress] = useState<CollectionProgress | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSummary(null);
      setAiSummary(null);
      setProgress(null);
      return;
    }
    setAiSummary(null);
    setProgress(null);
    setLoading(true);
    getHandoffSummary(sessionId, isManager)
      .then((data: HandoffSummary) => setSummary(data))
      .catch(() => setSummary(null))
      .finally(() => setLoading(false));
    getCollectionProgress(sessionId)
      .then((data: CollectionProgress) => setProgress(data))
      .catch(() => setProgress(null));
  }, [sessionId, isManager]);

  if (!sessionId) return (
    <div className="flex items-center justify-center h-full bg-white text-gray-400 text-sm px-4 text-center">
      选择会话后查看客户上下文
    </div>
  );
  if (loading) return (
    <div className="flex items-center justify-center h-full bg-white">
      <Spinner className="w-5 h-5 text-gray-400" />
    </div>
  );
  if (!summary) return (
    <div className="flex items-center justify-center h-full bg-white text-gray-400 text-sm">
      无法加载上下文信息
    </div>
  );

  return (
    <div className="h-full overflow-y-auto bg-white">
      <div className="p-5 space-y-5">
        <div>
          <SectionTitle title="基本信息" />
          <InfoRow label="姓名" value={summary.customerName} />
          <InfoRow label="电话" value={summary.phoneNumber} />
          <InfoRow label="城市" value={summary.serviceCity} />
          <InfoRow label="来源" value={getSourceLabel(summary.source)} />
          <div className="flex items-center h-9">
            <span className="w-20 shrink-0 text-[13px] text-gray-500">线索状态</span>
            <span className="inline-flex items-center px-2 py-0.5 rounded bg-gray-100 text-xs text-gray-600">
              {STATUS_LABELS[summary.leadStatus] ?? summary.leadStatus}
            </span>
          </div>
        </div>
        {progress ? (
          <div>
            <SectionTitle title="采集进度" />
            <div className="flex flex-col items-center">
              <ProgressRing percent={progress.percent} collectedCount={progress.collectedCount}
                totalCount={progress.totalCount} />
              <span className="mt-2 text-[13px] text-gray-500">需求采集完成度</span>
            </div>
            <div className="mt-3 space-y-0.5">
              {progress.items.map((item: CollectionProgressItem) => (
                <div key={item.field} className="flex items-start gap-1.5 py-0.5">
                  {item.collected ? (
                    <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0 mt-0.5" />
                  ) : (
                    <div className={`w-3 h-3 rounded-full border shrink-0 mt-0.5 ${item.required ? 'border-gray-400' : 'border-gray-300'}`} />
                  )}
                  <span className="text-xs text-gray-500 shrink-0">{item.label}
                    {item.required ? <span className="text-red-400">*</span> : null}</span>
                  {item.collected && item.value ? (
                    <span className="text-xs text-gray-800 break-words ml-auto text-right max-w-[120px] truncate">
                      {formatRequirementFieldValue(item.field, item.value)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            {progress.aiSummary ? (
              <div className="mt-3 pt-2 border-t border-gray-100">
                <div className="flex items-center gap-1 text-xs text-purple-600 mb-1">
                  <Sparkles className="w-3 h-3" />AI需求摘要
                </div>
                <p className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">
                  {progress.aiSummary}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {summary.transferredBy ? (
          <div>
            <SectionTitle title="转接摘要" />
            <div className="space-y-1">
              <p className="text-[13px] text-gray-700">
                转接原因：
                {summary.transferReason === 'AI识别紧急投诉，自动转接人工'
                  ? '情绪升级'
                  : summary.transferReason ?? '--'}
              </p>
              <p className="text-[13px] text-gray-500">
                消息数：{summary.messageCount}
              </p>
              <p className="text-[13px] text-gray-500">
                会话时长：
                {formatDurationMinutes(dayjs().diff(dayjs(summary.sessionStartedAt), 'minute'))}
              </p>
            </div>
          </div>
        ) : null}
        <div>
          <SectionTitle title="AI 对话摘要" />
          {aiSummary ? (
            <div className="rounded-lg border border-purple-200 bg-purple-50 p-2.5">
              <p className="text-xs text-gray-700 whitespace-pre-wrap leading-relaxed">{aiSummary}</p>
            </div>
          ) : (
            <button type="button" disabled={summaryLoading}
              onClick={() => {
                if (!sessionId) return;
                setSummaryLoading(true);
                setAiSummary(null);
                generateSummary(sessionId, isManager)
                  .then((res: { summary: string }) => setAiSummary(res.summary))
                  .catch(() => setAiSummary('摘要生成失败，请稍后重试'))
                  .finally(() => setSummaryLoading(false));
              }}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-purple-200 bg-purple-50 text-xs text-purple-600 hover:bg-purple-100 transition-colors disabled:opacity-50"
            >
              {summaryLoading ? (
                <><Spinner className="w-3.5 h-3.5" />AI 正在分析对话...</>
              ) : (
                <><Sparkles className="w-3.5 h-3.5" />生成 AI 对话摘要</>
              )}
            </button>
          )}
        </div>
        {suggestionLoading ? (
          <div>
            <SectionTitle title="AI 建议" />
            <div className="flex items-center gap-1.5 text-[13px] text-gray-400">
              <Spinner className="w-3.5 h-3.5" />AI 建议生成中...
            </div>
          </div>
        ) : suggestions.length > 0 ? (
          <div>
            <SectionTitle title="AI 建议" />
            <div className="space-y-1.5">
              {suggestions.map((s: string, i: number) => (
                <SuggestionItem key={i} text={s} onClick={() => onSuggestionClick(s)} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default ContextPanel;
