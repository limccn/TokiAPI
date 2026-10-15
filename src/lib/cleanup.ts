// M5 5.4 明细保留期清理：scheduled cron 按保留期删除过期 request_logs（默认 30 天，env 可配置）。
// D1 大批量删除分批执行（每批 DELETE ... LIMIT 500），避免单条超大语句与长事务；
// 达到单次运行上限（MAX_CHUNKS × 500 行）时截断并记 warn（cron 执行时长防护）。
import { inArray, lt } from "drizzle-orm";
import type { Db } from "../db";
import { balanceTx, requestLogs } from "../db/schema";
import type { Logger } from "./logger";

export const DEFAULT_RETENTION_DAYS = 30;

const DELETE_CHUNK_SIZE = 500;
const MAX_CHUNKS = 400;

/** 解析保留天数配置（env 字符串）：非法/缺失回退默认 30。 */
export function parseRetentionDays(raw: string | undefined): number {
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_RETENTION_DAYS;
  }
  return parsed;
}

export interface CleanupResult {
  deleted: number;
  truncated: boolean;
}

/** 删除 created_at 早于 cutoff 的明细（分批 LIMIT），返回删除总数与是否触顶截断。 */
export async function runRequestLogCleanup(
  db: Db,
  retentionDays: number,
  logger: Logger,
): Promise<CleanupResult> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  let truncated = false;

  for (let chunk = 0; chunk < MAX_CHUNKS; chunk++) {
    // D1 PRAGMA foreign_keys=1（实测）：balance_tx.ref_request_id 引用
    // request_logs.id 且无 ON DELETE 动作 → 直接删被引用行会整批撞 FK 报错。
    // 先取本批待删 id 并置空流水追溯指针（流水行保留，仅断明细跳转），再删明细。
    const victims = await db
      .select({ id: requestLogs.id })
      .from(requestLogs)
      .where(lt(requestLogs.createdAt, cutoff))
      .limit(DELETE_CHUNK_SIZE);
    if (victims.length === 0) {
      break;
    }
    const ids = victims.map((v) => v.id);
    await db
      .update(balanceTx)
      .set({ refRequestId: null })
      .where(inArray(balanceTx.refRequestId, ids));
    const result = await db
      .delete(requestLogs)
      .where(inArray(requestLogs.id, ids))
      .run();
    deleted += result.meta.changes;
    if (result.meta.changes < DELETE_CHUNK_SIZE) {
      break;
    }
    if (chunk === MAX_CHUNKS - 1) {
      truncated = true;
    }
  }

  if (truncated) {
    logger.warn("request_log_cleanup_truncated", {
      retentionDays,
      cutoff: cutoff.toISOString(),
      deleted,
    });
  } else {
    logger.info("request_log_cleanup", {
      retentionDays,
      cutoff: cutoff.toISOString(),
      deleted,
    });
  }
  return { deleted, truncated };
}
