// 重建式迁移的数据保全（09-22-seed-users-dev-only，AC-F9 / 决策 D-F1）。
//
// 这是本仓**第一条重建式迁移**（drizzle 生成的 `__new_*` → INSERT SELECT → DROP → RENAME，
// 见 drizzle/0011_lame_silver_fox.sql：SQLite 无法直接放开 NOT NULL，只能重建表）。
// 重建是唯一能**静默吃数据**的迁移形态 —— `INSERT ... SELECT` 写漏一列、或顺序颠倒，
// 应用「成功」、测试全绿，而生产数据已经丢了。故用专项用例把两件事同时锁死：
//   ① 既有行**原样存活**（含 created_by 原值）；
//   ② 新能力**真的生效**（NULL 签发者从被拒变为可插）—— ② 必须有 ① 的"拒"作为对照，
//      否则「本来就能插 NULL」的实现会平凡满足它。
//
// 做法：先只应用 0011 **之前**的迁移（模拟"生产已运行到 0010、表里已有数据"），插入夹具，
// 再应用 0011，最后断言。applyD1Migrations 按 d1_migrations 表跳过已应用项，故可分两次调用。
import { applyD1Migrations, env } from "cloudflare:test";
import { asc } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { inviteCodes } from "../src/db/schema";

/**
 * 本用例锚定的迁移 = **最后一根重建式迁移**（`__new_*` → INSERT SELECT → DROP → RENAME）。
 *
 * 定位方式是 `findIndex` 按名字找（见下），**不是**取「数组最后一个」—— 故：
 *   - 又加了一根 `ALTER TABLE ADD COLUMN` 类迁移（如 0012）⇒ **本常量不动、本用例不红**；
 *   - 又出现一根**重建式**迁移 ⇒ 把本常量改成那一根（目标换了，夹具才有意义）。
 *
 * 为什么不能「只把字符串从 0011 改成 0012」：本用例的判别力全部来自
 * 「夹具插进**尚未重建**的表 → 跑重建 → 断言既有行存活」。若把一根 ADD COLUMN 迁移当目标，
 * 0011（真正的重建）就会落进 `prior`，夹具插进的是**已被重建完**的表 ——
 * 于是「既有行原样存活」这一步变成**平凡真**。
 *
 * ⚠ 但那种误锚**不会**静默变绿（2026-09-23 实测：把本常量改成 "0012_last_warlock.sql" ⇒ 红）：
 * prior 含 0011 ⇒ created_by 已是可空 ⇒ 第 ① 步「插 NULL 必须被 NOT NULL 拒」拿到空错误链，
 * 用例在 `expect(errorChain(beforeMigration)).toMatch(/NOT NULL/i)` 处**先**红。
 * 即「① 拒 → ② 通过」这对**成对断言**本身就是锚点正确性的守护（锚在重建之前 ⇒ 拒得掉；
 * 锚错 ⇒ 拒不掉）。反方向锚在 0011 之前（如 0010）同样是红：rebuild 没跑，第 ④ 步插 NULL 失败。
 * 故这段注释别再被读成「锚错了也看不出来」—— 锚错**看得出来**，只是红的理由与你以为的不同。
 */
const TARGET_MIGRATION = "0011_lame_silver_fox.sql";

/** 展开错误链（drizzle 包装错误 → D1 原始错误），用于断言底层列约束文案。 */
function errorChain(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur instanceof Error; depth += 1) {
    parts.push(cur.message);
    cur = cur.cause;
  }
  return parts.join(" | ");
}

