/**
 * 需求字段配置 — 单一数据源 (Single Source of Truth)
 *
 * 所有需求字段的定义集中在这里。
 * 加一个新字段？只改这个文件，其他地方自动同步：
 *   - prompt 生成的字段列表
 *   - 解析逻辑的字段键
 *   - 护栏逻辑的触发词
 *   - 字段标签 / 命名映射
 *   - DB 列名映射
 *
 * 注意：字段的 DB 列名（snake_case）必须与 schema.ts 中的列名一致。
 */

export interface RequirementFieldConfig {
  /** 字段中文名（用于 UI 展示 / prompt 描述） */
  label: string;
  /** DB 列名（snake_case），与 schema.ts 一致 */
  dbColumn: string;
  /** prompt 中给 AI 看的字段描述 */
  promptDescription: string;
  /** 护栏：疑问句触发词正则（camelCase key 对应） */
  guardQuestionTrigger?: RegExp;
  /** 护栏：显式询问触发词正则（不要求问号结尾） */
  guardImperativeTrigger?: RegExp;
  /** 字段类型，默认 text */
  type?: 'text' | 'number' | 'select';
}

/**
 * 所有需求字段的配置表。
 * key 是 camelCase 字段名（代码层使用），value 是配置对象。
 *
 * 顺序很重要：prompt 输出和 UI 展示都按这个顺序。
 */
