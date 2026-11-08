// D1 全表 schema（design.md §2 数据模型）。
// 约定：
// - 数据库列名 snake_case；时间戳 integer epoch seconds（drizzle mode "timestamp"）。
// - 网关 API Key 只存 sha256 哈希（spec 强制）；上游 Provider 密钥 AES-GCM 加密后存储。
// - 金额一律 REAL（虚拟币）；价格单位为 USD / 每百万 tokens。
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
};

// --- 用户 ---
// role: 'admin' | 'member'；balance 为预充值余额（硬配额）；status: 'active' | 'disabled'。
// M2 起该表同时充当 Better Auth 的 user 模型：
// - 列名与 Better Auth 字段名映射通过 drizzle 属性名（camelCase）匹配（id/name/email/createdAt/updatedAt/emailVerified/image）。
// - role/balance/status/githubId 为应用自有字段；其中 role/balance/status 注册为 additionalFields（input: false，不可由客户端写入）。
// - id 保持 INTEGER 自增；Better Auth 侧配置 advanced.database.generateId = "serial" 与之匹配。
export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    role: text("role").notNull().default("member"), // 'admin' | 'member'
    status: text("status").notNull().default("active"), // 'active' | 'disabled'
    balance: real("balance").notNull().default(0),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image"),
    githubId: text("github_id").unique(),
    // 手机号（11-06-sms-alicloud-auth）：**规范形** `+86` + 11 位（见 src/lib/phone.ts）。
    // 唯一 —— 一个号码只能挂一个账号（邮箱/手机号账号可各自独立存在，但号码不可重复）。
    // NULL = 未绑定；短信注册时由插件写入并置 verified。
    phoneNumber: text("phone_number").unique(),
    // 号码是否经短信验证码验证过（插件在 verify 建号/绑定时写 true）。
    // notNull + default(false)：存量行自动为 false，无需回填。
    phoneNumberVerified: integer("phone_number_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    // 赠金幂等标记（09-16-signup-bonus-grant）：NULL = 该档未发放；非 NULL = 已发放时间。
    // 均为 nullable 无默认值（迁移只增不改）；条件 UPDATE 的 WHERE 依据，
    // 并发两次触发只有一次能命中（配合 balance_tx_bonus_once_idx 部分唯一索引双保险）。
    signupBonusGrantedAt: integer("signup_bonus_granted_at", {
      mode: "timestamp",
    }),
    emailVerifyBonusGrantedAt: integer("email_verify_bonus_granted_at", {
      mode: "timestamp",
    }),
    // 首次登录欢迎弹窗标记（09-16-signup-bonus-onboarding C2 使用；本任务只建列，不写不改）
    welcomeSeenAt: integer("welcome_seen_at", { mode: "timestamp" }),
    ...timestamps,
  },
  (table) => [index("users_email_idx").on(table.email)],
);

// --- Better Auth session 表 ---
// 列（drizzle 属性名）与 Better Auth session 模型字段名一致：token/expiresAt/ipAddress/userAgent/userId/createdAt/updatedAt。
export const sessions = sqliteTable(
  "sessions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull().unique(), // SHA-256 哈希后的会话 token
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("sessions_token_idx").on(table.token),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

// --- Better Auth account 表 ---
// email/password 账号（providerId='credential'）与 GitHub OAuth 账号（providerId='github'）统一存储。
// password 列为 scrypt 哈希；accessToken/refreshToken 等 OAuth 令牌不对外返回。
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    issuer: text("issuer").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex("accounts_issuer_account_id_idx").on(
      table.issuer,
      table.accountId,
    ),
    index("accounts_user_id_idx").on(table.userId),
  ],
);

