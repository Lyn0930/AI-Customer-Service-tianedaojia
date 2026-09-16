import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import {
  ArrowLeft,
  MessageCircle,
  MessageSquare,
  Phone,
  Plus,
  MessageSquareText,
} from 'lucide-react';
import type {
  ContactLog,
  ContactStatus,
  ContactType,
  Lead,
  Requirement,
} from '@shared/api.interface';
import { getLeadById, getLeadRequirements } from '@client/src/api/leads';
import GradeInfoSection from './GradeInfoSection';
import { getSourceLabel } from '@shared/channels';
import { formatHouseholdSize, formatArea, formatBudget } from '@client/src/utils/requirement-format';
import { getContactLogs, createContactLog } from '@client/src/api/contact';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Badge } from '@client/src/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@client/src/components/ui/card';

/* ============ 常量映射 ============ */

const CONTACT_TYPE_MAP: Record<ContactType, { label: string; icon: React.FC<{ className?: string }> }> = {
  wechat_add: { label: '添加微信', icon: MessageCircle },
  wechat_message: { label: '微信消息', icon: MessageSquare },
  phone_call: { label: '电话联系', icon: Phone },
};

const CONTACT_STATUS_MAP: Record<ContactStatus, { label: string; className: string }> = {
  pending: { label: '待处理', className: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  success: { label: '成功', className: 'bg-green-100 text-green-700 border-green-200' },
  failed: { label: '失败', className: 'bg-red-100 text-red-700 border-red-200' },
};

const LEAD_STATUS_MAP: Record<string, { label: string; className: string }> = {
  new: { label: '新线索', className: 'bg-blue-100 text-blue-700 border-blue-200' },
  contacting: { label: '联系中', className: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
  chatting: { label: '聊天中', className: 'bg-purple-100 text-purple-700 border-purple-200' },
  collected: { label: '已收集', className: 'bg-green-100 text-green-700 border-green-200' },
  closed: { label: '已关闭', className: 'bg-gray-100 text-gray-500 border-gray-200' },
  nurturing: { label: '培育中', className: 'bg-orange-100 text-orange-700 border-orange-200' },
  recycled: { label: '已回收', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  filtered: { label: '已过滤', className: 'bg-red-100 text-red-600 border-red-200' },
  assigned: { label: '已分配', className: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
  pending: { label: '待分配', className: 'bg-yellow-100 text-yellow-700 border-yellow-200' },
};

const GRADE_STYLE: Record<string, string> = {
  A: 'bg-green-100 text-green-700 border-green-200',
  B: 'bg-blue-100 text-blue-700 border-blue-200',
  C: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  D: 'bg-orange-100 text-orange-700 border-orange-200',
  E: 'bg-gray-100 text-gray-500 border-gray-200',
};

const URGENCY_STYLE: Record<string, string> = {
  high: 'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  low: 'bg-gray-100 text-gray-500 border-gray-200',
};

const URGENCY_LABEL: Record<string, string> = {
  high: '紧急',
  medium: '一般',
  low: '不急',
};

/* ============ 工具函数 ============ */

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/* ============ 子组件 ============ */

interface ContactStatusBadgeProps {
  status: ContactStatus;
}

const ContactStatusBadge: React.FC<ContactStatusBadgeProps> = ({ status }) => {
  const cfg = CONTACT_STATUS_MAP[status];
  return (
    <Badge variant="outline" className={cfg.className}>
      {cfg.label}
    </Badge>
  );
};

interface InfoRowProps {
  label: string;
  value: string | null;
}

const InfoRow: React.FC<InfoRowProps> = ({ label, value }) => (
  <div className="flex py-2 border-b border-gray-100 last:border-0">
    <span className="w-28 shrink-0 text-sm text-gray-400">{label}</span>
    <span className="flex-1 text-sm text-gray-800">{value || '未填写'}</span>
  </div>
);

interface ContactLogItemProps {
  log: ContactLog;
  isLast: boolean;
}

const ContactLogItem: React.FC<ContactLogItemProps> = ({ log, isLast }) => {
  const typeCfg = CONTACT_TYPE_MAP[log.contactType];
  const Icon = typeCfg.icon;

  return (
    <div className="flex gap-3 pb-6 last:pb-0">
      {/* 时间线轴 */}
      <div className="flex flex-col items-center">
        <div className="flex items-center justify-center w-9 h-9 rounded-full bg-primary/10 text-primary shrink-0">
          <Icon className="w-4 h-4" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-gray-200 mt-1" />}
      </div>
      {/* 内容 */}
      <div className="flex-1 min-w-0 -mt-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-gray-800">{typeCfg.label}</span>
          <ContactStatusBadge status={log.status} />
          <span className="text-xs text-gray-400">{formatDate(log.createdAt)}</span>
        </div>
        {log.notes && (
          <p className="mt-1 text-sm text-gray-500 break-words">{log.notes}</p>
        )}
      </div>
    </div>
  );
};

interface AddContactFormProps {
  leadId: string;
  onCreated: () => void;
}

const AddContactForm: React.FC<AddContactFormProps> = ({ leadId, onCreated }) => {
  const [contactType, setContactType] = useState<string>('wechat_add');
  const [status, setStatus] = useState<string>('pending');
  const [notes, setNotes] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await createContactLog(leadId, {
        contactType: contactType as ContactType,
        status: status as ContactStatus,
        notes: notes.trim() || undefined,
      });
      setNotes('');
      setStatus('pending');
      setContactType('wechat_add');
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加联系记录失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={contactType} onValueChange={setContactType}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="wechat_add">添加微信</SelectItem>
            <SelectItem value="wechat_message">微信消息</SelectItem>
            <SelectItem value="phone_call">电话联系</SelectItem>
          </SelectContent>
        </Select>

        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">待处理</SelectItem>
            <SelectItem value="success">成功</SelectItem>
            <SelectItem value="failed">失败</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Textarea
        placeholder="备注（可选）"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="min-h-16 bg-white"
      />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <div className="flex justify-end">
        <Button size="sm" onClick={handleSubmit} disabled={submitting}>
          {submitting ? '提交中...' : '提交'}
        </Button>
      </div>
    </div>
  );
};

/* ============ 主页面 ============ */

const LeadDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [lead, setLead] = useState<Lead | null>(null);
  const [contactLogs, setContactLogs] = useState<ContactLog[]>([]);
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState<boolean>(false);

  const loadContactLogs = useCallback(async () => {
    if (!id) return;
    try {
      const logs = await getContactLogs(id);
      setContactLogs(logs);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载联系记录失败');
    }
  }, [id]);

  const loadAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [leadData, logsData, reqData] = await Promise.all([
        getLeadById(id),
        getContactLogs(id),
        getLeadRequirements(id),
      ]);
      setLead(leadData);
      setContactLogs(logsData);
      setRequirement(reqData);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载线索详情失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const handleBack = () => {
    navigate('/');
  };

  const handleAddContact = () => {
    setShowAddForm(true);
  };

  const handleContactCreated = () => {
    setShowAddForm(false);
    loadContactLogs();
  };

  // 渲染
  if (loading) {
    return (
      <div className="p-6">
        <div className="p-12 text-center text-gray-400">加载中...</div>
      </div>
    );
  }

  if (error && !lead) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error}
        </div>
        <Button variant="outline" size="sm" className="mt-4" onClick={handleBack}>
          返回线索列表
        </Button>
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6">
        <div className="p-12 text-center text-gray-400">线索不存在</div>
      </div>
    );
  }

  const leadStatusCfg = LEAD_STATUS_MAP[lead.status] ?? {
    label: lead.status,
    className: 'bg-gray-100 text-gray-500 border-gray-200',
  };

  return (
    <div className="p-6 space-y-4">
      {/* 顶部导航 */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={handleBack}>
          <ArrowLeft />
          返回线索列表
        </Button>
        <h1 className="text-xl font-bold text-gray-800">线索详情</h1>
      </div>

      {/* 错误提示（非致命） */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 左右分栏 */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* 左侧 2/3 */}
        <div className="flex-1 lg:flex-[2] space-y-4">
          {/* 线索信息卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">线索信息</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6">
                <InfoRow label="客户姓名" value={lead.customerName} />
                <InfoRow label="电话号码" value={lead.phoneNumber} />
                <InfoRow label="服务城市" value={lead.serviceCity} />
                <InfoRow label="来源" value={getSourceLabel(lead.source)} />
                <InfoRow label="来源细分" value={lead.leadSourceDetail} />
                <div className="flex py-2 border-b border-gray-100 last:border-0">
                  <span className="w-28 shrink-0 text-sm text-gray-400">状态</span>
                  <Badge variant="outline" className={leadStatusCfg.className}>
                    {leadStatusCfg.label}
                  </Badge>
                </div>
                <GradeInfoSection lead={lead} onGradeUpdated={loadAll} />
                <div className="flex py-2 border-b border-gray-100 last:border-0">
                  <span className="w-28 shrink-0 text-sm text-gray-400">紧急程度</span>
                  {lead.urgencyLevel ? (
                    <Badge variant="outline" className={URGENCY_STYLE[lead.urgencyLevel] ?? ''}>
                      {URGENCY_LABEL[lead.urgencyLevel] ?? lead.urgencyLevel}
                    </Badge>
                  ) : (
                    <span className="text-sm text-gray-400">未判断</span>
                  )}
                </div>
                <div className="flex py-2 border-b border-gray-100 last:border-0">
                  <span className="w-28 shrink-0 text-sm text-gray-400">电话验证</span>
                  <Badge variant="outline" className={lead.phoneVerified ? 'bg-green-100 text-green-700 border-green-200' : 'bg-gray-100 text-gray-500 border-gray-200'}>
                    {lead.phoneVerified ? '已验证' : '未验证'}
                  </Badge>
                </div>
                <InfoRow label="创建时间" value={formatDate(lead.createdAt)} />
              </div>
            </CardContent>
          </Card>

          {/* 联系记录时间线 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">联系记录</CardTitle>
            </CardHeader>
            <CardContent>
              {contactLogs.length === 0 ? (
                <div className="py-8 text-center text-sm text-gray-400">
                  暂无联系记录
                </div>
              ) : (
                <div>
                  {contactLogs.map((log: ContactLog, idx: number) => (
                    <ContactLogItem
                      key={log.id}
                      log={log}
                      isLast={idx === contactLogs.length - 1}
                    />
                  ))}
                </div>
              )}

              {/* 添加联系记录 */}
              {!showAddForm ? (
                <Button variant="outline" size="sm" onClick={handleAddContact}>
                  <Plus />
                  添加联系记录
                </Button>
              ) : (
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAddForm(false)}
                  >
                    取消
                  </Button>
                  <AddContactForm leadId={lead.id} onCreated={handleContactCreated} />
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* 右侧 1/3 */}
        <div className="lg:flex-1 space-y-4">
          {/* 需求信息卡片 */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">需求信息</CardTitle>
            </CardHeader>
            <CardContent>
              {requirement ? (
                <div className="flex flex-col">
                  <InfoRow label="服务类型" value={requirement.serviceType} />
                  <InfoRow label="家庭人口" value={formatHouseholdSize(requirement.householdSize)} />
                  <InfoRow label="面积" value={formatArea(requirement.area)} />
                  <InfoRow label="老人照护" value={requirement.elderlyCare} />
                  <InfoRow label="休息天数" value={requirement.restDays} />
                  <InfoRow label="到岗时间" value={requirement.startTime} />
                  <InfoRow label="服务地址" value={requirement.serviceAddress} />
                  <InfoRow label="阿姨要求" value={requirement.helperRequirements} />
                  <InfoRow label="口味偏好" value={requirement.dietaryPreferences} />
                  <InfoRow label="预算" value={formatBudget(requirement.budget)} />
                  <InfoRow label="服务周期" value={lead.serviceDuration} />
                  <InfoRow label="特殊需求" value={lead.specialRequirements ?? requirement.specialRequirements} />
                  <InfoRow label="家庭情况" value={lead.familyInfo} />
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-gray-400">
                  暂无需求信息
                </div>
              )}
            </CardContent>
          </Card>

          {/* 聊天入口卡片 */}
          {lead.chatToken && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">聊天会话</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-3">
                  <MessageSquareText className="w-5 h-5 text-primary" />
                  <span className="text-sm text-gray-600">该线索有客户聊天会话</span>
                </div>
                <Button asChild variant="outline" size="sm" className="mt-3">
                  <Link to="/chat-sessions">查看聊天记录</Link>
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};

export default LeadDetailPage;
