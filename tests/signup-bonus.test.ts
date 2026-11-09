// 赠金三档集成测试（09-16-signup-bonus-grant；11-08-reward-semantics-overhaul 改语义）。
//
// 覆盖（新语义真源见 PRD 语义矩阵）：
//   AC1   邮箱密码注册 → **不发**赠金（建号不再等于赠金触发点）
//   AC4   邮箱验证 → email_verify_bonus（余额 0 → 5，重复验证不重复）
//   AC5/6 GitHub 绑定赠金：已有手机号 / 已有 credential 账户行 → 发放
//   AC7   GitHub 绑定赠金：OAuth 直接注册形状（既无手机也无 credential）→ 不发；非 github provider → 不发
//   AC8   存量账号（bonus_eligible=false）三档全部冻结（含成对对照：资格 true 时三档各发一次）
//   AC10  金额分支矩阵（三档；含 SIGNUP / EMAIL_VERIFY 既有分支不回归）
//   AC11  流水按 type 可筛选（三档各自，含 admin 视角）+ 未知 type 400
//   AC12  幂等与并发 + 部分唯一索引兜底
//
// 已知覆盖缺口（刻意为之，不是遗漏）：
//   **真实 GitHub OAuth 回调（linkSocial / 首登）无自动化测试**：触发 OAuth 回调需模拟
//   GitHub 的 token/userinfo 交换，成本远超收益。缓解方式：
//     1) 触发点是 databaseHooks.account.create.after 的结构接线，判定只读库内事实
//        （users.phone_number / accounts.provider_id），本文件直调包装覆盖三分支；
//     2) OAuth 路径由维护者线上手工验证（交付报告「待办」）。
//
// 金额分支为什么不用端到端注册覆盖：miniflare bindings 在测试进程内固定，无法逐用例改 env
// ——因此金额矩阵走「纯函数（bonus.unit.test.ts）+ 直接调用包装注入 env」，
// 端到端只钉默认值（sms-auth.test.ts 的 AC7 钉 phone-number 接线上的 5）。
import { env } from "cloudflare:test";
import { createEmailVerificationToken } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import type { Db } from "../src/db";
import { accounts, balanceTx, inviteCodes, users } from "../src/db/schema";
import { createAuth } from "../src/lib/auth";
import {
  grantBonusOnce,
  grantEmailVerifyBonus,
  grantGithubBindBonus,
  grantSignupBonus,
} from "../src/lib/bonus";
import type { Logger } from "../src/lib/logger";
import {
  applyMigrations,
  countTxByType,
  createSession,
  getBalance,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

let ADMIN_ID = 0;
let inviteSeq = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("sb-admin@test.dev", 0, "admin");
});

/** 造一张一次性邀请码（邮箱密码注册路径的准入门槛）。 */
async function insertInvite(): Promise<string> {
  const db = createDb(env);
  inviteSeq += 1;
  const code = `SBTEST${String(inviteSeq).padStart(2, "0")}`;
  await db.insert(inviteCodes).values({
    code,
    createdBy: ADMIN_ID,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return code;
}

/** 走真实注册端点建号（带邀请码），返回自增 id 与响应。 */
async function signUp(email: string): Promise<{ res: Response; userId: number }> {
  const inviteCode = await insertInvite();
  const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password: "testpass123",
      name: email.split("@")[0] ?? email,
      inviteCode,
    }),
  });
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.email, email),
    columns: { id: true },
  });
  if (!row) {
    throw new Error(`signup did not create user ${email} (status ${res.status})`);
  }
  return { res, userId: row.id };
}

async function userRow(userId: number) {
  const db = createDb(env);
  const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!row) {
    throw new Error("user not found");
  }
  return row;
}

async function txRows(userId: number, type: string) {
  const db = createDb(env);
  return db
    .select()
    .from(balanceTx)
    .where(and(eq(balanceTx.userId, userId), eq(balanceTx.type, type)));
}

/** 给用户补一个已验证手机号（GitHub 绑定档的「注册证据」之一）。 */
async function attachPhone(userId: number, phoneNumber: string): Promise<void> {
  const db = createDb(env);
  await db
    .update(users)
    .set({ phoneNumber, phoneNumberVerified: true })
    .where(eq(users.id, userId));
}

