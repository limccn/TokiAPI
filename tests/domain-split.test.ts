// 双域名分流单测（09-21-dual-domain-split；AC-B1..AC-B9 + R-B8/R-B11/R-B13 的规则面）。
//
// 驱动方式：`selfFetch` 直接构造带 host 的 Request —— URL 里的 host 就是分流中间件读的 Host。
// 环境维度靠 helpers 的 withSwitch("API_DOMAIN") / withBetterAuthUrl() 逐用例翻转：
// vitest.config.ts 把 `API_DOMAIN` **pin 成 ""（= 未配置 ⇒ 分流整体关闭）**，故既有用例零影响；
// 本文件逐例翻成真实域名来覆盖规则。
//
// ⚠️ **本文件一律用 `fetchManual`（redirect: "manual"）而不是裸 `selfFetch`**：
// `exports.default.fetch()` 走的是**运行时子请求**（不是同 isolate 的直呼），fetch 的缺省
// `redirect: "follow"` 会**静默跟随** 301/308 —— 测试环境里所有 host 都落在同一个 worker 上，
// 于是跟随后的请求正好打到目标域并通过校验，拿到的是"跟随后的最终响应"（401/200）。
// 症状极具误导性：看起来像"中间件根本没生效"，实为断言对象错了（2026-09-22 实测踩过）。
// 反过来，跟随后拿到 401/200 也说明**重定向不成环**（见文件末尾那条 follow 用例）。
//
// **本文件刻意只用两套配置**（PROD / STG，值与真实环境逐字一致）：断言目标域时写"本环境的域名"
// 而不是某个固定字面量 —— 中间件若把目标域写死成 prod 域名，stg 那组断言立刻变红（AC-B9 的
// 判别性就来自这里）。这与 stg 一验就现形的那类错误是同一个判据。
import { describe, expect, it } from "vitest";
import { selfFetch, withBetterAuthUrl, withSwitch } from "./helpers";

/** 重定向状态码（含 302/303/307 —— 断言"不是重定向"时不能只排 301/308）。 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** 不跟随重定向的 selfFetch（文件头说明为什么必须有这一层）。 */
function fetchManual(input: string, init: RequestInit = {}): Promise<Response> {
  return selfFetch(input, { redirect: "manual", ...init });
}

/** 重定向目标（非重定向返回 null —— 用于「到达业务处理」这类反向断言）。 */
function redirectTarget(res: Response): string | null {
  return REDIRECT_STATUSES.has(res.status) ? (res.headers.get("Location") ?? "") : null;
}

interface DomainConfig {
  /** 公开 API 域（翻 `API_DOMAIN`）。 */
  apiDomain: string;
  /** 管理台域 origin（翻 `BETTER_AUTH_URL`；分流的平台域由它派生）。 */
  betterAuthUrl: string;
}

/** 两套线上形态的**夹具配置**（stg 脚手架拆除后保留：分流断言的判别力靠两套域名两两不等）。 */
const PROD: DomainConfig = {
  apiDomain: "api.lmlh.net",
  betterAuthUrl: "https://platform.lmlh.net",
};
const STG: DomainConfig = {
  apiDomain: "stg-api.lmlh.net",
  betterAuthUrl: "https://stg-platform.lmlh.net",
};
/**
 * **本地 dev 的真实形态**（不是 `withSplitDisabled`）：本地 `.dev.vars` 可给 `API_DOMAIN`
 * 一个真公网域名（在本地演练分流），只有 `BETTER_AUTH_URL` 是 localhost。
 * 这一套配置是环回例外存在的原因，也是它必须覆盖**下发路径**的原因（见 AC-B9 的环回用例）。
 */
const LOCAL_DEV: DomainConfig = {
  apiDomain: "api.lmlh.net",
  betterAuthUrl: "http://localhost:5173",
};

/** 在给定环境配置下跑一段（两层 try/finally 还原；嵌套顺序无关，两者都会还原）。 */
async function withDomains<T>(cfg: DomainConfig, fn: () => Promise<T>): Promise<T> {
  return withBetterAuthUrl(cfg.betterAuthUrl, () =>
    withSwitch("API_DOMAIN", cfg.apiDomain, fn),
  );
}

