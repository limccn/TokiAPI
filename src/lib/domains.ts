// 双域名分流的域名解析（09-21-dual-domain-split）。
//
// 一处真源：本模块是「本环境的平台域 / 公开 API 域分别是哪个 host」的**唯一**解析点 ——
// src/middleware/domain-split.ts（按 Host 分流与越界互跳）与 src/index.ts 的 `GET /api/config`
// （运行期下发给前端）都从这里取，避免两处各解析一遍后漂移。
//
// 两个 domain 的来源刻意不同：
//   - apiDomain      ← `[vars] API_DOMAIN`（显式声明；未配置 ⇒ 分流整体关闭）
//   - platformDomain ← `BETTER_AUTH_URL` **派生**（不新增 PLATFORM_DOMAIN token：BETTER_AUTH_URL
//     已经是"本环境管理台 origin"的真源，多一个就是第三个真源，必然漂移）
// 各部署各自成立：谁的部署谁派生自己的平台域（BETTER_AUTH_URL 指向谁，平台域就是谁）。

/** 只取需要的两个键 —— 使本模块可同时用于 worker 的 `Env`、测试的 `Cloudflare.Env` 与纯字面量。 */
export interface DomainEnv {
  /** 公开 API 域（管理台域之外的另一个 custom domain；未配置或为空 = 未启用分流）。 */
  API_DOMAIN?: string;
  /** 管理台 origin（Better Auth 站点 URL）；平台域由它的 hostname 派生。 */
  BETTER_AUTH_URL?: string;
}

export interface DomainConfig {
  /** 公开 API 域 hostname（已小写化）；null = 未配置 ⇒ 分流关闭。 */
  apiDomain: string | null;
  /** 管理台域 hostname（已小写化）；null = BETTER_AUTH_URL 缺失/非法。 */
  platformDomain: string | null;
}

function normalizeHost(raw: string | undefined): string | null {
  const value = raw?.trim();
  // 空串视为未配置（运行时不该假设配置一定合法）
  return value ? value.toLowerCase() : null;
}

/** 解析 BETTER_AUTH_URL → URL；缺失/非法返回 null（调用方各自决定回落形态）。 */
function parseAuthUrl(raw: string | undefined): URL | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function resolveDomainConfig(env: DomainEnv): DomainConfig {
  const parsed = parseAuthUrl(env.BETTER_AUTH_URL);
  return {
    apiDomain: normalizeHost(env.API_DOMAIN),
    platformDomain: parsed ? normalizeHost(parsed.hostname) : null,
  };
}

/**
 * API 面路径（公开代理：OpenAI 兼容面 + Anthropic 兼容面）。
 *
 * 前缀必须后接 `/` 或行尾 —— 刻意**不是**裸的 `startsWith("/v1")`：那样 `/v1alpha` 会在两个
 * 域名之间来回弹（api 域判"越界"→ 回管理台域；管理台域判"API 面"→ 回 api 域），客户端看到的是
 * 无限重定向。两侧共用**同一个判据**是"不会形成重定向环"的结构保证（见域分流中间件的注释）。
 */
export function isApiPath(path: string): boolean {
  return /^\/v1(\/|$)/.test(path) || /^\/anthropic(\/|$)/.test(path);
}

/**
 * 环回 host（本地 dev / 本地验证脚本）。
 *
 * 为什么必须显式挡掉：本地 .dev.vars 可覆盖 API_DOMAIN（在本地演练公网域分流）—— 那样
 * `http://localhost:5173/v1/...` 若不挡掉就会被 301 到**公网** api 域（本地验证脚本会打到线上）。
 * 环回地址不可能是任何 canonical 域，也不可能是需要转发的别名，故永不分流。
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1).toLowerCase()
    : host.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/**
 * 请求 origin 是否来自环回 host（判据与中间件的环回例外**同源**，见 `isLoopbackHost`）。
 * 无法解析的 origin 一律按"非环回"处理 —— 那是配置错误，不该被静默降级成本地地址。
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * 公开 API 域的 base URL（**不带 `/v1` 后缀**：调用方按 `${apiBaseUrl}${basePath}` 拼接）。
 *
 * **环回例外（必须先于配置取值判定）**：请求来自环回 host 时一律回落请求 origin。
 * 为什么必须与中间件同一条判据：本地 .dev.vars 可覆盖 API_DOMAIN 演练分流，而中间件恰恰
 * 因环回例外**放行了**本地的 `/v1`（否则本地验证脚本会打到线上）。两处若不同步：本地 dev
 * server 自己服务着 `/v1`，下发的 base URL 却是**生产**网关地址 —— 管理台 Quick start
 * 卡把生产域展示给正在调试的人，复制即打到线上、真计费，而本地那把 key 在生产根本不存在。
 * 判据落在**请求** origin 上（不是配置值上）：同一份配置被环回与非环回请求各问一次，答案本就该不同。
 */
export function apiBaseUrl(env: DomainEnv, fallbackOrigin: string): string {
  if (isLoopbackOrigin(fallbackOrigin)) return fallbackOrigin;
  const { apiDomain } = resolveDomainConfig(env);
  return apiDomain ? `https://${apiDomain}` : fallbackOrigin;
}

/**
 * 管理台 base URL（取 BETTER_AUTH_URL 的 origin —— 保留 scheme 与端口，本地即 http://localhost:5173）。
 *
 * **刻意不加环回例外**（与 `apiBaseUrl` 的非对称是有理由的，别"顺手补对称"）：`BETTER_AUTH_URL`
 * 是"本环境管理台 origin"的**权威声明**，本地那份值本来就是 `http://localhost:5173`；
 * 而 `API_DOMAIN` 是"公网 API 域"，本地只在演练分流时才覆盖它（值本就不是给本地服务的）
 * —— 需要例外的正是"本地值不本地"的那一个。若这里也回落，反而会掩盖 `BETTER_AUTH_URL`
 * 配错（配成公网域时本地 dev 根本不该能用）。
 */
export function platformBaseUrl(env: DomainEnv, fallbackOrigin: string): string {
  const parsed = parseAuthUrl(env.BETTER_AUTH_URL);
  return parsed ? parsed.origin : fallbackOrigin;
}
