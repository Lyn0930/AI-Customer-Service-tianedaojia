/* 前后端共享的类型写在这里 */

/* ============ 验证码相关 ============ */
export interface CaptchaResponse {
  key: string;
  svg: string;
  expiresAt: number;
}

export interface SmsSendResponse {
  success: boolean;
  devCode?: string;
}

/* ============ 线索相关 ============ */

// 6 个公开渠道：与现有多维表格（bitable）来源字段值保持一致
// 沿用 bitable 的中文 label，存进 DB 后给运营/客服直接看
export type LeadSource =
  | '小红书'
  | '抖音'
  | 'SEO'
  | '美团'
  | '大众点评'
  | '自有APP'
  | '小程序'
  | '官网'
  | 'unknown';

// 服务类型组：保姆 vs 月嫂
export type ServiceTypeGroup = 'baomu' | 'yuesao';

// 服务类型：7 个具体值
export type ServiceType = 'zhujia' | 'yuer' | 'baiban' | 'yanglao' | 'zhongdian' | 'feishi' | '26day_yuesao';

export type LeadStatus = 'new' | 'contacting' | 'chatting' | 'collected' | 'closed' | 'nurturing' | 'recycled' | 'filtered' | 'assigned' | 'pending';

export type LeadChannel = 'openapi' | 'bitable_form' | 'chat' | 'phone' | 'manual';

export type LeadGrade = 'A' | 'B' | 'B_PRICE' | 'C1' | 'C2' | 'D';

export type GradeTransitionTrigger = 'ai' | 'manual' | 'system';