/** **未配置** API_DOMAIN 时的形态（vitest pin 值即是 —— 也即本地 dev / 今日行为）。 */
function withSplitDisabled<T>(fn: () => Promise<T>): Promise<T> {
  return withBetterAuthUrl("http://localhost:5173", () => withSwitch("API_DOMAIN", "", fn));
}

// ============================================================ 关闭态（R-B8）

describe("R-B8 未配置 API_DOMAIN ⇒ 分流整体关闭", () => {
  it("任意 host 上的 /v1、/api/*、SPA 路径都不被重定向（与今日完全一致）", async () => {
    await withSplitDisabled(async () => {
      // api 域这个名字本身不特殊（未配置就是未配置）——不能因为 host 长得像 api 域就分流
      const api = await fetchManual("https://api.lmlh.net/api/keys");
      expect(redirectTarget(api)).toBeNull();
      expect(api.status).toBe(401); // requireSession

      const v1 = await fetchManual("https://api.lmlh.net/v1/models");
      expect(redirectTarget(v1)).toBeNull();
      expect(v1.status).toBe(401); // gatewayAuth

      const spa = await fetchManual("https://platform.lmlh.net/usage");
      expect(redirectTarget(spa)).toBeNull();
      expect(spa.status).toBe(200); // ASSETS 回退 index.html
    });
  });
});

// ============================================================ API 域侧（AC-B1 / AC-B2）

describe("AC-B1/B2 api 域：放行 API 面、越界回管理台域", () => {
  it("AC-B1 /v1/* 与 /anthropic/* 到达业务处理（非重定向）", async () => {
    await withDomains(PROD, async () => {
      const models = await fetchManual("https://api.lmlh.net/v1/models");
      expect(redirectTarget(models)).toBeNull();
      expect(models.status).toBe(401); // 无网关 key：业务侧鉴权，不是重定向

      const anthropic = await fetchManual("https://api.lmlh.net/anthropic/v1/messages", {
        method: "POST",
      });
      expect(redirectTarget(anthropic)).toBeNull();
      expect(anthropic.status).toBe(401);
    });
  });

  it("AC-B2 根路径与 /api/* 越界 ⇒ 301 到管理台域（path + query 原样保留）", async () => {
    await withDomains(PROD, async () => {
      const root = await fetchManual("https://api.lmlh.net/");
      expect(root.status).toBe(301);
      expect(root.headers.get("Location")).toBe("https://platform.lmlh.net/");

      const api = await fetchManual("https://api.lmlh.net/api/keys?limit=1&offset=2");
      expect(api.status).toBe(301);
      expect(api.headers.get("Location")).toBe(
        "https://platform.lmlh.net/api/keys?limit=1&offset=2",
      );
    });
  });

  it("AC-B2 任意 SPA 路径（深链）同样越界 ⇒ 301 到管理台域", async () => {
    await withDomains(PROD, async () => {
      const res = await fetchManual("https://api.lmlh.net/keys");
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://platform.lmlh.net/keys");
    });
  });

  it("R-B12 /api/health 在 api 域上放行（刻意例外：Worker 存活探针）", async () => {
    await withDomains(PROD, async () => {
      const res = await fetchManual("https://api.lmlh.net/api/health");
      expect(redirectTarget(res)).toBeNull();
      expect(res.status).toBe(200);
    });
  });
});

// ============================================================ 平台域侧（AC-B3 / AC-B4 / AC-B5）

