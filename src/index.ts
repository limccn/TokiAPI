// AI API Gateway - Worker 入口。
// 中间件/路由注册顺序（Hono 按注册顺序匹配）：
//   1. requestContext（MUST 最先挂载，注入 requestId + logger）
//   2. domainSplit（双域名分流：按 Host 放行/互跳；未配置 API_DOMAIN 时整体关闭）
//   3. zod 校验错误统一中间件（M8：@hono/zod-validator 400 响应统一为 {error:{message}}）
//   4. GET /api/health（public）+ GET /api/config（public）
//   5. authRateLimit 挂载 /api/auth/*（认证面限流，09-28-auth-rate-limit-fix / security-audit F1）
//      —— **必须先于 authRouter 注册**，否则永远不跑
//   6. /api/auth/*（Better Auth，public）与 /api/invites/validate（批次 U 公开预校验，
//      同挂 authRateLimit）—— 必须先于 requireSession 注册
//   7. requireSession 挂载 /api/*（未登录 401）
//   8. 管理面模块路由（/api/users、/api/keys、/api/providers 等）
//   9. notFound 兜底：/api/* 与 /v1/* 返回 JSON 404；其余路径交给 env.ASSETS 托管
//      （M6 前端：SPA index.html + 构建产物；wrangler.jsonc assets run_worker_first=true）
// 代理面 /v1/*（M3）：网关 Key 鉴权，独立于会话鉴权，在 requireSession 之前注册（互不冲突）。
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { requestContext } from "./middleware/request-context";
import { domainSplit } from "./middleware/domain-split";
import { authRateLimit } from "./middleware/auth-rate-limit";
import { requireSession } from "./middleware/auth";
import { apiBaseUrl, platformBaseUrl } from "./lib/domains";
import authRouter from "./routes/auth/router";
import invitesRouter from "./routes/invites/router";
import usersRouter from "./routes/users/router";
import keysRouter from "./routes/keys/router";
import providersRouter from "./routes/providers/router";
import modelsRouter from "./routes/models/router";
import v1Router from "./routes/v1/router";
import anthropicRouter from "./routes/anthropic/router";
import usageRouter from "./routes/usage/router";
import settingsRouter from "./routes/settings/router";
import billingRouter from "./routes/billing/router";
import onboardingRouter from "./routes/onboarding/router";
import profileRouter from "./routes/profile/router";
import { toUnifiedErrorBody } from "./lib/error-format";
import { logger } from "./lib/logger";
import { consumeUsageBatch } from "./lib/usage-aggregation";
import { consumeBillingBatch } from "./lib/billing-queue";
import { parseRetentionDays, runRequestLogCleanup } from "./lib/cleanup";
import { createDb } from "./db";
import type { AppEnv } from "./types";

const app = new Hono<AppEnv>();

// MUST be first — 提供 requestId + 结构化 logger
app.use("*", requestContext());

// 双域名分流（09-21-dual-domain-split）：管理台域 / 公开 API 域按 Host 分流、越界路径互跳。
// 必须在 zod 统一中间件之前 —— 301/308 不该进入"400 响应重写"路径。
// 未配置 API_DOMAIN（本地 dev 等）⇒ 整体关闭，行为与今日完全一致。
app.use("*", domainSplit());

// M8 全局 zod 校验错误统一（journal 延期项 1）：
// @hono/zod-validator 校验失败返回 `{success:false, error: <ZodError 序列化>}`（400，直接返回、
// 不抛错，onError 收不到），与项目统一格式 `{error:{message}}` 不一致。
// 此处对所有 400 JSON 响应做一次检测并重写为统一格式，覆盖 /api/* 与 /v1/*，
// 不逐调用点修改。消息格式与下方 onError 的 ZodError 分支保持一致；
// ZodError 序列化形态见 src/lib/error-format.ts（zod v3 `{issues:[...]}` / zod v4 `{name,message}`）。
app.use("*", async (c, next) => {
  await next();
  const res = c.res;
  if (res.status !== 400) {
    return;
  }
  const contentType = res.headers.get("Content-Type") ?? "";
  if (!contentType.includes("application/json")) {
    return;
  }
  const cloned = res.clone();
  const body: unknown = await cloned.json().catch(() => null);
  const unified = toUnifiedErrorBody(body);
  if (unified !== null) {
    c.get("logger").warn("validation_error", { path: c.req.path });
    c.res = c.json(unified, 400);
  }
});

