export interface RequirementField {
  key: string;
  label: string;
  question: string;
  required: boolean;
}

/**
 * 6 种保姆类型白名单（v1.1·2026-08-22 林琳拍板）
 * - 钟点工保姆 / 白班保姆 / 住家保姆 / 育儿保姆 / 护工保姆 / 菲式保姆
 * - 注意：v1.1 把"养老保姆"合并到"护工保姆"（养老相关需求统一归为护工）
 * - 不在此列表的 service_type → 整条 requirements 记录删除
 * - 客户说的非标准表述（"住家阿姨""养老保姆""护工"）AI 必须归一化到标准枚举值
 */
export const VALID_BAOMU_TYPES = ['钟点工保姆', '白班保姆', '住家保姆', '育儿保姆', '护工保姆', '菲式保姆'] as const;
export type BaomuServiceType = typeof VALID_BAOMU_TYPES[number];

/** 需要主动问 service_hours 的 4 种类型（v1.1：把养老改成护工） */
export const SERVICE_HOURS_REQUIRED_TYPES: BaomuServiceType[] = ['钟点工保姆', '育儿保姆', '护工保姆', '菲式保姆'];

/** 默认 service_hours（白班=8-9小时，住家=24小时） */
export const DEFAULT_SERVICE_HOURS: Record<string, string> = {
  '白班保姆': '8-9小时',
  '住家保姆': '24小时',
};

export function isValidBaomuType(type: string | null | undefined): type is BaomuServiceType {
  return !!type && VALID_BAOMU_TYPES.includes(type as BaomuServiceType);
}

export function needsServiceHoursAsk(type: string | null | undefined): boolean {
  return !!type && SERVICE_HOURS_REQUIRED_TYPES.includes(type as BaomuServiceType);
}

export function getDefaultServiceHours(type: string | null | undefined): string | null {
  if (!type) return null;
  return DEFAULT_SERVICE_HOURS[type] ?? null;
}

/**
 * 字段采集状态（三级）
 *
 * - clear：已明确采集。客户给出了明确的"是"或"否"（含具体信息）
 *   例："需要老人照护，我妈 75 岁" / "不需要" / "有，两位老人" / "不用照顾"
 *
 * - vague：已询问过。客户回答了但是模糊的，没有明确的是或否
 *   例："随便" / "都行" / "看情况" / "待定" / "暂时不确定" / "还没想好" / "再说吧"
 *   行为：不反复追问，但可以在合适时机自然确认一下
 *
 * - none：未采集。客户没回答、转移话题、或值为空
 */
export type FieldCollectionStatus = 'clear' | 'vague' | 'none';

/** 模糊回答关键词——客户说了这些，算"已询问过"但不算"已明确采集" */
const VAGUE_ANSWER_PATTERNS = [
  /^随便$/,
  /^都行$/,
  /^都可以$/,
  /^无所谓$/,
  /^看情况$/,
  /^待定$/,
  /^暂时不确定/,
  /^还没.*想/,
  /^再说/,
  /^先看看/,
  /^还没定/,
  /^没考虑/,
  /^没怎么想/,
  /^到时候再/,
  /^看你们/,
  /^看安排/,
  /^你们定/,
  /^你看着/,
  /^都行吧$/,
  /^随便吧$/,
  /^都可以吧$/,
];

/** 明确否定回答关键词——客户明确说"不需要/没有" */
const CLEAR_NEGATIVE_PATTERNS = [
  /不需要/,
  /不用(?!了$)/, // "不用"算否定，但"不用了"也一样算，这里不用排除
  /没有/,
  /不要/,
  /不用了/,
  /没有了/,
  /不用照顾/,
  /不用照护/,
  /不需要照顾/,
  /不需要照护/,
  /不用陪护/,
  /不需要陪护/,
  /无老人/,
  /没老人/,
  /没有老人/,
  /不需要人/,
  /不需要老人/,
  /家里没有/,
  /暂不需要/,
  /暂时不需要/,
  /暂不/,
];