describe("AC-B3/B4/B5 管理台域：放行管理面与 SPA、API 面去 api 域", () => {
  it("AC-B3 /api/* 与 SPA 深链行为与今日逐一致（关/开两态同码）", async () => {
    const paths = ["/api/keys", "/api/health", "/usage", "/keys"];
    for (const path of paths) {
      const today = await withSplitDisabled(() =>
        fetchManual(`https://platform.lmlh.net${path}`),
      );
      const split = await withDomains(PROD, () =>
        fetchManual(`https://platform.lmlh.net${path}`),
      );
      expect(redirectTarget(split), `${path} 不应被重定向`).toBeNull();
      expect({ path, status: split.status }).toEqual({ path, status: today.status });
    }
  });

  it("AC-B3 /api/health 在管理台域返回 200", async () => {
    await withDomains(PROD, async () => {
      const res = await fetchManual("https://platform.lmlh.net/api/health");
      expect(res.status).toBe(200);
    });
  });

  it("AC-B4 /v1/* 与 /anthropic* ⇒ 301 到 api 域（path + query 保留）", async () => {
    await withDomains(PROD, async () => {
      const v1 = await fetchManual("https://platform.lmlh.net/v1/models");
      expect(v1.status).toBe(301);
      expect(v1.headers.get("Location")).toBe("https://api.lmlh.net/v1/models");

      const anthropic = await fetchManual(
        "https://platform.lmlh.net/anthropic/v1/messages?beta=1",
      );
      expect(anthropic.status).toBe(301);
      expect(anthropic.headers.get("Location")).toBe(
        "https://api.lmlh.net/anthropic/v1/messages?beta=1",
      );
    });
  });

  it("AC-B5 非 GET/HEAD ⇒ 308（301 会把 POST 降级为 GET 并丢弃 body）", async () => {
    await withDomains(PROD, async () => {
      const post = await fetchManual("https://platform.lmlh.net/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.6-sol", messages: [] }),
      });
      expect(post.status).toBe(308);
      expect(post.headers.get("Location")).toBe("https://api.lmlh.net/v1/chat/completions");

      // 成对断言的判别性 = 同一条路径只因方法不同就换状态码（否则"永远是 308"也能骗过上面那条）
      const get = await fetchManual("https://platform.lmlh.net/v1/chat/completions");
      expect(get.status).toBe(301);
      expect(get.headers.get("Location")).toBe("https://api.lmlh.net/v1/chat/completions");

      const head = await fetchManual("https://platform.lmlh.net/v1/models", { method: "HEAD" });
      expect(head.status).toBe(301);
    });
  });
});

// ============================================================ 别名 / 旧域转发（AC-B7）
//
// 旧域 router.lmlh.net / stg-router.lmlh.net 已于 2026-10-16 退役（route 摘除 + DNS 删除）。
// 下面用例把它们作**合成夹具 host** 保留（fetchManual 自取响应，不走 DNS）——中间件的
// 「未知 host 按路径转发」行为与任何具体域名无关，域名只提供判别力（两两不等）。

describe("AC-B7 别名/旧域/无关 host 按路径转发（刻意行为）", () => {
  it("stg 旧域 stg-router.lmlh.net（2026-10-16 已退役的合成夹具）：API 面 → stg-api，其余 → stg-platform", async () => {
    await withDomains(STG, async () => {
      const v1 = await fetchManual("https://stg-router.lmlh.net/v1/models");
      expect(v1.status).toBe(301);
      expect(v1.headers.get("Location")).toBe("https://stg-api.lmlh.net/v1/models");

      const login = await fetchManual("https://stg-router.lmlh.net/login");
      expect(login.status).toBe(301);
      expect(login.headers.get("Location")).toBe("https://stg-platform.lmlh.net/login");

      const post = await fetchManual("https://stg-router.lmlh.net/v1/chat/completions", {
        method: "POST",
      });
      expect(post.status).toBe(308);
      expect(post.headers.get("Location")).toBe(
        "https://stg-api.lmlh.net/v1/chat/completions",
      );
    });
  });

  // prod 的旧域与 stg 同构（router.lmlh.net 为**夹具旧域**，2026-10-16 已退役）：
  // 绑到本 Worker 的旧域名上，旧 base_url / 书签零改动继续可用
  // （poster 用 308 保住方法与 body；SDK 跟随重定向后拿到的仍是业务响应）。
  it("prod 旧域 router.lmlh.net（2026-10-16 已退役的合成夹具）：API 面 → api，其余 → platform", async () => {
    await withDomains(PROD, async () => {
      const v1 = await fetchManual("https://router.lmlh.net/v1/models");
      expect(v1.status).toBe(301);
      expect(v1.headers.get("Location")).toBe("https://api.lmlh.net/v1/models");

      const login = await fetchManual("https://router.lmlh.net/login");
      expect(login.status).toBe(301);
      expect(login.headers.get("Location")).toBe("https://platform.lmlh.net/login");

      const post = await fetchManual("https://router.lmlh.net/v1/chat/completions", {
        method: "POST",
      });
      expect(post.status).toBe(308);
      expect(post.headers.get("Location")).toBe("https://api.lmlh.net/v1/chat/completions");
    });
  });

  it("任意无关 host（如 example.com）同样走转发规则，**不透传** —— workers.dev 同理", async () => {
    await withDomains(STG, async () => {
      const v1 = await fetchManual("https://example.com/v1/models");
      expect(v1.status).toBe(301);
      expect(v1.headers.get("Location")).toBe("https://stg-api.lmlh.net/v1/models");

      const login = await fetchManual("https://example.com/login");
      expect(login.status).toBe(301);
      expect(login.headers.get("Location")).toBe("https://stg-platform.lmlh.net/login");
    });
  });

  it("R-B12 别名域上的 /api/health 也放行（200）", async () => {
    await withDomains(STG, async () => {
      const res = await fetchManual("https://stg-router.lmlh.net/api/health");
      expect(redirectTarget(res)).toBeNull();
      expect(res.status).toBe(200);
    });
  });
});

