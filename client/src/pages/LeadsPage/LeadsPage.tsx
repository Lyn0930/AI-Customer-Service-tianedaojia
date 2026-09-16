import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw, Search, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { Lead, LeadListParams, LeadListResponse, LeadStatus, PoolListParams } from '@shared/api.interface';
import { getLeads, assignLead, getPoolLeads, claimLead } from '@client/src/api/leads';
import { getSourceLabel } from '@shared/channels';
import PoolActions from './PoolActions';
import LeadsPagination from './LeadsPagination';
import {
  STATUS_OPTIONS,
  STATUS_MAP,
  GRADE_OPTIONS,
  URGENCY_OPTIONS,
  GRADE_MAP,
  formatDate,
} from './leads-constants';
import { useRole } from '@client/src/hooks/useRole';
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
import { UserSelect } from '@/components/business-ui/user-select';
import { UserDisplay } from '@/components/business-ui/user-display';

type LeadTab = 'all' | 'mine' | 'pool';

interface AppliedFilters {
  status: string;
  city: string;
  keyword: string;
  leadGrade: string;
  urgencyLevel: string;
}

const TH_CLASS = 'h-11 px-4 text-left text-[13px] font-bold text-[#374151]';
const BASE_COLUMNS: string[] = ['客户姓名', '电话', '来源', '状态', '分级'];
const EMPTY_CELL = <span className="text-[#D1D5DB]">--</span>;

interface StatusBadgeProps {
  status: LeadStatus;
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ status }) => {
  const cfg = STATUS_MAP[status] ?? { label: status, className: 'bg-[#6B7280]' };
  return (
    <span className={`inline-flex h-[22px] items-center rounded px-2 text-xs text-white ${cfg.className}`}>
      {cfg.label}
    </span>
  );
};

interface FilterSelectProps {
  value: string;
  options: { value: string; label: string }[];
  placeholder: string;
  width: string;
  onApply: (val: string) => void;
}

