import type { LeadStatus } from '@shared/api.interface';

export const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'new', label: '新线索' },
  { value: 'contacting', label: '联系中' },
  { value: 'chatting', label: '聊天中' },
  { value: 'collected', label: '已收集' },
  { value: 'closed', label: '已关闭' },
  { value: 'nurturing', label: '培育中' },
  { value: 'recycled', label: '已回收' },
  { value: 'filtered', label: '已过滤' },
  { value: 'assigned', label: '已分配' },
  { value: 'pending', label: '待分配' },
];

export const STATUS_MAP: Record<LeadStatus, { label: string; className: string }> = {
  new: { label: '新线索', className: 'bg-[#2563EB]' },
  contacting: { label: '联系中', className: 'bg-[#F59E0B]' },
  chatting: { label: '聊天中', className: 'bg-[#10B981]' },
  collected: { label: '已收集', className: 'bg-[#8B5CF6]' },
  closed: { label: '已关闭', className: 'bg-[#6B7280]' },
  nurturing: { label: '培育中', className: 'bg-[#F59E0B]' },
  recycled: { label: '已回收', className: 'bg-[#9CA3AF]' },
  filtered: { label: '已过滤', className: 'bg-[#9CA3AF]' },
  assigned: { label: '已分配', className: 'bg-[#2563EB]' },
  pending: { label: '待分配', className: 'bg-[#F59E0B]' },
};

export const GRADE_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部分级' },
  { value: 'A', label: 'A 优质' },
  { value: 'B', label: 'B 普通' },
  { value: 'B_PRICE', label: 'B-price 低预算' },
  { value: 'C1', label: 'C1 转人工' },
  { value: 'C2', label: 'C2 待采集' },
  { value: 'D', label: 'D 无效' },
];

export const URGENCY_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: '全部紧急度' },
  { value: 'high', label: '紧急' },
  { value: 'medium', label: '一般' },
  { value: 'low', label: '不急' },
];

export const GRADE_MAP: Record<string, { label: string; className: string }> = {
  A: { label: 'A', className: 'bg-[#FFF7ED] text-[#F59E0B]' },
  B: { label: 'B', className: 'bg-[#EFF6FF] text-[#2563EB]' },
  B_PRICE: { label: 'B-price', className: 'bg-[#FFF7ED] text-[#F59E0B]' },
  C1: { label: 'C1', className: 'bg-[#F3F4F6] text-[#6B7280]' },
  C2: { label: 'C2', className: 'bg-[#F3F4F6] text-[#6B7280]' },
  D: { label: 'D', className: 'bg-[#F3F4F6] text-[#6B7280]' },
};

export const PAGE_SIZE_OPTIONS: number[] = [10, 20, 50];

export const formatDate = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