/** 明确肯定回答关键词——客户明确说"需要/有/是" */
const CLEAR_POSITIVE_PATTERNS = [
  /需要/,
  /有老人/,
  /有(的|啊|哦|呢|吧)/,
  /是的?/,
  /对(的|啊|哦|呢|吧)?/,
  /要(的|啊|哦|呢|吧)?/,
  /好(的|啊|哦|呢|吧)?/,
  /嗯/,
  /需要照顾/,
  /需要照护/,
  /需要陪护/,
  /要照顾/,
  /要照护/,
  /要陪护/,
  /有长辈/,
  /家里有/,
  /需要人/,
];

/**
 * 统一判断字段采集状态（三级：clear / vague / none）
 *
 * 为什么要分三级：
 *   - clear：明确的是或否 → 绝对不重复问
 *   - vague：客户回答了但是模糊 → 不反复追问，但可以自然确认
 *   - none：没采集到 → 应该问
 *
 * 之前只有两级（已采集/未采集），问题是"待定/随便"这种模糊回答
 *   被当成"已采集"后 AI 就彻底跳过了，可能错过重要信息。
 */
export function getFieldCollectionStatus(value: string | null | undefined): FieldCollectionStatus {
  if (value === null || value === undefined) return 'none';
  const trimmed = String(value).trim();
  if (trimmed.length === 0) return 'none';

  // 先检查是不是模糊回答（整句匹配模糊词）
  const isVague = VAGUE_ANSWER_PATTERNS.some((p) => p.test(trimmed));
  if (isVague) return 'vague';

  // 再检查是不是明确回答（肯定或否定）
  const isClearNegative = CLEAR_NEGATIVE_PATTERNS.some((p) => p.test(trimmed));
  const isClearPositive = CLEAR_POSITIVE_PATTERNS.some((p) => p.test(trimmed));
  if (isClearNegative || isClearPositive) return 'clear';

  // 有具体内容但没命中关键词 → 也算明确采集（比如"我妈 75 岁"这种直接描述）
  // 长度超过 5 个字、且不是纯语气词 → 视为有实质内容
  if (trimmed.length >= 5) return 'clear';

  // 短文本但没命中任何模式 → 保守算 vague（可能是"哦"/"啊"/"嗯"之类单字回应）
  return 'vague';
}

/**
 * 简化版：判断字段是否已采集（clear + vague 都算）
 * 用于"要不要重复问"的判断——只要客户回答过，不管明确还是模糊，都别反复问
 */
export function isFieldCollected(value: string | null | undefined): boolean {
  const status = getFieldCollectionStatus(value);
  return status === 'clear' || status === 'vague';
}

/**
 * 判断字段是否已明确采集（只有 clear 才算）
 * 用于"要不要在合适时机自然确认一下"的判断
 */
export function isFieldClear(value: string | null | undefined): boolean {
  return getFieldCollectionStatus(value) === 'clear';
}

/**
 * 住家保姆一次性采集模板（2026-08-16 林琳拍板 + 8/16 修正）
 * 2026-08-16 v1: 5 字段精简版（3 单独项由人工对接）
 * 2026-08-16 v2 (当前): 5 字段 + 3 单独项 = 8 字段，分 2 阶段采集
 *   - 阶段 1（5 字段一次性）：使用类型 + 工作内容 + 阿姨休息 + 到岗时间 + 服务地址
 *   - 阶段 2（3 单独项，由 AI 单独问）：阿姨要求 + 做饭口味 + 薪资预算
 *
 * 区别于通用 BAOMU_TEMPLATE（10 字段）：
 *   - 去掉了"工作制"（住家保姆默认 24 小时住家，不需要单独问）
 *   - 工作内容三子字段任一填就算"工作内容"采了
 *   - 3 单独项保留（v1 一度去除，v2 加回）—— 林琳决策"由 AI 采集，只是单独问"
 */