// ============================================================ AC-B8 / AC-B9：两套配置各自的目标域

describe("AC-B8 stg 分流可用（同一份代码、stg 的配置）", () => {
  it("两侧放行：stg-platform 的管理面 / stg-api 的 API 面", async () => {
    await withDomains(STG, async () => {
      const health = await fetchManual("https://stg-platform.lmlh.net/api/health");
      expect(health.status).toBe(200);

      const models = await fetchManual("https://stg-api.lmlh.net/v1/models");
      expect(redirectTarget(models)).toBeNull();
      expect(models.status).toBe(401);
    });
  });

  it("两侧越界 ⇒ 301 到**本环境**的对侧域（不得跳到 prod 域名）", async () => {
    await withDomains(STG, async () => {
      const fromPlatform = await fetchManual("https://stg-platform.lmlh.net/v1/models");
      expect(fromPlatform.status).toBe(301);
      expect(fromPlatform.headers.get("Location")).toBe("https://stg-api.lmlh.net/v1/models");

      const fromApi = await fetchManual("https://stg-api.lmlh.net/api/keys");
      expect(fromApi.status).toBe(301);
      expect(fromApi.headers.get("Location")).toBe("https://stg-platform.lmlh.net/api/keys");
    });
  });
});

describe("AC-B9 同一份代码 + 两套配置 ⇒ 各自的目标域（判别性用例）", () => {
  it("同一个别名 host 的同一请求，prod 配置去 prod api 域、stg 配置去 stg api 域", async () => {
    const prod = await withDomains(PROD, () =>
      fetchManual("https://alias.example.test/v1/models"),
    );
    const stg = await withDomains(STG, () =>
      fetchManual("https://alias.example.test/v1/models"),
    );

    expect(prod.headers.get("Location")).toBe("https://api.lmlh.net/v1/models");
    expect(stg.headers.get("Location")).toBe("https://stg-api.lmlh.net/v1/models");
    // 判别性：目标域**随配置变化**（写死 prod 域名的实现会让下一行变红）
    expect(prod.headers.get("Location")).not.toBe(stg.headers.get("Location"));
  });

  it("回管理台方向的越界（平台域上的 /v1）同样随配置变化", async () => {
    const prod = await withDomains(PROD, () =>
      fetchManual("https://platform.lmlh.net/v1/models"),
    );
    const stg = await withDomains(STG, () =>
      fetchManual("https://stg-platform.lmlh.net/v1/models"),
    );
    expect(prod.headers.get("Location")).toBe("https://api.lmlh.net/v1/models");
    expect(stg.headers.get("Location")).toBe("https://stg-api.lmlh.net/v1/models");
  });

  it("别名域的 SPA 路径 → 各自的平台域（另一个方向同样由配置派生）", async () => {
    const prod = await withDomains(PROD, () => fetchManual("https://alias.example.test/login"));
    const stg = await withDomains(STG, () => fetchManual("https://alias.example.test/login"));
    expect(prod.headers.get("Location")).toBe("https://platform.lmlh.net/login");
    expect(stg.headers.get("Location")).toBe("https://stg-platform.lmlh.net/login");
  });
});

