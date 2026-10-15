// 双域名分流（09-21-dual-domain-split）。
//
// 形态：同一 Worker 绑多个 custom domain —— 管理台域（BETTER_AUTH_URL 派生：/api/* + SPA 深链）
// 与公开 API 域（API_DOMAIN：/v1、/anthropic）。两域都在部署配置里声明（wrangler.jsonc /
// 维护者 wrangler.prod.jsonc）；部署方还可把**任意旧域名**继续绑到本 Worker —— "host 不属于两类
// 新域"一律按路径转发（下文第 1 条），旧 base_url 零改动继续可用。
// 本中间件按请求 Host 分流：命中本侧就放行，越界就重定向到对侧域名。
//
// 挂载位（src/index.ts）：requestContext 之后、zod 统一中间件之前 —— 分流是路由层关注点，
// 越早越好，且 301/308 不应进入"400 响应重写"路径。
//
// 三条**刻意**行为，改代码前先读完（否则会把它们当 bug 修掉）：
//   1. **无法归类的 host 按路径转发**（不是透传、也不是 404）。能到达本 Worker 的 host 只有
//      routes 里声明过的，故"host 既不是 api 域也不是平台域"恰好等价于"是别名/旧域"——
//      部署方保留绑定的旧域名与 `<worker>.<subdomain>.workers.dev` 都落进这条。
//      把 workers.dev 转发到 canonical 域比抛 1016（无路由）错误**友好**，是期望行为。
//   2. **`/api/health` 在所有 host 上都放行**（含别名域）。它是 Worker 自身的存活探针
//      （见 src/index.ts，**不触达 DB**），把监控打到 api 域拿到 301 是运维陷阱。
//      这是对"api 域只服务 /v1 与 /anthropic"的刻意例外，不泄漏任何管理面能力。
//   3. **非 GET/HEAD 用 308 而非 301**：301 会让客户端把 POST 降级为 GET 并**丢弃请求体**
//      （用户拿到一张 HTML，看不出错在哪）。308 同样是永久重定向，但保留方法与 body。
//
// 目标域一律由**本环境**的配置派生（`resolveDomainConfig`）—— 代码里**不得**写死任何域名：
// 写死的话其他部署（fork/环境）会被跳到写死的那家域名（单元测试专抓这一条）。
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import { isApiPath, isLoopbackHost, resolveDomainConfig } from "../lib/domains";

/** 存活探针路径：所有 host 放行（见文件头第 2 条）。 */
const HEALTH_PATH = "/api/health";

export const domainSplit = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const { apiDomain, platformDomain } = resolveDomainConfig(c.env);

    // 关闭条件 1：未配置公开 API 域 ⇒ 分流整体关闭（**本地 dev 与今日完全一致**）。
    // 关闭条件 2：平台域无法从 BETTER_AUTH_URL 派生 ⇒ 目标域不可知，同样关闭。
    // 两者都是 fail-open 到"今天的单域名行为"，不制造新的失败模式。
    if (!apiDomain || !platformDomain) {
      await next();
      return;
    }

    const url = new URL(c.req.url);
    const host = url.hostname.toLowerCase();
    const path = c.req.path;

    // 关闭条件 3：环回 host（本地 dev / 本地验证脚本）。本地 .dev.vars 覆盖 API_DOMAIN 演练分流时
    // 该值是真公网域名 —— 不挡掉的话 `http://localhost:5173/v1/...` 会被 301 到线上。
    if (isLoopbackHost(host)) {
      await next();
      return;
    }

    if (path === HEALTH_PATH) {
      await next();
      return;
    }

    const apiPath = isApiPath(path);

    if (host === apiDomain) {
      // api 域：放行 /v1、/anthropic；其余（含 /api/*、SPA 路径）回管理台域。
      if (apiPath) {
        await next();
        return;
      }
      return redirectTo(c, url, platformDomain);
    }

    if (host === platformDomain) {
      // 管理台域：放行其余全部（含 SPA 静态资源与深链）；/v1、/anthropic 去 api 域。
      if (!apiPath) {
        await next();
        return;
      }
      return redirectTo(c, url, apiDomain);
    }

    // 别名/旧域/任意无关 host ⇒ 按路径转发到对应新域（文件头第 1 条，**刻意行为**）。
    // 目标域取本环境配置：绑到本 Worker 的旧域只会转发到本环境自己的两个新域。
    return redirectTo(c, url, apiPath ? apiDomain : platformDomain);
  };
};

/**
 * 重定向到 `https://<domain><path><query>`：保留 path 与 query，目标一律 https。
 * 状态码按方法选择（文件头第 3 条）：GET/HEAD → 301，其余 → 308。
 */
function redirectTo(c: Context<AppEnv>, url: URL, domain: string): Response {
  const status = c.req.method === "GET" || c.req.method === "HEAD" ? 301 : 308;
  return c.redirect(`https://${domain}${url.pathname}${url.search}`, status);
}
