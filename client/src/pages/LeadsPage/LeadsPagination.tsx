import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { PAGE_SIZE_OPTIONS } from './leads-constants';

interface LeadsPaginationProps {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

const NAV_BTN_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md border border-[#D1D5DB] text-[#374151] hover:bg-[#F3F4F6] disabled:cursor-not-allowed disabled:opacity-50';

const PAGE_BTN_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md border border-[#D1D5DB] text-[13px] text-[#374151] hover:bg-[#F3F4F6]';

const PAGE_BTN_ACTIVE_CLASS =
  'flex h-8 w-8 items-center justify-center rounded-md bg-[#2563EB] text-[13px] text-white';

const getPageItems = (page: number, totalPages: number): (number | string)[] => {
  const nums: number[] = Array.from(
    new Set<number>([1, totalPages, page - 1, page, page + 1]),
  )
    .filter((n: number) => n >= 1 && n <= totalPages)
    .sort((a: number, b: number) => a - b);
  const items: (number | string)[] = [];
  let prev = 0;
  for (const n of nums) {
    if (prev && n - prev > 1) {
      items.push(`ellipsis-${prev}`);
    }
    items.push(n);
    prev = n;
  }
  return items;
};

const LeadsPagination: React.FC<LeadsPaginationProps> = ({
  page,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}) => {
  const totalPages: number = Math.max(1, Math.ceil(total / pageSize));
  const items: (number | string)[] = getPageItems(page, totalPages);

  return (
    <div className="flex h-14 items-center justify-end gap-2 px-4">
      <span className="mr-auto text-[13px] text-[#6B7280]">共 {total} 条</span>
      <button
        type="button"
        className={NAV_BTN_CLASS}
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      {items.map((item: number | string) =>
        typeof item === 'number' ? (
          <button
            key={item}
            type="button"
            className={item === page ? PAGE_BTN_ACTIVE_CLASS : PAGE_BTN_CLASS}
            onClick={() => onPageChange(item)}
          >
            {item}
          </button>
        ) : (
          <span
            key={item}
            className="flex h-8 w-8 items-center justify-center text-[13px] text-[#9CA3AF]"
          >
            ...
          </span>
        ),
      )}
      <button
        type="button"
        className={NAV_BTN_CLASS}
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <Select
        value={String(pageSize)}
        onValueChange={(val: string) => onPageSizeChange(Number(val))}
      >
        <SelectTrigger className="h-8 w-[104px] rounded-md border-[#D1D5DB] text-[13px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {PAGE_SIZE_OPTIONS.map((size: number) => (
            <SelectItem key={size} value={String(size)}>
              {size} 条/页
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
};

export default LeadsPagination;
