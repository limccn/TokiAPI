// 09-28-auth-rate-limit-fix：`/api/auth/*` 认证面限流（F1 修复）判别性测试。
//
// ⚠ **本文件证明的是「接线正确」，不是「生产恰好放行 N 次」**：
//   本地 miniflare 的限流器是 SQLite 背书的 Durable Object，**精确串行**、超限真返回
//   `success:false`；生产侧官方定位是 **permissive, eventually consistent**（"must not be used
//   as an accurate accounting system"），并发突发下**允许多放**。
//   ⇒ 下面的「第 11 次必 429」在本地成立，**不得**据此在交付说明里宣称生产有硬上限
//   （表述纪律见 design §7.1）。
//
// 两条设计上的取证纪律：
//   1. **每个用例一个专属假 IP**。`reset()` 是否逐用例清理计数器属于 vitest-pool-workers 的
//      行为，不该由本任务的正确性担保；独立 IP 把「用例互相污染」整类失败排除在外。
//   2. **AC1/AC2 成对、AC4 用同 IP**。只有 AC1 会被「全局计数器」实现蒙混过关；
//      AC4 若按 AC 原文取「新 IP」，任何实现（含单一共享计数器）都满足 ⇒ 那是恒真假绿。
//      故 AC4 同时断言同 IP 变体（判别力在此）。
//   3. **突发一律打 2×limit+1 次**。固定窗口的边界相位对测试不可见：11 连发约有 1–2%
//      概率恰好跨过 60s 边界（两个窗口各放行 limit 次 ⇒ 零 429 ⇒ 假红，实测出现过）。
//      2×limit+1 保证**无论是否跨界都必然撞出至少一个 429**；「恰好第 limit+1 次转 429」
//      这条强断言只在确认未跨界的常见路径上追加（AC1）。
//
// 档位常量与 wrangler.jsonc 的 [[ratelimits]] 由 tests/config-fork.test.ts 的
// 「[[ratelimits]] 结构契约」钉住；两处必须一起改。
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, selfFetch } from "./helpers";
import { authRateLimitBucket, RETRY_AFTER_SECONDS } from "../src/middleware/auth-rate-limit";

/** 凭据类桶的 limit（wrangler.jsonc AUTH_CREDENTIAL_LIMIT.simple.limit）。 */
const CREDENTIAL_LIMIT = 10;
/** 邮件类桶的 limit（wrangler.jsonc AUTH_EMAIL_LIMIT.simple.limit）。 */
const EMAIL_LIMIT = 5;

/** 假 IP：文档保留段 203.0.113.0/24（RFC 5737），逐用例递增。 */
const IP_A = "203.0.113.1";
const IP_B = "203.0.113.2";
const IP_C = "203.0.113.3";
const IP_D = "203.0.113.4";
const IP_E = "203.0.113.5";
const IP_F = "203.0.113.6";
const IP_G = "203.0.113.7";

const PROBE_EMAIL = "ratelimit-probe@test.dev";

