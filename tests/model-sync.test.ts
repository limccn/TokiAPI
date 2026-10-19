// OpenRouter 价格同步（10-16-openrouter-price-sync）单测。
//
// 这个文件守的是四件互不重叠的事，每件都配了它的"对照"：
//   ① buildSyncPlan 匹配/映射规则（纯函数,零 DB）:厂商前缀推导 + 两个显式锚
//      + `:`/`~` 变体排除 + ×1e6 映射 + long=short + cached 缺省保留现值语义。
//   ② 端到端按钮路径（stub fetch 回 canned OR 目录）:matched 行刷 5 价列、
//      白名单缺行 INSERT、maxOutputTokens/freeMode/hiddenFromMembers **不动**、
//      幂等（重放零插入）、member 403、OR 目录失败 502。
//   ③ 白名单 ↔ seed.sql 键序防漂移:两份清单**逐字一致**（改一处不改另一处 = 此处红）。
//   ④ 跳过明细 reason 稳定字符串（前端/日志可按值分支）。
//
// 测试没有 node:fs:seed.sql 走 Vite `?raw` 构建期内联（同 config-fork.test.ts 的
// wrangler.jsonc 先例,见 tests/test-env.d.ts 的模块声明）。
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import seedSql from "../seed.sql?raw";
import { createDb } from "../src/db";
import { models } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setModelFlags,
  setupPrice,
  setupUser,
} from "./helpers";
import {
  OPENROUTER_INSERT_ALLOWLIST,
  buildSyncPlan,
  gatewayModelToSlug,
  type OpenRouterModel,
} from "../src/routes/models/lib/openrouter-sync";

const SYNC_URL = "http://localhost/api/models/sync-openrouter";

// ============ canned OR 目录（快照形态的最小子集,真实结构按 OpenRouterModel 收） ============

/** 一条正常目录行:text pricing 三源全有。 */
function orModel(id: string, prompt: string, completion: string, cache?: string): OpenRouterModel {
  return { id, pricing: { prompt, completion, ...(cache !== undefined ? { input_cache_read: cache } : {}) } };
}

// ============ ① 匹配/映射规则（纯函数） ============

describe("gatewayModelToSlug：前缀推导 + 显式锚", () => {
  it("已知前缀按表推导", () => {
    expect(gatewayModelToSlug("claude-opus-5.5")).toBe("anthropic/claude-opus-5.5");
    expect(gatewayModelToSlug("gpt-6-sol")).toBe("openai/gpt-6-sol");
    expect(gatewayModelToSlug("glm-5.3-prime")).toBe("z-ai/glm-5.3-prime");
    expect(gatewayModelToSlug("mimo-v2.6-pro")).toBe("xiaomi/mimo-v2.6-pro");
    expect(gatewayModelToSlug("minimax-m3")).toBe("minimax/minimax-m3");
  });

  it("厂商名紧贴版本号的 id 必须命中（2026-10-19 stg 实证回归）", () => {
    // 这批在首版实现里全被 split("-")[0] 误判成 no-slug —— 28 行里 4 行
    expect(gatewayModelToSlug("qwen3.8-flash")).toBe("qwen/qwen3.8-flash");
    expect(gatewayModelToSlug("qwen3.8-27b")).toBe("qwen/qwen3.8-27b");
    expect(gatewayModelToSlug("hy3")).toBe("tencent/hy3");
    expect(gatewayModelToSlug("hy4-preview")).toBe("tencent/hy4-preview");
  });

  it("显式锚优先于前缀推导（OR 无精确 slug 的两行）", () => {
    expect(gatewayModelToSlug("gpt-5.6-codex")).toBe("openai/gpt-5.6-sol");
    expect(gatewayModelToSlug("qwen3.8-max")).toBe("qwen/qwen3.8-max-0902");
  });

  it("无厂商前缀返回 null（不参与同步）", () => {
    expect(gatewayModelToSlug("3.5-turbo")).toBeNull(); // 数字开头
    expect(gatewayModelToSlug("llama-3")).toBeNull(); // 前缀不在表
    expect(gatewayModelToSlug("some-third-party-model")).toBeNull();
  });
});

