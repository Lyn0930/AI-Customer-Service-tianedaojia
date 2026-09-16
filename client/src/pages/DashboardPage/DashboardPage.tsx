import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ListChecks, TrendingUp, UserPlus, MessageSquare, Clock, Zap, Target } from 'lucide-react';
import ReactECharts from 'echarts-for-react';
import type { EChartsOption } from 'echarts';
import type { DashboardStats, Lead, LeadStatus } from '@shared/api.interface';
import { getSourceLabel } from '@shared/channels';
import { getLeadStats } from '@client/src/api/leads';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';

/* ============ 常量映射 ============ */

const STATUS_LABELS: Record<string, string> = {
  new: '新线索',
  contacting: '联系中',
  chatting: '聊天中',
  collected: '已收集',
  closed: '已关闭',
  nurturing: '培育中',
  recycled: '已回收',
  filtered: '已过滤',
  assigned: '已分配',
  pending: '待分配',
};

const STATUS_BADGE_CLASS: Record<LeadStatus, string> = {
  new: 'bg-blue-100 text-blue-700 border-blue-200',
  contacting: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  chatting: 'bg-purple-100 text-purple-700 border-purple-200',
  collected: 'bg-green-100 text-green-700 border-green-200',
  closed: 'bg-gray-100 text-gray-500 border-gray-200',
  nurturing: 'bg-orange-100 text-orange-700 border-orange-200',
  recycled: 'bg-gray-100 text-gray-600 border-gray-200',
  filtered: 'bg-red-100 text-red-600 border-red-200',
  assigned: 'bg-cyan-100 text-cyan-700 border-cyan-200',
  pending: 'bg-yellow-100 text-yellow-700 border-yellow-200',
};

/* 统计卡片配色 */
const STAT_ITEMS = [
  { key: 'totalLeads', label: '总线索数', icon: ListChecks, iconBg: 'bg-blue-100', iconColor: 'text-blue-600' },
  { key: 'todayNew', label: '今日新增', icon: TrendingUp, iconBg: 'bg-green-100', iconColor: 'text-green-600' },
  { key: 'unassigned', label: '待分配', icon: UserPlus, iconBg: 'bg-orange-100', iconColor: 'text-orange-600' },
  { key: 'activeSessions', label: '活跃会话', icon: MessageSquare, iconBg: 'bg-purple-100', iconColor: 'text-purple-600' },
] as const;

/* 效率指标卡片配色（近 7 天口径） */
const EFFICIENCY_ITEMS = [
  {
    key: 'avgChatDuration',
    label: '平均聊天时长',
    icon: Clock,
    iconBg: 'bg-cyan-100',
    iconColor: 'text-cyan-600',
    format: (v: number): string => (v >= 60 ? `${Math.round(v / 60)} 分钟` : `${v} 秒`),
  },
  {
    key: 'avgCollectionDuration',
    label: 'AI 采集耗时',
    icon: Zap,
    iconBg: 'bg-amber-100',
    iconColor: 'text-amber-600',
    format: (v: number): string => (v >= 60 ? `${Math.round(v / 60)} 分钟` : `${v} 秒`),
  },
  {
    key: 'collectionCompletionRate',
    label: '采集完成率',
    icon: Target,
    iconBg: 'bg-emerald-100',
    iconColor: 'text-emerald-600',
    format: (v: number): string => `${v}%`,
  },
] as const;

/* 图表配色（仅 hex） */
const PIE_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444'];
const BAR_COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#6366F1'];

/* ============ 图表配置构建 ============ */

const buildSourcePieOption = (
  data: { source: string; count: number }[],
): EChartsOption => {
  const items = data.slice(0, 5);
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: { bottom: 0, type: 'scroll' },
    series: [
      {
        type: 'pie',
        radius: ['40%', '65%'],
        center: ['50%', '45%'],
        label: { show: false },
        emphasis: { label: { show: false } },
        data: items.map((it, idx: number) => ({
          name: getSourceLabel(it.source),
          value: it.count,
          itemStyle: { color: PIE_COLORS[idx % PIE_COLORS.length] },
        })),
      },
    ],
  };
};