// ============================================================ 本地 dev 与判据边界

describe("R-B8 后续 / X6 本地 dev：环回 host 永不被重定向", () => {
  it("分流开启时（.dev.vars 的 API_DOMAIN 是真的）localhost / 127.0.0.1 上的 /v1 仍走本地", async () => {
    await withDomains(PROD, async () => {
      for (const url of [
        "http://localhost:5173/v1/models",
        "http://127.0.0.1:5173/v1/models",
        "http://localhost:5173/api/keys",
      ]) {
        const res = await fetchManual(url);
        expect(redirectTarget(res), `${url} 不应被 301 到公网域名`).toBeNull();
        // 正向信号：请求确实到达了业务处理（不是"被别的什么挡掉了"）
        expect(res.status, url).toBe(401);
      }
    });
  });

  it("平台域无法从 BETTER_AUTH_URL 派生（缺失/非法）⇒ 同样整体关闭", async () => {
    await withBetterAuthUrl("", () =>
      withSwitch("API_DOMAIN", PROD.apiDomain, async () => {
        // 用 SPA 路径做判据：它若被分流就会 301 到平台域，而平台域此刻**不可知**
        // （BETTER_AUTH_URL 为空时 Better Auth 自身会报错，故不能用 /api/* 做探针）
        const spa = await fetchManual("https://api.lmlh.net/usage");
        expect(redirectTarget(spa), "平台域不可知时不得重定向").toBeNull();
        expect(spa.status).toBe(200);

        const v1 = await fetchManual("https://api.lmlh.net/v1/models");
        expect(redirectTarget(v1)).toBeNull();
        expect(v1.status).toBe(401); // 网关鉴权（不依赖 Better Auth）仍然照常
      }),
    );
  });

  it("`/v1alpha`、`/anthropicx` 不是 API 面 —— 两侧判据一致，不会形成重定向环", async () => {
    await withDomains(PROD, async () => {
      // 管理台域：不是 API 面 ⇒ 留在本地（前缀后无 `/` ⇒ ASSETS 回退 index.html）
      const alpha = await fetchManual("https://platform.lmlh.net/v1alpha");
      expect(redirectTarget(alpha)).toBeNull();
      expect(alpha.status).toBe(200);

      // api 域：不是 API 面 ⇒ 去管理台域（若管理台域又判它是 API 面就会无限弹）
      const onApi = await fetchManual("https://api.lmlh.net/anthropicx");
      expect(onApi.status).toBe(301);
      expect(onApi.headers.get("Location")).toBe("https://platform.lmlh.net/anthropicx");
    });
  });

  it("重定向**可被跟随**且不在两侧之间成环（缺省 follow 形态落到业务处理）", async () => {
    await withDomains(PROD, async () => {
      // 刻意用裸 selfFetch（= fetch 缺省 follow）：api 域上的管理面路径 → 301 → 平台域 → 401。
      // 若是环（或目标域不可达），这里会抛错而不是拿到响应。
      const followed = await selfFetch("https://api.lmlh.net/api/keys");
      expect(redirectTarget(followed)).toBeNull();
      expect(followed.status).toBe(401);
    });
  });
});

// ============================================================ 下发端点（R-B14 / R-B15）