const ZHUJIA_TEMPLATE: RequirementField[] = [
  // ===== 阶段 1：5 字段一次性 =====
  { key: 'serviceType', label: '使用类型', question: '咱们这边是住家保姆服务对吗？', required: true },
  { key: 'householdSize', label: '家庭人数', question: '家里几口人吃饭呀？', required: false },
  { key: 'area', label: '房屋面积', question: '房子大概多大面积呢？', required: false },
  { key: 'elderlyCare', label: '照护老人', question: '是否需要同时照顾老人/小孩？', required: false },
  { key: 'restDays', label: '阿姨休息', question: '阿姨月休几天呢？4天还是2天？', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '在哪个区哪个街道？', required: true },
  // ===== 阶段 2：3 单独项（5 字段采齐后由 AI 单独问） =====
  { key: 'helperRequirements', label: '阿姨要求', question: '对阿姨有什么特别要求吗？比如年龄、经验、做饭风格等', required: false },
  { key: 'dietaryPreferences', label: '做饭口味', question: '做饭口味有什么偏好？比如菜系、忌口等', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: false },
];

/**
 * 阶段 1 采齐判断（5 字段：restDays + startTime + serviceAddress + 工作内容 3 选 1+）
 * 2026-08-16 林琳拍板，zhujia 专用
 */
export function isZhujiaRequiredFieldsComplete(req: {
  restDays?: string | null;
  startTime?: string | null;
  serviceAddress?: string | null;
  householdSize?: string | null;
  area?: string | null;
  elderlyCare?: string | null;
} | null): boolean {
  if (!req) return false;
  const requiredOk = !!(req.restDays && req.startTime && req.serviceAddress);
  const workContentOk = !!(req.householdSize || req.area || req.elderlyCare);
  return requiredOk && workContentOk;
}

/**
 * 阶段 2 采齐判断（5 字段 + 3 单独项 = 8 字段全齐）
 * 2026-08-16 v2 修正：3 单独项也由 AI 采集，必须全齐才转人工
 * 注：3 单独项是选填（required: false），但缺一项时 AI 应继续引导（不转人工）
 * 客户明确说"不需要/不用/没要求"等负面回复也算"采了"（detectFieldsFromConversation 已处理）
 */
export function isZhujiaAllFieldsComplete(req: {
  restDays?: string | null;
  startTime?: string | null;
  serviceAddress?: string | null;
  householdSize?: string | null;
  area?: string | null;
  elderlyCare?: string | null;
  helperRequirements?: string | null;
  dietaryPreferences?: string | null;
  budget?: string | null;
} | null): boolean {
  if (!req) return false;
  if (!isZhujiaRequiredFieldsComplete(req)) return false;
  return !!(req.helperRequirements && req.dietaryPreferences && req.budget);
}

/**
 * 兼容旧 API：isZhujiaOneShotComplete 现在等价于 isZhujiaRequiredFieldsComplete
 * @deprecated 请改用 isZhujiaRequiredFieldsComplete 或 isZhujiaAllFieldsComplete
 */
export const isZhujiaOneShotComplete = isZhujiaRequiredFieldsComplete;

/**
 * 钟点工保姆采集模板（2026-08-16 林琳 20:53 拍板·5+1 步分阶段采集）
 *
 * 区别于通用 BAOMU_TEMPLATE（10 字段）：
 *   - 去掉 elderlyCare（钟点工时间短，不需要照护老人/小孩）— 林琳 19:14 明确
 *   - 去掉 serviceType（chip 选过的服务类型不需要再列进进度）— 林琳 19:14 明确
 *   - 工作内容 2 选 1+（householdSize / area），其他保姆类是 3 选 1+
 *
 * 2026-08-16 20:53 拍板新增 2 字段（5+1 步分阶段采集）：
 *   - serviceItems: chip 5+1 选中的工作内容（做饭/洗衣/打扫卫生/买菜/接送孩子/自定义）
 *   - serviceHours: 每天上门小时数（2-5 小时，钟点工特性）
 *   模板字段从 8 → 10；UI 进度面板相应增加 2 项
 *
 * 阶段 1（6 字段，1 个 1 个问）：
 *   ① serviceItems（chip 5+1）
 *   ② serviceHours（每天几小时）
 *   ③ householdSize + area（1 个气泡问 2 子项：家里几口人、房子多大平）
 *   ④ restDays
 *   ⑤ startTime
 *   ⑥ serviceAddress
 * 阶段 2（3 单独项，6 字段采齐后由 AI 单独问）：
 *   helperRequirements + dietaryPreferences + budget
 */
