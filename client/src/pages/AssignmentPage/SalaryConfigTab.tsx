import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SalaryConfig } from '@shared/api.interface';
import {
  getSalaryConfigs,
  updateSalaryConfig,
  deleteSalaryConfig,
} from '@client/src/api/salary-config';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
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
import { showConfirm } from '@lark-apaas/client-toolkit';

// 2026-08-15 扩列后支持的 6 类服务
const SERVICE_TYPES: ReadonlyArray<string> = [
  '住家保姆',
  '钟点工',
  '白班',
  '育儿',
  '护工',
  '菲式',
];

interface EditState {
  id: string;
  baseLow: number;
  baseHigh: number;
  altLow: number;
  altHigh: number;
}

const SalaryConfigTab: React.FC = () => {
  const [items, setItems] = useState<SalaryConfig[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editTarget, setEditTarget] = useState<EditState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [filterService, setFilterService] = useState<string>('住家保姆');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 传空字符串等价于不过滤（拉全量 27 条），便于切换时一次拉全
      const data = await getSalaryConfigs(filterService || undefined);
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [filterService]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const openEdit = (item: SalaryConfig) => {
    setEditTarget({
      id: item.id,
      baseLow: item.baseLow,
      baseHigh: item.baseHigh,
      altLow: item.altLow,
      altHigh: item.altHigh,
    });
  };

  const handleSave = async () => {
    if (!editTarget) return;
    setSubmitting(true);
    try {
      await updateSalaryConfig(editTarget.id, {
        baseLow: editTarget.baseLow,
        baseHigh: editTarget.baseHigh,
        altLow: editTarget.altLow,
        altHigh: editTarget.altHigh,
      });
      toast.success('更新成功');
      setEditTarget(null);
      fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!await showConfirm('确认删除该条配置？删除后该城市/户型/工作制组合无话术可参考。')) return;
    try {
      await deleteSalaryConfig(id);
      toast.success('已删除');
      fetchAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  // 给"细分维度"列做友好显示
  const subDimLabel = (s: string) => (s ? s : '—');

  // 给"户型"列做友好显示（"不适用" → "—"）
  const areaLabel = (a: string) => (a === '不适用' ? '—' : a);

  // 服务显示名（钟点工 → 钟点工保姆，与 persona 一致）
  const serviceDisplay = (s: string) => (s.endsWith('保姆') ? s : `${s}保姆`);

  // 当前筛选下展示的所有行（filterService 选了某类时只展示那一类，全选时展示全部 27 条）
  const visibleItems = useMemo(() => {
    if (!filterService) return items;
    return items.filter((it) => it.serviceType === filterService);
  }, [items, filterService]);

  // 按"服务 → 城市 → 户型 → 细分维度"排序（list() 已排好，这里兜底）
  const sortedItems = useMemo(() => {
    return [...visibleItems].sort((a, b) => {
      if (a.serviceType !== b.serviceType) return a.serviceType.localeCompare(b.serviceType, 'zh-CN');
      if (a.cityTier !== b.cityTier) return a.cityTier.localeCompare(b.cityTier, 'zh-CN');
      if (a.areaType !== b.areaType) return a.areaType.localeCompare(b.areaType, 'zh-CN');
      return (a.subDimension ?? '').localeCompare(b.subDimension ?? '', 'zh-CN');
    });
  }, [visibleItems]);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-800">
        <div className="font-semibold mb-1">市场薪资话术 · 业务可维护</div>
        <div>
          这里维护的是 AI 在「客户询问市场薪资」时参考的区间。改完后<strong>不需要走代码发布</strong>，
          下一次对话生效。覆盖 6 类服务（住家保姆/钟点工/白班/育儿/护工/菲式）。
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-gray-600">服务类型：</span>
        <Select value={filterService} onValueChange={setFilterService}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">全部（{SERVICE_TYPES.length} 类）</SelectItem>
            {SERVICE_TYPES.map((s) => (
              <SelectItem key={s} value={s}>
                {serviceDisplay(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
        <span className="text-xs text-gray-500">
          当前显示 {sortedItems.length} 条
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">服务类型</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">城市档</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">户型</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">工作制</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">主线区间</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">低要求区间</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">最近更新</th>
              <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-12 text-center text-gray-400">加载中...</td>
              </tr>
            ) : sortedItems.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-12 text-center text-gray-400">无配置</td>
              </tr>
            ) : (
              sortedItems.map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-800">{serviceDisplay(r.serviceType)}</td>
                  <td className="px-4 py-3 text-sm text-gray-800">{r.cityTier}</td>
                  <td className="px-4 py-3 text-sm text-gray-800">{areaLabel(r.areaType)}</td>
                  <td className="px-4 py-3 text-sm text-gray-800">{subDimLabel(r.subDimension ?? '')}</td>
                  <td className="px-4 py-3 text-sm text-gray-800">
                    {r.baseLow}-{r.baseHigh} 元/月
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-800">
                    {r.altLow > 0 || r.altHigh > 0
                      ? `${r.altLow}-${r.altHigh} 元/月`
                      : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">
                    {new Date(r.updatedAt).toLocaleString('zh-CN')}
                    {r.updatedBy ? ` · ${r.updatedBy}` : ''}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(r)}>
                        <Pencil />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:text-red-700"
                        onClick={() => handleDelete(r.id)}
                      >
                        <Trash2 />
                        删除
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑薪资区间</DialogTitle>
          </DialogHeader>
          {editTarget && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">主线区间 下限（元/月）</label>
                  <Input
                    type="number"
                    value={editTarget.baseLow}
                    onChange={(e) =>
                      setEditTarget({ ...editTarget, baseLow: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">主线区间 上限（元/月）</label>
                  <Input
                    type="number"
                    value={editTarget.baseHigh}
                    onChange={(e) =>
                      setEditTarget({ ...editTarget, baseHigh: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">低要求区间 下限</label>
                  <Input
                    type="number"
                    value={editTarget.altLow}
                    onChange={(e) =>
                      setEditTarget({ ...editTarget, altLow: Number(e.target.value) })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium text-gray-700">低要求区间 上限</label>
                  <Input
                    type="number"
                    value={editTarget.altHigh}
                    onChange={(e) =>
                      setEditTarget({ ...editTarget, altHigh: Number(e.target.value) })
                    }
                  />
                </div>
              </div>
              <div className="text-xs text-gray-500">
                提示：主线 = 客户对阿姨要求正常时的推荐区间；低要求 = 客户要求不高时的备选区间。
                没有低要求的服务（钟点工/菲式）填 0 即可。
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={submitting}>
              确认更新
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default SalaryConfigTab;
