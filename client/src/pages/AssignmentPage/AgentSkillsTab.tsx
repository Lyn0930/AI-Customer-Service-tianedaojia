import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Plus, Trash2, Pencil, X, Check, ChevronsUpDown } from 'lucide-react';
import { toast } from 'sonner';
import type { AgentSkill } from '@shared/api.interface';
import {
  getAgentSkills,
  createAgentSkill,
  deleteAgentSkill,
} from '@client/src/api/routing';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@client/src/components/ui/dialog';
import { Badge } from '@client/src/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { UserSelect } from '@/components/business-ui/user-select';
import { UserDisplay } from '@/components/business-ui/user-display';
import { showConfirm } from '@lark-apaas/client-toolkit';

/** 客服技能标签（与 server 端 SKILL_TAG_MAP / BAOMU_SUBSKILLS / 数据迁移保持一致）
 *  命名约定：统一用"全名+角色"（白班保姆/育儿保姆），不再用短码或单字别名 */
const SKILL_OPTIONS = [
  { value: '钟点工保姆', label: '钟点工保姆' },
  { value: '白班保姆', label: '白班保姆' },
  { value: '住家保姆', label: '住家保姆' },
  { value: '育儿保姆', label: '育儿保姆' },
  { value: '护工保姆', label: '护工保姆' },
  { value: '养老保姆', label: '养老保姆' },
  { value: '菲式保姆', label: '菲式保姆' },
  { value: '投诉处理', label: '投诉处理' },
  { value: '售后处理', label: '售后处理' },
  { value: '通用咨询', label: '通用咨询' },
];

const SKILL_LABEL_MAP = new Map(
  SKILL_OPTIONS.map((o) => [o.value, o.label]),
);

/** 老值兼容：历史版本里用过的 skillTag（短码 / 旧全名），UI 显示映射到新 label。
 *  实际数据迁移在 server 端 schema-migration 跑；这里只保证 UI 不出现"陌生 tag" */
const LEGACY_LABEL_MAP: Record<string, string> = {
  钟点工: '钟点工保姆',
  白班: '白班保姆',
  住家: '住家保姆',
  育儿: '育儿保姆',
  护工: '护工保姆',
  养老: '养老保姆',
  菲式: '菲式保姆',
  育儿嫂: '育儿保姆',
  白班阿姨: '白班保姆',
  养老照护: '养老保姆',
  '26天月嫂': '26天月嫂',
};

const skillLabel = (tag: string): string =>
  SKILL_LABEL_MAP.get(tag) ?? LEGACY_LABEL_MAP[tag] ?? tag;

interface AgentSkillGroup {
  assigneeId: string;
  skills: AgentSkill[];
}

