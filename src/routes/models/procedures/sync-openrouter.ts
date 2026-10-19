// POST /api/models/sync-openrouter — OpenRouter 价格同步（admin,design §4.1）。
//
// 一次点击 = 拉 OR 公开目录 + buildSyncPlan + 按清单写库:
//   matched 行刷 5 价列（long=short;cached 缺则保留现值）;白名单缺行 INSERT;
//   不 DELETE;maxOutputTokens/freeMode/hiddenFromMembers 不动。
// 挂载在 models router 的 adminOnly **之后**（router.ts 顺序敏感,勿挪）。
import { eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { models } from "../../../db/schema";
import { createDb } from "../../../db";
import {
  buildSyncPlan,
  perMillion,
  type OpenRouterModel,
  type SyncOutcome,
} from "../lib/openrouter-sync";
import { syncOpenrouterOutputSchema, type SyncOpenrouterOutput } from "../types";

/** OR 目录端点（公开无鉴权;加固定超时防挂起请求占连接）。 */
const OR_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OR_FETCH_TIMEOUT_MS = 15_000;

export function syncOpenrouterRoute(app: Hono<AppEnv>): void {
  app.post("/sync-openrouter", async (c) => {
    const logger = c.get("logger");
    const db = createDb(c.env);

    // ① 拉 OR 目录（失败 → 502,不碰库;timeout 用 AbortSignal,Workers 支持）
    let orModels: OpenRouterModel[];
    try {
      const res = await fetch(OR_MODELS_URL, {
        signal: AbortSignal.timeout(OR_FETCH_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        throw new HTTPException(502, {
          message: `OpenRouter catalog fetch failed: ${res.status} ${res.statusText}`,
        });
      }
      const body = (await res.json()) as { data?: OpenRouterModel[] };
      orModels = Array.isArray(body.data) ? body.data : [];
    } catch (error) {
      if (error instanceof HTTPException) throw error;
      logger.error("openrouter_catalog_fetch_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new HTTPException(502, {
        message: "OpenRouter catalog fetch failed",
      });
    }

    // ② 算清单（纯函数;库现状 = 全量 model 名）
    const dbRows = await db.select({ model: models.model }).from(models);
    const plan = buildSyncPlan(
      dbRows.map((r) => r.model),
      orModels,
    );

    // ③ 写库:UPDATE matched 行（5 价列 + updated_at;cached 缺源保留现值 → 拆两式）
    let synced = 0;
    for (const u of plan.updates) {
      const setBase = {
        inputPriceShort: u.prices.short,
        inputPriceLong: u.prices.long,
        outputPriceShort: u.prices.out,
        outputPriceLong: u.prices.out,
        updatedAt: new Date(),
      };
      const affected = await db
        .update(models)
        .set(u.prices.cached === null ? setBase : { ...setBase, inputPriceCached: u.prices.cached })
        .where(eq(models.model, u.model))
        .returning({ id: models.id });
      synced += affected.length;
    }

    // ④ 白名单缺行 INSERT（价取 OR;5 价列同规则,行默认 freeMode/hiddenFromMembers=false）。
    //    过滤分支（entry 缺/无文本价）实际不可达:buildSyncPlan 只把**在目录索引里**的白名单行
    //    放进 inserts,而快照 17 行全有文本价——留着只为兜底改坏,不另计 skipped。
    let inserted = 0;
    const insertRows = plan.inserts
      .map((row) => {
        const entry = orModels.find(
          (m) =>
            m.id === row.slug &&
            !m.id.includes(":") &&
            !m.id.startsWith("~"),
        );
        if (entry === undefined) return null;
        const inShort = perMillion(entry.pricing.prompt);
        const out = perMillion(entry.pricing.completion);
        if (inShort === null || out === null) return null;
        const cached = perMillion(entry.pricing.input_cache_read) ?? 0;
        return {
          model: row.model,
          inputPriceShort: inShort,
          inputPriceLong: inShort,
          inputPriceCached: cached,
          outputPriceShort: out,
          outputPriceLong: out,
          maxOutputTokens: row.maxOutputTokens,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    if (insertRows.length > 0) {
      const res = await db.insert(models).values(insertRows).returning({ id: models.id });
      inserted = res.length;
    }
    // 并发兜底:两 admin 同时点按钮、白名单行撞唯一约束 ⇒ 第二个请求 500,但重放即幂等
    // （行已在库 ⇒ 并入 UPDATE 路径）,无需专门的 409 语义。

    // ⑤ 回显明细（含 skipped reasons;源 URL 供审计回溯）
    const outcome: SyncOutcome = { synced, inserted, skipped: plan.skipped };
    logger.info("model_prices_synced", {
      ...outcome,
      skippedCount: plan.skipped.length,
      source: OR_MODELS_URL,
    });

    const payload: SyncOpenrouterOutput = {
      success: true as const,
      ...outcome,
      source: "openrouter",
      fetchedAt: new Date().toISOString(),
    };
    // 输出 schema 校验（响应形态锁;缺字段/类型漂移此处红）
    const parsed = syncOpenrouterOutputSchema.safeParse(payload);
    if (!parsed.success) {
      logger.error("model_prices_synced_response_invalid", {
        issues: parsed.error.issues.slice(0, 5),
      });
      throw new HTTPException(500, { message: "Sync response validation failed" });
    }
    return c.json(parsed.data);
  });
}