beforeAll(async () => {
  await applyMigrations();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 打受保护端点；`ip` 省略 = **不带** cf-connecting-ip 头（AC5 用）。 */
async function authPost(
  path: string,
  body: unknown,
  ip?: string,
  method = "POST",
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip !== undefined) {
    headers["cf-connecting-ip"] = ip;
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = JSON.stringify(body);
  }
  return selfFetch(`http://localhost${path}`, init);
}

/** 凭据类端点：口令错误 ⇒ 认证层自己返回 401（与限流无关，我们只看是不是 429）。 */
function signIn(ip?: string): Promise<Response> {
  return authPost(
    "/api/auth/sign-in/email",
    { email: PROBE_EMAIL, password: "wrong-password-123" },
    ip,
  );
}

/** 邮件类端点：找回密码。邮箱不存在时静默 200，且 RESEND_API_KEY 为空 ⇒ 零外发、零 D1 写入。 */
function requestPasswordReset(ip?: string): Promise<Response> {
  return authPost("/api/auth/request-password-reset", { email: PROBE_EMAIL }, ip);
}

/** 收集 worker 结构化日志里指定 message 的条数（logger 的 warn/info 走 console.log、error 走 console.error）。 */
function countLogs(spy: { mock: { calls: unknown[][] } }, message: string): number {
  return spy.mock.calls.filter((call) => {
    try {
      return (JSON.parse(String(call[0])) as { message?: string }).message === message;
    } catch {
      return false;
    }
  }).length;
}

/** 对同一端点连发 n 个请求（突发断言统一 2×limit+1，见文件头纪律 3）。 */
async function burst(req: () => Promise<Response>, n: number): Promise<Response[]> {
  const responses: Response[] = [];
  for (let i = 0; i < n; i++) {
    responses.push(await req());
  }
  return responses;
}

describe("authRateLimitBucket — 路径→桶映射（纯函数）", () => {
  it("五条受保护路径各自落桶（credential 2 条 / email 3 条）", () => {
    expect(authRateLimitBucket("/api/auth/sign-in/email")).toBe("credential");
    expect(authRateLimitBucket("/api/auth/sign-in/social")).toBe("credential");
    expect(authRateLimitBucket("/api/auth/send-verification-email")).toBe("email");
    expect(authRateLimitBucket("/api/auth/request-password-reset")).toBe("email");
    expect(authRateLimitBucket("/api/auth/sign-up/email")).toBe("email");
  });

  it("批次 U（D30）：/api/invites/validate 落 credential 桶（复用 AUTH_CREDENTIAL_LIMIT，零 toml 改动）", () => {
    expect(authRateLimitBucket("/api/invites/validate")).toBe("credential");
  });

  it("未列举端点一律 null（不限流也不耗配额）", () => {
    for (const path of [
      "/api/auth/get-session",
      "/api/auth/sign-out",
      "/api/auth/update-user",
      "/api/auth/change-password",
      "/api/auth/verify-email",
      "/api/auth/callback/github",
      // 关键的反例：write 路径里真实存在的是 request-password-reset，
      // forget-password 只是**前端方法名** —— 写成它会静默失效，故这里显式钉住它不命中。
      "/api/auth/forget-password",
    ]) {
      expect(authRateLimitBucket(path)).toBeNull();
    }
  });

  it("**全路径**匹配：前缀/后缀相似的路径不命中（防 startsWith 式静默扩权）", () => {
    for (const path of [
      "/api/auth/sign-in/email/extra",
      "/api/auth/sign-in/email2",
      "/api/auth/sign-in",
      "/api/auth/sign-up/email/verify",
      "/api/auth/",
      "/api/auth",
    ]) {
      expect(authRateLimitBucket(path)).toBeNull();
    }
  });
});

describe("/api/auth/* 限流行为", () => {
  it("AC1 同源超限：第 1..10 次非 429、随后必有 429", async () => {
    const t0 = Date.now();
    const statuses = (await burst(() => signIn(IP_A), 2 * CREDENTIAL_LIMIT + 1)).map((r) => r.status);
    // 不变式（对窗口边界鲁棒，无条件断言）：新桶的前 limit 次必过；
    // 首个 429 不得早于第 limit+1 次（indexOf 对「零 429」返 -1，同样变红 ⇒ 恒成功变异被挡）。
    expect(statuses.slice(0, CREDENTIAL_LIMIT)).not.toContain(429);
    expect(statuses.indexOf(429)).toBeGreaterThanOrEqual(CREDENTIAL_LIMIT);
    // 强断言（仅常见路径）：未跨窗口边界时，恰在第 limit+1 次转 429，且 429 恰好 limit+1 个。
    if (Math.floor(t0 / 60_000) === Math.floor(Date.now() / 60_000)) {
      expect(statuses[CREDENTIAL_LIMIT]).toBe(429);
      expect(statuses.filter((s) => s === 429)).toHaveLength(CREDENTIAL_LIMIT + 1);
    }
  });

  it("AC2 换源不共享（AC1 的判别配对）：IP_A 耗尽后换 IP 打满限额次 ⇒ 全部非 429", async () => {
    // ⚠ 判据口径：这里只打**恰好 limit 次**，不能打 limit+1 —— 新 IP 是**新桶**，
    // 第 limit+1 次会撞它自己的限额（那不是「共享」，是 per-IP 语义本身）。
    // 判别力在：若实现是「全局计数器」（M2 变异），IP_A 已把计数抬到 11 ⇒ 这里的第 1 次就 429。
    const statuses: number[] = [];
    for (let i = 0; i < CREDENTIAL_LIMIT; i++) {
      statuses.push((await signIn(IP_B)).status);
    }
    expect(statuses).not.toContain(429);
  });

  it("AC3 未列举端点不受限：get-session 打到远超限额仍非 429（防映射退化成前缀匹配）", async () => {
    // 21 = 2×limit+1：即使映射被变异成前缀匹配（get-session 落进桶），两个窗口合计
    // 最多放行 2×limit ⇒ 必然撞出 429 ⇒ 这条「不受限」断言对窗口相位鲁棒地变红。
    const statuses = (await burst(() => authPost("/api/auth/get-session", {}, IP_C, "GET"), 2 * CREDENTIAL_LIMIT + 1))
      .map((r) => r.status);
    expect(statuses).not.toContain(429);
  });

  it("AC4 类别隔离：邮件桶打满后，**同 IP** 的凭据端点仍可用 ⇒ 两类是独立 binding", async () => {
    // 11 = 2×email limit+1 ⇒ 即使跨窗口边界也必有 ≥1 个 429（前置信号不因窗口相位假红）。
    const emailStatuses = (await burst(() => requestPasswordReset(IP_D), 2 * EMAIL_LIMIT + 1)).map((r) => r.status);
    // 前置信号：邮件桶确实在限（否则本例会因「压根没限流」而假绿）。
    // 「首个 429 不早于第 limit+1 次」同时钉住邮件档位真的比凭据类更紧。
    expect(emailStatuses.indexOf(429)).toBeGreaterThanOrEqual(EMAIL_LIMIT);

    // 判别力在这一条：**同一个 IP**，若两个桶共用计数器/命名空间，这里必 429。
    expect((await signIn(IP_D)).status).not.toBe(429);
    // AC 原文的「新 IP」变体：任何实现都满足（含单一共享计数器），保留以对齐 AC 文本。
    expect((await signIn(IP_E)).status).not.toBe(429);
  });

  it("AC5 缺 IP 头放行：连打 21 次全部非 429，且确实走进了「无 IP」分支", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // 21 = 2×limit+1：若缺头请求被拼进同一个共享键（M4' 变异），两个窗口合计也放不下
    // 21 次 ⇒ 必然撞出 429 ⇒ 下面的 not.toContain 对窗口相位鲁棒地变红。
    const attempts = 2 * CREDENTIAL_LIMIT + 1;
    const statuses = (await burst(() => signIn(), attempts)).map((r) => r.status);
    expect(statuses).not.toContain(429);
    // 正向信号：证明请求头真的缺席（否则本例可能只是「限额还没到」的假绿），
    // 同时把「不得拼空键落进共享桶」这条纪律钉住。
    expect(countLogs(logSpy, "auth_rate_limit_no_ip")).toBe(attempts);
  });

  it("AC6 binding 缺席不致命：请求正常返回，且走的是「binding 缺席」分支而非异常兜底", async () => {
    const original = env.AUTH_CREDENTIAL_LIMIT;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      env.AUTH_CREDENTIAL_LIMIT = undefined;
      const res = await signIn(IP_F);
      // 到达了认证层（口令错误的 401），不是 500、也不是 429
      expect(res.status).toBe(401);
      expect(res.headers.get("Retry-After")).toBeNull();
      // ⚠ 判别力在此：删掉缺席守卫后代码会抛 TypeError 并落进 catch，日志变成
      // auth_rate_limit_error ⇒ 只断言「非 429」的话这条 AC 就是恒真假绿。
      expect(countLogs(errSpy, "auth_rate_limit_binding_missing")).toBe(1);
      expect(countLogs(errSpy, "auth_rate_limit_error")).toBe(0);
    } finally {
      env.AUTH_CREDENTIAL_LIMIT = original;
    }
  });

  it("AC7 429 响应形态：429 + Retry-After（advisory）+ {error:{message}}，且无 X-RateLimit-*", async () => {
    // 21 = 2×limit+1 ⇒ 无论窗口相位如何必有 ≥1 个 429，取第一个做形态断言。
    const responses = await burst(() => signIn(IP_G), 2 * CREDENTIAL_LIMIT + 1);
    const found = responses.find((r) => r.status === 429);
    expect(found).toBeDefined();
    const limited = found as Response;
    expect(limited.status).toBe(429);

    const retryAfter = limited.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    // advisory 值：允许 ≥ 真实剩余，**不得小于**真实剩余。真实剩余无从得知（binding 不返回
    // 计数），故此处只钉住「与配置的 period 对齐」这一个可验证的性质。
    expect(Number(retryAfter)).toBe(RETRY_AFTER_SECONDS);
    // 绝不伪造 remaining —— binding 只返回 { success }，没有任何真实余量可报。
    expect(limited.headers.get("X-RateLimit-Remaining")).toBeNull();
    expect(limited.headers.get("X-RateLimit-Limit")).toBeNull();

    // 与代理面限流（src/routes/v1/rate-limit.ts）同一形态，前端错误处理不用分叉。
    const body = (await limited.json()) as { error?: { message?: string } };
    expect(typeof body.error?.message).toBe("string");
    expect(body.error?.message).toContain("Rate limit exceeded");
  });
});