/** 多选下拉:已选项以 chip 展示,触发器打开 popover 显示可选项(可搜索/可勾选) */
function SkillMultiSelect({
  options,
  value,
  onChange,
  placeholder = '请选择技能标签',
  excludeValues = [],
}: {
  options: { value: string; label: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  excludeValues?: string[];
}) {
  const [open, setOpen] = useState(false);
  const toggle = (v: string) => {
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  };
  const available = options.filter(
    (o) => !excludeValues.includes(o.value) || value.includes(o.value),
  );
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((v) => (
            <Badge key={v} variant="secondary" className="gap-1 pr-1">
              {skillLabel(v)}
              <button
                type="button"
                onClick={() => toggle(v)}
                className="ml-1 rounded hover:bg-gray-300/60"
                aria-label={`移除 ${skillLabel(v)}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
            type="button"
          >
            <span className="text-gray-500">{placeholder}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command>
            <CommandInput placeholder="搜索技能..." />
            <CommandList>
              <CommandEmpty>未找到技能</CommandEmpty>
              <CommandGroup>
                {available.map((opt) => {
                  const selected = value.includes(opt.value);
                  const disabled = excludeValues.includes(opt.value) && !selected;
                  return (
                    <CommandItem
                      key={opt.value}
                      value={opt.label}
                      disabled={disabled}
                      onSelect={() => {
                        if (disabled) return;
                        toggle(opt.value);
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 h-4 w-4',
                          selected ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <span className={disabled ? 'text-gray-400' : ''}>
                        {opt.label}
                        {disabled && (
                          <span className="ml-1 text-xs text-gray-400">(已配置)</span>
                        )}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const AgentSkillsTab: React.FC = () => {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [newAssignee, setNewAssignee] = useState<string | null>(null);
  const [newSkills, setNewSkills] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [editTarget, setEditTarget] = useState<AgentSkillGroup | null>(null);
  const [editSkills, setEditSkills] = useState<string[]>([]);
  const [editPickerValue, setEditPickerValue] = useState<string[]>([]);

  const fetchSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAgentSkills();
      setSkills(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  // 按专员分组(后端已按 assigneeId 排序,这里再保险 group)
  const groups = useMemo<AgentSkillGroup[]>(() => {
    const map = new Map<string, AgentSkillGroup>();
    for (const s of skills) {
      if (!map.has(s.assigneeId)) {
        map.set(s.assigneeId, { assigneeId: s.assigneeId, skills: [] });
      }
      map.get(s.assigneeId)!.skills.push(s);
    }
    return Array.from(map.values());
  }, [skills]);

  const handleAdd = async () => {
    if (!newAssignee || newSkills.length === 0) return;
    setSubmitting(true);
    try {
      // 同一专员多技能并发创建(后端有 uniqueIndex 兜底,冲突会被自然吃掉)
      const results = await Promise.allSettled(
        newSkills.map((tag) =>
          createAgentSkill({ assigneeId: newAssignee, skillTag: tag }),
        ),
      );
      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      const failCount = results.length - okCount;
      if (failCount > 0) {
        toast.warning(`已添加 ${okCount} 项,${failCount} 项失败(可能已存在)`);
      } else {
        toast.success(`成功添加 ${okCount} 项技能`);
      }
      setAddOpen(false);
      setNewAssignee(null);
      setNewSkills([]);
      fetchSkills();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '添加失败');
    } finally {
      setSubmitting(false);
    }
  };

  const openEdit = (group: AgentSkillGroup) => {
    setEditTarget(group);
    setEditSkills(group.skills.map((s) => s.skillTag));
    setEditPickerValue([]);
  };

  const handleEditSave = async () => {
    if (!editTarget) return;
    setSubmitting(true);
    try {
      const current = new Set(editTarget.skills.map((s) => s.skillTag));
      const next = new Set(editSkills);
      // 要新增的
      const toAdd = editPickerValue.filter((v) => !current.has(v));
      // 要删除的
      const toRemove = editTarget.skills.filter((s) => !next.has(s.skillTag));
      const ops: Promise<unknown>[] = [];
      toAdd.forEach((tag) =>
        ops.push(createAgentSkill({ assigneeId: editTarget.assigneeId, skillTag: tag })),
      );
      toRemove.forEach((s) => ops.push(deleteAgentSkill(s.id)));
      const results = await Promise.allSettled(ops);
      const fail = results.filter((r) => r.status === 'rejected').length;
      if (fail > 0) {
        toast.warning(`部分操作失败: ${fail} 项,请刷新后重试`);
      } else if (toAdd.length + toRemove.length > 0) {
        toast.success(`已更新(${toAdd.length} 新增,${toRemove.length} 移除)`);
      } else {
        toast.success('无变化');
      }
      setEditTarget(null);
      setEditSkills([]);
      setEditPickerValue([]);
      fetchSkills();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveOneSkill = async (skill: AgentSkill) => {
    try {
      await deleteAgentSkill(skill.id);
      toast.success(`已移除 ${skillLabel(skill.skillTag)}`);
      fetchSkills();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const handleRemoveAgent = async (group: AgentSkillGroup) => {
    if (!await showConfirm(`确认移除专员 ${group.assigneeId} 的全部 ${group.skills.length} 项技能?`)) {
      return;
    }
    try {
      await Promise.allSettled(
        group.skills.map((s) => deleteAgentSkill(s.id)),
      );
      toast.success('已移除全部技能');
      fetchSkills();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={fetchSkills} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
        <Button size="sm" onClick={() => setAddOpen(true)}>
          <Plus />
          新增技能
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {loading && skills.length === 0 ? (
          <div className="p-12 text-center text-gray-400">加载中...</div>
        ) : groups.length === 0 ? (
          <div className="p-12 text-center text-gray-400">
            暂无技能记录，点击「新增技能」创建
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">专员</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">技能标签</th>
                <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">操作</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <tr key={group.assigneeId} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 align-top">
                    <UserDisplay value={[group.assigneeId]} size="small" />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      {group.skills.map((s) => (
                        <Badge key={s.id} variant="secondary" className="gap-1 pr-1">
                          {skillLabel(s.skillTag)}
                          <button
                            type="button"
                            onClick={() => handleRemoveOneSkill(s)}
                            className="ml-1 rounded hover:bg-gray-300/60"
                            aria-label={`移除 ${skillLabel(s.skillTag)}`}
                            title="移除该技能"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(group)}
                      >
                        <Pencil />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => handleRemoveAgent(group)}
                      >
                        <Trash2 />
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 新增对话框 */}
      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) {
            setAddOpen(false);
            setNewAssignee(null);
            setNewSkills([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增专员技能</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">专员</label>
              <UserSelect
                value={newAssignee}
                onChange={setNewAssignee}
                placeholder="请选择专员"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">技能标签(可多选)</label>
              <SkillMultiSelect
                options={SKILL_OPTIONS}
                value={newSkills}
                onChange={setNewSkills}
                placeholder="请选择技能标签"
                excludeValues={
                  newAssignee
                    ? groups
                        .find((g) => g.assigneeId === newAssignee)
                        ?.skills.map((s) => s.skillTag) ?? []
                    : []
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAddOpen(false);
                setNewAssignee(null);
                setNewSkills([]);
              }}
            >
              取消
            </Button>
            <Button
              onClick={handleAdd}
              disabled={submitting || !newAssignee || newSkills.length === 0}
            >
              确认添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑对话框 */}
      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditTarget(null);
            setEditSkills([]);
            setEditPickerValue([]);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑专员技能</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">专员</label>
              <div className="px-3 py-2 rounded-md bg-gray-50 border border-gray-200">
                {editTarget && (
                  <UserDisplay value={[editTarget.assigneeId]} size="small" />
                )}
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">当前技能</label>
              {editSkills.length === 0 ? (
                <div className="text-sm text-gray-400">该专员暂未配置任何技能</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {editSkills.map((tag) => (
                    <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                      {skillLabel(tag)}
                      <button
                        type="button"
                        onClick={() =>
                          setEditSkills(editSkills.filter((t) => t !== tag))
                        }
                        className="ml-1 rounded hover:bg-gray-300/60"
                        aria-label={`移除 ${skillLabel(tag)}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">添加新技能</label>
              <SkillMultiSelect
                options={SKILL_OPTIONS}
                value={editPickerValue}
                onChange={setEditPickerValue}
                placeholder="搜索并选择要新增的技能..."
                excludeValues={editSkills}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setEditTarget(null);
                setEditSkills([]);
                setEditPickerValue([]);
              }}
            >
              取消
            </Button>
            <Button onClick={handleEditSave} disabled={submitting}>
              确认保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default AgentSkillsTab;
