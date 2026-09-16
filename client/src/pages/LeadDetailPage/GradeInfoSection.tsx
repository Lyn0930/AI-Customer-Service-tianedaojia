import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, History } from 'lucide-react';
import { toast } from 'sonner';
import type { Lead, GradeHistory, LeadGrade } from '@shared/api.interface';
import { regradeLead, getLeadGradeHistory } from '@client/src/api/leads';
import { Button } from '@client/src/components/ui/button';
import { Textarea } from '@client/src/components/ui/textarea';
import { Badge } from '@client/src/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@client/src/components/ui/dialog';

const GRADE_STYLE: Record<string, string> = {
  A: 'bg-green-100 text-green-700 border-green-200',
  B: 'bg-blue-100 text-blue-700 border-blue-200',
  B_PRICE: 'bg-orange-100 text-orange-700 border-orange-200',
  C1: 'bg-purple-100 text-purple-700 border-purple-200',
  C2: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  D: 'bg-gray-100 text-gray-500 border-gray-200',
};

const GRADE_LABEL: Record<string, string> = {
  A: 'A 优质线索',
  B: 'B 普通线索',
  B_PRICE: 'B-price 预算偏低（AI培育）',
  C1: 'C1 客户主动转人工',
  C2: 'C2 待采集',
  D: 'D 无效/黑名单',
};

const TRIGGER_LABEL: Record<string, string> = {
  ai: 'AI自动',
  manual: '人工',
  system: '系统',
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

interface GradeInfoSectionProps {
  lead: Lead;
  onGradeUpdated: () => void;
}

const GradeInfoSection: React.FC<GradeInfoSectionProps> = ({ lead, onGradeUpdated }) => {
  const [history, setHistory] = useState<GradeHistory[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [regradeValue, setRegradeValue] = useState<LeadGrade>(lead.leadGrade as LeadGrade ?? 'C2');
  const [regradeReason, setRegradeReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const data = await getLeadGradeHistory(lead.id);
      setHistory(data);
    } catch {
      setHistory([]);
    }
  }, [lead.id]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const handleRegrade = async () => {
    if (!regradeReason.trim()) {
      toast.error('请填写调整原因');
      return;
    }
    setSubmitting(true);
    try {
      await regradeLead(lead.id, regradeValue, regradeReason.trim());
      toast.success('分级调整成功');
      setDialogOpen(false);
      setRegradeReason('');
      onGradeUpdated();
      loadHistory();
    } catch {
      toast.error('分级调整失败');
    } finally {
      setSubmitting(false);
    }
  };

  const confidence = lead.gradeConfidence;
  const isLowConfidence = confidence != null && confidence < 0.7;

  return (
    <div className="space-y-3">
      <div className="flex py-2 border-b border-gray-100 last:border-0">
        <span className="w-28 shrink-0 text-sm text-gray-400">分级</span>
        <div className="flex items-center gap-2">
          {lead.leadGrade ? (
            <Badge variant="outline" className={GRADE_STYLE[lead.leadGrade] ?? ''}>
              {GRADE_LABEL[lead.leadGrade] ?? lead.leadGrade}
            </Badge>
          ) : (
            <span className="text-sm text-gray-400">未评级</span>
          )}
          {isLowConfidence && (
            <span className="flex items-center gap-1 text-xs text-orange-500">
              <AlertTriangle className="h-3.5 w-3.5" />
              待复核
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => {
              setRegradeValue((lead.leadGrade as LeadGrade) ?? 'C2');
              setDialogOpen(true);
            }}
          >
            调整分级
          </Button>
        </div>
      </div>

      <div className="flex py-2 border-b border-gray-100 last:border-0">
        <span className="w-28 shrink-0 text-sm text-gray-400">置信度</span>
        {confidence != null ? (
          <div className="flex items-center gap-2">
            <div className="h-2 w-24 rounded-full bg-gray-200">
              <div
                className={`h-2 rounded-full ${isLowConfidence ? 'bg-orange-400' : 'bg-green-400'}`}
                style={{ width: `${Math.round(confidence * 100)}%` }}
              />
            </div>
            <span className={`text-sm ${isLowConfidence ? 'text-orange-500' : 'text-gray-600'}`}>
              {Math.round(confidence * 100)}%
            </span>
          </div>
        ) : (
          <span className="text-sm text-gray-400">-</span>
        )}
      </div>

      <div className="flex py-2 border-b border-gray-100 last:border-0">
        <span className="w-28 shrink-0 text-sm text-gray-400">评分</span>
        <span className="text-sm text-gray-600">
          {lead.leadScore != null ? lead.leadScore : '-'}
        </span>
      </div>

      {lead.gradeReason && (
        <div className="flex py-2 border-b border-gray-100 last:border-0">
          <span className="w-28 shrink-0 text-sm text-gray-400">分级原因</span>
          <span className="text-sm text-gray-600">{lead.gradeReason}</span>
        </div>
      )}

      {history.length > 0 && (
        <div className="py-2">
          <div className="flex items-center gap-1.5 mb-2">
            <History className="h-4 w-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-500">分级变更历史</span>
          </div>
          <div className="space-y-2 pl-2">
            {history.map((item) => (
              <div key={item.id} className="flex items-start gap-2 text-xs">
                <span className="text-gray-400 whitespace-nowrap">{formatDate(item.createdAt)}</span>
                <span className="text-gray-600">
                  <span className={GRADE_STYLE[item.oldGrade ?? ''] ?? 'text-gray-400'}>
                    {item.oldGrade ?? '-'}
                  </span>
                  {' → '}
                  <span className={GRADE_STYLE[item.newGrade] ?? 'text-gray-600'}>
                    {item.newGrade}
                  </span>
                  <span className="ml-1.5 text-gray-400">[{TRIGGER_LABEL[item.triggeredBy] ?? item.triggeredBy}]</span>
                  {item.reason && <span className="ml-1.5 text-gray-400">{item.reason}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>调整线索分级</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">目标分级</label>
              <Select value={regradeValue} onValueChange={(v) => setRegradeValue(v as LeadGrade)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(GRADE_LABEL) as LeadGrade[]).map((g) => (
                    <SelectItem key={g} value={g}>
                      {GRADE_LABEL[g]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">调整原因</label>
              <Textarea
                value={regradeReason}
                onChange={(e) => setRegradeReason(e.target.value)}
                placeholder="请填写调整原因（如：人工核实后调整、用户需求变化等）"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              取消
            </Button>
            <Button onClick={handleRegrade} disabled={submitting}>
              {submitting ? '提交中...' : '确认调整'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default GradeInfoSection;