const buildStatusBarOption = (
  data: { status: string; count: number }[],
): EChartsOption => {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { containLabel: true, bottom: '20%', top: '10%' },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: data.map((it) => STATUS_LABELS[it.status] ?? it.status),
      axisLabel: { color: '#6B7280' },
    },
    yAxis: { type: 'value', axisLabel: { color: '#6B7280' } },
    series: [
      {
        type: 'bar',
        barWidth: '50%',
        data: data.map((it, idx: number) => ({
          value: it.count,
          itemStyle: { color: BAR_COLORS[idx % BAR_COLORS.length] },
        })),
      },
    ],
  };
};

const buildCityBarOption = (
  data: { city: string; count: number }[],
): EChartsOption => {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { containLabel: true, bottom: '20%', top: '10%' },
    xAxis: {
      type: 'category',
      boundaryGap: true,
      data: data.map((it) => it.city || '未知'),
      axisLabel: { color: '#6B7280', rotate: data.length > 6 ? 30 : 0 },
    },
    yAxis: { type: 'value', axisLabel: { color: '#6B7280' } },
    series: [
      {
        type: 'bar',
        barWidth: '40%',
        data: data.map((it, idx: number) => ({
          value: it.count,
          itemStyle: { color: BAR_COLORS[idx % BAR_COLORS.length] },
        })),
      },
    ],
  };
};

/* ============ 子组件 ============ */

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ElementType;
  iconBg: string;
  iconColor: string;
}

const StatCard: React.FC<StatCardProps> = ({ label, value, icon: Icon, iconBg, iconColor }) => {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-5">
      <div className="flex items-center justify-between">
        <div className={`flex items-center justify-center w-11 h-11 rounded-full ${iconBg}`}>
          <Icon className={`w-5 h-5 ${iconColor}`} />
        </div>
      </div>
      <div className="mt-4 text-3xl font-bold text-gray-800">{value}</div>
      <div className="mt-1 text-sm text-gray-500">{label}</div>
    </div>
  );
};

/* ============ 主页面 ============ */

