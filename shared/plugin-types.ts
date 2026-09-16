// ---- plugin:send_swan_home_clue_notification_1 ----
// ============================================================
// 插件 send_swan_home_clue_notification_1 (天鹅到家线索系统关键节点通知) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface SendSwanHomeClueNotificationOneInput {
  /** 消息通知标题 */
  title: string;
  /** 消息通知正文内容 */
  content: string;
  /** 接收消息的用户ID列表 */
  receiverUserList: string[];
}

/**
 * capabilityClient.load('send_swan_home_clue_notification_1').call<SendSwanHomeClueNotificationOneOutput>('send_feishu_message', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { success } = result;
 * 返回值形如：
 *   {"success":false}
 */
export interface SendSwanHomeClueNotificationOneOutput {
  /** [object Object] */
  success: boolean;
}
// ---- end:send_swan_home_clue_notification_1 ----

// ---- plugin:household_service_demand_extraction_1 ----
// ============================================================
// 插件 household_service_demand_extraction_1 (家政服务需求结构化提取) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface HouseholdServiceDemandExtractionOneInput {
  /** 客服与用户的对话文本内容 */
  conversation_text: string;
}

/**
 * capabilityClient.load('household_service_demand_extraction_1').call<HouseholdServiceDemandExtractionOneOutput>('textToJson', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { service_type, start_time, service_duration, ... } = result;
 * 返回值形如：
 *   {"service_type":"示例文本","start_time":"示例文本","service_duration":"示例文本","special_requirements":"示例文本","family_info":"示例文本","dietary_preferences":"示例文本","budget":"示例文本","household_size":"示例文本","area":"示例文本","elderly_care":"示例文本","rest_days":"示例文本","service_address":"示例文本","helper_requirements":"示例文本"}
 */
export interface HouseholdServiceDemandExtractionOneOutput {
  /** 服务类型，值为yuesao/baomu/baojie/yuer/yanglao，未明确则为空 */
  service_type: string;
  /** 期望到岗时间，格式为YYYY-MM-DD */
  start_time: string;
  /** 服务周期，如长期/26天/42天/3个月 */
  service_duration: string;
  /** 特殊需求，如住家/不住家/会做饭/会开车/会早教 */
  special_requirements: string;
  /** 家庭情况，包括面积/人口/老人小孩信息 */
  family_info: string;
  /** 家庭成员的饮食口味要求、忌口等 */
  dietary_preferences: string;
  /** 薪资预算范围，例如：6000-8000元/月 */
  budget: string;
  /** 家庭人口数量，例如：3口人 */
  household_size: string;
  /** 房屋面积，例如：120平米 */
  area: string;
  /** 照顾老人的相关信息，包括老人年龄、身体状况、护理需求等 */
  elderly_care: string;
  /** 每月休息天数，例如：4天 */
  rest_days: string;
  /** 服务详细地址 */
  service_address: string;
  /** 对家政阿姨的具体要求，包括年龄、经验、技能、性格等 */
  helper_requirements: string;
}
// ---- end:household_service_demand_extraction_1 ----

// ---- plugin:swan_home_ai_customer_service_reply_1 ----
// ============================================================
// 插件 swan_home_ai_customer_service_reply_1 (天鹅到家家政服务顾问智能对话回复) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface SwanHomeAiCustomerServiceReplyOneInput {
  /** 小书人设信息 */
  persona: string;
  /** 历史对话记录 */
  conversation_history: string;
  /** 已收集的客户需求信息 */
  collected_requirements: string;
  /** 客户最新发送的消息 */
  latest_customer_message: string;
}

/**
 * capabilityClient.load('swan_home_ai_customer_service_reply_1').callStream<SwanHomeAiCustomerServiceReplyOneOutput>('textGenerate', input)
 * 每个 chunk 就是下面这个扁平对象，字段名与 SwanHomeAiCustomerServiceReplyOneOutput 一致，外面没有 data / choices / message 包装：
 *   {"content":"示例文本","response":"示例文本"}
 * 返回值可能是 AsyncIterable<chunk>，也可能是 { output: AsyncIterable<chunk> }，取流前先归一化。
 * 逐段累加：
 *   for await (const chunk of stream) { result += chunk.content ?? ''; }
 */
export interface SwanHomeAiCustomerServiceReplyOneOutput {
  /** [object Object] */
  content: string;
  /** [object Object] */
  response?: string;
}
// ---- end:swan_home_ai_customer_service_reply_1 ----

// ---- plugin:swan_home_conversation_summary_1 ----
// ============================================================
// 插件 swan_home_conversation_summary_1 (天鹅到家客服对话摘要生成) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface SwanHomeConversationSummaryOneInput {
  /** 客服与客户的完整对话文本 */
  conversation_text: string;
}

/**
 * capabilityClient.load('swan_home_conversation_summary_1').callStream<SwanHomeConversationSummaryOneOutput>('textSummary', input)
 * 每个 chunk 就是下面这个扁平对象，字段名与 SwanHomeConversationSummaryOneOutput 一致，外面没有 data / choices / message 包装：
 *   {"summary":"示例文本"}
 * 返回值可能是 AsyncIterable<chunk>，也可能是 { output: AsyncIterable<chunk> }，取流前先归一化。
 * 逐段累加：
 *   for await (const chunk of stream) { result += chunk.summary ?? ''; }
 */
export interface SwanHomeConversationSummaryOneOutput {
  /** [object Object] */
  summary: string;
}
// ---- end:swan_home_conversation_summary_1 ----

// ---- plugin:customer_service_intent_classifier_1 ----
// ============================================================
// 插件 customer_service_intent_classifier_1 (意图分类器-L2) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface CustomerServiceIntentClassifierOneInput {
  /** 最近几轮对话上下文，帮助理解歧义 */
  conversation_context?: string;
  /** 客户当前消息内容 */
  customer_message: string;
}

/**
 * capabilityClient.load('customer_service_intent_classifier_1').call<CustomerServiceIntentClassifierOneOutput>('textToJson', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { intent, confidence, service_type, ... } = result;
 * 返回值形如：
 *   {"intent":"示例文本","confidence":0,"service_type":"示例文本","key_phrase":"示例文本"}
 */
export interface CustomerServiceIntentClassifierOneOutput {
  /** 意图分类结果，只能是 transfer_human / market_price / service_scope / none 这 4 个值之一。中介费/服务费/信息费/介绍费由 L1 正则处理，一律输出 none；模糊钱问法（怎么收费/收费模式/费用多少）归 market_price，默认客户问总价，按总账答，不反问 */
  intent: string;
  /** 置信度 0~1，拿不准就给低分 */
  confidence: number;
  /** 识别出的服务类型。只填客户明确说出的 6 个标准枚举值（住家保姆/白班保姆/钟点工保姆/育儿保姆/护工保姆/菲式保姆）；客户用非标准说法（阿姨/保姆/育儿嫂/养老保姆/护工/带娃/照顾老人等）一律填空字符串，不自行归一；没有提到也填空字符串 */
  service_type: string;
  /** 客户原话中最能代表这个意图的关键词/短语，3~10 个字，用于自学习闭环聚合 */
  key_phrase: string;
}
// ---- end:customer_service_intent_classifier_1 ----