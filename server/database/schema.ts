/* eslint-disable */
/** auto generated, do not edit */
import { sql } from 'drizzle-orm';
import { boolean, doublePrecision, foreignKey, index, integer, jsonb, numeric, pgSequence, pgTable, text, timestamp, uniqueIndex, uuid, varchar, customType } from "drizzle-orm/pg-core"

export const customTimestamptz = customType<{
  data: Date;
  driverData: string;
  config: { precision?: number };
}>({
  dataType(config) {
    const precision = typeof config?.precision !== 'undefined'
      ? ` (${config.precision})`
      : '';
    return `timestamptz${precision}`;
  },
  toDriver(value: Date | string | number) {
    if (value == null) return value as any;
    if (typeof value === 'number') return new Date(value).toISOString();
    if (typeof value === 'string') return value;
    if (value instanceof Date) return value.toISOString();
    throw new Error('Invalid timestamp value');
  },
  fromDriver(value: string | Date): Date {
    if (value instanceof Date) return value;
    return new Date(value);
  },
});

export const userProfile = customType<{
  data: string;
  driverData: string;
}>({
  dataType() {
    return 'user_profile';
  },
  toDriver(value: string) {
    return sql`ROW(${value})::user_profile`;
  },
  fromDriver(value: string) {
    const [userId] = value.slice(1, -1).split(',');
    return userId.trim();
  },
});

export type FileAttachment = {
  bucket_id: string;
  file_path: string;
};

export const fileAttachment = customType<{
  data: FileAttachment;
  driverData: string;
}>({
  dataType() {
    return 'file_attachment';
  },
  toDriver(value: FileAttachment) {
    return sql`ROW(${value.bucket_id},${value.file_path})::file_attachment`;
  },
  fromDriver(value: string): FileAttachment {
    const [bucketId, filePath] = value.slice(1, -1).split(',');
    return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
  },
});