/** 捕获式 logger（断言 fail-open 的 catch 分支确实记录了错误日志 / 策略跳过留痕）。 */
function capturingLogger(): {
  logger: Logger;
  events: Array<{ level: string; message: string; fields?: Record<string, unknown> }>;
} {
  const events: Array<{ level: string; message: string; fields?: Record<string, unknown> }> = [];
  const record =
    (level: string) =>
    (message: string, fields?: Record<string, unknown>) => {
      events.push(fields !== undefined ? { level, message, fields } : { level, message });
    };
  return {
    logger: { info: record("info"), warn: record("warn"), error: record("error") },
    events,
  };
}

/** 取指定 message 的事件（断言时多数用例只关心一类）。 */
function eventsOf(
  events: Array<{ level: string; message: string; fields?: Record<string, unknown> }>,
  message: string,
) {
  return events.filter((e) => e.message === message);
}

/**
 * 「D1 不可用」测试替身：链式查询方法返回自身，batch 与资格预读（query.users.findFirst）抛错 ——
 * 用来验证三档包装的 fail-open 分支真的吞掉异常、且不阻断主流程。
 *
 * 资格预读是包装内的**第一步**库操作（D5：batch 之外），故 `query` 必须一并抛错，
 * 否则日志里的 error 文本来自 batch 阶段而偏离真实故障点。
 */
function brokenDb(): Db {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const method of ["set", "where", "returning", "values", "onConflictDoNothing"]) {
    chain[method] = self;
  }
  return {
    update: () => chain,
    insert: () => chain,
    query: {
      users: {
        findFirst: async () => {
          throw new Error("d1 unavailable");
        },
      },
    },
    batch: async () => {
      throw new Error("d1 unavailable");
    },
  } as unknown as Db;
}

describe("AC1 邮箱密码注册不再发放赠金（语义变更，不是回归）", () => {
  it("AC1：注册成功 → 余额 0、无 signup_bonus 流水、三个标记列均 NULL", async () => {
    const email = "sb-signup@test.dev";
    const { res, userId } = await signUp(email);
    expect([200, 201]).toContain(res.status);

    expect(await getBalance(userId)).toBe(0);
    expect(await countTxByType(userId, "signup_bonus")).toBe(0);

    const row = await userRow(userId);
    expect(row.signupBonusGrantedAt).toBeNull();
    expect(row.emailVerifyBonusGrantedAt).toBeNull();
    expect(row.githubBindBonusGrantedAt).toBeNull();
  });

  it("流水可辨识：signup_bonus 与 usage/adjust 各自独立可数", async () => {
    const userId = await setupUser("sb-typeisolated@test.dev", 0);
    const db = createDb(env);
    await db.insert(balanceTx).values({ userId, amount: -1, type: "usage", note: "usage: x" });
    await db.insert(balanceTx).values({ userId, amount: 3, type: "adjust", note: "manual" });
    await grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus");

    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await countTxByType(userId, "adjust")).toBe(1);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
  });
});

describe("AC4 邮箱验证赠金（createEmailVerificationToken → GET /api/auth/verify-email）", () => {
  it("AC4：验证成功 → emailVerified 置 true，余额 0 → 5，恰 1 条 email_verify_bonus 流水", async () => {
    const email = "sb-verify@test.dev";
    const { userId } = await signUp(email);
    expect(await getBalance(userId)).toBe(0); // 建号不再赠金（基线 0）

    const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    const res = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(200);

    const row = await userRow(userId);
    expect(row.emailVerified).toBe(true);
    expect(await getBalance(userId)).toBe(5);
    const rows = await txRows(userId, "email_verify_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(5);
    expect(row.emailVerifyBonusGrantedAt).not.toBeNull();
    // 另两档未被邮箱验证顺带触发（三档互相独立）
    expect(row.signupBonusGrantedAt).toBeNull();
    expect(row.githubBindBonusGrantedAt).toBeNull();
  });

  it("AC4：重复调用验证端点（已 emailVerified）→ 余额与流水条数不变", async () => {
    const email = "sb-verify-twice@test.dev";
    const { userId } = await signUp(email);

    const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    const first = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(first.status).toBe(200);
    const balanceAfterFirst = await getBalance(userId);
    expect(balanceAfterFirst).toBe(5);

    // 同 token 二次调用 + 新 token 再来一次：都不得再发钱
    const again = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(token)}`,
    );
    expect(again.status).toBe(200);
    const freshToken = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
    const third = await selfFetch(
      `http://localhost/api/auth/verify-email?token=${encodeURIComponent(freshToken)}`,
    );
    expect(third.status).toBe(200);

    expect(await getBalance(userId)).toBe(balanceAfterFirst);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
  });
});