// --- Better Auth verification 表（邮箱验证 token 等一次性记录） ---
export const verifications = sqliteTable(
  "verifications",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

// --- 邀请码（admin 生成，邮箱密码注册携带） ---
// code 明文存储（一次性使用 + 乐观锁置 used_at，遵循 security.md 一次性 code 模式）；
// usedAt 通过条件 UPDATE 置位，防并发重复使用。
export const inviteCodes = sqliteTable(
  "invite_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    code: text("code").notNull().unique(),
    // createdBy **可空**（09-22-seed-users-dev-only，决策 D-F1）：空库里的第一张邀请码
    // **结构性没有合法签发者** —— dev-only 种子路由（POST /api/seed/users）必须在 signUpEmail
    // 之前铸码，而此刻目标用户尚不存在，且 users.id 由 D1 自增（generateId: "serial"）无从预知，
    // FK 又是立即检查 ⇒ 只能留空。生产路径恒有签发者（admin 在管理端发起）。
    // 该字段不参与任何鉴权：唯一消费方是 delete.ts 的「删用户时顺带清理他发的码」，
    // NULL 行不匹配该条件、不被清理（仅 dev 会存在，无害）。
    createdBy: integer("created_by").references(() => users.id),
    usedAt: integer("used_at", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("invite_codes_created_by_idx").on(table.createdBy),
    index("invite_codes_code_idx").on(table.code),
  ],
);

// --- 网关 API Key ---
// hash = sha256(明文 key)，明文仅在创建响应中返回一次；prefix 用于 UI 识别。
/** 响应缓存默认 TTL（秒）：schema 默认值与 /api/admin/settings 展示的唯一来源。 */
export const DEFAULT_CACHE_TTL_SECONDS = 3600;

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    hash: text("hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    status: text("status").notNull().default("active"), // 'active' | 'revoked'
    qpsLimit: integer("qps_limit").notNull().default(60),
    cacheEnabled: integer("cache_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    cacheTtl: integer("cache_ttl")
      .notNull()
      .default(DEFAULT_CACHE_TTL_SECONDS), // 秒
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("api_keys_user_id_idx").on(table.userId)],
);

// --- 上游 Provider ---
// type: 'openai' | 'anthropic'；api_key_enc 为 AES-GCM 加密后的上游密钥；
// models 为 JSON 路由映射（内部模型名 -> 上游模型名）。
export const providers = sqliteTable(
  "providers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    baseUrl: text("base_url").notNull(),
    apiKeyEnc: text("api_key_enc").notNull(),
    // 明文前 10 字符（与 api_keys.prefix 同思路）：仅用于 UI 展示识别，不敏感
    apiKeyPrefix: text("api_key_prefix").notNull().default(""),
    models: text("models").notNull(),
    // 高级 HTTP 选项（JSON 字符串）：AES-GCM 加密存储（headers 可能含上游认证值）；
    // NULL ≡ 未配置（{}，行为与现状一致）
    httpOptionsEnc: text("http_options_enc"),
    // 负载均衡权重：多 provider 供同一模型时按 weight 比例分配（槽位法），默认 1 均分
    weight: integer("weight").notNull().default(1),
    // 思考模式（R2，09-01-reasoning-effort-mapping）：NULL ≡ auto（自适应线优先）；
    // 'adaptive' 强制自适应线（thinking:{type:"adaptive"}+output_config:{effort}）；
    // 'budget' 旧模型线（thinking:{type:"enabled",budget_tokens}，仅服务 R1 逐字透传；
    //   reasoning_effort 在此模式丢弃 + warn）；'off' 保持现状丢弃。
    // H3：NULL ≡ 不映射（零变更契约）——未配置时不注入 thinking/删参数（此前 NULL≡auto
    // 把未配置静默升格为强制 adaptive 线）；合法值由 providers 读写 zod enum（H6）约束。
    thinkingMode: text("thinking_mode"),
    // reasoning 输入项回传（Workstream B，09-01-codex-responses-lite-full）：false（默认）→
    // openai 适配器剥离 assistant.reasoning_content（上游零变化）；true → 保留（deepseek
    // 思考模式上游要求回传）。仅 openai 面生效；anthropic 适配器天然忽略。
    reasoningRoundtrip: integer("reasoning_roundtrip", { mode: "boolean" })
      .notNull()
      .default(false),
    // 上游超时（毫秒，09-01-stg-glm-ccswitch-fix）：NULL ≡ 默认 60s（DEFAULT_UPSTREAM_TIMEOUT_MS）。
    // 长生成模型（如 b.ai glm-5.3-flash）慢生成易撞默认超时 → 按 provider 调大。
    upstreamTimeoutMs: integer("upstream_timeout_ms"),
    // 厂商身份标签（09-28-upstream-custom-type-passthrough D1）：可空。preset 只是记录上的
    // 标签（建档预填来源），**运行时零感知**——档案本体是代码 const（src/providers/presets.ts，
    // 批次 5）；proxy / 适配器不得出现任何厂商名分支（AC2）。
    preset: text("preset"),
    // 协议面声明（同任务）：JSON 字符串（与 models 列同惯例），NULL ≡ 未声明。
    // 语义（解析真源 = src/providers/endpoints.ts）：出现某面 = 该上游支持该面（不出现 ⇒
    // 路由不命中该面）；面内省略 baseUrl ⇒ 继承 base_url（不复制 URL，避免两份漂移）；
    // 省略 policy ⇒ 取该面默认（messages/chat = verbatim，其余 = convert）。
    // 遗留等价规则：protocols=NULL 时按 type 复现今天的隐式面表（openai 3 面 / anthropic
    // 2 面，messages 面 streamPassthrough=true = P2a 字节直通的恒等复现）。
    protocols: text("protocols"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("providers_type_idx").on(table.type)],
);

// --- 余额流水 ---
// amount 带符号（充值 + / 扣费 -）；
// type: 'recharge' | 'usage' | 'adjust' | 'signup_bonus' | 'email_verify_bonus'
// （后两者为赠送赠金，2026-09-16 起；zod 是取值真源：src/routes/billing/types.ts）。
export const balanceTx = sqliteTable(
  "balance_tx",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    amount: real("amount").notNull(),
    type: text("type").notNull(),
    note: text("note"),
    refRequestId: integer("ref_request_id").references(
      () => requestLogs.id,
    ),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("balance_tx_user_id_idx").on(table.userId),
    index("balance_tx_created_at_idx").on(table.createdAt),
    // 赠金幂等兜底（09-16-signup-bonus-grant）：同一用户每档赠金至多一行流水。
    // 部分唯一索引只覆盖两个赠金 type（usage 单请求多行、adjust/recharge 不受影响）；
    // 与 users.signup_bonus_granted_at / email_verify_bonus_granted_at 标记列双保险：
    // 标记列挡住重复加钱，本索引挡住「标记被清空后重复写流水」。
    uniqueIndex("balance_tx_bonus_once_idx")
      .on(table.userId, table.type)
      .where(
        sql`${table.type} IN ('signup_bonus', 'email_verify_bonus')`,
      ),
  ],
);