const ZHONGDIAN_TEMPLATE: RequirementField[] = [
  // ===== 阶段 1：6 字段（1 个 1 个问）=====
  { key: 'serviceItems', label: '工作内容', question: '主要想让阿姨负责哪些事呢？', required: true },
  { key: 'serviceHours', label: '工作小时', question: '请问您每天需要阿姨上门几个小时呢？', required: true },
  { key: 'householdSize', label: '家庭情况', question: '家里几口人吃饭呀？', required: false },
  { key: 'area', label: '房屋面积', question: '房子大概多大面积呢？', required: false },
  // 2026-08-16 林琳 16:16 拍板：钟点工月休问"无月休、月休2天、或月休4天"3 选项
  // 选"无月休"不触发转人工（钟点工特殊性质：客户工作忙不需要阿姨休息）
  { key: 'restDays', label: '休息天数', question: '您想让阿姨月休几天呢？无月休、月休2天、或月休4天', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '在哪个区哪个街道？', required: true },
  // ===== 阶段 2：3 单独项（6 字段采齐后由 AI 单独问） =====
  { key: 'helperRequirements', label: '阿姨要求', question: '对阿姨有什么特别要求吗？比如年龄、经验、做饭风格等', required: false },
  { key: 'dietaryPreferences', label: '做饭口味', question: '做饭口味有什么偏好？比如菜系、忌口等', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: false },
];

/**
 * 阶段 1 采齐判断（6 字段：serviceItems + serviceHours + restDays + startTime + serviceAddress + 工作内容 2 选 1+）
 * 2026-08-16 20:53 林琳拍板，zhongdian 专用（5+1 步分阶段采集）
 * 2026-08-22 林琳拍板：serviceItems / serviceHours 从 collectedFields JSON 迁为独立列，直接传字符串
 */
export function isZhongdianRequiredFieldsComplete(req: {
  serviceItems?: string | null;
  serviceHours?: string | null;
  restDays?: string | null;
  startTime?: string | null;
  serviceAddress?: string | null;
  householdSize?: string | null;
  area?: string | null;
} | null): boolean {
  if (!req) return false;
  const requiredOk = !!(req.serviceItems && req.serviceHours && req.restDays && req.startTime && req.serviceAddress);
  const workContentOk = !!(req.householdSize || req.area);
  return requiredOk && workContentOk;
}

/**
 * 阶段 2 采齐判断（6 阶段 1 字段 + 3 单独项 = 9 字段条件 / UI 10 项全齐）
 * 2026-08-16 v1：3 单独项也由 AI 采集，必须全齐才转人工
 * 2026-08-16 v3（林琳 16:58 澄清）：钟点工 restDays="无月休" 视为正常选项之一，4+3 字段全齐后正常转人工
 *   - "无月休"在钟点工是合法选项（客户工作忙不需要阿姨休息），不作为转人工的排除条件
 *   - 4+3 字段全齐+月休2天/4天 → true → 转人工
 * 2026-08-16 v4（林琳 19:44 拍板反转）：钟点工 restDays="无月休" 8 字段全齐**不**走转人工
 *   - 钟点工客户工作忙选无月休，AI 整理需求复述后结束采集即可，不需人工对接
 *   - isZhongdianAllFieldsComplete 函数仍返 true（9 字段全齐了），由 ChatRequirementsService.autoTransferIfFieldsComplete 根据 restDays 决定是否触发转人工
 *   - 与 chat.service.ts:detectNonStandardRestDays 的早拦截配合：钟点工场景下"无月休"不走该早拦截
 * 2026-08-16 v5（林琳 19:14）：serviceType 从模板去掉，采集判断不变（serviceType 不在 isZhongdianXxxComplete 中）
 * 2026-08-16 v6（林琳 20:53 拍板·5+1 步分阶段采集）：阶段 1 增加 serviceItems + serviceHours 两字段
 *   - 6+3 = 9 字段全齐后判断"阶段 1 必填 + 阶段 2 单独项"是否齐全
 *   - "无月休"豁免转人工规则保持不变
 */