describe("AC12 幂等与并发（直接调用发放原语）", () => {
  it("AC12：同一用户同一档并发两次 → 只有一次 granted，余额只增一次，流水一行", async () => {
    const userId = await setupUser("sb-concurrent@test.dev", 0);
    const db = createDb(env);

    const [a, b] = await Promise.all([
      grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus"),
      grantBonusOnce(db, userId, "signup_bonus", 5, "signup bonus"),
    ]);

    const grantedCount = [a, b].filter((r) => r.granted).length;
    expect(grantedCount).toBe(1);
    expect(await getBalance(userId)).toBe(5);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
  });

  it("AC12：三档互不干扰 —— 各自发一次后重复调用不再发", async () => {
    const userId = await setupUser("sb-both@test.dev", 0);
    const db = createDb(env);

    for (const type of ["signup_bonus", "email_verify_bonus", "github_bind_bonus"] as const) {
      await grantBonusOnce(db, userId, type, 5, `${type} note`);
    }
    const repeats = await Promise.all(
      (["signup_bonus", "email_verify_bonus", "github_bind_bonus"] as const).map((type) =>
        grantBonusOnce(db, userId, type, 5, `${type} note`),
      ),
    );

    expect(repeats.every((r) => !r.granted)).toBe(true);
    expect(await getBalance(userId)).toBe(15);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(1);
  });

  it("AC12：部分唯一索引兜底 —— 三档直接重复插入均被拒，usage 多行不受影响", async () => {
    const userId = await setupUser("sb-index@test.dev", 0);
    const db = createDb(env);

    for (const type of ["signup_bonus", "email_verify_bonus", "github_bind_bonus"] as const) {
      await db.insert(balanceTx).values({ userId, amount: 5, type });
      // 第二次直接插入（不走 onConflictDoNothing）必须被部分唯一索引拒绝
      await expect(db.insert(balanceTx).values({ userId, amount: 5, type })).rejects.toThrow();
    }

    // usage：索引只覆盖三个赠金 type，多行仍可写
    await db.insert(balanceTx).values({ userId, amount: -1, type: "usage" });
    await db.insert(balanceTx).values({ userId, amount: -2, type: "usage" });
    await expect(countTxByType(userId, "usage")).resolves.toBe(2);
  });
});