describe("R-B14/B15 GET /api/config 运行期下发", () => {
  it("prod 配置：apiBaseUrl 不带 /v1 后缀；**无会话也能读**（注册在 requireSession 之前）", async () => {
    await withDomains(PROD, async () => {
      const res = await fetchManual("https://platform.lmlh.net/api/config");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        apiBaseUrl: "https://api.lmlh.net",
        platformBaseUrl: "https://platform.lmlh.net",
      });
    });
  });

  it("stg 配置：下发 stg 的两个域名", async () => {
    await withDomains(STG, async () => {
      const res = await fetchManual("https://stg-platform.lmlh.net/api/config");
      expect(await res.json()).toEqual({
        apiBaseUrl: "https://stg-api.lmlh.net",
        platformBaseUrl: "https://stg-platform.lmlh.net",
      });
    });
  });

  it("未配置 API_DOMAIN ⇒ apiBaseUrl 回落请求 origin", async () => {
    await withSplitDisabled(async () => {
      const res = await fetchManual("http://localhost:5173/api/config");
      expect(await res.json()).toEqual({
        apiBaseUrl: "http://localhost:5173",
        platformBaseUrl: "http://localhost:5173",
      });
    });
  });

  // AC-B9 的环回用例：**判别性在于「已配置 + 环回」这一组合**，而不是「未配置」。
  // 未配置时回落 origin 是平凡的（两个分支都返回 fallbackOrigin）；只有配置了真公网域名、
  // 请求又来自环回 host 时，两条路才分叉——中间件放行本地 /v1（环回例外），
  // 故下发的 base URL 必须是本地地址，否则管理台 Quick start 卡会把**生产**网关
  // 展示给正在本地调试的人（复制即打到线上、真计费），而本地 dev server 明明自己就能服务 /v1。
  it("已配置真公网 API_DOMAIN + 环回请求 ⇒ apiBaseUrl 必须是环回 origin（不得广告生产域）", async () => {
    await withDomains(LOCAL_DEV, async () => {
      const res = await fetchManual("http://localhost:5173/api/config");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        apiBaseUrl: "http://localhost:5173",
        platformBaseUrl: "http://localhost:5173",
      });
    });
  });

  // 上一条的**判别对**：同一份配置、两个请求 host、两个各自正确的答案。
  // 判据必须落在**请求** host 上（与中间件的环回例外同一条判据）——若哪天被写成
  // "凡配置里是公网域就返回公网域"（忽略请求来源），上一条会红；若被写成"永远回落 origin"，
  // 这一条会红。两条一起才锁得住"环回 ⇒ 本地地址，否则 ⇒ 配置域"。
  //
  // 本条同时**锁住两个下发函数的非对称**（见 src/lib/domains.ts 两处注释）：
  // 环回例外只对 `apiBaseUrl` 成立（其配置值是"本地不本地"的生产继承值），
  // `platformBaseUrl` 取自权威声明 `BETTER_AUTH_URL`，故它在环回请求上仍是配置域 —— 这不是漏改。
  it("同一份 prod 配置：环回请求的 apiBaseUrl 本地化，platformBaseUrl 仍取配置（非对称是设计）", async () => {
    await withDomains(PROD, async () => {
      const onLoopback = await fetchManual("http://localhost:5173/api/config");
      expect(onLoopback.status).toBe(200); // 中间件的环回例外放行，故这里必须能被服务
      expect(await onLoopback.json()).toEqual({
        apiBaseUrl: "http://localhost:5173", // 环回例外：本地能被服务的地址
        platformBaseUrl: "https://platform.lmlh.net", // 无例外：BETTER_AUTH_URL 的 origin
      });

      const onPlatform = await fetchManual("https://platform.lmlh.net/api/config");
      expect(onPlatform.status).toBe(200);
      expect(await onPlatform.json()).toEqual({
        apiBaseUrl: "https://api.lmlh.net",
        platformBaseUrl: "https://platform.lmlh.net",
      });
    });
  });

  it("api 域上的 /api/config 属于越界 ⇒ 301 去管理台域（管理面不在 api 域）", async () => {
    await withDomains(PROD, async () => {
      const res = await fetchManual("https://api.lmlh.net/api/config");
      expect(res.status).toBe(301);
      expect(res.headers.get("Location")).toBe("https://platform.lmlh.net/api/config");
    });
  });
});
