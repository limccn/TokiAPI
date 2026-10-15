// 部署配置 fork 护栏（10-14-deploy-button-research design §5）：
// 渲染管线拆除后，「两份配置的漂移」从渲染器的结构性保证降为测试断言 —— 本文件就是那个护栏。
//   1. wrangler.jsonc（提交形态 / 按钮契约）：结构契约 + 安全缺省 + [vars] 键集合白名单。
//   2. wrangler.prod.jsonc（维护者 fork，gitignored）：binding 键集合 ⊇ jsonc 对应集合 +
//      routes 存在且 ≥2 条 custom_domain；fork 不存在时整组跳过（CI / 按钮克隆形态，AC7）。
//
// 读取方式：workerd 里没有 node:fs —— wrangler.jsonc 走 Vite `?raw`（构建期内联）；prod fork
// 由 vitest.config.ts 在 Node 侧读文件后经 miniflare binding TEST_PROD_FORK_JSON 注入
// （空串 = fork 不存在 → 跳过该组）。
// jsonc 解析：字符串感知的 `//` 与 `/* */` 注释剥离（朴素正则会把 "http://" 里的 // 也吃掉），
// 剥完 JSON.parse（顺手容忍尾逗号 —— 规格允许，且解析器不该成为写配置的隐性约束）。
import jsoncRaw from "../wrangler.jsonc?raw";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/** 字符串感知地剥 JSONC 注释 + 容忍尾逗号；引号内的 URL（http://）不受影响。 */
function stripJsonc(src: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++; // 吃掉 '/'
      continue;
    }
    if (ch === ",") {
      // 尾逗号：下一个非空白字符是 } 或 ] 时丢弃
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j] ?? "")) j++;
      if (src[j] === "}" || src[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(src: string): Record<string, unknown> {
  return JSON.parse(stripJsonc(src)) as Record<string, unknown>;
}

/** 取数组首元素并守卫（noUncheckedIndexedAccess 下裸下标是 T|undefined；契约测试对空数组应红而非静默）。 */
function firstOf(arr: unknown): Record<string, unknown> {
  const first = (arr as Array<Record<string, unknown>>)[0];
  if (!first) throw new Error("expected a non-empty array in config");
  return first;
}

const cfg = parseJsonc(jsoncRaw);

/** [vars] 白名单（15 键，design §2；与 wrangler.jsonc 逐键相等，多键少键都红）。 */
const VARS_WHITELIST = [
  "API_DOMAIN",
  "API_KEY_PREFIX",
  "BETTER_AUTH_URL",
  "BILLING_QUEUE_NAME",
  "CACHE_ENABLED",
  "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED",
  "EMAIL_ALLOWED_RECIPIENTS",
  "EMAIL_VERIFICATION_ENABLED",
  "EMAIL_VERIFY_BONUS_AMOUNT",
  "GITHUB_ALLOWED_EMAILS",
  "GITHUB_CLIENT_ID",
  "MODELCAP_BASE_TOKENS",
  "MODELCAP_MULTIPLIER",
  "REQUEST_LOG_RETENTION_DAYS",
  "SIGNUP_BONUS_AMOUNT",
];

/** 真实 secret 键名 —— 任何部署配置文件都不允许出现（值更不允许；红线自查）。 */
const SECRET_KEY_NAMES = [
  "BETTER_AUTH_SECRET",
  "GITHUB_CLIENT_SECRET",
  "GATEWAY_SECRET_KEY",
  "RESEND_API_KEY",
];

const vars = cfg.vars as Record<string, string>;
const ratelimits = cfg.ratelimits as Array<{ name: string; namespace_id: string }>;
const d1 = firstOf(cfg.d1_databases);
const kv = firstOf(cfg.kv_namespaces);
const queues = cfg.queues as {
  producers: Array<{ binding: string; queue: string }>;
  consumers: Array<{ queue: string; max_batch_size: number; max_retries: number }>;
};
const assets = cfg.assets as Record<string, unknown>;
const triggers = cfg.triggers as { crons: string[] };

describe("wrangler.jsonc（按钮形态）结构契约", () => {
  it("main / migrations_dir / 资源 binding 名与 design §2 一致", () => {
    expect(cfg.main).toBe("src/index.ts");
    expect(d1.binding).toBe("DB");
    expect(d1.database_name).toBe("cf-ai-gateway-db");
    expect(d1.migrations_dir).toBe("drizzle");
    expect(kv.binding).toBe("CACHE_KV");
    expect(assets.binding).toBe("ASSETS");
    expect(assets.directory).toBe("dist/client");
    expect(queues.producers.map((p) => p.binding).sort()).toEqual(["BILLING_QUEUE", "USAGE_QUEUE"]);
  });

  it("[[ratelimits]] ×2：名与 namespace_id 固定（auth-rate-limit 中间件的策略真源）", () => {
    expect(ratelimits).toHaveLength(2);
    expect(ratelimits.map((r) => r.name)).toEqual(["AUTH_CREDENTIAL_LIMIT", "AUTH_EMAIL_LIMIT"]);
    expect(ratelimits.map((r) => r.namespace_id)).toEqual(["1001", "1002"]);
  });

  it("cron 声明保留期清理（M5 5.4）", () => {
    expect(triggers.crons).toContain("0 2 * * *");
  });

  it("[vars] 键集合 == 15 键白名单（多键少键都红 —— 渲染管线的键契约断言在此续命）", () => {
    expect(Object.keys(vars).sort()).toEqual(VARS_WHITELIST);
  });

  it("资源 id 为「待供给」占位形态（双安装器契约：Deploy 按钮 + Appflare）", () => {
    // 提交形态的 D1 database_id / KV id 必须是 Appflare 可识别的显式占位符
    // （$NAME / ${NAME} / {{NAME}} / <NAME>）——两个安装器都会对它自动供给真实资源；
    // 真实 id 只允许出现在 gitignored 的 wrangler.prod.jsonc。
    // 形态依据：appflare.dev/catalog/submit/（kv/r2/d1 的 id 允许空串或上述占位符）。
    // 实证补注（2026-10-15）：wrangler 对 KV id 显式拒绝空串（length===0 报错），
    // 故排除空串形态，统一用 $NAME 占位 —— wrangler 侧任何非空串均通过校验。
    // ${NAME}/{{NAME}} 形态会与下方「无 {TOKEN} 渲染占位残留」护栏冲突，同样排除。
    const placeholderRe = /^\$[A-Z][A-Z_0-9]*$|^<[A-Z][A-Z_0-9]*>$/;
    for (const [label, value] of [
      ["d1_databases[0].database_id", d1.database_id],
      ["kv_namespaces[0].id", kv.id],
    ] as const) {
      const s = String(value);
      expect(placeholderRe.test(s), `${label} 必须为待供给占位符（$NAME / <NAME>），实际值「${s}」疑似真实资源 id`).toBe(true);
    }
  });

  it("无 routes / 无 [env.*] / 无 placement（按钮形态 = 无自定义域名、无环境段）", () => {
    expect(cfg).not.toHaveProperty("routes");
    expect(cfg).not.toHaveProperty("env");
    expect(cfg).not.toHaveProperty("placement");
  });

  it("queue() 分流不变式：BILLING_QUEUE_NAME [vars] 与 producers 里 BILLING_QUEUE 的队列名字面一致", () => {
    // src/index.ts queue() 按 batch.queue === env.BILLING_QUEUE_NAME 精确比对分流；
    // 漂移会让计费批静默落进用量分支（不扣费且账上无痕）。
    const billing = queues.producers.find((p) => p.binding === "BILLING_QUEUE");
    expect(billing).toBeDefined();
    expect(vars.BILLING_QUEUE_NAME).toBe(billing?.queue);
    // consumers 与 producers 同队列名（队列没有消费者 = 在途消息无人消费）
    const consumerQueues = queues.consumers.map((c) => c.queue).sort();
    expect(consumerQueues).toEqual(queues.producers.map((p) => p.queue).sort());
  });
});

describe("wrangler.jsonc 安全缺省（fail-closed）", () => {
  it("GITHUB_ALLOWED_EMAILS 空 = 拒绝所有 GitHub 登录", () => {
    expect(vars.GITHUB_ALLOWED_EMAILS).toBe("");
  });

  it("功能开关缺省关闭（CACHE / EMAIL_VERIFICATION / ADMIN_PROMOTION）", () => {
    expect(vars.CACHE_ENABLED).toBe("false");
    expect(vars.EMAIL_VERIFICATION_ENABLED).toBe("false");
    expect(vars.EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED).toBe("false");
  });

  it("不含任何 lmlh.net 域名（按钮克隆形态与维护者域名零耦合）", () => {
    expect(jsoncRaw).not.toContain("lmlh.net");
  });

  it("无 {TOKEN} 渲染占位残留（旧管线的模板语法不得回流）", () => {
    expect(jsoncRaw).not.toMatch(/\{[A-Z][A-Z_0-9]+\}/);
  });

  it("四个真实 secret 键名不出现（secrets 只走 secret put / .dev.vars）", () => {
    for (const secret of SECRET_KEY_NAMES) {
      expect(jsoncRaw).not.toContain(secret);
    }
  });
});

describe("维护者 prod fork（wrangler.prod.jsonc，存在时）", () => {
  // vitest.config.ts Node 侧注入；空串 = fork 不存在（CI / 按钮克隆），整组跳过（AC7）。
  const forkRaw = env.TEST_PROD_FORK_JSON ?? "";
  const fork = forkRaw ? parseJsonc(forkRaw) : null;

  it.skipIf(fork === null)("binding 键集合 ⊇ jsonc 对应集合 + routes ≥2 条 custom_domain", () => {
    const f = fork as Record<string, unknown>;
    // main / crons / assets 契约同构
    expect(f.main).toBe(cfg.main);
    expect(JSON.stringify(f.triggers)).toBe(JSON.stringify(cfg.triggers));
    const fAssets = f.assets as Record<string, unknown>;
    expect(fAssets.binding).toBe("ASSETS");
    expect(fAssets.directory).toBe("dist/client");

    // d1 / kv：binding 同名，id 必须脱离占位（占位/空串 id 是提交形态专属；fork 是真资源）
    // 注意 fork 侧 id 可为空串之外任何形态——真实部署前必须已回填真实 id，故只断言
    // 与 jsonc 的「待供给」值不同且非零 UUID（空串也不行：fork 无安装器代为供给）。
    const fD1 = f.d1_databases as Array<Record<string, unknown>>;
    const fD1First = firstOf(fD1);
    expect(fD1.map((d) => d.binding)).toContain("DB");
    expect(fD1First.database_id).not.toBe(d1.database_id);
    expect(String(fD1First.database_id)).not.toBe("");
    expect(String(fD1First.database_id)).not.toMatch(/^0+(-0+)+$/);
    const fKv = f.kv_namespaces as Array<Record<string, unknown>>;
    const fKvFirst = firstOf(fKv);
    expect(fKv.map((k) => k.binding)).toContain("CACHE_KV");
    expect(fKvFirst.id).not.toBe(kv.id);
    expect(String(fKvFirst.id)).not.toBe("");

    // queues：producers bindings ⊇ jsonc；BILLING_QUEUE_NAME 分流不变式同样成立
    const fQueues = f.queues as typeof queues;
    const fProducerBindings = fQueues.producers.map((p) => p.binding);
    for (const p of queues.producers) {
      expect(fProducerBindings).toContain(p.binding);
    }
    const fVars = f.vars as Record<string, string>;
    const fBilling = fQueues.producers.find((p) => p.binding === "BILLING_QUEUE");
    expect(fVars.BILLING_QUEUE_NAME).toBe(fBilling?.queue);

    // ratelimits：两个绑定都在（name + namespace_id 同构）
    const fRatelimits = f.ratelimits as typeof ratelimits;
    for (const r of ratelimits) {
      expect(fRatelimits).toContainEqual(r);
    }

    // [vars]：键集合 ⊇ 白名单（fork 可加键，不可少键）
    for (const key of VARS_WHITELIST) {
      expect(fVars).toHaveProperty(key);
    }

    // routes：存在且 ≥2 条 custom_domain（管理台域 + 公开 API 域；旧域转发路由已随 staging 退役拆除）
    const routes = f.routes as Array<Record<string, unknown>>;
    expect(Array.isArray(routes)).toBe(true);
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const r of routes) {
      expect(r.custom_domain).toBe(true);
    }
  });

  it.skipIf(fork === null)("fork 文件不含真实 secret 值通道（secrets 只走 secret put）", () => {
    for (const secret of SECRET_KEY_NAMES) {
      expect(forkRaw).not.toContain(secret);
    }
  });
});