export function escapeLiteral(str: string): string {
  return "'" + str.replace(/'/g, "''") + "'";
}

export const userProfileArray = customType<{
  data: string[];
  driverData: string;
}>({
  dataType() {
    return 'user_profile[]';
  },
  toDriver(value: string[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::user_profile[]`;
    }
    const elements = value.map(id => `ROW(${escapeLiteral(id)})::user_profile`).join(',');
    return sql.raw(`ARRAY[${elements}]::user_profile[]`);
  },
  fromDriver(value: string): string[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => m.slice(1, -1).split(',')[0].trim());
  },
});

export const fileAttachmentArray = customType<{
  data: FileAttachment[];
  driverData: string;
}>({
  dataType() {
    return 'file_attachment[]';
  },
  toDriver(value: FileAttachment[]) {
    if (!value || value.length === 0) {
      return sql`'{}'::file_attachment[]`;
    }
    const elements = value.map(f =>
      `ROW(${escapeLiteral(f.bucket_id)},${escapeLiteral(f.file_path)})::file_attachment`
    ).join(',');
    return sql.raw(`ARRAY[${elements}]::file_attachment[]`);
  },
  fromDriver(value: string): FileAttachment[] {
    if (!value || value === '{}') return [];
    const inner = value.slice(1, -1);
    const matches = inner.match(/\([^)]*\)/g) || [];
    return matches.map(m => {
      const [bucketId, filePath] = m.slice(1, -1).split(',');
      return { bucket_id: bucketId.trim(), file_path: filePath.trim() };
    });
  },
});

export const intentDiscoveriesIdSeq = pgSequence("intent_discoveries_id_seq");

export const requirementFieldDelta = pgTable("requirement_field_delta", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: varchar("lead_id", { length: 50 }).notNull(),
  sessionId: varchar("session_id", { length: 50 }),
  messageId: varchar("message_id", { length: 50 }),
  fieldKey: varchar("field_key", { length: 50 }).notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changeSource: varchar("change_source", { length: 30 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_req_field_delta_lead").on(table.leadId, table.createdAt),
]);

export const faqs = pgTable("faqs", {
  id: uuid("id").primaryKey().defaultRandom(),
  topic: varchar("topic", { length: 100 }).notNull(),
  triggerWords: text("trigger_words").array().notNull().default([]),
  questionPattern: varchar("question_pattern", { length: 255 }),
  answer: text("answer").notNull(),
  category: varchar("category", { length: 20 }).notNull(),
  priority: integer("priority").notNull().default(5),
  hasLead: boolean("has_lead").notNull().default(false),
  status: varchar("status", { length: 20 }).notNull().default('draft'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const feeQuoteLogs = pgTable("fee_quote_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  quotedAmount: integer("quoted_amount").notNull(),
  aliasUsed: varchar("alias_used", { length: 50 }).notNull(),
  aliasNormalized: varchar("alias_normalized", { length: 50 }).notNull(),
  serviceType: varchar("service_type", { length: 100 }),
  leadId: uuid("lead_id"),
  sessionId: varchar("session_id", { length: 100 }),
  intentSource: varchar("intent_source", { length: 20 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
});

export const intentDiscoveries = pgTable("intent_discoveries", {
  id: integer("id").primaryKey().default(sql`nextval('intent_discoveries_id_seq'::regclass)`),
  intent: varchar("intent", { length: 32 }).notNull(),
  keyPhrase: varchar("key_phrase", { length: 200 }).notNull(),
  messageContent: text("message_content").notNull(),
  serviceType: varchar("service_type", { length: 64 }),
  confidence: numeric("confidence").notNull(),
  sessionId: varchar("session_id", { length: 64 }),
  messageId: varchar("message_id", { length: 64 }),
  status: varchar("status", { length: 16 }).notNull().default('pending'),
  approvedKeyword: varchar("approved_keyword", { length: 200 }),
  rejectedReason: varchar("rejected_reason", { length: 200 }),
  createdAt: timestamp("created_at", { mode: 'string' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp("updated_at", { mode: 'string' }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_intent_discoveries_agg").on(table.intent, table.status, table.keyPhrase),
  index("idx_intent_discoveries_created").on(table.createdAt),
]);

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  agentId: uuid("agent_id").notNull(),
  isOnline: boolean("is_online").notNull().default(false),
  lastHeartbeatAt: customTimestamptz("last_heartbeat_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_agent_sessions_agent_id").on(table.agentId),
]);

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 50 }).notNull(),
  phone: varchar("phone", { length: 20 }),
  city: varchar("city", { length: 50 }).notNull(),
  /**
   * @type string[]
   */
  serviceTypes: jsonb("service_types").notNull().default('[]'),
  /**
   * @type string[]
   */
  skillTags: jsonb("skill_tags").notNull().default('[]'),
  conversionRate: doublePrecision("conversion_rate").notNull().default(50),
  maxLeads: integer("max_leads").notNull().default(10),
  activeLeadsCount: integer("active_leads_count").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_agents_city").on(table.city),
]);

export const salaryConfig = pgTable("salary_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceType: varchar("service_type", { length: 50 }).notNull(),
  cityTier: varchar("city_tier", { length: 20 }).notNull(),
  areaType: varchar("area_type", { length: 20 }).notNull(),
  subDimension: varchar("sub_dimension", { length: 20 }).notNull(),
  baseLow: integer("base_low").notNull(),
  baseHigh: integer("base_high").notNull(),
  altLow: integer("alt_low").notNull(),
  altHigh: integer("alt_high").notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("uniq_salary_config").on(table.serviceType, table.cityTier, table.areaType, table.subDimension),
  index("idx_salary_config_service").on(table.serviceType),
]);

export const aiTemplateUsage = pgTable("ai_template_usage", {
  id: uuid("id").primaryKey().defaultRandom(),
  templateId: uuid("template_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_ai_template_usage_session").on(table.sessionId, table.status),
  index("idx_ai_template_usage_template").on(table.templateId),
]);

export const aiLearnedTemplates = pgTable("ai_learned_templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  topicKey: varchar("topic_key", { length: 100 }).notNull(),
  questionText: text("question_text").notNull(),
  answerText: text("answer_text").notNull(),
  useCount: integer("use_count").notNull().default(0),
  successCount: integer("success_count").notNull().default(0),
  failCount: integer("fail_count").notNull().default(0),
  status: varchar("status", { length: 20 }).notNull().default('learning'),
  successThreshold: integer("success_threshold").notNull().default(80),
  sourceSessionId: uuid("source_session_id"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_ai_learned_templates_topic").on(table.topicKey),
  index("idx_ai_learned_templates_status").on(table.status),
]);

export const agentOnlineStatus = pgTable("agent_online_status", {
  id: uuid("id").primaryKey().defaultRandom(),
  assigneeId: varchar("assignee_id", { length: 100 }).notNull().unique(),
  status: varchar("status", { length: 20 }).notNull().default('offline'),
  lastHeartbeatAt: customTimestamptz("last_heartbeat_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("agent_online_status_assignee_id_key").on(table.assigneeId),
  index("idx_agent_online_status_assignee").on(table.assigneeId),
  index("idx_agent_online_status_status").on(table.status),
]);

export const leadGradeHistory = pgTable("lead_grade_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  oldGrade: varchar("old_grade", { length: 10 }),
  newGrade: varchar("new_grade", { length: 10 }).notNull(),
  reason: varchar("reason", { length: 200 }),
  triggeredBy: varchar("triggered_by", { length: 20 }).notNull().default('system'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_lead_grade_history_lead_id").on(table.leadId),
]);

export const serviceOrders = pgTable("service_orders", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  workerId: uuid("worker_id").notNull(),
  serviceType: varchar("service_type", { length: 50 }).notNull(),
  startDate: varchar("start_date", { length: 100 }),
  endDate: varchar("end_date", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  amount: varchar("amount", { length: 50 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_service_orders_lead_id").on(table.leadId),
  index("idx_service_orders_worker_id").on(table.workerId),
  index("idx_service_orders_status").on(table.status),
  foreignKey({
    columns: [table.leadId],
    foreignColumns: [leads.id],
    name: "service_orders_lead_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.workerId],
    foreignColumns: [workers.id],
    name: "service_orders_worker_id_fkey",
  }).onDelete("cascade"),
]);

export const matchRecords = pgTable("match_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  workerId: uuid("worker_id").notNull(),
  matchScore: integer("match_score").notNull().default(0),
  matchReason: text("match_reason"),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_match_records_lead_id").on(table.leadId),
  index("idx_match_records_worker_id").on(table.workerId),
  index("idx_match_records_status").on(table.status),
  foreignKey({
    columns: [table.leadId],
    foreignColumns: [leads.id],
    name: "match_records_lead_id_fkey",
  }).onDelete("cascade"),
  foreignKey({
    columns: [table.workerId],
    foreignColumns: [workers.id],
    name: "match_records_worker_id_fkey",
  }).onDelete("cascade"),
]);

export const workerAvailability = pgTable("worker_availability", {
  id: uuid("id").primaryKey().defaultRandom(),
  workerId: uuid("worker_id").notNull(),
  date: varchar("date", { length: 20 }).notNull(),
  timeSlot: varchar("time_slot", { length: 50 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('available'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_worker_availability_worker_id").on(table.workerId),
  index("idx_worker_availability_date_status").on(table.date, table.status),
]);

export const workerSkills = pgTable("worker_skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  workerId: uuid("worker_id").notNull(),
  skillTag: varchar("skill_tag", { length: 50 }).notNull(),
  proficiency: varchar("proficiency", { length: 20 }).notNull().default('intermediate'),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_worker_skills_worker_id").on(table.workerId),
  uniqueIndex("idx_worker_skills_worker_tag").on(table.workerId, table.skillTag),
]);

export const workers = pgTable("workers", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  phone: varchar("phone", { length: 20 }).notNull(),
  gender: varchar("gender", { length: 10 }).notNull().default('male'),
  serviceCity: varchar("service_city", { length: 100 }).notNull(),
  serviceType: varchar("service_type", { length: 50 }).notNull(),
  level: varchar("level", { length: 20 }).notNull().default('junior'),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  rating: integer("rating").notNull().default(0),
  totalOrders: integer("total_orders").notNull().default(0),
  avatar: text("avatar"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_workers_service_city").on(table.serviceCity),
  index("idx_workers_status").on(table.status),
  index("idx_workers_service_type").on(table.serviceType),
]);

export const smsCodes = pgTable("sms_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
  code: varchar("code", { length: 6 }).notNull(),
  expiresAt: customTimestamptz("expires_at", { precision: 6 }).notNull(),
  used: boolean("used").notNull().default(false),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_sms_codes_phone").on(table.phoneNumber, table.used),
  index("idx_sms_codes_expires").on(table.expiresAt),
]);

export const agentSkills = pgTable("agent_skills", {
  id: uuid("id").primaryKey().defaultRandom(),
  assigneeId: varchar("assignee_id", { length: 100 }).notNull(),
  skillTag: varchar("skill_tag", { length: 50 }).notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("idx_agent_skills_agent_tag").on(table.assigneeId, table.skillTag),
]);

export const aiConfigs = pgTable("ai_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  configKey: varchar("config_key", { length: 100 }).notNull().unique(),
  configValue: text("config_value").notNull(),
  configType: varchar("config_type", { length: 20 }).notNull().default('text'),
  description: text("description"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("ai_configs_config_key_key").on(table.configKey),
]);

export const qaEntries = pgTable("qa_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  category: varchar("category", { length: 50 }).notNull().default('general'),
  enabled: boolean("enabled").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_qa_entries_category").on(table.category),
  index("idx_qa_entries_enabled").on(table.enabled),
]);

export const requirements = pgTable("requirements", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull().unique(),
  serviceType: varchar("service_type", { length: 50 }),
  householdSize: varchar("household_size", { length: 50 }),
  area: varchar("area", { length: 50 }),
  elderlyCare: text("elderly_care"),
  restDays: varchar("rest_days", { length: 50 }),
  startTime: varchar("start_time", { length: 100 }),
  serviceAddress: text("service_address"),
  helperRequirements: text("helper_requirements"),
  dietaryPreferences: text("dietary_preferences"),
  budget: varchar("budget", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull().default('collecting'),
  specialRequirements: text("special_requirements"),
  /**
   * @type { field: string, value: string, label: string }[]
   */
  collectedFields: jsonb("collected_fields").default('[]'),
  aiSummary: text("ai_summary"),
  hasPet: varchar("has_pet", { length: 100 }),
  serviceItems: text("service_items"),
  serviceHours: varchar("service_hours", { length: 50 }),
  source: text("source").default('chat'),
  cardSubmittedAt: timestamp("card_submitted_at", { mode: 'string' }),
  childCare: text("child_care"),
  /**
   * @type Record<string, { status: string, confidence: number, source: string | null }>
   */
  fieldMetadata: jsonb("field_metadata"),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_requirements_lead_id").on(table.leadId),
  uniqueIndex("requirements_lead_id_key").on(table.leadId),
  foreignKey({
    columns: [table.leadId],
    foreignColumns: [leads.id],
    name: "requirements_lead_id_fkey",
  }).onDelete("cascade"),
]);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id").notNull(),
  role: varchar("role", { length: 20 }).notNull(),
  content: text("content").notNull(),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_chat_messages_session_id").on(table.sessionId),
  foreignKey({
    columns: [table.sessionId],
    foreignColumns: [chatSessions.id],
    name: "chat_messages_session_id_fkey",
  }).onDelete("cascade"),
]);

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  status: varchar("status", { length: 20 }).notNull().default('active'),
  startedAt: customTimestamptz("started_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  endedAt: customTimestamptz("ended_at", { precision: 3 }),
  mode: varchar("mode", { length: 20 }).notNull().default('ai'),
  transferReason: varchar("transfer_reason", { length: 200 }),
  transferredBy: varchar("transferred_by", { length: 20 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_chat_sessions_lead_id").on(table.leadId),
  foreignKey({
    columns: [table.leadId],
    foreignColumns: [leads.id],
    name: "chat_sessions_lead_id_fkey",
  }).onDelete("cascade"),
]);

export const contactLogs = pgTable("contact_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull(),
  contactType: varchar("contact_type", { length: 20 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default('pending'),
  notes: text("notes"),
  operatorId: varchar("operator_id", { length: 100 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  index("idx_contact_logs_lead_id").on(table.leadId),
  foreignKey({
    columns: [table.leadId],
    foreignColumns: [leads.id],
    name: "contact_logs_lead_id_fkey",
  }).onDelete("cascade"),
]);

export const leads = pgTable("leads", {
  id: uuid("id").primaryKey().defaultRandom(),
  serviceCity: varchar("service_city", { length: 100 }).notNull(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull(),
  customerName: varchar("customer_name", { length: 50 }),
  source: varchar("source", { length: 50 }).notNull().default('unknown'),
  status: varchar("status", { length: 20 }).notNull().default('new'),
  chatToken: varchar("chat_token", { length: 100 }).notNull().unique().default(sql`(gen_random_uuid())::text`),
  assigneeId: varchar("assignee_id", { length: 100 }),
  bitableRecordId: varchar("bitable_record_id", { length: 100 }),
  assignedAt: customTimestamptz("assigned_at", { precision: 6 }),
  lastFollowedUpAt: customTimestamptz("last_followed_up_at", { precision: 6 }),
  intent: varchar("intent", { length: 50 }),
  routingReason: varchar("routing_reason", { length: 200 }),
  leadGrade: varchar("lead_grade", { length: 10 }),
  leadScore: numeric("lead_score"),
  budgetRange: varchar("budget_range", { length: 50 }),
  serviceStartTime: varchar("service_start_time", { length: 100 }),
  serviceDuration: varchar("service_duration", { length: 50 }),
  specialRequirements: text("special_requirements"),
  familyInfo: text("family_info"),
  urgencyLevel: varchar("urgency_level", { length: 10 }),
  phoneVerified: boolean("phone_verified").notNull().default(false),
  leadSourceDetail: varchar("lead_source_detail", { length: 100 }),
  channel: varchar("channel", { length: 20 }).notNull().default('openapi'),
  gradeReason: varchar("grade_reason", { length: 200 }),
  gradeConfidence: numeric("grade_confidence"),
  pendingAssignmentUntil: customTimestamptz("pending_assignment_until", { precision: 3 }),
  routingAttempts: integer("routing_attempts").notNull().default(0),
  lastRoutingAt: customTimestamptz("last_routing_at", { precision: 3 }),
  escalatedToSupervisor: boolean("escalated_to_supervisor").notNull().default(false),
  supervisorNotifiedAt: customTimestamptz("supervisor_notified_at", { precision: 3 }),
  fallbackNotifiedAt: customTimestamptz("fallback_notified_at", { precision: 3 }),
  crossChannelHistory: jsonb("cross_channel_history").notNull().default('[]'),
  serviceType: varchar("service_type", { length: 50 }),
  respondedAt: customTimestamptz("responded_at", { precision: 3 }),
  assignmentStatus: varchar("assignment_status", { length: 20 }).notNull().default('pending'),
  originalAgentId: varchar("original_agent_id", { length: 100 }),
  pendingComfortAt: customTimestamptz("pending_comfort_at", { precision: 3 }),
  // System field: Creation time (auto-filled, do not modify)
  createdAt: customTimestamptz("_created_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Creator (auto-filled, do not modify)
  createdBy: userProfile("_created_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
  // System field: Update time (auto-filled, do not modify)
  updatedAt: customTimestamptz("_updated_at", { precision: 3 }).notNull().default(sql`CURRENT_TIMESTAMP`),
  // System field: Updater (auto-filled, do not modify)
  updatedBy: userProfile("_updated_by").default(sql`CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL`),
}, (table) => [
  uniqueIndex("leads_chat_token_key").on(table.chatToken),
  index("idx_leads_status").on(table.status),
  index("idx_leads_service_city").on(table.serviceCity),
  index("idx_leads_assignee_id").on(table.assigneeId),
  index("idx_leads_bitable_record_id").on(table.bitableRecordId),
  index("idx_leads_urgency_level").on(table.urgencyLevel),
  index("idx_leads_channel").on(table.channel),
  index("idx_leads_phone_number").on(table.phoneNumber),
  index("idx_leads_lead_grade").on(table.leadGrade),
  index("idx_leads_assignment_status").on(table.assignmentStatus),
]);

// table aliases
export const agentOnlineStatusTable = agentOnlineStatus;
export const agentSessionsTable = agentSessions;
export const agentSkillsTable = agentSkills;
export const agentsTable = agents;
export const aiConfigsTable = aiConfigs;
export const aiLearnedTemplatesTable = aiLearnedTemplates;
export const aiTemplateUsageTable = aiTemplateUsage;
export const chatMessagesTable = chatMessages;
export const chatSessionsTable = chatSessions;
export const contactLogsTable = contactLogs;
export const faqsTable = faqs;
export const feeQuoteLogsTable = feeQuoteLogs;
export const intentDiscoveriesTable = intentDiscoveries;
export const leadGradeHistoryTable = leadGradeHistory;
export const leadsTable = leads;
export const matchRecordsTable = matchRecords;
export const qaEntriesTable = qaEntries;
export const requirementFieldDeltaTable = requirementFieldDelta;
export const requirementsTable = requirements;
export const salaryConfigTable = salaryConfig;
export const serviceOrdersTable = serviceOrders;
export const smsCodesTable = smsCodes;
export const workerAvailabilityTable = workerAvailability;
export const workerSkillsTable = workerSkills;
export const workersTable = workers;
