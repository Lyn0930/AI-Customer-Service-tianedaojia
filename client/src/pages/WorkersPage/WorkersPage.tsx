import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Eye, Pencil, Trash2, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { getWorkers, deleteWorker } from '@client/src/api/workers';
import WorkerFormDialog from './WorkerFormDialog';
import type { Worker, WorkerListParams } from '@shared/api.interface';

const LEVEL_LABELS: Record<string, string> = {
  junior: '初级', intermediate: '中级', senior: '高级', gold: '金牌',
};
const STATUS_LABELS: Record<string, string> = {
  active: '在岗', on_leave: '休假',
};
const SERVICE_TYPE_LABELS: Record<string, string> = {
  baomu: '保姆', yuesao: '月嫂',
};

const LEVEL_OPTIONS = [
  { value: 'junior', label: '初级' }, { value: 'intermediate', label: '中级' },
  { value: 'senior', label: '高级' }, { value: 'gold', label: '金牌' },
];
const STATUS_OPTIONS = [
  { value: 'active', label: '在岗' }, { value: 'on_leave', label: '休假' },
];
const SERVICE_TYPE_OPTIONS = [
  { value: 'baomu', label: '保姆' }, { value: 'yuesao', label: '月嫂' },
];

const WorkersPage: React.FC = () => {
  const navigate = useNavigate();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [filters, setFilters] = useState<WorkerListParams>({});
  const [appliedFilters, setAppliedFilters] = useState<WorkerListParams>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWorker, setEditingWorker] = useState<Worker | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Worker | null>(null);

  const fetchWorkers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getWorkers({ ...appliedFilters, page, pageSize });
      if (!res || !Array.isArray(res.items)) {
        toast.error('加载劳动者列表失败');
        return;
      }
      setWorkers(res.items);
      setTotal(res.total);
    } catch {
      toast.error('加载劳动者列表失败');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters, page, pageSize]);

  useEffect(() => { fetchWorkers(); }, [fetchWorkers]);

  const handleSearch = () => {
    setPage(1);
    setAppliedFilters(filters);
  };

  const handleReset = () => {
    setFilters({});
    setAppliedFilters({});
    setPage(1);
  };

  const handleAdd = () => {
    setEditingWorker(null);
    setDialogOpen(true);
  };

  const handleEdit = (worker: Worker) => {
    setEditingWorker(worker);
    setDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteWorker(deleteTarget.id);
      toast.success('劳动者已删除');
      setDeleteTarget(null);
      fetchWorkers();
    } catch {
      toast.error('删除失败');
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">劳动者管理</h1>
        <Button onClick={handleAdd}>
          <Plus className="w-4 h-4 mr-1" /> 新增劳动者
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">城市</label>
              <Input
                placeholder="服务城市"
                value={filters.serviceCity ?? ''}
                onChange={(e) => setFilters({ ...filters, serviceCity: e.target.value })}
                className="w-36"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">服务类型</label>
              <Select
                value={filters.serviceType ?? 'all'}
                onValueChange={(v) => setFilters({ ...filters, serviceType: v === 'all' ? undefined : v })}
              >
                <SelectTrigger className="w-32"><SelectValue placeholder="全部" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  {SERVICE_TYPE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">状态</label>
              <Select
                value={filters.status ?? 'all'}
                onValueChange={(v) => setFilters({ ...filters, status: v === 'all' ? undefined : v as Worker['status'] })}
              >
                <SelectTrigger className="w-28"><SelectValue placeholder="全部" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  {STATUS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">等级</label>
              <Select
                value={filters.level ?? 'all'}
                onValueChange={(v) => setFilters({ ...filters, level: v === 'all' ? undefined : v as Worker['level'] })}
              >
                <SelectTrigger className="w-28"><SelectValue placeholder="全部" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  {LEVEL_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-500">关键词</label>
              <Input
                placeholder="姓名/手机号"
                value={filters.keyword ?? ''}
                onChange={(e) => setFilters({ ...filters, keyword: e.target.value })}
                className="w-40"
              />
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleSearch}>
                <Search className="w-4 h-4 mr-1" /> 查询
              </Button>
              <Button variant="ghost" size="sm" onClick={handleReset}>重置</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>劳动者列表（共 {total} 人）</CardTitle></CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-gray-500">加载中...</div>
          ) : workers.length === 0 ? (
            <div className="text-center py-8 text-gray-500">暂无数据</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>姓名</TableHead>
                  <TableHead>手机号</TableHead>
                  <TableHead>服务城市</TableHead>
                  <TableHead>服务类型</TableHead>
                  <TableHead>等级</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="text-center">评分</TableHead>
                  <TableHead className="text-center">订单数</TableHead>
                  <TableHead className="text-center">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workers.map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="font-medium">{w.name}</TableCell>
                    <TableCell>{w.phone}</TableCell>
                    <TableCell>{w.serviceCity}</TableCell>
                    <TableCell>{SERVICE_TYPE_LABELS[w.serviceType] ?? w.serviceType}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{LEVEL_LABELS[w.level] ?? w.level}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={w.status === 'active' ? 'default' : 'secondary'}>
                        {STATUS_LABELS[w.status] ?? w.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-center">{w.rating}</TableCell>
                    <TableCell className="text-center">{w.totalOrders}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-center gap-1">
                        <Button variant="ghost" size="sm" onClick={() => navigate(`/workers/${w.id}`)}>
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(w)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(w)}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4">
              <span className="text-sm text-gray-500">
                第 {page} / {totalPages} 页，共 {total} 条
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  下一页
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <WorkerFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingWorker={editingWorker}
        onSuccess={fetchWorkers}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              确定要删除劳动者「{deleteTarget?.name}」吗？此操作不可撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default WorkersPage;
