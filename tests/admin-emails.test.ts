// 管理员邮箱名单（ADMIN_EMAILS）测试（11-06-sms-alicloud-auth，PRD R17 / AC31 / AC32，
// design §13.1）。
//
// 两层，刻意分开：
//   A. **纯函数**（parseAdminEmails / isAdminEmail）：解析口径与空名单语义的真实表；
//   B. **真实端点**（POST /api/auth/sign-up/email、POST /api/auth/sign-in/email）：
//      断言两个 databaseHook 的实际效果 —— 一律**直查 D1 的 role 列**，不看响应体
//      （响应 200 不等于角色写对了；效果断言才防「返回看似成功、库中未变」的假绿）。
//
// 判别性纪律（spec shared/assertion-discipline）：
//   - 每个「命中名单」用例都配一个**只差名单内容**的对照（同一邮箱、空名单 ⇒ member）；
//   - 「只升不降」用同一账号先升后撤名单再登录，断言 role 保持 admin（若实现变成无条件 UPDATE，
//     该断言仍绿 —— 故另配一个人工降级 + 名单仍在的用例，证明自动逻辑会重新升上去）。
//
// 提权**不受** EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED 约束：vitest.config.ts 已 pin 该开关为
// "false"（部署缺省），本文件的命中用例在该缺省态下仍然升到 admin —— 这本身就是断言。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { inviteCodes, users } from "../src/db/schema";
import { isAdminEmail, parseAdminEmails } from "../src/lib/admin-emails";
import { applyMigrations, selfFetch, setupUser, withAdminEmails } from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";
const PASSWORD = "admin-emails-pass-123";

let INVITER_ID = 0;
let inviteSeq = 0;

beforeAll(async () => {
  await applyMigrations();
  INVITER_ID = await setupUser("admin-emails-inviter@test.dev", 0, "admin");
});

// ============ 夹具 ============

async function insertInvite(): Promise<string> {
  inviteSeq += 1;
  const code = `ADMEMAIL${String(inviteSeq).padStart(2, "0")}`;
  const db = createDb(env);
  await db.insert(inviteCodes).values({
    code,
    createdBy: INVITER_ID,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return code;
}

/** 真实邮箱注册（返回 HTTP 状态；调用方按需再查库）。 */
async function signUp(email: string): Promise<number> {
  const inviteCode = await insertInvite();
  const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      name: email.split("@")[0] ?? email,
      inviteCode,
    }),
  });
  await res.text(); // 消耗 body，避免悬挂
  return res.status;
}

/** 真实邮箱登录（返回 HTTP 状态）。 */
async function signIn(email: string): Promise<number> {
  const res = await selfFetch("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  await res.text();
  return res.status;
}

async function roleOf(email: string): Promise<string | undefined> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { role: true },
  });
  return row?.role;
}

async function userIdOf(email: string): Promise<number> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(`user "${email}" not found`);
  }
  return row.id;
}

// ============ A. 纯函数 ============

describe("parseAdminEmails / isAdminEmail（纯函数）", () => {
  it("逗号分隔：trim + 小写 + 丢弃空项", () => {
    expect(parseAdminEmails(" Alice@Example.com , bob@example.com ,, ")).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
    // 未配置 / 空串 = 空名单（调用方不需要区分两者）
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails(undefined)).toEqual([]);
    expect(parseAdminEmails(" , , ")).toEqual([]);
  });

  it("名单命中不区分大小写与首尾空白", () => {
    expect(isAdminEmail("alice@example.com", "ALICE@example.com")).toBe(true);
    expect(isAdminEmail(" alice@example.com ", "alice@example.com")).toBe(true);
    expect(isAdminEmail("alice@example.com,bob@example.com", "bob@example.com")).toBe(true);
  });

  it("空名单 / 名单外 / 空邮箱 ⇒ false（且近邻为 true，证明不是恒 false）", () => {
    expect(isAdminEmail("", "alice@example.com")).toBe(false);
    expect(isAdminEmail(undefined, "alice@example.com")).toBe(false);
    expect(isAdminEmail("bob@example.com", "alice@example.com")).toBe(false);
    // 前缀相似但不是同一邮箱（子串匹配会被这条抓住）
    expect(isAdminEmail("notalice@example.com", "alice@example.com")).toBe(false);
    expect(isAdminEmail("alice@example.com", "")).toBe(false);
    // 近邻：同一份名单、同一邮箱的规范化版本必须命中
    expect(isAdminEmail(" alice@example.com ", "Alice@Example.com")).toBe(true);
  });
});

// ============ B. 注册自动提权（user.create.after） ============

describe("注册时自动提权（databaseHooks.user.create.after）", () => {
  it("名单内邮箱：注册即 admin（且不受 EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED=false 约束）", async () => {
    const email = "listed-signup@test.dev";
    await withAdminEmails(email, async () => {
      expect(await signUp(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
    });
  });

  it("对照：同一类注册、空名单 ⇒ member", async () => {
    const email = "unlisted-signup@test.dev";
    // 部署缺省的名单形态（vitest pin ""）——不套 withAdminEmails
    expect(await signUp(email)).toBe(200);
    expect(await roleOf(email)).toBe("member");
  });
});

// ============ B. 登录自动提权（session.create.after） ============

describe("登录时自动提权（databaseHooks.session.create.after）", () => {
  it("账号先存在、后加进名单：下一次登录即 admin", async () => {
    const email = "later-listed@test.dev";
    // 先以空名单注册 ⇒ member
    expect(await signUp(email)).toBe(200);
    expect(await roleOf(email)).toBe("member");

    // 后加名单 → 登录（会话创建）触发提权
    await withAdminEmails(email, async () => {
      expect(await signIn(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
    });
  });

  it("同一账号再次登录（已在名单内、已是 admin）⇒ 仍是 admin（重复登录零写操作）", async () => {
    const email = "repeat-login@test.dev";
    await withAdminEmails(email, async () => {
      expect(await signUp(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
      expect(await signIn(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
    });
  });
});

// ============ B. 只升不降 ============

describe("只升不降", () => {
  it("移出名单后登录 ⇒ 仍保持 admin（自动逻辑从不降级）", async () => {
    const email = "never-demoted@test.dev";
    await withAdminEmails(email, async () => {
      expect(await signUp(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
    });

    // 名单已还原为空（withAdminEmails 的 finally）；再次登录
    expect(await signIn(email)).toBe(200);
    expect(await roleOf(email)).toBe("admin");
  });

  it("人工降级为 member、名单仍在 ⇒ 下一次登录自动升回 admin", async () => {
    const email = "re-promoted@test.dev";
    await withAdminEmails(email, async () => {
      expect(await signUp(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
    });

    // 人工降级（合法运维动作；自动逻辑不得把它当成「不可再升」）
    const userId = await userIdOf(email);
    const db = createDb(env);
    await db.update(users).set({ role: "member" }).where(eq(users.id, userId));
    expect(await roleOf(email)).toBe("member");

    await withAdminEmails(email, async () => {
      expect(await signIn(email)).toBe(200);
      expect(await roleOf(email)).toBe("admin");
    });
  });
});
