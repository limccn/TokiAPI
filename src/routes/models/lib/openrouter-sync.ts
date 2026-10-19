// OpenRouter 价格同步核心（10-16-openrouter-price-sync，design §4.1.1）。
//
// **100% 同价策略**（用户裁决 2026-10-16）：OR `pricing.prompt`/`pricing.completion`
// （USD/token）× 1e6 直取网关 inputPriceShort/outputPriceShort，无视 discount
// （OR API 的 pricing 字段即结算价，目录无独立 discount 键——快照键集已核）。
// OR 无源的补全：long 档 = short 档；cached = pricing.input_cache_read × 1e6。
//
// 两个职责：
//   1. 匹配：网关 model 名（裸 id，无厂商前缀）→ OR slug（`<vendor>/<id>`）。
//      厂商前缀表 + 两个显式锚（OR 无精确 slug，用户裁决）为代码常量。
//   2. 白名单 INSERT：主流新 id 17 行，与 seed.sql 的白名单段**逐字一致**
//      （键序防漂移由 tests/model-sync.test.ts 钉，勿单侧改）。
// 按钮（procedures/sync-openrouter.ts）只做 fetch + 调本模块 + 回显明细；
// 计费/maxOutputTokens/freeMode/hiddenFromMembers 一概不碰。

/**
 * 网关裸 id → OR 厂商前缀表。
 *
 * ⚠ 查表键是**厂商名**（claude/gpt/deepseek/...），推导在 `vendorOf` 里做——不能简单
 * 用 `id.split("-")[0]` 直接查：`qwen3.8-flash` 的首段是 `qwen3.8`、`hy4-preview` 的首段是
 * `hy4`，都不在表里，会被误判成 `no-slug`（2026-10-19 stg 实走实证：28 行里 4 行中招）。
 */
const VENDOR_PREFIX: Readonly<Record<string, string>> = {
  claude: "anthropic",
  gpt: "openai",
  deepseek: "deepseek",
  qwen: "qwen",
  glm: "z-ai",
  mimo: "xiaomi",
  hy: "tencent",
  kimi: "moonshotai",
  minimax: "minimax",
};

/**
 * 从网关 id 推出厂商前缀（最长前缀匹配；无则 null）。
 *
 * 逐个 `-` 片段累加成候选，每轮尝试三种形态查表：
 *   ① 候选原样            `qwen3.8` → ×
 *   ② 去掉尾部数字/点号    `qwen3.8` → `qwen` ✓
 *   ③ 去掉尾部纯数字       `hy4` → `hy` ✓
 * 由此 `qwen3.8-flash`→qwen、`hy4-preview`→hy、`gpt-6-sol`→gpt、`minimax-m3`→minimax 全部命中。
 */
function vendorOf(model: string): string | null {
  const segments = model.split("-");
  let candidate = "";
  for (const seg of segments) {
    candidate = candidate === "" ? seg : `${candidate}-${seg}`;
    const bases = [candidate, candidate.replace(/[\d.]+$/, ""), candidate.replace(/\d+$/, "")];
    for (const base of bases) {
      const vendor = VENDOR_PREFIX[base];
      if (vendor !== undefined) return vendor;
    }
  }
  return null;
}

/** 显式锚（OR 无精确 slug 的两行,用户裁决 2026-10-16）:网关 model → OR slug,优先于前缀推导。 */
const SLUG_OVERRIDES: Readonly<Record<string, string>> = {
  // OR 目录无 gpt-5.6-codex（只有 gpt-5.x 系老 codex）,锚同代旗舰 sol 同价
  "gpt-5.6-codex": "openai/gpt-5.6-sol",
  // OR 只有 max-prime / max-0902 两个变体,无裸 max;0902 为在架最新版
  "qwen3.8-max": "qwen/qwen3.8-max-0902",
};

/**
 * 白名单新增行（design §3.1 Q5 表逐字钉,17 行）。按钮同步在行缺失时按本表 INSERT
 * （幂等:行已存在时零插入）;seed.sql 的白名单段与本表一一对应,改一处须同步另一处
 * （tests/model-sync.test.ts 键序断言防漂移）。cap 沿 seed 档位惯例:1x 旗舰 / 2x mimo / 4x flash。
 */
export const OPENROUTER_INSERT_ALLOWLIST: readonly {
  model: string;
  slug: string;
  maxOutputTokens: number;
}[] = [
  { model: "claude-opus-5.5", slug: "anthropic/claude-opus-5.5", maxOutputTokens: 16384 },
  { model: "claude-sonnet-5.5", slug: "anthropic/claude-sonnet-5.5", maxOutputTokens: 16384 },
  { model: "claude-haiku-5.5", slug: "anthropic/claude-haiku-5.5", maxOutputTokens: 16384 },
  { model: "gpt-6.1-sol", slug: "openai/gpt-6.1-sol", maxOutputTokens: 16384 },
  { model: "gpt-6.1-sol-pro", slug: "openai/gpt-6.1-sol-pro", maxOutputTokens: 16384 },
  { model: "gpt-6-sol", slug: "openai/gpt-6-sol", maxOutputTokens: 16384 },
  { model: "gpt-6-sol-pro", slug: "openai/gpt-6-sol-pro", maxOutputTokens: 16384 },
  { model: "gpt-6-luna", slug: "openai/gpt-6-luna", maxOutputTokens: 16384 },
  { model: "gpt-6-luna-pro", slug: "openai/gpt-6-luna-pro", maxOutputTokens: 16384 },
  { model: "gpt-6-astra-pro", slug: "openai/gpt-6-astra-pro", maxOutputTokens: 16384 },
  { model: "gpt-5.6-sol-pro", slug: "openai/gpt-5.6-sol-pro", maxOutputTokens: 16384 },
  { model: "gpt-5.6-terra-pro", slug: "openai/gpt-5.6-terra-pro", maxOutputTokens: 16384 },
  { model: "gpt-5.6-luna-pro", slug: "openai/gpt-5.6-luna-pro", maxOutputTokens: 16384 },
  { model: "glm-5.3-prime", slug: "z-ai/glm-5.3-prime", maxOutputTokens: 16384 },
  { model: "glm-5.3-flashx", slug: "z-ai/glm-5.3-flashx", maxOutputTokens: 65536 },
  { model: "mimo-v2.6-pro", slug: "xiaomi/mimo-v2.6-pro", maxOutputTokens: 32768 },
  { model: "mimo-v2.6-flash", slug: "xiaomi/mimo-v2.6-flash", maxOutputTokens: 32768 },
];