describe("AC8 存量账号资格门控（users.bonus_eligible）", () => {
  it("AC8：冻结账号三档全部不发 —— 余额不变、流水 0、三标记 NULL、日志 reason=ineligible", async () => {
    const userId = await setupUser("sb-frozen@test.dev", 3);
    await attachPhone(userId, "+8613700000001");
    const db = createDb(env);
    await db.update(users).set({ bonusEligible: false }).where(eq(users.id, userId));
    const { logger, events } = capturingLogger();

    await grantSignupBonus({}, db, logger, userId);
    await grantEmailVerifyBonus({}, db, logger, userId);
    await grantGithubBindBonus({}, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(3);
    expect(await countTxByType(userId, "signup_bonus")).toBe(0);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(0);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(0);
    const row = await userRow(userId);
    expect(row.signupBonusGrantedAt).toBeNull();
    expect(row.emailVerifyBonusGrantedAt).toBeNull();
    expect(row.githubBindBonusGrantedAt).toBeNull();

    // 三档都是「策略性跳过」（与金额 0 的跳过区分：那条不带 reason）
    const skipped = eventsOf(events, "bonus_grant_skipped");
    expect(skipped).toHaveLength(3);
    expect(skipped.map((e) => e.fields?.["type"]).sort()).toEqual([
      "email_verify_bonus",
      "github_bind_bonus",
      "signup_bonus",
    ]);
    expect(skipped.every((e) => e.fields?.["reason"] === "ineligible")).toBe(true);
    expect(events.filter((e) => e.message === "bonus_granted")).toHaveLength(0);
  });

  it("AC8 对照：同一构造、资格 true → 三档各发一次（证明上面的「不发」不是 helper 恒假的假绿）", async () => {
    const userId = await setupUser("sb-eligible@test.dev", 0);
    await attachPhone(userId, "+8613700000002");
    const db = createDb(env);
    const { logger, events } = capturingLogger();

    await grantSignupBonus({}, db, logger, userId);
    await grantEmailVerifyBonus({}, db, logger, userId);
    await grantGithubBindBonus({}, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(15);
    expect(await countTxByType(userId, "signup_bonus")).toBe(1);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(1);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(1);
    const row = await userRow(userId);
    expect(row.bonusEligible).toBe(true);
    expect(row.signupBonusGrantedAt).not.toBeNull();
    expect(row.emailVerifyBonusGrantedAt).not.toBeNull();
    expect(row.githubBindBonusGrantedAt).not.toBeNull();
    expect(events.filter((e) => e.message === "bonus_granted")).toHaveLength(3);
  });
});

describe("AC5/AC6/AC7 GitHub 绑定赠金（直接调用 grantGithubBindBonus）", () => {
  it("AC5：providerId=github + 用户已有手机号 → 发 5、1 条流水、标记置位；再调一次不重复", async () => {
    const userId = await setupUser("sb-gh-phone@test.dev", 0);
    await attachPhone(userId, "+8613700000011");
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantGithubBindBonus({}, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(5);
    const rows = await txRows(userId, "github_bind_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(5);
    expect(rows[0]?.note).toBe("github linked bonus");
    expect((await userRow(userId)).githubBindBonusGrantedAt).not.toBeNull();

    // 重复触发（如再次 OAuth 登录 / 重新绑定）不重复发放
    await grantGithubBindBonus({}, db, logger, userId, "github");
    expect(await getBalance(userId)).toBe(5);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(1);
  });

  it("AC6：providerId=github + 用户无手机但有 credential 账户行 → 发 5", async () => {
    const userId = await setupUser("sb-gh-cred@test.dev", 0);
    const db = createDb(env);
    await db.insert(accounts).values({
      issuer: "local",
      accountId: `cred-${userId}`,
      providerId: "credential",
      userId,
    });
    const { logger } = capturingLogger();

    await grantGithubBindBonus({}, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(5);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(1);
    expect((await userRow(userId)).githubBindBonusGrantedAt).not.toBeNull();
  });

  it("AC7：两者皆无（OAuth 直接注册形状）→ 不发，日志 reason=signup_evidence_missing（与上两条成对）", async () => {
    const userId = await setupUser("sb-gh-oauth@test.dev", 0);
    const db = createDb(env);
    const { logger, events } = capturingLogger();

    await grantGithubBindBonus({}, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(0);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(0);
    expect((await userRow(userId)).githubBindBonusGrantedAt).toBeNull();

    const skipped = eventsOf(events, "bonus_grant_skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.fields?.["reason"]).toBe("signup_evidence_missing");
    expect(skipped[0]?.fields?.["type"]).toBe("github_bind_bonus");
  });

  it("AC7：providerId 非 github（google / credential）→ 静默不发、零日志", async () => {
    const db = createDb(env);
    const googleUser = await setupUser("sb-gh-google@test.dev", 0);
    await attachPhone(googleUser, "+8613700000012");
    const credUser = await setupUser("sb-gh-credprovider@test.dev", 0);
    await attachPhone(credUser, "+8613700000013");
    const { logger, events } = capturingLogger();

    await grantGithubBindBonus({}, db, logger, googleUser, "google");
    await grantGithubBindBonus({}, db, logger, credUser, "credential");

    expect(await getBalance(googleUser)).toBe(0);
    expect(await getBalance(credUser)).toBe(0);
    expect(await countTxByType(googleUser, "github_bind_bonus")).toBe(0);
    expect(await countTxByType(credUser, "github_bind_bonus")).toBe(0);
    // 非 github provider 不是配置错误：不查库、不写日志（连跳过日志都没有）
    expect(events).toHaveLength(0);
  });

  it("AC12：并发两次 grantBonusOnce(github_bind_bonus) → 一次 granted", async () => {
    const userId = await setupUser("sb-gh-concurrent@test.dev", 0);
    const db = createDb(env);

    const [a, b] = await Promise.all([
      grantBonusOnce(db, userId, "github_bind_bonus", 5, "github linked bonus"),
      grantBonusOnce(db, userId, "github_bind_bonus", 5, "github linked bonus"),
    ]);

    expect([a, b].filter((r) => r.granted)).toHaveLength(1);
    expect(await getBalance(userId)).toBe(5);
    expect(await countTxByType(userId, "github_bind_bonus")).toBe(1);
  });
});

describe("AC10 金额分支（直接调用包装注入 env）", () => {
  it("AC10：SIGNUP_BONUS_AMOUNT=0 → 不发放（余额不变、无流水、标记仍 NULL）", async () => {
    const userId = await setupUser("sb-zero@test.dev", 3);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "0" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(3);
    expect(await countTxByType(userId, "signup_bonus")).toBe(0);
    expect((await userRow(userId)).signupBonusGrantedAt).toBeNull();
  });

  it("AC10：SIGNUP_BONUS_AMOUNT=abc（非法）→ 行为同 0（不发放、不抛错）", async () => {
    const userId = await setupUser("sb-invalid@test.dev", 3);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "abc" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(3);
    expect(await countTxByType(userId, "signup_bonus")).toBe(0);
    expect((await userRow(userId)).signupBonusGrantedAt).toBeNull();
  });

  it("AC10：SIGNUP_BONUS_AMOUNT=8 → 发放 8（配置生效）", async () => {
    const userId = await setupUser("sb-eight@test.dev", 0);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "8" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(8);
    const rows = await txRows(userId, "signup_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(8);
    expect((await userRow(userId)).signupBonusGrantedAt).not.toBeNull();
  });

  it("AC10：SIGNUP_BONUS_AMOUNT 未配置 → 取默认 5", async () => {
    const userId = await setupUser("sb-default@test.dev", 0);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantSignupBonus({}, db, logger, userId);

    expect(await getBalance(userId)).toBe(5);
  });

  it("AC10：EMAIL_VERIFY_BONUS_AMOUNT=0 → 不发放（标记仍 NULL）", async () => {
    const userId = await setupUser("sb-ev-zero@test.dev", 4);
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantEmailVerifyBonus({ EMAIL_VERIFY_BONUS_AMOUNT: "0" }, db, logger, userId);

    expect(await getBalance(userId)).toBe(4);
    expect(await countTxByType(userId, "email_verify_bonus")).toBe(0);
    expect((await userRow(userId)).emailVerifyBonusGrantedAt).toBeNull();
  });

  it("AC10：GITHUB_BIND_BONUS_AMOUNT=8 → 发放 8", async () => {
    const userId = await setupUser("sb-gh-eight@test.dev", 0);
    await attachPhone(userId, "+8613700000021");
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantGithubBindBonus({ GITHUB_BIND_BONUS_AMOUNT: "8" }, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(8);
    const rows = await txRows(userId, "github_bind_bonus");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(8);
  });

  it("AC10：GITHUB_BIND_BONUS_AMOUNT=0 / abc → 不发放、不抛错、标记 NULL", async () => {
    for (const raw of ["0", "abc"]) {
      const userId = await setupUser(`sb-gh-off-${raw === "0" ? "zero" : "bad"}@test.dev`, 2);
      await attachPhone(userId, raw === "0" ? "+8613700000022" : "+8613700000023");
      const db = createDb(env);
      const { logger } = capturingLogger();

      await expect(
        grantGithubBindBonus({ GITHUB_BIND_BONUS_AMOUNT: raw }, db, logger, userId, "github"),
      ).resolves.toBeUndefined();

      expect(await getBalance(userId)).toBe(2);
      expect(await countTxByType(userId, "github_bind_bonus")).toBe(0);
      expect((await userRow(userId)).githubBindBonusGrantedAt).toBeNull();
    }
  });

  it("AC10：GITHUB_BIND_BONUS_AMOUNT 未配置 → 取默认 5", async () => {
    const userId = await setupUser("sb-gh-default@test.dev", 0);
    await attachPhone(userId, "+8613700000024");
    const db = createDb(env);
    const { logger } = capturingLogger();

    await grantGithubBindBonus({}, db, logger, userId, "github");

    expect(await getBalance(userId)).toBe(5);
  });
});

describe("fail-open（赠金异常不得阻断主流程）", () => {
  it("注册赠金遇 DB 异常 → 不抛，且记录 bonus_grant_failed 错误日志", async () => {
    const { logger, events } = capturingLogger();

    await expect(
      grantSignupBonus({ SIGNUP_BONUS_AMOUNT: "5" }, brokenDb(), logger, 1),
    ).resolves.toBeUndefined();

    const errors = events.filter(
      (e) => e.level === "error" && e.message === "bonus_grant_failed",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.["userId"]).toBe(1);
    expect(errors[0]?.fields?.["type"]).toBe("signup_bonus");
    expect(String(errors[0]?.fields?.["error"])).toContain("d1 unavailable");
  });

  it("验证赠金遇 DB 异常 → 同样不抛（验证流程不受影响）", async () => {
    const { logger, events } = capturingLogger();

    await expect(
      grantEmailVerifyBonus({ EMAIL_VERIFY_BONUS_AMOUNT: "5" }, brokenDb(), logger, 2),
    ).resolves.toBeUndefined();

    expect(
      events.filter((e) => e.level === "error" && e.message === "bonus_grant_failed"),
    ).toHaveLength(1);
  });

  it("GitHub 绑定赠金遇 DB 异常 → 同样不抛（OAuth 回调链不受影响）", async () => {
    const { logger, events } = capturingLogger();

    await expect(
      grantGithubBindBonus({ GITHUB_BIND_BONUS_AMOUNT: "5" }, brokenDb(), logger, 3, "github"),
    ).resolves.toBeUndefined();

    const errors = events.filter(
      (e) => e.level === "error" && e.message === "bonus_grant_failed",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.["type"]).toBe("github_bind_bonus");
    expect(String(errors[0]?.fields?.["error"])).toContain("d1 unavailable");
  });

  it("发放原语对不存在的用户由 FK 约束暴露（整批回滚，钱不会凭空落账）", async () => {
    const db = createDb(env);
    // balance_tx.user_id → users.id 外键：不存在的用户会让 batch 整体失败（同 chargeUsage 语义）；
    // 上层包装（grantSignupBonus）负责吞掉它 —— 故端点不会因此 5xx。
    await expect(
      grantBonusOnce(db, 999_999, "signup_bonus", 5, "signup bonus"),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});

describe("EMAIL_VERIFICATION_ENABLED 门控（后端侧）", () => {
  // 开关语义是「关闭 ⇒ 整个 emailVerification 段不配置」（而非配置了但内部 no-op）——
  // 直接对 createAuth 的产物断言，比走端点更能钉住这条结构性保证。
  it("关闭时 auth.options.emailVerification 为 undefined（不发信、不发验证赠金）", async () => {
    const db = createDb(env);
    const auth = createAuth({ ...env, EMAIL_VERIFICATION_ENABLED: "false" }, db);
    expect(auth.options.emailVerification).toBeUndefined();
  });

  it("开启时 emailVerification 段存在，sendOnSignUp 与验证赠金钩子均已接线", async () => {
    const db = createDb(env);
    const auth = createAuth({ ...env, EMAIL_VERIFICATION_ENABLED: "true" }, db);
    expect(auth.options.emailVerification?.sendOnSignUp).toBe(true);
    expect(typeof auth.options.emailVerification?.afterEmailVerification).toBe("function");
  });

  it("两种开关取值下都不动 emailAndPassword（注册响应形状零变更的前提）", async () => {
    const db = createDb(env);
    for (const flag of ["false", "true"]) {
      const auth = createAuth({ ...env, EMAIL_VERIFICATION_ENABLED: flag }, db);
      expect(auth.options.emailAndPassword?.enabled).toBe(true);
      // 用 `in` 而非属性访问：createAuth 的返回类型是窄化字面量，
      // 而这里要断言的正是「该键根本不存在」。
      const emailAndPassword: object = auth.options.emailAndPassword ?? {};
      expect("requireEmailVerification" in emailAndPassword).toBe(false);
      expect("autoSignIn" in emailAndPassword).toBe(false);
    }
  });
});

describe("AC11 流水筛选（三档 type 各自可筛 + 未知 type 400）", () => {
  it("GET /api/me/transactions?type=signup_bonus 可筛出赠金流水（直调包装造流水，不依赖注册路径）", async () => {
    const userId = await setupUser("sb-filter@test.dev", 0);
    const db = createDb(env);
    const { logger } = capturingLogger();
    await grantSignupBonus({}, db, logger, userId);
    const cookie = sessionCookie(await createSession(userId));

    const res = await selfFetch(
      "http://localhost/api/me/transactions?type=signup_bonus",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: Array<{ type: string; amount: number; note: string | null }>;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.type).toBe("signup_bonus");
    expect(body.items[0]?.amount).toBe(5);
  });

  it("GET /api/admin/transactions?type=email_verify_bonus（admin 视角同口径）", async () => {
    const userId = await setupUser("sb-filter-admin@test.dev", 0);
    const db = createDb(env);
    const { logger } = capturingLogger();
    await grantEmailVerifyBonus({}, db, logger, userId);

    const adminCookie = sessionCookie(await createSession(ADMIN_ID));
    const res = await selfFetch(
      `http://localhost/api/admin/transactions?type=email_verify_bonus&userId=${userId}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      items: Array<{ type: string; amount: number }>;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]?.type).toBe("email_verify_bonus");
    expect(body.items[0]?.amount).toBe(5);
  });

  it("AC11：github_bind_bonus 在 member 与 admin 两个筛选面都可筛出", async () => {
    const userId = await setupUser("sb-filter-gh@test.dev", 0);
    await attachPhone(userId, "+8613700000031");
    const db = createDb(env);
    const { logger } = capturingLogger();
    await grantGithubBindBonus({}, db, logger, userId, "github");

    const cookie = sessionCookie(await createSession(userId));
    const meRes = await selfFetch(
      "http://localhost/api/me/transactions?type=github_bind_bonus",
      { headers: { Cookie: cookie } },
    );
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as {
      total: number;
      items: Array<{ type: string; amount: number }>;
    };
    expect(meBody.total).toBe(1);
    expect(meBody.items[0]?.type).toBe("github_bind_bonus");
    expect(meBody.items[0]?.amount).toBe(5);

    const adminCookie = sessionCookie(await createSession(ADMIN_ID));
    const adminRes = await selfFetch(
      `http://localhost/api/admin/transactions?type=github_bind_bonus&userId=${userId}`,
      { headers: { Cookie: adminCookie } },
    );
    expect(adminRes.status).toBe(200);
    const adminBody = (await adminRes.json()) as {
      total: number;
      items: Array<{ type: string }>;
    };
    expect(adminBody.total).toBe(1);
    expect(adminBody.items[0]?.type).toBe("github_bind_bonus");
  });

  it("AC11：未知 type 仍被入参校验拒绝（400）", async () => {
    const userId = await setupUser("sb-filter-unknown@test.dev", 0);
    const cookie = sessionCookie(await createSession(userId));
    const res = await selfFetch(
      "http://localhost/api/me/transactions?type=unknown_bonus",
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(400);
  });
});