describe("buildSyncPlan：目录索引与动作清单", () => {
  it("`:` 变体与 `~` auto-slug 不进目录索引", () => {
    const plan = buildSyncPlan(
      ["gpt-6-sol"],
      [
        orModel("openai/gpt-6-sol:free", "0.000001", "0.000002"),
        orModel("~openai/gpt-6-sol", "0.000001", "0.000002"),
        orModel("openai/gpt-6-sol", "0.000001", "0.000002"),
      ],
    );
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]?.prices.short).toBe(1); // 0.000001 × 1e6 = 1 USD/M
    // gpt-6-sol 本行不在 skip 里（`:free`/`~` 变体被排除 ⇒ 命中干净 slug）。
    // ⚠ 白名单段不受 dbModels 影响:其余 16 行不在本目录 ⇒ allowlist-missing-from-or,
    // 那是白名单与目录的正常交互,不在此例的判据里。
    expect(plan.skipped.filter((s) => s.model === "gpt-6-sol")).toHaveLength(0);
  });

  it("long=short、cached=input_cache_read×1e6、无 cache 源则 null（=保留现值）", () => {
    const plan = buildSyncPlan(["glm-5.3"], [orModel("z-ai/glm-5.3", "0.000000079", "0.0000048", "0.000000078")]);
    const u = plan.updates[0];
    // ×1e6 浮点乘法有尾差（0.0000002 × 1e6 = 0.19999999999999998）:价格断言一律 toBeCloseTo,
    // 逐字节相等断言留给整数价的用例。
    expect(u?.prices.short).toBeCloseTo(0.079, 9);
    expect(u?.prices.long).toBeCloseTo(0.079, 9); // long = short
    expect(u?.prices.cached).toBeCloseTo(0.078, 9);
    expect(u?.prices.out).toBeCloseTo(4.8, 9);
    // 无 input_cache_read ⇒ cached null ⇒ procedure 侧保留现值(拆 set 两分支的判据)
    const planNoCache = buildSyncPlan(["glm-5.3"], [orModel("z-ai/glm-5.3", "0.000000079", "0.0000048")]);
    expect(planNoCache.updates[0]?.prices.cached).toBeNull();
  });

  it("skip reasons: no-slug / missing-from-or / no-text-pricing / allowlist-missing-from-or", () => {
    const plan = buildSyncPlan(
      ["llama-3", "gpt-6-sol"],
      [
        // 目录里只有非文本价（如 audio/image 计价行）的模型
        { id: "openai/gpt-6-sol", pricing: { image: "0.000001" } },
      ],
    );
    expect(plan.skipped).toContainEqual({ model: "llama-3", reason: "no-slug" });
    // gpt-6-sol 在目录但 prompt/completion 缺 ⇒ no-text-pricing
    expect(plan.skipped).toContainEqual({ model: "gpt-6-sol", reason: "no-text-pricing" });

    const planMissing = buildSyncPlan(["gpt-6-sol"], []);
    expect(planMissing.skipped).toContainEqual({ model: "gpt-6-sol", reason: "missing-from-or" });

    // 白名单行目录缺失 ⇒ allowlist-missing-from-or(显式 skip,不静默丢)
    const planAllow = buildSyncPlan(
      [],
      [orModel("anthropic/claude-opus-5.5", "0.000001", "0.000002")],
    );
    // 库空 ⇒ 17 白名单行全走插;只有 claude-opus-5.5 在目录 ⇒ 其余 16 行 allowlist-missing-from-or
    const allowSkipped = planAllow.skipped.filter((s) => s.reason === "allowlist-missing-from-or");
    expect(allowSkipped).toHaveLength(OPENROUTER_INSERT_ALLOWLIST.length - 1);
    expect(planAllow.inserts).toEqual([
      { model: "claude-opus-5.5", slug: "anthropic/claude-opus-5.5", maxOutputTokens: 16384 },
    ]);
  });

  it("白名单行已在库 ⇒ 并入 UPDATE 路径,零重复插入", () => {
    const plan = buildSyncPlan(
      ["claude-opus-5.5"],
      [orModel("anthropic/claude-opus-5.5", "0.000004", "0.00002", "0.0000002")],
    );
    expect(plan.inserts).toHaveLength(0);
    expect(plan.updates.map((u) => u.model)).toContain("claude-opus-5.5");
  });
});