export const REQUIREMENT_FIELDS: Record<string, RequirementFieldConfig> = {
  serviceType: {
    label: '服务类型',
    dbColumn: 'service_type',
    promptDescription: '客户需要的服务类型（住家保姆/白班保姆/钟点工保姆/育儿保姆/护工保姆/菲式保姆，仅此 6 类，不含月嫂、保洁，勿采集）',
    guardQuestionTrigger: /(哪类服务|您要哪类|您需要哪类|您想找哪种|想找哪种|找哪种|找什么类型|您想找.{0,4}(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|您要(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|您要找.{0,4}(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|您需要.{0,4}(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|需要(.{0,4})(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|想要(.{0,4})(月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|哪种(类型)?的?(阿姨|服务|月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|要(哪种|哪类|什么)(类型|服务|月嫂|育儿|护工|菲式|住家|白班|钟点|保姆)|选择(哪种|哪类|什么)|需要(哪种|哪类|什么)|您是.{0,6}哪种|您想要哪种|您要.{0,3}哪一|要哪一(类|种)|服务类型)/,
    guardImperativeTrigger: /(告诉我您要(哪一|什么|哪种)|您想找.{0,4}告诉我|您要(选|挑|确定|确认)哪|请告诉我您(要|想|需要)哪|想找.{0,4}告诉我|告诉我.{0,4}(哪一|什么类型|哪种))/,
  },
  householdSize: {
    label: '家庭人口',
    dbColumn: 'household_size',
    promptDescription: '家庭人口数（几口人）',
    guardQuestionTrigger: /(几口人|家里几口|家庭几口|家(里|中)有(几|多少)人|有(几|多少)口人|几口之家)/,
  },
  area: {
    label: '房屋面积',
    dbColumn: 'area',
    promptDescription: '房屋面积（多少平米/平）',
    guardQuestionTrigger: /(多大(面积|平米|平方|平)|多少(平米|平方|平|大)|(房屋|家|您家)?(面积|平米|平方|户型)|面积(多大|多少|怎么样))/,
  },
  elderlyCare: {
    label: '老人照护',
    dbColumn: 'elderly_care',
    promptDescription: '是否需要老人照护服务，以及具体需求',
    guardQuestionTrigger: /(老人|照护|陪护|老人家|家中老人|老人照护|照顾老人|需不需要.*老人|有没有.*老人|老人.*多大|老人.*年纪|老人.*身体|长辈)/,
  },
  childCare: {
    label: '照顾小孩',
    dbColumn: 'child_care',
    promptDescription: '是否需要照顾/接送小孩，以及孩子年龄',
    guardQuestionTrigger: /(小孩|孩子|宝宝|带娃|育儿|儿童|接送孩子|孩子多大|宝宝多大|几个孩子)/,
  },
  restDays: {
    label: '月休天数',
    dbColumn: 'rest_days',
    promptDescription: '每月休息天数（4天/2天/6天/无月休等）',
    guardQuestionTrigger: /(月休(几|多少|哪)天|休息(几|多少|哪)天|休(几|多少|哪)天|月休(安排|选择)|\d+\s*天还是\s*\d+\s*天|几天呢)/,
  },
  startTime: {
    label: '到岗时间',
    dbColumn: 'start_time',
    promptDescription: '希望阿姨什么时候到岗/开始服务',
    guardQuestionTrigger: /(什么时候(到岗|开始|上门|来|过来)|希望阿姨(什么时候|多久)|(到岗|开始)时间|阿姨.{0,3}(什么时候|多久)(到岗|来|开始))/,
  },
  serviceAddress: {
    label: '服务地址',
    dbColumn: 'service_address',
    promptDescription: '服务地址（哪个区/街道/小区）',
    guardQuestionTrigger: /(在(哪个|什么)区|哪个(区|街道|小区|街道)|(服务)?地址(在|是)|住在哪里|住址|您家在哪|在什么(位置|地方))/,
  },
  helperRequirements: {
    label: '阿姨要求',
    dbColumn: 'helper_requirements',
    promptDescription: '对阿姨的具体要求（年龄/经验/性格/地域等）',
    guardQuestionTrigger: /(对阿姨(有|有什么|有什么)(特别|什么|特殊)?(要求|期望|期待|条件|标准|偏好|建议)|阿姨(有|有什么|有什么)(特别|什么|特殊)?(要求|期望|期待|条件|标准|偏好|建议)|希望阿姨(.{0,4})|想找(.{0,4})阿姨)/,
  },
  dietaryPreferences: {
    label: '做饭口味',
    dbColumn: 'dietary_preferences',
    promptDescription: '做饭口味偏好（清淡/辣/菜系/忌口等）',
    guardQuestionTrigger: /(做饭(有|有什么|有什么)(口味|偏好|习惯|风格|要求|禁忌|忌口)|(口味|菜系|饮食)(偏好|要求|习惯|偏好)|偏好(什么|哪|哪些)(口味|菜系|饮食|做饭))/,
  },
  budget: {
    label: '薪资预算',
    dbColumn: 'budget',
    promptDescription: '薪资预算范围',
    guardQuestionTrigger: /(薪资(预算|大概)|预算(多少|大概)|能(给到|出)(多少|什么价))/,
  },
  specialRequirements: {
    label: '特殊需求',
    dbColumn: 'special_requirements',
    promptDescription: '其他特殊需求或备注',
  },
  serviceItems: {
    label: '工作内容',
    dbColumn: 'service_items',
    promptDescription: '阿姨的主要工作内容（做饭/打扫/带孩子/照顾老人等）',
    guardQuestionTrigger: /(主要想(让|要)阿姨负责(哪些事|什么|哪些工作|啥)|阿姨(主要|要)负责(什么|哪些|啥)|工作内容(是什么|有哪些|是哪些)|阿姨做什么)/,
  },
  serviceHours: {
    label: '工作小时',
    dbColumn: 'service_hours',
    promptDescription: '每天工作小时数',
    guardQuestionTrigger: /(每天(几|多少|需要)(小时|个钟头|个小时)|上门(几|多少)(小时|个钟头|个小时)|(几个小时|几小时).*上门|工作小时)/,
  },
};

/** 所有字段的 camelCase 键列表 */
export const FIELD_KEYS = Object.keys(REQUIREMENT_FIELDS);

/** 所有字段的 snake_case DB 列名列表（含 JSON 存储的） */
export const FIELD_DB_COLUMNS = FIELD_KEYS.map((k) => REQUIREMENT_FIELDS[k].dbColumn);

/** camelCase → snake_case 映射 */
export const CAMEL_TO_SNAKE: Record<string, string> = {};
for (const key of FIELD_KEYS) {
  CAMEL_TO_SNAKE[key] = REQUIREMENT_FIELDS[key].dbColumn;
}

/** snake_case → camelCase 映射 */
export const SNAKE_TO_CAMEL: Record<string, string> = {};
for (const key of FIELD_KEYS) {
  SNAKE_TO_CAMEL[REQUIREMENT_FIELDS[key].dbColumn] = key;
}

/** 字段标签映射（camelCase → 中文标签） */
export const FIELD_LABELS: Record<string, string> = {};
for (const key of FIELD_KEYS) {
  FIELD_LABELS[key] = REQUIREMENT_FIELDS[key].label;
}

/** 有护栏触发词的字段 */
export const GUARD_FIELDS = FIELD_KEYS.filter(
  (k) => REQUIREMENT_FIELDS[k].guardQuestionTrigger,
);

/**
 * 生成 prompt 用的字段说明列表（给 AI 看的）
 * 格式：- snake_case：中文描述
 */
export function buildFieldPromptList(): string {
  return FIELD_KEYS.map(
    (k) => `  - ${REQUIREMENT_FIELDS[k].dbColumn}：${REQUIREMENT_FIELDS[k].promptDescription}`,
  ).join('\n');
}

/**
 * 生成护栏用的疑问触发词映射
 */
export function buildGuardQuestionTriggers(): Record<string, RegExp> {
  const result: Record<string, RegExp> = {};
  for (const key of FIELD_KEYS) {
    const trigger = REQUIREMENT_FIELDS[key].guardQuestionTrigger;
    if (trigger) {
      result[key] = trigger;
    }
  }
  return result;
}

/**
 * 生成护栏用的显式询问触发词映射
 */
export function buildGuardImperativeTriggers(): Record<string, RegExp> {
  const result: Record<string, RegExp> = {};
  for (const key of FIELD_KEYS) {
    const trigger = REQUIREMENT_FIELDS[key].guardImperativeTrigger;
    if (trigger) {
      result[key] = trigger;
    }
  }
  return result;
}