/**
 * 字段全齐判断统一入口（2026-08-29 下沉重构）：
 *   - 住家：8 字段全齐（isZhujiaAllFieldsComplete）
 *   - 钟点工：9 字段全齐（isZhongdianAllFieldsComplete；无月休例外由调用方判断）
 *   - 育儿：3 字段（服务类型+地址+预算）+ childCare 必采（2026-08-29 林琳拍板）
 *   - 其他类型：服务类型+地址+预算 3 项齐
 */
export function isRequirementCompleteForTransfer(req: {
  serviceType?: string | null;
  householdSize?: string | null;
  area?: string | null;
  elderlyCare?: string | null;
  childCare?: string | null;
  restDays?: string | null;
  startTime?: string | null;
  serviceAddress?: string | null;
  helperRequirements?: string | null;
  dietaryPreferences?: string | null;
  budget?: string | null;
  serviceItems?: string | null;
  serviceHours?: string | null;
} | null): boolean {
  if (!req?.serviceType) return false;
  const subType = normalizeServiceSubType(req.serviceType);
  if (subType === 'zhujia') return isZhujiaAllFieldsComplete(req);
  if (subType === 'zhongdian') return isZhongdianAllFieldsComplete(req);
  if (subType === 'yuer') {
    return !!(req.childCare && req.serviceAddress && req.budget);
  }
  return !!(req.serviceAddress && req.budget);
}

export function isZhongdianAllFieldsComplete(req: {
  serviceItems?: string | null;
  serviceHours?: string | null;
  restDays?: string | null;
  startTime?: string | null;
  serviceAddress?: string | null;
  householdSize?: string | null;
  area?: string | null;
  helperRequirements?: string | null;
  dietaryPreferences?: string | null;
  budget?: string | null;
} | null): boolean {
  if (!req) return false;
  if (!isZhongdianRequiredFieldsComplete(req)) return false;
  return !!(req.helperRequirements && req.dietaryPreferences && req.budget);
}


const BAOMU_TEMPLATE: RequirementField[] = [
  // 2026-08-16 林琳 18:55 拍板：label 按用户原文（使用类型/家庭人数/房屋面积/照护老人/阿姨休息/到岗时间/服务地址/阿姨要求/做饭口味/薪资预算）
  { key: 'serviceType', label: '使用类型', question: '咱们这边是需要钟点工、白班、住家、育儿、护工还是菲式保姆呢？', required: true },
  { key: 'householdSize', label: '家庭人数', question: '家里几口人吃饭呀？', required: false },
  { key: 'area', label: '房屋面积', question: '房子大概多大面积呢？', required: false },
  { key: 'elderlyCare', label: '照护老人', question: '家里有需要照顾的老人吗？老人多大年纪？', required: false },
  { key: 'restDays', label: '阿姨休息', question: '阿姨月休几天呢？4天还是2天？', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'helperRequirements', label: '阿姨要求', question: '对阿姨有什么特殊要求吗？', required: false },
  { key: 'dietaryPreferences', label: '做饭口味', question: '做饭口味有什么偏好？', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: true },
];

