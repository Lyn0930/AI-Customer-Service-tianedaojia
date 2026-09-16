import React, { useState, useEffect } from 'react';
import { Pencil } from 'lucide-react';
import type { Requirement } from '@shared/api.interface';
import { updateRequirement } from '@client/src/api/leads';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@client/src/components/ui/dialog';

interface FieldConfig {
  key: string;
  label: string;
  type: 'input' | 'textarea';
}

const FIELDS: FieldConfig[] = [
  { key: 'serviceType', label: '服务类型', type: 'input' },
  { key: 'householdSize', label: '家庭人口', type: 'input' },
  { key: 'area', label: '面积', type: 'input' },
  { key: 'elderlyCare', label: '老人照护', type: 'textarea' },
  { key: 'restDays', label: '休息天数', type: 'input' },
  { key: 'startTime', label: '到岗时间', type: 'input' },
  { key: 'serviceAddress', label: '服务地址', type: 'textarea' },
  { key: 'helperRequirements', label: '阿姨要求', type: 'textarea' },
  { key: 'dietaryPreferences', label: '口味偏好', type: 'textarea' },
  { key: 'budget', label: '预算', type: 'input' },
  { key: 'specialRequirements', label: '特殊需求', type: 'textarea' },
];

interface RequirementEditDialogProps {
  leadId: string;
  requirement: Requirement;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}

const RequirementEditDialog: React.FC<RequirementEditDialogProps> = ({
  leadId,
  requirement,
  open,
  onOpenChange,
  onSuccess,
}) => {
  const [form, setForm] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      const initial: Record<string, string> = {};
      for (const f of FIELDS) {
        const val = requirement[f.key as keyof typeof requirement];
        initial[f.key] = typeof val === 'string' ? val : '';
      }
      setForm(initial);
    }
  }, [open, requirement]);

  const handleChange = (key: string, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const data: Record<string, string> = {};
      for (const f of FIELDS) {
        data[f.key] = form[f.key] ?? '';
      }
      await updateRequirement(leadId, data);
      toast.success('需求信息已更新');
      onOpenChange(false);
      onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新需求信息失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-4 h-4" />
            编辑需求信息
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3 py-4">
          {FIELDS.map((f) => (
            <div
              key={f.key}
              className={f.type === 'textarea' ? 'sm:col-span-2 space-y-1' : 'space-y-1'}
            >
              <label className="text-sm font-medium text-gray-700">{f.label}</label>
              {f.type === 'input' ? (
                <Input
                  value={form[f.key] ?? ''}
                  onChange={(e) => handleChange(f.key, e.target.value)}
                />
              ) : (
                <Textarea
                  value={form[f.key] ?? ''}
                  onChange={(e) => handleChange(f.key, e.target.value)}
                  className="min-h-16"
                />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RequirementEditDialog;