const FilterSelect: React.FC<FilterSelectProps> = ({ value, options, placeholder, width, onApply }) => (
  <Select value={value} onValueChange={onApply}>
    <SelectTrigger className={`h-9 ${width} rounded-md border-[#D1D5DB]`}>
      <SelectValue placeholder={placeholder} />
    </SelectTrigger>
    <SelectContent>
      {options.map((opt) => (
        <SelectItem key={opt.value} value={opt.value}>
          {opt.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const LeadsPage: React.FC = () => {
  const navigate = useNavigate();
  const { role } = useRole();
  const isManager = role === 'manager';
  // 输入状态（仅控制表单，不触发请求）
  const [statusInput, setStatusInput] = useState<string>('');
  const [cityInput, setCityInput] = useState<string>('');
  const [keywordInput, setKeywordInput] = useState<string>('');
  const [gradeInput, setGradeInput] = useState<string>('');
  const [urgencyInput, setUrgencyInput] = useState<string>('');

  // 已应用的筛选条件（触发请求）
  const [appliedFilters, setAppliedFilters] = useState<AppliedFilters>({
    status: '',
    city: '',
    keyword: '',
    leadGrade: '',
    urgencyLevel: '',
  });

  // 数据状态
  const [data, setData] = useState<LeadListResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);
  const [tab, setTab] = useState<LeadTab>(isManager ? 'all' : 'mine');

  // 分配客服弹窗状态
  const [assignOpen, setAssignOpen] = useState(false);
  const [assigningLeadId, setAssigningLeadId] = useState<string | null>(null);
  const [assignUserId, setAssignUserId] = useState<string | null>(null);
  const [assignSubmitting, setAssignSubmitting] = useState(false);

  const fetchLeads = useCallback(
    async (p: number, filters: AppliedFilters, currentTab: LeadTab, size: number) => {
      setLoading(true);
      setError(null);
      try {
        if (currentTab === 'pool') {
          const params: PoolListParams = { page: p, pageSize: size };
          if (filters.city.trim()) params.serviceCity = filters.city.trim();
          if (filters.keyword.trim()) params.keyword = filters.keyword.trim();
          const res = await getPoolLeads(params);
          setData(res);
        } else {
          const params: LeadListParams = { page: p, pageSize: size };
          if (currentTab === 'mine') {
            params.role = 'agent';
          }
          if (filters.status) {
            params.status = filters.status as LeadStatus;
          }
          if (filters.city.trim()) {
            params.serviceCity = filters.city.trim();
          }
          if (filters.keyword.trim()) {
            params.keyword = filters.keyword.trim();
          }
          if (filters.leadGrade) {
            params.leadGrade = filters.leadGrade;
          }
          if (filters.urgencyLevel) {
            params.urgencyLevel = filters.urgencyLevel;
          }
          const res = await getLeads(params);
          setData(res);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : '加载线索失败');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    fetchLeads(page, appliedFilters, tab, pageSize);
  }, [page, pageSize, appliedFilters, fetchLeads, tab]);

  useEffect(() => {
    setTab(isManager ? 'all' : 'mine');
    setPage(1);
  }, [role]);

  // 事件处理
  const applyFilter = (key: keyof AppliedFilters, setter: (v: string) => void) => (val: string) => {
    setter(val);
    setAppliedFilters((prev) => ({ ...prev, [key]: val }));
    setPage(1);
  };

  const handleSearch = () => {
    setAppliedFilters({
      status: statusInput,
      city: cityInput,
      keyword: keywordInput,
      leadGrade: gradeInput,
      urgencyLevel: urgencyInput,
    });
    setPage(1);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handlePrev = () => {
    if (page > 1) setPage(page - 1);
  };

  const handleNext = () => {
    const totalPages = data ? Math.ceil(data.total / data.pageSize) : 1;
    if (page < totalPages) setPage(page + 1);
  };

  const handleRefresh = () => {
    fetchLeads(page, appliedFilters, tab, pageSize);
  };

  const handleViewDetail = (id: string) => {
    navigate(`/leads/${id}`);
  };

  const handleClaim = async (leadId: string) => {
    try {
      await claimLead(leadId);
      toast.success('领取成功');
      fetchLeads(page, appliedFilters, tab, pageSize);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '领取失败');
    }
  };

  const handleOpenAssign = (lead: Lead) => {
    setAssigningLeadId(lead.id);
    setAssignUserId(lead.assigneeId);
    setAssignOpen(true);
  };

  const handleAssign = async () => {
    if (!assigningLeadId || !assignUserId) return;
    setAssignSubmitting(true);
    try {
      await assignLead(assigningLeadId, assignUserId);
      toast.success('分配成功');
      setAssignOpen(false);
      setAssigningLeadId(null);
      setAssignUserId(null);
      fetchLeads(page, appliedFilters, tab, pageSize);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '分配失败');
    } finally {
      setAssignSubmitting(false);
    }
  };

  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1);
  };

  // 渲染
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="p-6 space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold text-gray-800">线索管理</h1>
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            <button
              className={`px-3 py-1 text-sm rounded-md transition-colors ${tab === (isManager ? 'all' : 'mine') ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
              onClick={() => { setTab(isManager ? 'all' : 'mine'); setPage(1); }}
            >
              {isManager ? '全部线索' : '我的线索'}
            </button>
            <button
              className={`px-3 py-1 text-sm rounded-md transition-colors ${tab === 'pool' ? 'bg-white text-gray-800 shadow-sm' : 'text-gray-500'}`}
              onClick={() => { setTab('pool'); setPage(1); }}
            >
              公海
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isManager && tab === 'pool' && <PoolActions onRefresh={() => fetchLeads(page, appliedFilters, tab, pageSize)} />}
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {/* 筛选栏 */}
        <div className="flex h-14 items-center gap-3 border-b border-[#E5E7EB] px-4">
          <FilterSelect
            value={statusInput}
            options={STATUS_OPTIONS}
            placeholder="全部状态"
            width="w-[140px]"
            onApply={applyFilter('status', setStatusInput)}
          />
          <Input
            placeholder="服务城市"
            value={cityInput}
            onChange={(e) => setCityInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="h-9 w-[160px] rounded-md border-[#D1D5DB]"
          />
          <FilterSelect
            value={gradeInput}
            options={GRADE_OPTIONS}
            placeholder="全部分级"
            width="w-[120px]"
            onApply={applyFilter('leadGrade', setGradeInput)}
          />
          <FilterSelect
            value={urgencyInput}
            options={URGENCY_OPTIONS}
            placeholder="全部紧急度"
            width="w-[120px]"
            onApply={applyFilter('urgencyLevel', setUrgencyInput)}
          />
          <div className="ml-auto flex items-center gap-3">
            <Input
              placeholder="搜索客户姓名/电话"
              value={keywordInput}
              onChange={(e) => setKeywordInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-9 w-60 rounded-md border-[#D1D5DB]"
            />
            <Button className="h-9 bg-[#2563EB] text-white hover:bg-[#1D4ED8]" onClick={handleSearch} disabled={loading}>
              <Search />
              搜索
            </Button>
            <Button variant="outline" className="h-9" onClick={handleRefresh} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              刷新
            </Button>
          </div>
        </div>

        {/* 错误提示 */}
        {error && (
          <div className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* 数据表格 */}
        {loading && items.length === 0 ? (
          <div className="p-12 text-center text-gray-400">加载中...</div>
        ) : items.length === 0 ? (
          <div className="p-12 text-center text-gray-400">暂无线索数据</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-[#E5E7EB] bg-[#F9FAFB]">
                {BASE_COLUMNS.map((col: string) => (
                  <th key={col} className={TH_CLASS}>{col}</th>
                ))}
                {isManager && <th className={TH_CLASS}>负责客服</th>}
                <th className={TH_CLASS}>最后跟进</th>
                <th className={TH_CLASS}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((lead: Lead) => (
                <tr
                  key={lead.id}
                  className="h-[52px] cursor-pointer border-b border-gray-100 transition-colors hover:bg-[#F9FAFB]"
                  onClick={() => handleViewDetail(lead.id)}
                >
                  <td className="px-4 text-sm text-[#111827]">{lead.customerName || EMPTY_CELL}</td>
                  <td className="px-4 text-sm text-[#374151] break-all">{lead.phoneNumber}</td>
                  <td className="px-4 text-sm text-[#374151]">{getSourceLabel(lead.source) || EMPTY_CELL}</td>
                  <td className="px-4"><StatusBadge status={lead.status} /></td>
                  <td className="px-4">
                    {lead.leadGrade ? (
                      <div className="flex items-center gap-1">
                        <span className={`inline-flex h-[22px] items-center rounded px-2 text-xs ${GRADE_MAP[lead.leadGrade]?.className ?? ''}`}>
                          {GRADE_MAP[lead.leadGrade]?.label ?? lead.leadGrade}
                        </span>
                        {lead.gradeConfidence != null && lead.gradeConfidence < 0.7 && (
                          <span
                            className="text-[#F59E0B]"
                            title={`置信度 ${Math.round(lead.gradeConfidence * 100)}%，待人工复核`}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </div>
                    ) : (
                      EMPTY_CELL
                    )}
                  </td>
                  {isManager && (
                    <td className="px-4">
                      {lead.assigneeId ? <UserDisplay value={[lead.assigneeId]} size="small" /> : EMPTY_CELL}
                    </td>
                  )}
                  <td className="px-4 text-sm text-[#6B7280] whitespace-nowrap">
                    {lead.lastFollowedUpAt ? formatDate(lead.lastFollowedUpAt) : EMPTY_CELL}
                  </td>
                  <td className="px-4">
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        className="text-sm text-[#2563EB] hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleViewDetail(lead.id);
                        }}
                      >
                        查看
                      </button>
                      {tab !== 'pool' && isManager && (
                        <button
                          type="button"
                          className="text-sm text-[#2563EB] hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenAssign(lead);
                          }}
                        >
                          分配
                        </button>
                      )}
                      {tab === 'pool' && (
                        <button
                          type="button"
                          className="text-sm text-[#2563EB] hover:underline"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleClaim(lead.id);
                          }}
                        >
                          领取
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 分页 */}
        {total > 0 && (
          <div className="border-t border-[#E5E7EB]">
            <LeadsPagination
              page={page}
              total={total}
              pageSize={pageSize}
              onPageChange={(p: number) => {
                if (p >= 1 && p <= totalPages) {
                  setPage(p);
                }
              }}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </div>

      {/* 分配客服 Dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>分配负责客服</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">负责客服</label>
              <UserSelect
                value={assignUserId}
                onChange={setAssignUserId}
                placeholder="请选择客服"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAssignOpen(false)}>
              取消
            </Button>
            <Button
              onClick={handleAssign}
              disabled={assignSubmitting || !assignUserId}
            >
              确认分配
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default LeadsPage;