// --- 请求明细 ---
// 鉴权失败（rejected）/未路由时 user_id / key_id / provider_id 为 null；
// latency 字段仅在转发后存在。
// request_id：延迟计费幂等键（请求路径生成的 UUID；成功路径明细由计费消费者写入，
// 部分唯一索引保证重复投递（at-least-once）只落一行；旧行/错误路径同步明细不受限）。
export const requestLogs = sqliteTable(
  "request_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestId: text("request_id"),
    userId: integer("user_id").references(() => users.id),
    keyId: integer("key_id").references(() => apiKeys.id),
    providerId: integer("provider_id").references(() => providers.id),
    model: text("model"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: real("cost").notNull().default(0),
    latencyMs: integer("latency_ms"),
    upstreamLatencyMs: integer("upstream_latency_ms"),
    status: text("status").notNull(), // 'success' | 'error' | 'cached' | 'rejected'
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index("request_logs_created_at_idx").on(table.createdAt),
    index("request_logs_user_id_idx").on(table.userId),
    index("request_logs_key_id_idx").on(table.keyId),
    uniqueIndex("request_logs_request_id_idx")
      .on(table.requestId)
      .where(sql`${table.requestId} IS NOT NULL`),
  ],
);

// --- 用量日聚合（Queues consumer 异步 upsert） ---
export const usageDaily = sqliteTable(
  "usage_daily",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    keyId: integer("key_id")
      .notNull()
      .references(() => apiKeys.id),
    model: text("model").notNull(),
    date: text("date").notNull(), // YYYY-MM-DD
    requests: integer("requests").notNull().default(0),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    cost: real("cost").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.keyId, table.model, table.date],
    }),
  ],
);

// --- 模型价格表 ---
// 单价单位：USD / 每百万 tokens；seed 提供默认价格（seed.sql），admin 可覆盖。
// 分层规则（M9）：请求未缓存输入 tokens > 128,000 时输入/输出均取 long 档，否则 short 档；
// 缓存命中输入按 inputPriceCached 计（各厂商官方公布的缓存价，通常为 short 输入价的 10%~20%）。
export const models = sqliteTable(
  "models",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    model: text("model").notNull().unique(),
    inputPriceShort: real("input_price_short").notNull(),
    inputPriceLong: real("input_price_long").notNull(),
    inputPriceCached: real("input_price_cached").notNull(),
    outputPriceShort: real("output_price_short").notNull(),
    outputPriceLong: real("output_price_long").notNull(),
    // 模型级输出上限（tokens，09-01-stg-glm-ccswitch-fix）：NULL ≡ 不限制。
    // 请求 max_tokens 超过上限时 proxy 层 clamp（防慢模型长生成撞上游超时）。
    maxOutputTokens: integer("max_output_tokens"),
    // 免费模式（09-14-admin-ui-adjustments-2 批次 P，D17）：**标记列**，5 个价列一字不动。
    // 计费侧 findModelPrice 命中后返回有效价（FREE_MODE_PRICE_PER_MILLION）而非库里的价 ——
    // 作用是让该模型仍走**真实扣费路径**（cost > 0 ⇒ 有 balance_tx 流水、余额真的下降），
    // 而不是「改价」或「防计价失败」（0 token 的请求 cost 恰为 0，连极小值也救不了）。
    freeMode: integer("free_mode", { mode: "boolean" }).notNull().default(false),
    // 隐藏（同批次 D18）：⚠ **不是「停用」** —— 网关照常服务该模型（代理路径与 /v1/models
    // 都不读这一列），只是 member 的价格表响应里**不列这一行**（服务端过滤）。
    // 命名刻意避开 hidden / disabled，以免日后被读成「已停用」而据此删行。
    hiddenFromMembers: integer("hidden_from_members", { mode: "boolean" })
      .notNull()
      .default(false),
    ...timestamps,
  },
  (table) => [index("models_model_idx").on(table.model)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Verification = typeof verifications.$inferSelect;
export type NewVerification = typeof verifications.$inferInsert;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type NewInviteCode = typeof inviteCodes.$inferInsert;
export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type Provider = typeof providers.$inferSelect;
export type NewProvider = typeof providers.$inferInsert;
export type BalanceTx = typeof balanceTx.$inferSelect;
export type NewBalanceTx = typeof balanceTx.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type UsageDaily = typeof usageDaily.$inferSelect;
export type NewUsageDaily = typeof usageDaily.$inferInsert;
export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;
