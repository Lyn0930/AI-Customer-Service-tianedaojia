export const CLARITY_FIELDS: (keyof ClaritySource)[] = [
  'serviceType', 'serviceAddress', 'startTime', 'budget', 'area',
  'serviceHours', 'helperRequirements', 'restDays',
  'dietaryPreferences', 'householdSize', 'hasPet',
];

export interface ClaritySource {
  serviceType?: string | null;
  serviceAddress?: string | null;
  startTime?: string | null;
  budget?: string | null;
  area?: string | null;
  serviceHours?: string | null;
  helperRequirements?: string | null;
  restDays?: string | null;
  dietaryPreferences?: string | null;
  householdSize?: string | null;
  hasPet?: string | null;
}

// budget 解析已统一到 shared（2026-09-16），re-export 保持旧引用路径兼容
export { parseBudgetNumber } from '../../../shared/budget-format';

export function scoreUrgency(startTime: string | null): 1 | 2 | 3 {
  if (!startTime) return 1;
  if (/尽快|马上|立即|急需| asap/i.test(startTime)) return 3;
  if (/一周内|7天|一个星期/.test(startTime)) return 3;
  if (/两周内|14天|半个月/.test(startTime)) return 2;
  const dateMatch = startTime.match(/(\d{4})[年\-/.](\d{1,2})[月\-/.](\d{1,2})/);
  if (dateMatch) {
    const target = new Date(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
    );
    const days = (target.getTime() - Date.now()) / 86400000;
    if (days <= 7) return 3;
    if (days <= 14) return 2;
    return 1;
  }
  return 1;
}

export function scoreClarity(
  req: ClaritySource | null,
): { score: 1 | 2 | 3; filled: number } {
  if (!req) return { score: 1, filled: 0 };
  const filled = CLARITY_FIELDS.filter((f: keyof ClaritySource) => {
    const v = req[f];
    return !!v && v.trim() !== '' && v !== '待定';
  }).length;
  const ratio = filled / CLARITY_FIELDS.length;
  if (ratio > 0.8) return { score: 3, filled };
  if (ratio >= 0.6) return { score: 2, filled };
  return { score: 1, filled };
}

const TIER1_CITIES = ['北京', '上海', '广州', '深圳'];
const TIER2_CITIES = [
  '成都', '杭州', '重庆', '武汉', '西安', '南京', '苏州', '天津',
  '长沙', '郑州', '青岛', '沈阳', '东莞', '佛山', '合肥', '昆明',
  '福州', '厦门', '济南', '大连', '宁波', '无锡',
];

export function getCityTier(city: string | null): string {
  if (!city) return '三线';
  if (TIER1_CITIES.some((c: string) => city.includes(c))) return '一线';
  if (TIER2_CITIES.some((c: string) => city.includes(c))) return '二线';
  return '三线';
}

export function mapSalaryServiceType(serviceType: string): string {
  if (serviceType.includes('菲')) return '菲式';
  if (serviceType.includes('护工') || serviceType.includes('养老')) return '护工';
  if (serviceType.includes('钟点')) return '钟点工';
  return serviceType;
}

export const HIGH_EMOTION_KEYWORDS = [
  '投诉', '垃圾', '什么玩意', '太差了', '骗人', '退款', '差评',
  '赶紧', '立刻', '马上', '怎么还没人', '等多久了', '太慢了',
];