describe("重建式迁移（invite_codes.created_by 放开 NOT NULL）", () => {
  it("既有行与索引原样存活，且 NULL 签发者由被拒变为可插", async () => {
    // 按名字定位 + 下标切 prior（**不是** `all[all.length - 1]` / `all.slice(0, -1)`）：
    // 目标之后若又加了迁移（如 0012 的 ADD COLUMN），取"最后一个"会锚错对象，
    // 而锚错的后果是**测试变绿且失去判别力**（见 TARGET_MIGRATION 的注释）。
    const all = env.TEST_MIGRATIONS;
    const idx = all.findIndex((m) => m.name === TARGET_MIGRATION);
    expect(idx, `未找到目标迁移 ${TARGET_MIGRATION}（若已重命名/删除请同步本用例）`).toBeGreaterThan(
      -1,
    );
    const target = all[idx];
    const prior = all.slice(0, idx);

    // ---------- ① 跑到 0010，造"生产已有数据"的夹具 ----------
    await applyD1Migrations(env.DB, prior);
    const db = createDb(env);
    // 签发者夹具走**裸 SQL**而非 `db.insert(users)`：本用例的 prior 集合锚定在 0010，
    // 而 Drizzle schema 是**当前**形态 —— 后续任何一根 `users` 的 ADD COLUMN 迁移
    // （如 0014 的 phone_number / phone_number_verified）都会让 schema 生成的 INSERT
    // 列出 0010 时还不存在的列，夹具插入先于断言就 SQLITE_ERROR。
    // 那是夹具与时间线错位，不是被测迁移的缺陷，故这里只写 0010 时确定存在的列。
    // （created_at / updated_at 是 NOT NULL 且**没有** SQL 默认值 —— drizzle 的 $defaultFn
    //  在 JS 侧补值，裸 SQL 必须自己给。）
    const nowSeconds = Math.floor(Date.now() / 1000);
    const issuerResult = await env.DB.prepare(
      "INSERT INTO users (email, name, role, balance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind("mig-issuer@test.dev", "Issuer", "admin", 0, nowSeconds, nowSeconds)
      .run();
    const issuerId = issuerResult.meta.last_row_id;
    // 夹具时间戳取整到秒：`mode: "timestamp"` 的列存的是**秒**，毫秒在写入时即被截断
    // （与本迁移无关；不取整会让下面的"原值不变"断言拿毫秒去比秒）。
    const toSeconds = (ms: number): Date => new Date(Math.floor(ms / 1000) * 1000);
    const expiresAt = toSeconds(Date.now() + 24 * 3600 * 1000);
    const consumedAt = toSeconds(Date.now());
    await db.insert(inviteCodes).values([
      { code: "MIGKEEP001", createdBy: issuerId, expiresAt, usedAt: consumedAt },
      { code: "MIGKEEP002", createdBy: issuerId, expiresAt },
    ]);

    // 对照：0010 的 schema 下 created_by 是 NOT NULL，插入 NULL 必须被**数据库**拒绝。
    // （drizzle 类型上此时已允许 null —— 拒绝来自列约束，正是本迁移要放开的那一条。）
    // 穿透错误链：drizzle 抛的是包装错误（"Failed query: ..."），列约束原文在 cause 里。
    let beforeMigration: unknown;
    try {
      await db.insert(inviteCodes).values({ code: "MIGNULL000", createdBy: null, expiresAt });
    } catch (err) {
      beforeMigration = err;
    }
    expect(errorChain(beforeMigration)).toMatch(/NOT NULL/i);

    // ---------- ② 应用目标迁移（重建 invite_codes）----------
    await applyD1Migrations(env.DB, [target]);

    // ---------- ③ 既有行存活，且 created_by / used_at 原值不变 ----------
    const rows = await db.select().from(inviteCodes).orderBy(asc(inviteCodes.id));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    expect(byCode.has("MIGKEEP001")).toBe(true);
    expect(byCode.has("MIGKEEP002")).toBe(true);
    expect(byCode.get("MIGKEEP001")?.createdBy).toBe(issuerId);
    expect(byCode.get("MIGKEEP002")?.createdBy).toBe(issuerId);
    expect(byCode.get("MIGKEEP001")?.usedAt?.getTime()).toBe(consumedAt.getTime());
    expect(byCode.get("MIGKEEP002")?.usedAt).toBeNull();
    expect(byCode.get("MIGKEEP001")?.expiresAt.getTime()).toBe(expiresAt.getTime());

    // ---------- ④ 新能力生效：NULL 可插（③ 的对照）----------
    const inserted = await db
      .insert(inviteCodes)
      .values({ code: "MIGNULL001", createdBy: null, expiresAt })
      .returning();
    expect(inserted[0]?.createdBy).toBeNull();

    // ---------- ⑤ 重建没有丢结构：两个索引 + 一条指向 users 的外键仍在 ----------
    // （唯一索引在重建里是 DROP 之后**重建**的 —— 漏掉它不会有任何功能用例变红。）
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invite_codes'",
    ).all<{ name: string }>();
    const indexNames = indexes.results.map((r) => r.name).sort();
    expect(indexNames).toContain("invite_codes_created_by_idx");
    expect(indexNames).toContain("invite_codes_code_idx");
    expect(indexNames).toContain("invite_codes_code_unique");

    const fks = await env.DB.prepare("PRAGMA foreign_key_list(invite_codes)").all<{
      table: string;
      from: string;
    }>();
    expect(fks.results).toHaveLength(1);
    expect(fks.results[0]?.table).toBe("users");
    expect(fks.results[0]?.from).toBe("created_by");
  });
});
