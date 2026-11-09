// 共享类型（spec environment.md：集中式类型系统）。
// Bindings 来自 `wrangler types` 生成的 worker-configuration.d.ts（D1/KV/Queues 绑定），
// 字符串环境变量（BETTER_AUTH_* 等）在 src/env.d.ts 中通过接口合并补充。
import type { Logger } from "./lib/logger";
import type { AuthInstance } from "./lib/auth";
import type { ApiKey, User } from "./db/schema";

export type Bindings = Env;

// 用户角色 / 状态（users.role / users.status 列的窄化字面量类型）
export type UserRole = "admin" | "member";
export type UserStatus = "active" | "disabled";

// Better Auth getSession 的返回类型（user 携带 additionalFields：role/status/balance）
type SessionResult = Awaited<ReturnType<AuthInstance["api"]["getSession"]>>;
export type AuthSession = NonNullable<SessionResult>["session"];
/**
 * 会话用户。额外并入 phone-number 插件的字段（11-06-sms-alicloud-auth）：
 * 插件由 SMS_AUTH_ENABLED 门控**条件注册**，auth.ts 的 plugins 是「有插件 / 无插件」的联合类型，
 * 直接取 `NonNullable<SessionResult>["user"]` 得到的是联合，`phoneNumberVerified` 不在公共成员上。
 * 运行时语义与此一致：开关开启时该字段随会话下发（插件 schema 并入 user 表），
 * 关闭时**结构性缺席** —— 故声明为可选，调用方（phone 门禁）必须先判开关再读它。
 */
export type SessionUser = NonNullable<SessionResult>["user"] & {
  // 插件 schema 把该字段声明为「可空且可选」（库侧 parseUserOutput 对缺失值给 null），
  // 与 drizzle 列 NOT NULL 的严格性不同 —— 以库侧类型为准，门禁用 `=== true` 判定即可。
  phoneNumberVerified?: boolean | null;
};

/** 代理面鉴权上下文（由 gatewayAuth 中间件注入 /v1/* 请求）。 */
export type GatewayAuthContext = {
  /** api_keys 行（active） */
  key: ApiKey;
  /** 关联 users 行（active，balance 用于余额检查） */
  user: User;
};

export type Variables = {
  requestId: string;
  logger: Logger;
  // 由 requireSession 注入（Better Auth 会话解析结果 + userId/role 快照）
  session?: AuthSession;
  user?: SessionUser;
  userId?: string;
  role?: UserRole;
  // 由 gatewayAuth 注入（代理面 Bearer 网关 Key 鉴权，与 /api/* 会话鉴权并存）
  gatewayAuth?: GatewayAuthContext;
  // 由 protocolDetectMiddleware 注入（/v1/messages 双协议感知；未检测 = undefined）
  detectedProtocol?: import("./lib/protocol-detect").Protocol;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