const DashboardPage: React.FC = () => {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getLeadStats();
      setStats(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载统计数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const recentLeads: Lead[] = (stats?.recentLeads ?? []).slice(0, 5);

  return (
    <div className="p-6 space-y-4 bg-gray-50 min-h-full">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">数据概览</h1>
        <Button variant="outline" size="sm" onClick={fetchStats} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : ''} />
          刷新
        </Button>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 调试信息：服务端子查询失败时露出具体原因 */}
      {stats?.debug && (
        <div
          data-testid="dashboard-debug-panel"
          className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 space-y-2"
        >
          <div className="font-semibold">
            ⚠️ 服务端子查询失败 — stage: <span className="font-mono">{stats.debug.stage}</span>
          </div>
          <div className="text-xs text-amber-700">
            排查时把下面这段贴给开发者即可，500 已降级为 200 + debug 字段。
          </div>
          <pre className="overflow-auto rounded bg-white/70 p-2 text-[12px] leading-snug whitespace-pre-wrap break-all">
{`message: ${stats.debug.message}${
  stats.debug.code ? `\ncode:    ${stats.debug.code}` : ''
}${
  stats.debug.detail ? `\ndetail:  ${stats.debug.detail}` : ''
}${
  stats.debug.stack ? `\nstack:\n${stats.debug.stack}` : ''
}`}
          </pre>
        </div>
      )}

      {/* 一次性 schema 迁移状态：显示 6 个 leads 列补列结果 */}
      {stats?.migrationInfo && stats.migrationInfo.length > 0 && (
        <div
          data-testid="dashboard-migration-panel"
          className="rounded-lg border border-slate-300 bg-slate-50 p-4 text-sm text-slate-800 space-y-2"
        >
          <div className="font-semibold flex items-center gap-2">
            🛠️ Schema 迁移（commit a994ed5 引入的 6 个 leads 列）
            {stats.migrationInfo.every((c) => c.status === 'skip' || c.status === 'ok') ? (
              <span className="text-emerald-600 text-xs font-normal">全部就位</span>
            ) : (
              <span className="text-rose-600 text-xs font-normal">
                {stats.migrationInfo.filter((c) => c.status === 'fail').length} 列失败
              </span>
            )}
          </div>
          <ul className="text-xs space-y-1 font-mono">
            {stats.migrationInfo.map((c) => (
              <li key={c.name} className="flex items-start gap-2">
                <span className="w-12 shrink-0">
                  {c.status === 'ok' ? (
                    <span className="text-emerald-600">✓ ok</span>
                  ) : c.status === 'skip' ? (
                    <span className="text-slate-500">– skip</span>
                  ) : (
                    <span className="text-rose-600">✗ fail</span>
                  )}
                </span>
                <span className="font-semibold w-56 shrink-0">{c.name}</span>
                {c.error && (
                  <span className="text-rose-700 break-all whitespace-pre-wrap">{c.error}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 加载中 */}
      {loading && !stats ? (
        <div className="flex items-center justify-center py-20 text-gray-400">
          <RefreshCw className="w-6 h-6 mr-2 animate-spin" />
          加载中...
        </div>
      ) : (
        <>
          {/* 统计卡片 */}
          <div className="grid grid-cols-4 gap-4">
            {STAT_ITEMS.map((item) => (
              <StatCard
                key={item.key}
                label={item.label}
                value={stats ? Number(stats[item.key as keyof DashboardStats]) : 0}
                icon={item.icon}
                iconBg={item.iconBg}
                iconColor={item.iconColor}
              />
            ))}
          </div>

          {/* 效率指标卡片 */}
          <div className="grid grid-cols-3 gap-4">
            {EFFICIENCY_ITEMS.map((item) => {
              const rawValue: number = stats ? Number(stats[item.key as keyof DashboardStats]) : 0;
              return (
                <StatCard
                  key={item.key}
                  label={item.label}
                  value={item.format(rawValue)}
                  icon={item.icon}
                  iconBg={item.iconBg}
                  iconColor={item.iconColor}
                />
              );
            })}
          </div>

          {/* 图表区 */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-base font-semibold text-gray-800 mb-2">线索来源分布</h2>
              <ReactECharts
                option={buildSourcePieOption(stats?.sourceDistribution ?? [])}
                theme="ud"
                className="h-[300px]"
              />
            </div>
            <div className="bg-white rounded-lg border border-gray-200 p-5">
              <h2 className="text-base font-semibold text-gray-800 mb-2">线索状态分布</h2>
              <ReactECharts
                option={buildStatusBarOption(stats?.statusDistribution ?? [])}
                theme="ud"
                className="h-[300px]"
              />
            </div>
          </div>

          {/* 城市分布 */}
          <div className="bg-white rounded-lg border border-gray-200 p-5">
            <h2 className="text-base font-semibold text-gray-800 mb-2">城市分布</h2>
            <ReactECharts
              option={buildCityBarOption(stats?.cityDistribution ?? [])}
              theme="ud"
              className="h-[300px]"
            />
          </div>

          {/* 最近线索 */}
          <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
            <h2 className="text-base font-semibold text-gray-800 px-5 py-4 border-b border-gray-200">
              最近线索
            </h2>
            {recentLeads.length === 0 ? (
              <div className="p-12 text-center text-gray-400">暂无线索数据</div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">客户姓名</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">电话</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">服务城市</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">来源</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">状态</th>
                    <th className="text-left px-4 py-3 text-sm font-semibold text-gray-600">创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {recentLeads.map((lead: Lead) => (
                    <tr
                      key={lead.id}
                      className="border-b border-gray-100 hover:bg-gray-50 transition-colors"
                    >
                      <td className="px-4 py-3 text-sm text-gray-800">
                        {lead.customerName || '未填写'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600 break-all">
                        {lead.phoneNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {lead.serviceCity || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {getSourceLabel(lead.source)}
                      </td>
                      <td className="px-4 py-3">
                        <Badge
                          variant="outline"
                          className={STATUS_BADGE_CLASS[lead.status]}
                        >
                          {STATUS_LABELS[lead.status] ?? lead.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">
                        {new Date(lead.createdAt).toLocaleString('zh-CN')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default DashboardPage;