// GET /api/health —— 存活探针；不触达 DB（database.md Pitfall 4：避免冷启动叠加）
app.get("/api/health", (c) =>
  c.json({ ok: true, service: "cf-ai-gateway", ts: new Date().toISOString() }),
);

// GET /api/config —— 公开的**运行期**前端配置（R-B14）。**必须注册在下面 requireSession 之前**
// （Hono 按注册顺序匹配，先命中的 handler 返回即终止）—— 它是登录页也要用的公开端点。
// 为什么不能构建期烘焙：SPA 是**同一份**静态产物，同时服务 prod / stg / 本地 dev
// （assets.directory 是构建产物，[env.*] 改不了前端 bundle），只能运行期下发。
// 取值见 design §2.3：apiBaseUrl **不带 /v1 后缀**（前端按 `${apiBaseUrl}${basePath}` 拼接，
// 保持既有结构）；未配置 API_DOMAIN 时回落请求自身 origin（本地行为与今日完全一致）。
app.get("/api/config", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    apiBaseUrl: apiBaseUrl(c.env, origin),
    platformBaseUrl: platformBaseUrl(c.env, origin),
  });
});

// 认证面限流（09-28-auth-rate-limit-fix / security-audit F1）：此前 /api/auth/* 零速率成本
// （Better Auth 自带限流挂 NODE_ENV === "production"，而 Workers 里它是 undefined ⇒ 从未启用），
// 匿名口令爆破与邮件放大都无上界。**必须在 authRouter 之前**（Hono 按注册顺序匹配）。
// 策略（10 次 / 5 次每 60 秒）在部署配置的 [[ratelimits]]（wrangler.jsonc；维护者 fork 为
// wrangler.prod.jsonc），改档位不用改代码、不用发版。
app.use("/api/auth/*", authRateLimit());

// Better Auth（public）：必须先于 requireSession 注册
app.route("/api/auth", authRouter);

// 邀请码预校验（批次 U，D29/D30）：GET /api/invites/validate —— 注册页**公开**端点
// （未登录 200），必须先于下面的 requireSession 注册（否则注册页拿到 401、预校验整条失效）。
// 限流先于路由挂载（同 /api/auth/* 的顺序纪律）：路径白名单在 auth-rate-limit.ts（credential 桶）。
app.use("/api/invites/validate", authRateLimit());
app.route("/api/invites", invitesRouter);

// 代理面（M3）：/v1/* —— 网关 Key 鉴权（与 /api/* 会话鉴权并存），独立挂载
app.route("/v1", v1Router);

// Anthropic 入站（R1）：/anthropic/v1/messages（主）+ /anthropic/messages（别名）；
// router 内部挂 x-api-key 兼容鉴权 + Anthropic 错误形态重写；/v1/messages 别名在 v1Router 内
app.route("/anthropic", anthropicRouter);

// 管理面 API：全部要求会话
app.use("/api/*", requireSession());

// 管理面模块路由
app.route("/api/users", usersRouter);
app.route("/api/keys", keysRouter);
app.route("/api/providers", providersRouter);
app.route("/api/models", modelsRouter);
app.route("/api", usageRouter); // /api/me/usage（member）、/api/admin/usage（admin）
app.route("/api", settingsRouter); // /api/admin/settings（admin 只读）
app.route("/api", billingRouter); // /api/me/transactions（member）、/api/admin/transactions（admin）
app.route("/api", onboardingRouter); // /api/me/onboarding（member：首登欢迎状态 / 标记已读）
app.route("/api", profileRouter); // /api/me/profile（member：账号资料只读，改 name 走 /api/auth/update-user）

