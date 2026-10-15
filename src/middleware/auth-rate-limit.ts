// 认证面限流（09-28-auth-rate-limit-fix；修复 security-audit 2026-09-23 的 F1）。
//
// 背景：`/api/auth/*` 此前**零速率成本** —— Better Auth 自带限流挂在 `NODE_ENV === "production"` 上，
// 而 Workers 运行时里 `NODE_ENV` 是 `undefined` ⇒ 生产上从未启用（F1 实证：同一测试臂改挂
// `NODE_ENV=production` 后第 4 个请求起 429）。于是匿名口令爆破与匿名邮件放大都没有上界。
// 方案：Cloudflare 原生 `[[ratelimits]]` 绑定（**策略 limit/period 全在 wrangler 配置**，
// 代码侧只传 `{ key }`），技术形态见 .trellis/tasks/09-28-auth-rate-limit-fix/design.md §2-§3。
//
// 挂载位（src/index.ts）：必须在 `app.route("/api/auth", authRouter)` **之前** ——
// Hono 按注册顺序匹配，先挂的先跑。
//
// 四条**刻意**行为，改代码前先读完（否则会把它们当 bug 修掉）：
//   1. **不用 binding 的默认键。** 官方文档从未说明省略 `key` 时平台代填什么；本地 miniflare 的
//      默认是**空串** ⇒ 省略 key 等于「所有请求共享一个桶」。显式传 CF-Connecting-IP，
//      本地与生产才走同一条路径，测试也才有判别力。
//   2. **缺 IP 头就放行，绝不拼空键。** 反面做法在「该头可被伪造」与「不可伪造」两种情形下都更糟：
//      全体无头请求落进同一个共享桶 = H5-H2 那场可用性事故换个入口复现。
//      反过来「放行」在两种情形下都不致命（可伪造 ⇒ 攻击者只绕过自己，不影响他人）。
//   3. **路径→桶是全路径白名单，不是前缀/后缀匹配。** `sign-in/email` 与 `sign-in/email/extra`
//      用 `startsWith` 会一起命中，而 Better Auth 的路由表将来加子路径时那是个静默扩权面。
//      漏配表现为「新端点默认不受限」（可接受，见 prd §3.2），误配才是不放行本该限的。
//   4. **三处降级一律放行（fail-open），不是 fail-closed。** 失效代价不对称：
//      少挡一层攻击者 « 全体用户登不进 —— 后者攻击者只需让 binding 触发异常即可主动制造。
//      三处都带告警日志，**这是它们可被接受的前提**（没日志的 fail-open 不可接受）。
//
// 表述纪律（design §7.1）：该 API 是**尽力而为的压制**（per-location、eventually consistent、
// 官方明写 "must not be used as an accurate accounting system"）。对外只能说「把无限次尝试压成
// 每 IP 每分钟有限次」，**不得**说「已防住爆破」—— 那是兑现不了也验证不了的承诺。
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/** 桶标识：credential = 凭据提交类；email = 匿名可打且会外发邮件 / 消耗外部资源的端点。 */
export type AuthRateLimitBucket = "credential" | "email";

/**
 * 完整请求路径 → 桶（**全路径**白名单）。
 * 已逐条比对 better-auth 1.7.1 的 `createAuthEndpoint(...)` 注册字面量，**不是按记忆写的**。
 * ⚠ `request-password-reset` **不是** `forget-password`（后者是前端方法名）——
 *   这类写错不报错、只是静默不限流，正是白名单匹配必须由 AC 覆盖的原因。
 * 未列入的一律 `null`（不限流）：`get-session` 是 SPA 每次加载都调的高频读、
 * `sign-out` / `update-user` / `change-password` 持会话（不是匿名攻击面）、
 * `callback/*` 锁死会把用户关在门外、`verify-email` 不外发邮件故不是放大面。
 */