const YUESAO_TEMPLATE: RequirementField[] = [
  { key: 'serviceType', label: '服务类型', question: '您是需要月嫂服务对吗？是26天还是42天的？', required: true },
  { key: 'startTime', label: '预产期/到岗', question: '预产期是什么时候？您需要月嫂什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'helperRequirements', label: '月嫂要求', question: '对月嫂有什么特殊要求吗？比如催乳、月子餐、新生儿护理等', required: false },
  { key: 'restDays', label: '休息天数', question: '月嫂月休几天呢？', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少？', required: true },
];

const YANGLOA_TEMPLATE: RequirementField[] = [
  { key: 'serviceType', label: '服务类型', question: '咱们这边是需要住家照顾老人还是白班陪护呢？', required: true },
  { key: 'elderlyCare', label: '老人情况', question: '老人身体状况如何？能自理 / 半自理 / 不能自理？', required: true },
  { key: 'restDays', label: '休息天数', question: '阿姨月休几天呢？4天还是2天？', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'helperRequirements', label: '阿姨要求', question: '对照顾老人的阿姨有什么特殊要求吗？', required: false },
  { key: 'dietaryPreferences', label: '做饭口味', question: '老人饮食有什么偏好或忌口？', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: true },
];

const YUER_TEMPLATE: RequirementField[] = [
  { key: 'serviceType', label: '服务类型', question: '咱们这边是需要住家育儿还是白班育儿呢？', required: true },
  { key: 'householdSize', label: '孩子情况', question: '宝宝多大啦？几个孩子需要照顾？', required: true },
  { key: 'childCare', label: '照顾小孩', question: '宝宝多大了？需要阿姨带孩子吗？', required: true },
  { key: 'restDays', label: '休息天数', question: '阿姨月休几天呢？4天还是2天？', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'helperRequirements', label: '阿姨要求', question: '对育儿阿姨有什么特殊要求吗？比如早教、辅食等', required: false },
  { key: 'dietaryPreferences', label: '做饭口味', question: '家里做饭口味有什么偏好？', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: true },
];

const BAOJIE_TEMPLATE: RequirementField[] = [
  { key: 'serviceType', label: '服务类型', question: '咱们这边是需要日常保洁还是深度保洁呢？', required: true },
  { key: 'area', label: '房屋面积', question: '房子大概多大面积呢？', required: true },
  { key: 'startTime', label: '开始时间', question: '希望阿姨什么时候开始服务呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'specialRequirements', label: '特殊需求', question: '有没有特殊保洁需求？比如油烟机清洗、擦玻璃、收纳整理等', required: false },
  { key: 'budget', label: '预算', question: '预算大概每次多少呢？', required: true },
];

const FEISHI_TEMPLATE: RequirementField[] = [
  { key: 'serviceType', label: '服务类型', question: '您是需要菲式保姆对吧？', required: true },
  { key: 'householdSize', label: '家庭情况', question: '家里几口人呢？主要想阿姨负责哪些事？', required: true },
  { key: 'restDays', label: '休息天数', question: '阿姨月休几天呢？4天还是2天？', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'helperRequirements', label: '阿姨要求', question: '对菲式阿姨有什么特殊要求吗？比如英语、做菜风格、带睡等', required: false },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: true },
];

const DEFAULT_TEMPLATE: RequirementField[] = [
  { key: 'serviceType', label: '服务类型', question: '咱们这边是需要住家、白班还是钟点服务呀？', required: true },
  { key: 'startTime', label: '到岗时间', question: '您希望阿姨什么时候到岗呢？', required: true },
  { key: 'serviceAddress', label: '服务地址', question: '服务地址在哪个区哪个街道？', required: true },
  { key: 'budget', label: '薪资预算', question: '薪资预算大概多少呢？', required: true },
];

const SERVICE_TYPE_ALIASES: Record<string, string> = {
  baomu: 'baomu',
  zhujia: 'baomu',
  baiban: 'baomu',
  zhongdian: 'baomu',
  feishi: 'feishi',
  '保姆': 'baomu',
  '住家': 'baomu',
  '白班': 'baomu',
  '白班保姆': 'baomu', // 2026-08-16 林琳 18:55 反馈修复：DB 存中文'白班保姆'，SERVICE_TYPE_ALIASES 缺整串映射，normalizeServiceType 落回 default
  '钟点': 'baomu',
  '钟点工': 'baomu',
  '钟点工保姆': 'baomu', // 同上防御层：避免 zhongdian 走 default
  '菲式': 'feishi',
  '菲佣': 'feishi',
  yuesao: 'yuesao',
  '26day_yuesao': 'yuesao',
  '月嫂': 'yuesao',
  '26天月嫂': 'yuesao',
  yanglao: 'yanglao',
  '养老': 'yanglao',
  '养老陪护': 'yanglao',
  '护工': 'yanglao',
  yuer: 'yuer',
  '育儿': 'yuer',
  '育儿嫂': 'yuer',
  baojie: 'baojie',
  qingjie: 'baojie',
  '保洁': 'baojie',
  '清洁': 'baojie',
  '保洁阿姨': 'baojie',
  '日常保洁': 'baojie',
  '深度保洁': 'baojie',
};

const SERVICE_TYPE_LABELS: Record<string, string> = {
  baomu: '保姆',
  feishi: '菲式保姆',
  yuesao: '月嫂',
  yanglao: '护工保姆',
  yuer: '育儿嫂',
  baojie: '保洁',
};

export const SERVICE_TYPE_TEMPLATES: Record<string, RequirementField[]> = {
  zhujia: ZHUJIA_TEMPLATE, // 2026-08-16 一次性采集，住家保姆走自己的精简模板（不走 baomu 的 10 字段）
  baomu: BAOMU_TEMPLATE,
  feishi: FEISHI_TEMPLATE,
  yuesao: YUESAO_TEMPLATE,
  yanglao: YANGLOA_TEMPLATE,
  yuer: YUER_TEMPLATE,
  baojie: BAOJIE_TEMPLATE,
};

export const DEFAULT_TEMPLATE_KEY = 'default';

export function normalizeServiceType(serviceType: string | null | undefined): string {
  if (!serviceType) return DEFAULT_TEMPLATE_KEY;
  const trimmed = serviceType.trim().toLowerCase();
  return SERVICE_TYPE_ALIASES[trimmed]
    ?? SERVICE_TYPE_ALIASES[serviceType.trim()]
    ?? DEFAULT_TEMPLATE_KEY;
}

const SERVICE_SUBTYPE_MAP: Record<string, string> = {
  zhujia: 'zhujia', '住家': 'zhujia', '住家保姆': 'zhujia',
  baiban: 'baiban', '白班': 'baiban', '白班保姆': 'baiban',
  yuer: 'yuer', '育儿': 'yuer', '育儿嫂': 'yuer', '育儿保姆': 'yuer',
  yanglao: 'yanglao', '养老': 'yanglao', '护工': 'yanglao', '护工保姆': 'yanglao', '养老保姆': 'yanglao', '养老陪护': 'yanglao',
  zhongdian: 'zhongdian', '钟点': 'zhongdian', '钟点工': 'zhongdian', '钟点工保姆': 'zhongdian',
  feishi: 'feishi', '菲式': 'feishi', '菲式保姆': 'feishi', '菲佣': 'feishi',
  '26day_yuesao': '26day_yuesao', yuesao: '26day_yuesao', '月嫂': '26day_yuesao', '26天月嫂': '26day_yuesao',
  baomu: 'baomu', '保姆': 'baomu',
};

export function normalizeServiceSubType(serviceType: string | null | undefined): string | null {
  if (!serviceType) return null;
  const trimmed = serviceType.trim();
  const lower = trimmed.toLowerCase();
  return SERVICE_SUBTYPE_MAP[lower] ?? SERVICE_SUBTYPE_MAP[trimmed] ?? null;
}

/**
 * 把 normalizeServiceSubType 返回的 pinyin 标准化成中文（用于写库）
 * normalizeServiceSubType 必须保留 pinyin 输出（routing 决策用），所以在写库前过这层
 */
export function chineseServiceType(pinyinOrChinese: string | null | undefined): string {
  if (!pinyinOrChinese) return '';
  const PINYIN_TO_CHINESE: Record<string, string> = {
    yuesao: '月嫂',
    '26day_yuesao': '月嫂',
    feishi: '菲式',
    zhongdian: '钟点工',
    yuer: '育儿嫂',
    yanglao: '护工',
    baomu: '住家保姆',
    baojie: '保洁',
    baiban: '白班保姆', // v4 实测漏改：白班 pinyin 永远还原不回来，导致白班保姆走兜底
  };
  if (PINYIN_TO_CHINESE[pinyinOrChinese]) return PINYIN_TO_CHINESE[pinyinOrChinese];
  if (/[\u4e00-\u9fa5]/.test(pinyinOrChinese)) return pinyinOrChinese;
  return pinyinOrChinese;
}

export function getTemplate(serviceType: string | null | undefined): RequirementField[] {
  // 2026-08-16 zhujia 一次性采集：住家保姆子类型走精简模板（不查 normalizeServiceType，
  // 直接基于 normalizeServiceSubType 结果判断，绕开 SERVICE_TYPE_ALIASES['zhujia']='baomu'）
  // 2026-08-16 zhongdian 同样走独立模板：林琳 16:11 拍板去掉 elderlyCare，9 字段
  // 2026-08-16 18:55 baiban 加分支：林琳反馈"白班保姆只显示 4 项"，DB 存中文'白班保姆' → normalizeServiceSubType='baiban'
  //   → 之前没有 baiban 分支 → normalizeServiceType 也没匹配上 → 落回 default 4 项
  //   修法：baiban 走 BAOMU_TEMPLATE 10 项（与 zhujia 共享内容，只是 serviceTypeLabel 不同）
  const subType = normalizeServiceSubType(serviceType);
  if (subType === 'zhujia') return ZHUJIA_TEMPLATE;
  if (subType === 'baiban') return BAOMU_TEMPLATE;
  if (subType === 'zhongdian') return ZHONGDIAN_TEMPLATE;
  const key = normalizeServiceType(serviceType);
  return SERVICE_TYPE_TEMPLATES[key] ?? DEFAULT_TEMPLATE;
}

export function getServiceTypeLabel(serviceType: string | null | undefined): string {
  const subType = normalizeServiceSubType(serviceType);
  if (subType === 'zhujia') return '住家保姆';
  if (subType === 'baiban') return '白班保姆';
  if (subType === 'zhongdian') return '钟点工保姆';
  const key = normalizeServiceType(serviceType);
  return SERVICE_TYPE_LABELS[key] ?? '通用';
}

export const OPENING_MESSAGES: Record<string, string> = {
  baomu:
    '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～咱们这边是钟点工、白班、住家、育儿、护工还是菲式保姆？【客服后续会根据您所在的城市给出准确报价】。',
  yuesao:
    '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～请问您的【预产期】是什么时候？需要【26 天】还是【42 天】的月嫂服务呢？【客服后续会根据您所在的城市给出准确报价】。',
  yanglao:
    '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～咱们这边是需要【住家】照顾老人还是【白班】陪护？【客服后续会根据您所在的城市给出准确报价】。',
  yuer:
    '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～请问【宝宝】多大啦？需要【住家】育儿还是【白班】育儿呢？【客服后续会根据您所在的城市给出准确报价】。',
  baojie:
    '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～咱们这边是需要【日常保洁】还是【深度保洁】呀？【客服后续会根据您所在的城市给出准确报价】。',
};

export const DEFAULT_OPENING_MESSAGE =
  '您好，我是天鹅到家家政服务顾问小书，很高兴为您服务～咱们先确认一下您需要的服务类型和主要想阿姨负责的事。具体价格会根据您所在的城市调整，【客服后续会给准确报价】。请问您想找哪种类型的阿姨？主要想阿姨负责什么呢？';