/** OR 目录单条的最小结构（pricing 全量收下,新增键不炸）。 */
export interface OpenRouterModel {
  id: string;
  pricing: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    [key: string]: string | undefined;
  };
}

export interface SyncOutcome {
  /** 已有行被刷价的条数。 */
  synced: number;
  /** 白名单新插的行数（行已存在时 0,幂等）。 */
  inserted: number;
  /** 未匹配/跳过的行明细（reason: 'no-slug' | 'missing-from-or' | 'no-text-pricing' | 'allowlist-missing-from-or'）。 */
  skipped: { model: string; reason: string }[];
}

/** 网关裸 id → OR slug（前缀推导 + 显式锚;无厂商前缀的 id 返回 null = 不参与同步）。 */
export function gatewayModelToSlug(model: string): string | null {
  if (SLUG_OVERRIDES[model] !== undefined) {
    return SLUG_OVERRIDES[model];
  }
  const vendor = vendorOf(model);
  return vendor === null ? null : `${vendor}/${model}`;
}

/** OR pricing 单价串（USD/token）→ USD/M 数值;空/非法返回 null。（seed.sql / procedure 共用映射,勿单侧改公式） */
export function perMillion(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return null;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) && v >= 0 ? v * 1_000_000 : null;
}

/**
 * 一次同步的全部计算（纯函数:目录输入 → 行级动作清单,不碰库）。
 * 按钮路径与测试共用;DB 写入在 procedures 侧按清单执行。
 *
 * - UPDATE：库中已有行,5 价列按 OR 刷新（long=short;cached=input_cache_read,缺则保留现值）。
 * - INSERT：白名单行不在库中时补插（在库则并入 UPDATE 路径,零重复插入）。
 * - 不 DELETE 任何行;maxOutputTokens/freeMode/hiddenFromMembers 不动。
 */
export interface SyncPlan {
  updates: { model: string; prices: { short: number; long: number; cached: number | null; out: number } }[];
  inserts: { model: string; slug: string; maxOutputTokens: number }[];
  skipped: { model: string; reason: string }[];
}

export function buildSyncPlan(
  dbModels: string[],
  orModels: OpenRouterModel[],
): SyncPlan {
  const updates: SyncPlan["updates"] = [];
  const inserts: SyncPlan["inserts"] = [];
  const skipped: SyncPlan["skipped"] = [];
  const dbSet = new Set(dbModels);

  // OR 目录索引:排除变体 slug（:batch/:free 等 `:` 后缀;首段可带 `~` 的 auto-slug 同排除）
  const catalog = new Map<string, OpenRouterModel>();
  for (const m of orModels) {
    const id = m.id;
    if (!id.includes("/") || id.startsWith("~") || id.includes(":")) continue;
    catalog.set(id, m);
  }

  // ① 库中已有行:逐行找 OR 价刷新
  for (const model of dbModels) {
    const slug = gatewayModelToSlug(model);
    if (slug === null) {
      skipped.push({ model, reason: "no-slug" });
      continue;
    }
    const entry = catalog.get(slug);
    if (entry === undefined) {
      skipped.push({ model, reason: "missing-from-or" });
      continue;
    }
    const inShort = perMillion(entry.pricing.prompt);
    const out = perMillion(entry.pricing.completion);
    if (inShort === null || out === null) {
      skipped.push({ model, reason: "no-text-pricing" });
      continue;
    }
    const cached = perMillion(entry.pricing.input_cache_read);
    updates.push({
      model,
      prices: { short: inShort, long: inShort, cached, out },
    });
  }

  // ② 白名单新行:库中缺谁插谁（幂等;在库行已被 ① 覆盖,不重复刷）
  for (const row of OPENROUTER_INSERT_ALLOWLIST) {
    if (dbSet.has(row.model)) continue;
    const entry = catalog.get(row.slug);
    if (entry === undefined) {
      // 白名单与目录漂移（目录删行/改 slug）:显式 skip,不静默丢
      skipped.push({ model: row.model, reason: "allowlist-missing-from-or" });
      continue;
    }
    inserts.push(row);
  }

  return { updates, inserts, skipped };
}

/** 数 → D1 REAL 字面量（去尾零;0.036 保持 0.036,不进科学计数）。 */
export function sqlReal(v: number): string {
  const s = v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}