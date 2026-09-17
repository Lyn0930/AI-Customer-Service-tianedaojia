// 公开线索收集表单用到的渠道、服务类型组、服务类型常量

export const CHANNELS = ['xiaohongshu', 'douyin', 'seo', 'meituan', 'dianping', 'app', 'miniapp'] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  seo: 'SEO',
  meituan: '美团',
  dianping: '大众点评',
  app: '自有APP',
  miniapp: '小程序',
};

export const SOURCE_LABELS: Record<string, string> = {
  '小红书': '小红书',
  '抖音': '抖音',
  'SEO': 'SEO',
  '美团': '美团',
  '大众点评': '大众点评',
  '自有APP': '自有APP',
  '小程序': '小程序',
  '官网': '官网',
  unknown: '未知',
  xiaohongshu: '小红书',
  douyin: '抖音',
  seo: 'SEO',
  meituan: '美团',
  dianping: '大众点评',
  app: '自有APP',
  miniapp: '小程序',
  website: '官网',
};

export const getSourceLabel = (source: string): string => SOURCE_LABELS[source] ?? source;

const SOURCE_NORMALIZE_MAP: Record<string, string> = {
  xiaohongshu: '小红书',
  douyin: '抖音',
  seo: 'SEO',
  meituan: '美团',
  dianping: '大众点评',
  app: '自有APP',
  miniapp: '小程序',
  website: '官网',
};

export function normalizeSource(source: string): string {
  if (!source) return 'unknown';
  return SOURCE_NORMALIZE_MAP[source] ?? source;
}

/* ============ 线索渠道（lead 进入系统的方式） ============ */

export const LEAD_CHANNELS = [
  'openapi',
  'bitable_form',
  'chat',
  'phone',
  'manual',
] as const;
export type LeadChannel = (typeof LEAD_CHANNELS)[number];

export const LEAD_CHANNEL_LABELS: Record<LeadChannel, string> = {
  openapi: 'API推送',
  bitable_form: '飞书表单',
  chat: '在线咨询',
  phone: '电话',
  manual: '手动录入',
};

export function getLeadChannelLabel(channel: string): string {
  return LEAD_CHANNEL_LABELS[channel as LeadChannel] ?? channel;
}

export const CHANNEL_DEFAULT_GRADE: Record<LeadChannel, string> = {
  openapi: 'C',
  bitable_form: 'B',
  chat: 'C',
  phone: 'B',
  manual: 'B',
};

/** 手机号归一化：去除 +86 前缀、空格、横线，保留纯数字 */
export function normalizePhoneNumber(phone: string): string {
  if (!phone) return phone;
  let result = phone.trim();
  result = result.replace(/^\+86/, '');
  result = result.replace(/[\s\-]/g, '');
  return result;
}

/** 归一化线索入参，所有渠道统一调用 */
export interface NormalizeLeadInput {
  channel: LeadChannel;
  phoneNumber: string;
  serviceCity?: string;
  customerName?: string;
  source?: string;
  serviceType?: string;
  serviceTypeGroup?: string;
  leadSourceDetail?: string;
  phoneVerified?: boolean;
}

export interface NormalizedLead {
  channel: LeadChannel;
  phoneNumber: string;
  serviceCity: string;
  customerName: string | null;
  source: string;
  serviceType: string | undefined;
  serviceTypeGroup: string | undefined;
  leadSourceDetail: string | null;
  phoneVerified: boolean;
}

const PHONE_VERIFIED_CHANNELS: LeadChannel[] = ['openapi', 'phone', 'manual'];

export function normalizeLead(input: NormalizeLeadInput): NormalizedLead {
  const customerName = input.customerName?.trim() || null;
  const phoneVerified =
    input.phoneVerified ?? PHONE_VERIFIED_CHANNELS.includes(input.channel);

  return {
    channel: input.channel,
    phoneNumber: normalizePhoneNumber(input.phoneNumber),
    serviceCity: sanitizeCity(input.serviceCity ?? ''),
    customerName,
    source: normalizeSource(input.source ?? 'unknown'),
    serviceType: input.serviceType?.trim() || undefined,
    serviceTypeGroup: input.serviceTypeGroup?.trim() || undefined,
    leadSourceDetail: input.leadSourceDetail?.trim() || null,
    phoneVerified,
  };
}

export function sanitizeCity(city: string): string {
  if (!city) return city;
  let result = city.trim();
  if (result.startsWith('[')) {
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed) && parsed.length > 0) {
        result = String(parsed[0]);
      }
    } catch {
      // not valid JSON, continue
    }
  }
  result = result.replace(/^\[(?:API_TEST|E2E_TEST)\]/, '');
  return result.trim();
}

export const SERVICE_TYPE_GROUPS = ['baomu'] as const;
export type ServiceTypeGroup = (typeof SERVICE_TYPE_GROUPS)[number];

export const SERVICE_TYPE_GROUP_LABELS: Record<ServiceTypeGroup, string> = {
  baomu: '保姆',
};

export const SERVICE_TYPES = ['zhujia', 'yuer', 'baiban', 'yanglao', 'zhongdian', 'feishi'] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

// 服务类型展示文案（保姆组加「保姆」后缀，与用户原 base 选项对齐）
export const SERVICE_TYPE_LABELS: Record<ServiceType, string> = {
  zhujia: '住家保姆',
  yuer: '育儿保姆',
  baiban: '白班保姆',
  yanglao: '护工保姆',
  zhongdian: '钟点工保姆',
  feishi: '菲式保姆',
};

export const SERVICE_TYPE_OPTIONS_BAOMU: { value: ServiceType; label: string }[] = [
  { value: 'zhongdian', label: '钟点工保姆' },
  { value: 'baiban', label: '白班保姆' },
  { value: 'zhujia', label: '住家保姆' },
  { value: 'yuer', label: '育儿保姆' },
  { value: 'yanglao', label: '护工保姆' },
  { value: 'feishi', label: '菲式保姆' },
];

export function getServiceTypeOptions(_group: ServiceTypeGroup) {
  return SERVICE_TYPE_OPTIONS_BAOMU;
}

// 解析 URL 参数
export function parseChannelParam(value: string | null | undefined): Channel | null {
  if (!value) return null;
  return (CHANNELS as readonly string[]).includes(value) ? (value as Channel) : null;
}

export function parseGroupParam(value: string | null | undefined): ServiceTypeGroup | null {
  if (!value) return null;
  return (SERVICE_TYPE_GROUPS as readonly string[]).includes(value)
    ? (value as ServiceTypeGroup)
    : null;
}
