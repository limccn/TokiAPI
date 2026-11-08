// 赠金资格迁移专项（11-08-reward-semantics-overhaul，AC9）。
//
// 被测语义只有一句话：**迁移时刻已存在的行永久无赠金资格，此后新建的行有资格**。
// 它是本仓唯一一根「结构迁移 + 业务回填」混合的迁移（drizzle 只生成 ADD COLUMN，末尾的
// `UPDATE users SET bonus_eligible = false` 是手工追加的）。漏掉那条 UPDATE 不会让任何
// 功能用例变红 —— 只会让存量账号悄悄具备资格（多发钱的静默故障），故必须单独立锁。
//
// 手法与 tests/migration-rebuild.test.ts 同源：先只应用目标迁移**之前**的迁移集（模拟
// 「生产已运行到 0014、表里已有数据」），插夹具，再应用目标迁移，最后断言。
// applyD1Migrations 按 d1_migrations 表跳过已应用项，故可分两次调用。
import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * 本用例锚定的迁移 = 引入 `users.bonus_eligible` 的那一根。
 *
 * 按名字定位（`findIndex`），**不是**取「数组最后一个」：之后再加任何迁移都不该让本用例变红
 * （夹具锚在目标**之前**的时间线，目标换了就失去意义）。重命名 / 重建迁移时同步本常量。
 */
const TARGET_MIGRATION = "0015_gifted_killmonger.sql";

describe("迁移 0015：bonus_eligible 回填（存量冻结 / 新行有资格）", () => {
  it("AC9：迁移前存在的行 → 0；迁移后新建（不给该列）→ 1；索引谓词与标记列同时到位", async () => {
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name === TARGET_MIGRATION);
    expect(
      idx,
      `未找到目标迁移 ${TARGET_MIGRATION}（若已重命名/删除请同步本用例）`,
    ).toBeGreaterThan(-1);
    const target = all[idx];
    const prior = all.slice(0, idx);

    // ---------- ① 跑到 0014，造「生产已有用户」的夹具 ----------
    await applyD1Migrations(env.DB, prior);
    // 夹具走**裸 SQL**：Drizzle schema 是**当前**形态，`db.insert(users)` 会列出 0014 时
    // 还不存在的 bonus_eligible / github_bind_bonus_granted_at 列，夹具先于断言就 SQLITE_ERROR。
    // 只写 0014 时确定存在的列（created_at / updated_at 是 NOT NULL 且无 SQL 默认值 ——
    // drizzle 的 $defaultFn 在 JS 侧补值，裸 SQL 必须自己给；`timestamp` 模式存**秒**）。
    const nowSeconds = Math.floor(Date.now() / 1000);
    const legacy = await env.DB.prepare(
      "INSERT INTO users (email, name, role, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("bonus-mig-legacy@test.dev", "Legacy", "member", 0, nowSeconds, nowSeconds)
      .run();
    const legacyId = legacy.meta.last_row_id;

    // ---------- ② 应用目标迁移 ----------
    await applyD1Migrations(env.DB, [target]);

    // ---------- ③ 存量行被冻结（漏掉手工 UPDATE 时这里会是 0 → 1 的差别）----------
    const legacyRow = await env.DB.prepare(
      "SELECT bonus_eligible FROM users WHERE id = ?",
    )
      .bind(legacyId)
      .first<{ bonus_eligible: number }>();
    expect(legacyRow?.bonus_eligible).toBe(0);

    // ---------- ④ 对照：迁移后新建的行（**不写**该列）按 DEFAULT 具备资格 ----------
    const fresh = await env.DB.prepare(
      "INSERT INTO users (email, name, role, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("bonus-mig-fresh@test.dev", "Fresh", "member", 0, nowSeconds, nowSeconds)
      .run();
    const freshRow = await env.DB.prepare(
      "SELECT bonus_eligible FROM users WHERE id = ?",
    )
      .bind(fresh.meta.last_row_id)
      .first<{ bonus_eligible: number }>();
    expect(freshRow?.bonus_eligible).toBe(1);

    // ---------- ⑤ 部分唯一索引的谓词已扩到第三档（少一档 = github_bind 可重复写流水）----------
    const indexRow = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'balance_tx_bonus_once_idx'",
    ).first<{ sql: string | null }>();
    expect(indexRow?.sql).toContain("github_bind_bonus");
    expect(indexRow?.sql).toContain("signup_bonus");
    expect(indexRow?.sql).toContain("email_verify_bonus");

    // ---------- ⑥ 新标记列真的存在 ----------
    const columns = await env.DB.prepare("PRAGMA table_info(users)").all<{
      name: string;
    }>();
    expect(columns.results.map((c) => c.name)).toContain("github_bind_bonus_granted_at");
    expect(columns.results.map((c) => c.name)).toContain("bonus_eligible");
  });
});