const BUCKET_BY_PATH: ReadonlyMap<string, AuthRateLimitBucket> = new Map([
  // credential：10 次 / 60s / IP（档位在部署配置 [[ratelimits]] 改——wrangler.jsonc / 维护者 fork，不用改代码）
  ["/api/auth/sign-in/email", "credential"],
  ["/api/auth/sign-in/social", "credential"],
  // email：5 次 / 60s / IP —— 比 credential 更紧，因为每次命中都会真的发出邮件
  ["/api/auth/send-verification-email", "email"],
  ["/api/auth/request-password-reset", "email"],
  ["/api/auth/sign-up/email", "email"],
  // 批次 U（D30）：注册页邀请码预校验（GET /api/invites/validate，**匿名可打**）——
  // 不在 better-auth 路径表内（上面几条才是逐条比对 createAuthEndpoint 的产物）。
  // 按「凭据猜测」口径压进 credential 桶：复用 AUTH_CREDENTIAL_LIMIT binding ⇒ 零配置改动。
  // 与登录共享计数（校验 1 次 + 登录 ≤9 次每分钟）—— 副作用已由 prd D30 认可。
  ["/api/invites/validate", "credential"],
]);

/** 纯函数：请求路径落在哪个桶；不在白名单内则 `null`（导出供单测直接锁路径表）。 */
export function authRateLimitBucket(path: string): AuthRateLimitBucket | null {
  return BUCKET_BY_PATH.get(path) ?? null;
}

/** 桶 → 绑定名。策略不在代码里（workerd 的 `RateLimitOptions` 只有 `key` 字段）。 */
const BINDING_BY_BUCKET = {
  credential: "AUTH_CREDENTIAL_LIMIT",
  email: "AUTH_EMAIL_LIMIT",
} as const satisfies Record<AuthRateLimitBucket, keyof Pick<Env, "AUTH_CREDENTIAL_LIMIT" | "AUTH_EMAIL_LIMIT">>;

/**
 * 429 的 `Retry-After` 秒数，与配置的 `period = 60` 对齐。
 * **只是建议值**：binding 只返回 `{ success }` —— 没有剩余量、没有窗口相位，
 * 故任何带具体秒数的限流头都只能是编造的（prd D7：因此不设 `X-RateLimit-*`）。
 */
export const RETRY_AFTER_SECONDS = 60;

export const authRateLimit = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const bucket = authRateLimitBucket(c.req.path);
    if (bucket === null) {
      await next();
      return;
    }

    // 计数键 = 客户端 IP（文件头第 1 条）。同一请求经三个 custom domain（旧域转发）到同一个
    // Worker 时共用一个计数，这是期望行为（research §7 已闭环）。
    const ip = c.req.header("cf-connecting-ip");
    if (!ip) {
      c.get("logger").warn("auth_rate_limit_no_ip", { path: c.req.path, bucket });
      await next();
      return;
    }

    // ⚠ binding 缺席 = 限流**静默失效**。最可能的原因是 `[[ratelimits]]` 不继承、
    // `[env.*]` 段漏写（design §2.2）—— 那种状态在部署侧不报错。放行但必须喊出来，
    // 否则「线上登录没限流」是事后查不出来的。
    const binding = c.env[BINDING_BY_BUCKET[bucket]];
    if (!binding) {
      c.get("logger").error("auth_rate_limit_binding_missing", { path: c.req.path, bucket });
      await next();
      return;
    }

    let outcome: RateLimitOutcome;
    try {
      outcome = await binding.limit({ key: ip });
    } catch (err) {
      // 文件头第 4 条。注意**不能依赖生产一定抛**（模拟器抛、文档未写），这条分支是防御性的。
      c.get("logger").error("auth_rate_limit_error", {
        path: c.req.path,
        bucket,
        err: String(err),
      });
      await next();
      return;
    }

    if (!outcome.success) {
      c.get("logger").warn("auth_rate_limit_exceeded", { path: c.req.path, bucket });
      c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      // body 与代理面限流（src/routes/v1/rate-limit.ts）保持同一形态，前端错误处理不用分叉。
      return c.json(
        { error: { message: "Rate limit exceeded. Please slow down and try again later." } },
        429,
      );
    }

    await next();
  };
};