export interface Lead {
  id: string;
  serviceCity: string;
  phoneNumber: string;
  customerName: string | null;
  source: LeadSource;
  status: LeadStatus;
  chatToken: string;
  assigneeId: string | null;
  bitableRecordId: string | null;
  assignedAt: string | null;
  lastFollowedUpAt: string | null;
  intent: string | null;
  routingReason: string | null;
  leadGrade: string | null;
  leadScore: number | null;
  gradeReason: string | null;
  gradeConfidence: number | null;
  budgetRange: string | null;
  serviceStartTime: string | null;
  serviceDuration: string | null;
  specialRequirements: string | null;
  familyInfo: string | null;
  urgencyLevel: string | null;
  phoneVerified: boolean;
  leadSourceDetail: string | null;
  channel: LeadChannel;
  /** 服务类型（中文：住家保姆/钟点工等），来自表单留资 */
  serviceType?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeadRequest {
  serviceCity: string;
  phoneNumber: string;
  customerName?: string;
  source?: string;
  /** 服务类型组：保姆/月嫂 */
  serviceTypeGroup?: ServiceTypeGroup;
  /** 服务类型：接受拼音码或中文 label（service 层归一化） */
  serviceType?: string;
  /** 短信验证码（openapi 渠道必填，其他渠道可省略） */
  smsCode?: string;
  /** 来源细分 */
  leadSourceDetail?: string;
  /** 线索渠道（默认 openapi） */
  channel?: LeadChannel;
}

export interface LeadListParams {
  status?: LeadStatus;
  serviceCity?: string;
  keyword?: string;
  assigneeId?: string;
  role?: string;
  leadGrade?: string;
  urgencyLevel?: string;
  page?: number;
  pageSize?: number;
}

export interface LeadListResponse {
  items: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AssignLeadRequest {
  assigneeId: string;
}

/* ============ 公海/线索池相关 ============ */

export interface PoolListParams {
  serviceCity?: string;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface PoolListResponse {
  items: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AutoAssignResult {
  assignedCount: number;
}

export interface RecycleResult {
  recycledCount: number;
}

export interface GradeHistory {
  id: string;
  leadId: string;
  oldGrade: string | null;
  newGrade: string;
  reason: string | null;
  triggeredBy: GradeTransitionTrigger;
  createdAt: string;
}

export interface RegradeRequest {
  grade: LeadGrade;
  reason: string;
}

export interface SyncResult {
  total: number;
  synced: number;
  duplicated: number;
  failed: number;
}

/* ============ 城市客服分配相关 ============ */

/* ============ 住家保姆等市场薪资区间配置 ============ */

export type SalaryCityTier = '一线' | '二线' | '三线' | '二三线';
export type SalaryAreaType = '大面积' | '小面积' | '不适用';
// 2026-08-15 扩列：用于「育儿/护工/菲式」按 8h/24h 分档；钟点工/白班/住家为空
// 6.1.7 月嫂下次录入时使用 26天/42天
export type SalarySubDimension = '' | '8h' | '24h' | '26天' | '42天';

export interface SalaryConfig {
  id: string;
  serviceType: string;
  cityTier: SalaryCityTier;
  areaType: SalaryAreaType;
  // 2026-08-15 新增：细分维度（空字符串表示按面积或不区分）
  subDimension: SalarySubDimension;
  baseLow: number;
  baseHigh: number;
  altLow: number;
  altHigh: number;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSalaryConfigRequest {
  serviceType: string;
  cityTier: SalaryCityTier;
  areaType: SalaryAreaType;
  subDimension?: SalarySubDimension;
  baseLow: number;
  baseHigh: number;
  altLow: number;
  altHigh: number;
}

export interface UpdateSalaryConfigRequest {
  baseLow?: number;
  baseHigh?: number;
  altLow?: number;
  altHigh?: number;
  subDimension?: SalarySubDimension;
  updatedBy?: string;
}

/* ============ 联系记录相关 ============ */

export type ContactType = 'wechat_add' | 'wechat_message' | 'phone_call';
export type ContactStatus = 'pending' | 'success' | 'failed';

export interface ContactLog {
  id: string;
  leadId: string;
  contactType: ContactType;
  status: ContactStatus;
  notes: string | null;
  operatorId: string | null;
  createdAt: string;
}

export interface CreateContactLogRequest {
  contactType: ContactType;
  status: ContactStatus;
  notes?: string;
}

/* ============ 聊天相关 ============ */

export type ChatSessionStatus = 'active' | 'completed';
export type ChatMessageRole = 'bot' | 'customer' | 'agent';
export type ChatSessionMode = 'ai' | 'human';

export type TransferSource = 'customer' | 'auto' | 'agent';

export interface ChatSession {
  id: string;
  leadId: string;
  status: ChatSessionStatus;
  mode: ChatSessionMode;
  transferReason: string | null;
  transferredBy: TransferSource | null;
  startedAt: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  type?: 'text' | 'form_card';
  formCard?: {
    serviceType: string;
    formName: string;
  };
  createdAt: string;
}

export interface ChatSessionListItem extends ChatSession {
  lead?: Lead;
  lastMessage?: ChatMessage;
  messageCount?: number;
  /**
   * 未读 = 最新一条消息是客户发的，agent 还没回
   * 用于工作台列表显示"待回复"红点
   */
  unread?: boolean;
}

export interface ChatSessionListResponse {
  items: ChatSessionListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ChatSessionDetail extends ChatSession {
  messages: ChatMessage[];
  lead?: Lead;
  requirement?: Requirement | null;
}

export interface SendMessageRequest {
  content: string;
}

export interface ReassignSessionRequest {
  targetAgentId: string;
}

export interface CustomerChatInfo {
  session: ChatSession;
  messages: ChatMessage[];
}

export interface CustomerPollResult {
  messages: ChatMessage[];
  mode: ChatSessionMode;
  status: ChatSessionStatus;
}

export interface TransferRequest {
  reason?: string;
}

export interface ReplySuggestion {
  suggestions: string[];
}

export interface HandoffSummary {
  customerName: string | null;
  phoneNumber: string;
  serviceCity: string;
  source: LeadSource;
  leadStatus: LeadStatus;
  intent: string | null;
  routingReason: string | null;
  transferReason: string | null;
  transferredBy: TransferSource | null;
  requirements: Requirement | null;
  messageCount: number;
  customerMessageCount: number;
  sessionStartedAt: string;
}

/* ============ 需求相关 ============ */

export type RequirementStatus = 'collecting' | 'completed';

export interface Requirement {
  id: string;
  leadId: string;
  serviceType: string | null;
  householdSize: string | null;
  area: string | null;
  elderlyCare: string | null;
  restDays: string | null;
  startTime: string | null;
  serviceAddress: string | null;
  helperRequirements: string | null;
  dietaryPreferences: string | null;
  budget: string | null;
  specialRequirements: string | null;
  serviceItems: string | null;
  serviceHours: string | null;
  hasPet: string | null;
  source: string | null;
  cardSubmittedAt: string | null;
  childCare: string | null;
  aiSummary: string | null;
  status: RequirementStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionProgressItem {
  field: string;
  label: string;
  question: string;
  required: boolean;
  value: string | null;
  collected: boolean;
}

export interface CollectionProgress {
  serviceType: string | null;
  serviceTypeLabel: string;
  items: CollectionProgressItem[];
  collectedCount: number;
  totalCount: number;
  requiredCount: number;
  requiredCollected: number;
  percent: number;
  nextField: CollectionProgressItem | null;
  status: RequirementStatus;
  aiSummary: string | null;
}

/* ============ 仪表盘统计 ============ */

export interface DashboardStats {
  totalLeads: number;
  todayNew: number;
  unassigned: number;
  activeSessions: number;
  /** 平均聊天时长（秒）：所有已转人工会话的 ended_at - started_at 平均值 */
  avgChatDuration: number;
  /** AI 采集耗时（秒）：transferReason='需求采集完成' 的会话平均时长 */
  avgCollectionDuration: number;
  /** 采集完成率（%）：需求采集完成转人工 / 所有转人工会话数 */
  collectionCompletionRate: number;
  sourceDistribution: { source: string; count: number }[];
  statusDistribution: { status: string; count: number }[];
  cityDistribution: { city: string; count: number }[];
  recentLeads: Lead[];
  /** 调试字段：任一阶段失败时填充，仅用于排查 dashboard 500 */
  debug?: {
    stage: string;
    message: string;
    stack?: string;
    /** PostgreSQL 错误码（如 '42703' 列不存在 / '42P01' 表不存在） */
    code?: string;
    /** PostgreSQL 错误详情 */
    detail?: string;
  };
  /**
   * 一次性 schema 迁移的逐列结果（commit a994ed5 引入的 6 个 leads 列）。
   * 状态：
   *   - 'ok'   列被成功补上
   *   - 'skip' 启动时已存在
   *   - 'fail' 补列失败（多为沙箱禁用 DDL 或权限不足）
   */
  migrationInfo?: Array<{ name: string; status: 'ok' | 'fail' | 'skip'; error?: string }>;
}

/* ============ 经营分析统计 ============ */

export interface TeamPerformanceItem {
  assigneeId: string;
  assignedCount: number;
  convertedCount: number;
  chattingCount: number;
  contactCount: number;
  activeSessions: number;
  conversionRate: number;
}

export interface LeadFunnel {
  new: number;
  contacting: number;
  chatting: number;
  collected: number;
  closed: number;
}

export interface TimelineItem {
  date: string;
  newLeads: number;
  contacts: number;
  conversions: number;
}

export interface SystemHealth {
  poolSize: number;
  activeSessions: number;
  unassigned: number;
  todayNew: number;
  totalLeads: number;
  totalContacts: number;
  totalSessions: number;
}

export interface SourceEffectiveness {
  source: string;
  total: number;
  converted: number;
  conversionRate: number;
}

/* ============ 线索层AI效能验证 ============ */

export interface GradeFunnelItem {
  stage: string;
  label: string;
  count: number;
  percentage: number;
  color: string;
}

export interface AiEffectivenessKpi {
  key: string;
  name: string;
  definition: string;
  target: number | null;
  actual: number | null;
  unit: string;
  dataSource: string;
  direction: 'higher' | 'lower';
}

export interface AiEffectivenessResponse {
  kpis: AiEffectivenessKpi[];
  gradeFunnel: GradeFunnelItem[];
  totalLeads: number;
}

/* ============ 管理后台 ============ */

export interface QAEntry {
  id: string;
  question: string;
  answer: string;
  category: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateQAEntryRequest {
  question: string;
  answer: string;
  category?: string;
  sortOrder?: number;
}

export interface UpdateQAEntryRequest {
  question?: string;
  answer?: string;
  category?: string;
  enabled?: boolean;
  sortOrder?: number;
}

export interface AIConfigItem {
  key: string;
  value: string;
  type: 'text' | 'number' | 'json';
  description: string;
  updatedAt: string;
}

export interface UpdateAIConfigRequest {
  configs: { key: string; value: string }[];
}

export interface TestChatRequest {
  message: string;
  history?: { role: string; content: string }[];
}

export interface TestChatResponse {
  reply: string;
}

/* ============ 智能路由相关 ============ */

export type IntentType =
  | 'urgent_complaint'
  | 'service_inquiry'
  | 'price_inquiry'
  | 'booking'
  | 'after_sale'
  | 'general';

export type UrgencyLevel = 'high' | 'medium' | 'low';

export interface IntentClassification {
  intent: IntentType;
  urgency: UrgencyLevel;
  category: string;
  suggestedSkill: string;
}

export interface RoutingResult {
  assigneeId: string | null;
  intent: IntentType | null;
  urgency: UrgencyLevel | null;
  routingReason: string;
  autoTransferred: boolean;
  priorityLevel: 'high' | 'normal' | 'skip';
}

export type AgentOnlineState = 'online' | 'offline' | 'busy';

export interface AgentOnlineStatus {
  assigneeId: string;
  status: AgentOnlineState;
  lastHeartbeatAt: string;
}

export interface HeartbeatRequest {
  status: AgentOnlineState;
}

export interface AgentSkill {
  id: string;
  assigneeId: string;
  skillTag: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentSkillRequest {
  assigneeId: string;
  skillTag: string;
}

export interface UpdateAgentSkillRequest {
  skillTag: string;
}

export interface AgentWorkload {
  assigneeId: string;
  activeSessions: number;
  chattingLeads: number;
  totalLeads: number;
  skills: string[];
}

/* ============ AI 对话摘要 ============ */

export interface ConversationSummaryResponse {
  summary: string;
}

/* ============ 劳动者管理 ============ */

export type WorkerGender = 'male' | 'female';
export type WorkerLevel = 'junior' | 'intermediate' | 'senior' | 'gold';
export type WorkerStatus = 'active' | 'on_leave';

export interface Worker {
  id: string;
  name: string;
  phone: string;
  gender: WorkerGender;
  serviceCity: string;
  serviceType: string;
  level: WorkerLevel;
  status: WorkerStatus;
  rating: number;
  totalOrders: number;
  avatar: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkerRequest {
  name: string;
  phone: string;
  gender?: WorkerGender;
  serviceCity: string;
  serviceType: string;
  level?: WorkerLevel;
  status?: WorkerStatus;
  rating?: number;
  totalOrders?: number;
  avatar?: string;
}

export interface UpdateWorkerRequest {
  name?: string;
  phone?: string;
  gender?: WorkerGender;
  serviceCity?: string;
  serviceType?: string;
  level?: WorkerLevel;
  status?: WorkerStatus;
  rating?: number;
  totalOrders?: number;
  avatar?: string;
}

export interface WorkerListParams {
  serviceCity?: string;
  serviceType?: string;
  status?: WorkerStatus;
  level?: WorkerLevel;
  keyword?: string;
  page?: number;
  pageSize?: number;
}

export interface WorkerListResponse {
  items: Worker[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WorkerDetail extends Worker {
  skills: WorkerSkill[];
  availabilities: WorkerAvailability[];
}

/* ============ 劳动者技能 ============ */

export type ProficiencyLevel = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export interface WorkerSkill {
  id: string;
  workerId: string;
  skillTag: string;
  proficiency: ProficiencyLevel;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkerSkillRequest {
  skillTag: string;
  proficiency?: ProficiencyLevel;
}

/* ============ 劳动者可用时间 ============ */

export type AvailabilityStatus = 'available' | 'booked';

export interface WorkerAvailability {
  id: string;
  workerId: string;
  date: string;
  timeSlot: string;
  status: AvailabilityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkerAvailabilityRequest {
  date: string;
  timeSlot: string;
  status?: AvailabilityStatus;
}

/* ============ 匹配记录 ============ */

export type MatchStatus = 'pending' | 'accepted' | 'rejected';

export interface MatchRecord {
  id: string;
  leadId: string;
  workerId: string;
  matchScore: number;
  matchReason: string | null;
  status: MatchStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MatchRecordListItem extends MatchRecord {
  worker?: Worker;
  lead?: Lead;
}

export interface MatchRecordListResponse {
  items: MatchRecordListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateMatchRecordRequest {
  leadId: string;
  workerId: string;
  matchScore?: number;
  matchReason?: string;
  status?: MatchStatus;
}

export interface UpdateMatchStatusRequest {
  status: MatchStatus;
}

/* ============ 服务工单 ============ */

export type ServiceOrderStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface ServiceOrder {
  id: string;
  leadId: string;
  workerId: string;
  serviceType: string;
  startDate: string | null;
  endDate: string | null;
  status: ServiceOrderStatus;
  amount: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceOrderListItem extends ServiceOrder {
  worker?: Worker;
  lead?: Lead;
}

export interface ServiceOrderListResponse {
  items: ServiceOrderListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateServiceOrderRequest {
  leadId: string;
  workerId: string;
  serviceType: string;
  startDate?: string;
  endDate?: string;
  status?: ServiceOrderStatus;
  amount?: string;
}

export interface UpdateServiceOrderRequest {
  serviceType?: string;
  startDate?: string;
  endDate?: string;
  status?: ServiceOrderStatus;
  amount?: string;
}

/* ============ 学习模板相关 ============ */

export type LearnedTemplateStatus = 'learning' | 'mastered';

export interface LearnedTemplate {
  id: string;
  topicKey: string;
  questionText: string;
  answerText: string;
  useCount: number;
  successCount: number;
  failCount: number;
  successThreshold: number;
  status: LearnedTemplateStatus;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateLearnedTemplateRequest {
  answerText?: string;
  status?: LearnedTemplateStatus;
}

/* ============ 需求更新 ============ */

export interface UpdateRequirementRequest {
  serviceType?: string;
  householdSize?: string;
  area?: string;
  elderlyCare?: string;
  restDays?: string;
  startTime?: string;
  serviceAddress?: string;
  helperRequirements?: string;
  dietaryPreferences?: string;
  budget?: string;
  specialRequirements?: string;
  hasPet?: string;
  childCare?: string;
  // 2026-08-16 21:35 林琳反馈 500 错误：serviceItems / serviceHours 改存到 collectedFields JSON
  //   不再作为 requirements 顶层字段（production user role 无 ALTER 权限）
  // 业务层通过 UpdateRequirementRequest.collectedFields 数组追加 serviceItems/serviceHours
}

export interface FormSubmitRequest {
  householdSize: string;
  area: string;
  hasPet: string;
  elderlyCare: string;
  childCare: string;
  restDays: string;
  startTime: string;
  serviceAddress: string;
}

export interface FormSubmitResponse {
  success: boolean;
  message: string;
}

// ============ 经纪人派单 ============

export interface AgentRecord {
  id: string;
  name: string;
  phone: string | null;
  city: string;
  serviceTypes: string[];
  skillTags: string[];
  conversionRate: number;
  maxLeads: number;
  activeLeadsCount: number;
  isOnline: boolean;
}

export interface CreateAgentRequest {
  name: string;
  phone?: string;
  city: string;
  serviceTypes: string[];
  skillTags?: string[];
  conversionRate?: number;
  maxLeads?: number;
}

export interface AgentListResponse {
  items: AgentRecord[];
  total: number;
}

export interface DispatchRunResponse {
  reassignedCount: number;
  assignedCount: number;
}

export interface SetAgentOnlineRequest {
  online: boolean;
  /** 下线时若仍有跟进中线索，前端二次确认后传 true 强制下线 */
  force?: boolean;
}

export interface SetAgentOnlineResponse {
  success: boolean;
  /** 下线时命中跟进中线索且未强制确认，需前端弹确认框 */
  needConfirm?: boolean;
  activeLeadCount?: number;
}

// ============ AI 能力最小实测（阶段三 L2 前置验证测试页） ============

export type AiTestKind = 'independent' | 'json_format' | 'enum_lock' | 'instruction' | 'budget_caliber' | 'swan_reply';

export interface AiTestRequest {
  test: AiTestKind;
  input: string;
}

export interface AiTestResponse {
  test: AiTestKind;
  /** AI 原文返回（生文通道为原始文本；textToJson 通道为格式化 JSON 文本） */
  raw: string;
  /** 仅 AI 调用失败时非空 */
  error?: string;
  /** 本次调用实际使用的 system prompt */
  systemPrompt: string;
  /** 本次调用实际使用的用户消息 */
  userMessage: string;
  /** enum_lock：textToJson 返回的结构化对象 */
  structured?: Record<string, unknown> | null;
  /** enum_lock：平台能力核实说明 */
  platformNote?: string;
}

export interface RouteTestRequest {
  message: string;
  /** 可选：模拟已采集的服务类型（影响报价类工具回复） */
  serviceType?: string;
}

export interface RouteTestResponse {
  handled: boolean;
  intent: string | null;
  reply: string;
}

export interface L2TestRequest {
  message: string;
  /** 可选：最近几轮对话上下文（帮助理解歧义） */
  conversationContext?: string;
}

export interface L2TestResponse {
  /** 是否高置信命中（阈值 0.7）；none / 低置信 / 解析失败均为 false（放行） */
  hit: boolean;
  /** 判定意图；放行时为 null */
  intent: string | null;
  confidence: number | null;
  serviceType: string | null;
  keyPhrase: string | null;
}