// notFound 兜底（M6）：API 路径保持 JSON 404；其余路径（SPA 深链/静态资源）交给 Workers Assets。
// run_worker_first=true 下 Worker 先收到全部请求，这里对非 API 路径回落到 env.ASSETS.fetch，
// html_handling=spa 会将无扩展名路径回退到 index.html（React Router 客户端路由）。
app.notFound((c) => {
  const path = c.req.path;
  // /anthropic 由 child A 挂载（R1）；未知子路径（含裸 /anthropic 本身）同样返回 JSON 404（错误体后续由协议错误适配层改写）
  if (path.startsWith("/api/") || path.startsWith("/v1/") || path.startsWith("/anthropic")) {
    return c.json({ error: { message: "Not Found" } }, 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((err, c) => {
  // requestContext 已挂载时使用请求级 logger；否则退回模块级 logger
  const requestLogger = c.get("logger") ?? logger;
  if (err instanceof HTTPException) {
    // 业务/鉴权错误：透传状态码与消息（401/403/404/400 等）
    requestLogger.warn("request_error", {
      status: err.status,
      message: err.message,
      path: c.req.path,
    });
    return c.json({ error: { message: err.message } }, err.status);
  }

  if (err instanceof ZodError) {
    // 输入校验失败：统一 400（error-logging spec：validation_error）
    const firstIssue = err.issues[0];
    const detail =
      firstIssue !== undefined
        ? `${firstIssue.path.join(".") || "body"}: ${firstIssue.message}`
        : err.message;
    requestLogger.warn("validation_error", {
      path: c.req.path,
      issues: err.issues,
    });
    return c.json({ error: { message: `Validation failed: ${detail}` } }, 400);
  }
  requestLogger.error("unhandled_error", {
    message: err.message,
    path: c.req.path,
  });
  return c.json({ error: { message: "Internal Server Error" } }, 500);
});

// 默认导出为模块 Worker 风格对象（M5 起）：fetch + queue + scheduled 统一挂在 default 上。
// 注意：Hono 实例的 fetch 是原型方法，展开运算符不会拷贝，需显式 bind；否则 wrangler/vitest-pool
// 按 `default.fetch` 派发时会拿到 undefined（M5 验证时曾出现 "Expected default export ... fetch" 错误）。
// 同时保留同名具名导出（测试直接 import 调用；vitest-pool 对 queue/scheduled 事件按 default 派发）。
export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  // 按队列名分流：BILLING_QUEUE → 延迟计费消费者；其余（USAGE_QUEUE）→ 用量聚合消费者。
  // 队列名来自部署配置 [vars]（wrangler.jsonc / 维护者 wrangler.prod.jsonc）。
  // BILLING_QUEUE_NAME 缺键时若静默走 usage 分支，
  // 计费消息会被丢弃（校验失败）且不扣费 —— fail-fast：抛错让批次重试，直到配置修复。
  if (!env.BILLING_QUEUE_NAME) {
    throw new Error("BILLING_QUEUE_NAME is not configured — billing events would be lost; fix [vars] before deploying");
  }
  if (batch.queue === env.BILLING_QUEUE_NAME) {
    await consumeBillingBatch(batch, env);
  } else {
    await consumeUsageBatch(batch, env);
  }
}

// Scheduled cron（M5 5.4）：按保留期清理过期 request_logs（默认 30 天，env REQUEST_LOG_RETENTION_DAYS 可配置）。
// 部署配置 [triggers] crons 声明（wrangler.jsonc / 维护者 fork）；本地 wrangler dev 不自动触发（用 --test-scheduled 或直接调用本函数验证）。
export async function scheduled(
  _event: ScheduledEvent,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const retentionDays = parseRetentionDays(env.REQUEST_LOG_RETENTION_DAYS);
  await runRequestLogCleanup(createDb(env), retentionDays, logger);
}

export default {
  fetch: app.fetch.bind(app),
  queue,
  scheduled,
};