// ============ ③ 白名单 ↔ seed.sql 键序防漂移 ============

describe("白名单 ↔ seed.sql 一致性（防漂移）", () => {
  /** 从 seed.sql 原文提取白名单段之后的 17 行 (model, maxOutputTokens)。 */
  function seedAllowlistFromRaw(): { model: string; maxOutputTokens: number }[] {
    const marker = "白名单新增 17 行";
    const lines = seedSql.split("\n");
    const markerIdx = lines.findIndex((l) => l.includes(marker));
    if (markerIdx < 0) throw new Error("seed.sql 里找不到白名单段标记行");
    const rows: { model: string; maxOutputTokens: number }[] = [];
    for (const line of lines.slice(markerIdx)) {
      const m = line.match(/^\s*\('([^']+)',.*?,\s*(\d+)\s*,\s*unixepoch\(\),\s*unixepoch\(\)\)/);
      if (m?.[1] === undefined || m?.[2] === undefined) continue;
      rows.push({ model: m[1], maxOutputTokens: Number.parseInt(m[2], 10) });
    }
    return rows;
  }

  it("两份清单逐字一致（键序敏感）", () => {
    const fromSeed = seedAllowlistFromRaw();
    expect(fromSeed).toHaveLength(17);
    // 逐键序断言:改 allowlist 不改 seed(或反之)= 这里红,提示同步另一侧
    expect(OPENROUTER_INSERT_ALLOWLIST.map((r) => [r.model, r.maxOutputTokens])).toEqual(
      fromSeed.map((r) => [r.model, r.maxOutputTokens]),
    );
  });

  it("seed.sql 全量与白名单段无重复模型名", () => {
    const all = [...seedSql.matchAll(/^\s*\('([^']+)',/gm)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    expect(new Set(all).size).toBe(all.length);
  });

  it("seed.sql 每个模型都能推出厂商前缀（覆盖回归，不依赖外部目录）", () => {
    // 判别力来源：首版实现用 split("-")[0] 查厂商表，qwen3.8-flash / hy3 / hy4-preview
    // 等行被误判 no-slug（2026-10-19 stg 实证 4 行）。这条立刻红。
    // ⚠ 刻意**不**读 OR 快照：快照在 gitignored 的 .trellis/ 下，CI 上不存在，
    //   导入它会让构建失败。这里只锁「推导得出 slug」这个纯函数性质。
    const models = [...seedSql.matchAll(/^\s*\('([^']+)',/gm)]
      .map((m) => m[1])
      .filter((name): name is string => name !== undefined);
    expect(models).toHaveLength(45);
    const unresolved = models.filter((model) => gatewayModelToSlug(model) === null);
    expect(unresolved).toEqual([]);
  });
});

// ============ ② 端到端按钮路径 ============

let adminCookie: string;
let memberCookie: string;

beforeAll(async () => {
  await applyMigrations();
  const adminId = await setupUser("sync-admin@test.dev", 10, "admin");
  const memberId = await setupUser("sync-member@test.dev", 10, "member");
  adminCookie = sessionCookie(await createSession(adminId));
  memberCookie = sessionCookie(await createSession(memberId));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** stub fetch:OR 目录端点回 canned 数据;其余转发主 worker。 */
function stubOrCatalog(catalog: OpenRouterModel[], opts: { status?: number } = {}): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://openrouter.ai/api/v1/models")) {
        return new Response(JSON.stringify({ data: catalog }), {
          status: opts.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const app = exports.default as { fetch(request: Request): Promise<Response> };
      return app.fetch(new Request(url, init));
    }),
  );
}

async function syncAs(cookie: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await selfFetch(SYNC_URL, { method: "POST", headers: { Cookie: cookie } });
  const body = res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null;
  return { status: res.status, body };
}

/** 直查库里的某行（价格五元组 + cap + 两标记）。 */
async function dbRow(model: string) {
  const db = createDb(env);
  const rows = await db.select().from(models).where(eq(models.model, model));
  const row = rows[0];
  if (!row) throw new Error(`库里没有 ${model}`);
  return row;
}

describe("POST /api/models/sync-openrouter（按钮路径）", () => {
  it("member 403（按钮不渲染是真防线,这是第二道）", async () => {
    stubOrCatalog([]);
    const res = await syncAs(memberCookie);
    expect(res.status).toBe(403);
  });

  it("未登录 401", async () => {
    stubOrCatalog([]);
    const res = await selfFetch(SYNC_URL, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("OR 目录 5xx ⇒ 502,库一字不动", async () => {
    await setupPrice("sync-probe@test", 1, 1, 0.1, 2, 2);
    stubOrCatalog([], { status: 503 });
    const res = await syncAs(adminCookie);
    expect(res.status).toBe(502);
    const row = await dbRow("sync-probe@test");
    expect([row.inputPriceShort, row.outputPriceShort]).toEqual([1, 2]); // 仍是原价
  });

  it("matched 刷价 + 白名单补插 + cap/标记不动 + 回显明细", async () => {
    // 库里一条 matched 行(claude 前缀),旧价故意不同
    await setupPrice("claude-opus-5.5", 99, 99, 9, 199, 199);
    // 一条白名单缺行(INSERT 候选)
    // 一条无 slug 行(skip 候选)
    await setupPrice("no-vendor-model", 5, 5, 0.5, 5, 5);

    stubOrCatalog([
      orModel("anthropic/claude-opus-5.5", "0.000004", "0.00002", "0.0000002"),
      orModel("openai/gpt-6-sol", "0.000002", "0.00001", "0.0000002"),
    ]);

    const res = await syncAs(adminCookie);
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body?.success).toBe(true);
    expect(body?.source).toBe("openrouter");
    expect(typeof body?.fetchedAt).toBe("string");

    // matched 行:5 价列刷成 OR 价（×1e6 浮点尾差 ⇒ toBeCloseTo）
    const updated = await dbRow("claude-opus-5.5");
    expect(updated.inputPriceShort).toBeCloseTo(4, 9);
    expect(updated.inputPriceLong).toBeCloseTo(4, 9);
    expect(updated.inputPriceCached).toBeCloseTo(0.2, 9);
    expect(updated.outputPriceShort).toBeCloseTo(20, 9);
    expect(updated.outputPriceLong).toBeCloseTo(20, 9);

    // 白名单缺行:按 allowlist 插,cap 挿 allowlist 值,标记取列默认 false
    const insertedRow = await dbRow("gpt-6-sol");
    expect(insertedRow.inputPriceShort).toBeCloseTo(2, 9);
    expect(insertedRow.inputPriceCached).toBeCloseTo(0.2, 9);
    expect(insertedRow.outputPriceShort).toBeCloseTo(10, 9);
    expect(insertedRow.maxOutputTokens).toBe(16384);
    expect(insertedRow.freeMode).toBe(false);
    expect(insertedRow.hiddenFromMembers).toBe(false);

    // 回显明细:synced ≥1(matched 一行),inserted ≥1(白名单缺行),skipped 含 no-vendor-model
    expect(typeof body?.synced).toBe("number");
    expect(typeof body?.inserted).toBe("number");
    expect((body?.inserted as number) ?? 0).toBeGreaterThanOrEqual(1);
    const skipped = (body?.skipped as { model: string; reason: string }[]) ?? [];
    expect(skipped).toContainEqual({ model: "no-vendor-model", reason: "no-slug" });
    // no-vendor-model 不在白名单 ⇒ 不被补插
    await expect(dbRow("no-vendor-model")).resolves.toBeDefined();
  });

  it("幂等:重放零插入,第二次 synced 条数一致", async () => {
    // afterEach 会 unstub ⇒ 每条用例自己 re-stub（目录内容与上一条一致）
    stubOrCatalog([
      orModel("anthropic/claude-opus-5.5", "0.000004", "0.00002", "0.0000002"),
      orModel("openai/gpt-6-sol", "0.000002", "0.00001", "0.0000002"),
    ]);
    const first = await syncAs(adminCookie);
    expect(first.status).toBe(200);
    // 第一次插过的白名单行,重放时已在库 ⇒ inserted 0
    await expect(dbRow("gpt-6-sol")).resolves.toBeDefined();
    const second = await syncAs(adminCookie);
    expect(second.status).toBe(200);
    expect(second.body?.inserted).toBe(0);
    // 重放的 synced 与第一次一致（同一批 matched 行再刷一遍）
    expect(second.body?.synced).toBe(first.body?.synced);
  });

  it("17 行白名单全缺时全量补插（D1 参数上限回归：单条 INSERT 必须分批）", async () => {
    // 空目录基线上把所有白名单行清掉 → 下一次同步要一次插 17 行。
    // ⚠ 这是 D1 绑定参数上限（100）的回归用例:12 列 × 17 行 = 204 参数,
    //   不分批会 500（stg 实走 2026-10-19 已实证）。删行用 raw SQL 一次清干净。
    const names = OPENROUTER_INSERT_ALLOWLIST.map((r) => r.model);
    await env.DB.prepare(
      `DELETE FROM models WHERE model IN (${names.map(() => "?").join(",")})`,
    )
      .bind(...names)
      .run();

    // 目录里 17 行白名单全在（价随便给,只要能插）
    stubOrCatalog(
      OPENROUTER_INSERT_ALLOWLIST.map((r) => orModel(r.slug, "0.000002", "0.00001", "0.0000002")),
    );
    const res = await syncAs(adminCookie);
    expect(res.status).toBe(200);
    expect(res.body?.inserted).toBe(OPENROUTER_INSERT_ALLOWLIST.length);

    // 逐行验证:行真的在库里,且 cap 取自 allowlist
    for (const row of OPENROUTER_INSERT_ALLOWLIST) {
      const stored = await dbRow(row.model);
      expect(stored.maxOutputTokens).toBe(row.maxOutputTokens);
    }
    // 重放即幂等
    const replay = await syncAs(adminCookie);
    expect(replay.body?.inserted).toBe(0);
  });

  it("cap/freeMode/hiddenFromMembers 不被同步改写（存量值保持）", async () => {
    // gpt-6-sol 已在库(前一条插的);人为改 cap + 开标记,再同步,断言不动
    const db = createDb(env);
    await db
      .update(models)
      .set({ maxOutputTokens: 32768 })
      .where(eq(models.model, "gpt-6-sol"));
    await setModelFlags("gpt-6-sol", { freeMode: true });

    stubOrCatalog([orModel("openai/gpt-6-sol", "0.000002", "0.00001", "0.0000002")]);
    const res = await syncAs(adminCookie);
    expect(res.status).toBe(200);

    const row = await dbRow("gpt-6-sol");
    expect(row.maxOutputTokens).toBe(32768); // 未被 allowlist 的 16384 覆写
    expect(row.freeMode).toBe(true); // 标记未被动
    expect(row.inputPriceShort).toBeCloseTo(2, 9); // 但价照刷
  });
});