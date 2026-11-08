// 用户管理：手机号列与解绑登录方式（11-08-reward-semantics-overhaul，R10 / design §14/§15.1）。
//
// 本文件钉的是**库内效果**，不是「返回了 200」：
//   - 成功用例直查 accounts / users（行消失、占位地址、email_verified、赠金标记逐列不变）；
//   - 每条 409 用例同时断言「被拒后一行未动」，防「先写后校验」的实现也能变绿；
//   - AC17 的列表契约用三类真实账户形态（credential / github / 裸行）各取字面值。
//
// 夹具 idiom 照抄 tests/admin-users-promotion-switch.test.ts：
//   - setupUser 直插 users 行；
//   - accounts 行直插（providerId='credential' / 'github'），不进真实注册/OAuth 链路 ——
//     本组端点只读「行在不在」，不校验库内哈希或 OAuth token 内容；
//   - 管理员/成员会话 = createSession（直插 sessions 行 + 签名 Cookie）。
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { accounts, sessions, users } from "../src/db/schema";
import { isPlaceholderEmail } from "../src/lib/phone";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  await applyMigrations();
});

// ============ 工具 ============

async function adminCookie(email: string): Promise<string> {
  const id = await setupUser(email, 0, "admin");
  return sessionCookie(await createSession(id));
}

async function insertAccount(
  userId: number,
  providerId: "credential" | "github",
): Promise<void> {
  await createDb(env).insert(accounts).values({
    issuer: providerId,
    // (issuer, account_id) 唯一：把 userId 编进 accountId，测试间天然不撞
    accountId: `${providerId}-${userId}`,
    providerId,
    userId,
    password: providerId === "credential" ? "fake-hash" : null,
  });
}

async function setPhone(
  userId: number,
  phoneNumber: string,
  verified = true,
): Promise<void> {
  await createDb(env)
    .update(users)
    .set({ phoneNumber, phoneNumberVerified: verified })
    .where(eq(users.id, userId));
}

async function accountCount(userId: number, providerId: string): Promise<number> {
  const rows = await createDb(env)
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, providerId)));
  return rows.length;
}

/** 会话行数：解绑是「换一种登录方式」，不是登出（design §14.2/§14.3 都写明不删 sessions）。 */
async function sessionCount(userId: number): Promise<number> {
  const rows = await createDb(env)
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.length;
}

async function userRow(userId: number) {
  const row = await createDb(env).query.users.findFirst({
    where: eq(users.id, userId),
  });
  if (!row) {
    throw new Error(`user ${userId} not found`);
  }
  return row;
}

interface UnbindBody {
  success?: boolean;
  user?: {
    id: string;
    email: string;
    emailRegistered: boolean;
    githubLinked: boolean;
    phoneNumber: string | null;
    phoneNumberVerified: boolean;
  };
  error?: { message: string };
}

async function unbindIdentity(
  cookie: string | undefined,
  userId: number,
  kind: "github" | "email",
): Promise<{ status: number; body: UnbindBody }> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  const res = await selfFetch(`http://localhost/api/users/${userId}/${kind}`, {
    method: "DELETE",
    headers,
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as UnbindBody };
}

interface ListedUser {
  id: string;
  email: string;
  emailRegistered: boolean;
  githubLinked: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
}

// ============ AC17 列表契约 ============

describe("AC17 GET /api/users：phoneNumber / phoneNumberVerified / githubLinked", () => {
  it("四类账户形态各取字面值，且与 accounts 事实一致", async () => {
    const cookie = await adminCookie("unbind-list-admin@test.dev");

    const credentialId = await setupUser("unbind-list-cred@test.dev", 0);
    await insertAccount(credentialId, "credential");
    await setPhone(credentialId, "+8613800138011");

    const githubId = await setupUser("unbind-list-gh@test.dev", 0);
    await insertAccount(githubId, "github");

    const bareId = await setupUser("unbind-list-bare@test.dev", 0);

    // 第四类：号码已填但未验证 —— UI 的 `unverified` 徽章判据就是这个组合。
    // 若只测「有号码=已验证」与「无号码=false」两态，字段映射错位（如恒取 false）
    // 仍可能全绿；这一行把 phoneNumber 非空与 verified=false 同时钉住。
    const unverifiedPhoneId = await setupUser("unbind-list-phone-unverified@test.dev", 0);
    await setPhone(unverifiedPhoneId, "+8613800138012", false);

    const res = await selfFetch("http://localhost/api/users?search=unbind-list-", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ListedUser[] };
    const byId = new Map(body.items.map((item) => [item.id, item]));

    expect(byId.get(String(credentialId))).toMatchObject({
      emailRegistered: true,
      githubLinked: false,
      phoneNumber: "+8613800138011",
      phoneNumberVerified: true,
    });
    expect(byId.get(String(githubId))).toMatchObject({
      emailRegistered: false,
      githubLinked: true,
      phoneNumber: null,
      phoneNumberVerified: false,
    });
    // 退化形态（生产不可达）：判据按字面取 false，而不是「未知一律拦」
    expect(byId.get(String(bareId))).toMatchObject({
      emailRegistered: false,
      githubLinked: false,
      phoneNumber: null,
      phoneNumberVerified: false,
    });
    expect(byId.get(String(unverifiedPhoneId))).toMatchObject({
      emailRegistered: false,
      githubLinked: false,
      phoneNumber: "+8613800138012",
      phoneNumberVerified: false,
    });
  });
});

// ============ AC18 解绑 GitHub ============

describe("AC18 DELETE /api/users/:id/github", () => {
  it("已绑定 + 有 credential → 200、github 行消失、响应 githubLinked=false", async () => {
    const cookie = await adminCookie("unbind-gh-admin-1@test.dev");
    const target = await setupUser("unbind-gh-ok@test.dev", 0);
    await insertAccount(target, "github");
    await insertAccount(target, "credential");
    // 赠金幂等标记：解绑不得清掉它 —— 否则再次 link-social 会二次发放 github_bind_bonus。
    const githubMarker = new Date(Math.floor(Date.now() / 1000) * 1000 - 3600_000);
    await createDb(env)
      .update(users)
      .set({ githubBindBonusGrantedAt: githubMarker })
      .where(eq(users.id, target));
    // 目标用户当前有登录态（解绑不是登出）
    await createSession(target);

    const { status, body } = await unbindIdentity(cookie, target, "github");

    expect(status).toBe(200);
    expect(body.user?.githubLinked).toBe(false);
    // 另一个事实（邮件凭据）不受解绑影响 —— 响应不得整体回退成 false
    expect(body.user?.emailRegistered).toBe(true);
    expect(await accountCount(target, "github")).toBe(0);
    expect(await accountCount(target, "credential")).toBe(1);
    expect(await sessionCount(target)).toBe(1);
    expect((await userRow(target)).githubBindBonusGrantedAt?.getTime()).toBe(
      githubMarker.getTime(),
    );
  });

  it("判别性：只有手机号（无 credential）也能解绑 —— 护栏是「最后一个方式」而非「必须有邮箱」", async () => {
    const cookie = await adminCookie("unbind-gh-admin-2@test.dev");
    const target = await setupUser("unbind-gh-phone@test.dev", 0);
    await insertAccount(target, "github");
    await setPhone(target, "+8613800138022");

    const { status, body } = await unbindIdentity(cookie, target, "github");

    expect(status).toBe(200);
    expect(body.user?.githubLinked).toBe(false);
    expect(await accountCount(target, "github")).toBe(0);
  });

  it("未绑定 → 409 且库不变", async () => {
    const cookie = await adminCookie("unbind-gh-admin-3@test.dev");
    const target = await setupUser("unbind-gh-none@test.dev", 0);
    await insertAccount(target, "credential");

    const { status, body } = await unbindIdentity(cookie, target, "github");

    expect(status).toBe(409);
    expect(body.error?.message).toBe("GitHub account is not linked");
    expect(await accountCount(target, "github")).toBe(0);
    expect(await accountCount(target, "credential")).toBe(1);
  });

  it("GitHub 是最后一个登录方式（无手机、无 credential）→ 409 且 github 行保留", async () => {
    const cookie = await adminCookie("unbind-gh-admin-4@test.dev");
    const target = await setupUser("unbind-gh-last@test.dev", 0);
    await insertAccount(target, "github");

    const { status, body } = await unbindIdentity(cookie, target, "github");

    expect(status).toBe(409);
    expect(body.error?.message).toBe("Cannot unlink the last sign-in method");
    expect(await accountCount(target, "github")).toBe(1);
  });

  it("member 调用 → 403（adminOnly 未被新路由绕过）且 github 行不变", async () => {
    const target = await setupUser("unbind-gh-member-target@test.dev", 0);
    await insertAccount(target, "github");
    const memberId = await setupUser("unbind-gh-member@test.dev", 0);
    const memberCookie = sessionCookie(await createSession(memberId));

    const { status } = await unbindIdentity(memberCookie, target, "github");

    expect(status).toBe(403);
    expect(await accountCount(target, "github")).toBe(1);
  });
});

// ============ AC19 解绑邮箱 ============

describe("AC19 DELETE /api/users/:id/email", () => {
  it("已绑手机 + credential → 200：占位地址、credential 消失、email_verified=false、三档赠金标记与资格列不变", async () => {
    const cookie = await adminCookie("unbind-email-admin-1@test.dev");
    const target = await setupUser("unbind-email-ok@test.dev", 0);
    await insertAccount(target, "credential");
    await setPhone(target, "+8613800138033");

    // 三档赠金标记先钉整秒的旧值（D1 timestamp 按秒存）：解绑不得回收/重置任何一档。
    // 资格列刻意置 false（存量账号的冻结形态）——端点若误调 grantBonusEligibility 或
    // 重算资格，这条会红；只钉真实发放的那一档区分不了这类回归。
    const markerBase = Math.floor(Date.now() / 1000) * 1000;
    const signupMarker = new Date(markerBase - 3 * 3600_000);
    const emailMarker = new Date(markerBase - 2 * 3600_000);
    const githubMarker = new Date(markerBase - 1 * 3600_000);
    await createDb(env)
      .update(users)
      .set({
        signupBonusGrantedAt: signupMarker,
        emailVerifyBonusGrantedAt: emailMarker,
        githubBindBonusGrantedAt: githubMarker,
        bonusEligible: false,
      })
      .where(eq(users.id, target));
    const before = await userRow(target);
    expect(before.signupBonusGrantedAt?.getTime()).toBe(signupMarker.getTime());
    expect(before.emailVerifyBonusGrantedAt?.getTime()).toBe(emailMarker.getTime());
    expect(before.githubBindBonusGrantedAt?.getTime()).toBe(githubMarker.getTime());
    expect(before.bonusEligible).toBe(false);
    // 目标用户当前有登录态（解绑邮箱不是登出）
    await createSession(target);

    const { status, body } = await unbindIdentity(cookie, target, "email");

    expect(status).toBe(200);
    const updated = await userRow(target);
    // 占位地址的形态与手机号注册同源（buildPhonePlaceholderEmail）
    expect(updated.email).not.toBe(before.email);
    expect(isPlaceholderEmail(updated.email)).toBe(true);
    expect(updated.email).toMatch(/^u[0-9a-f]{5}\.\+8613800138033@phone\.invalid$/);
    expect(updated.emailVerified).toBe(false);
    // 效果断言：三档赠金标记逐值未变（不回收、不重置），资格列也未被动过
    expect(updated.signupBonusGrantedAt?.getTime()).toBe(signupMarker.getTime());
    expect(updated.emailVerifyBonusGrantedAt?.getTime()).toBe(emailMarker.getTime());
    expect(updated.githubBindBonusGrantedAt?.getTime()).toBe(githubMarker.getTime());
    expect(updated.bonusEligible).toBe(false);
    expect(await accountCount(target, "credential")).toBe(0);
    // 会话保留：解绑后目标用户不需要重新登录
    expect(await sessionCount(target)).toBe(1);
    // 响应契约反映解绑后的事实（不是回旧值）
    expect(body.user?.email).toBe(updated.email);
    expect(body.user?.emailRegistered).toBe(false);
  });

  it("未绑手机 → 409，邮箱与 credential 一行未动", async () => {
    const cookie = await adminCookie("unbind-email-admin-2@test.dev");
    const target = await setupUser("unbind-email-nophone@test.dev", 0);
    await insertAccount(target, "credential");
    const before = await userRow(target);

    const { status, body } = await unbindIdentity(cookie, target, "email");

    expect(status).toBe(409);
    expect(body.error?.message).toBe("Bind a phone number before unbinding email");
    const after = await userRow(target);
    expect(after.email).toBe(before.email);
    expect(after.emailVerified).toBe(before.emailVerified);
    expect(await accountCount(target, "credential")).toBe(1);
  });

  it("无邮箱凭据（手机号账号的占位邮箱）→ 409 且地址不变", async () => {
    const cookie = await adminCookie("unbind-email-admin-3@test.dev");
    const target = await setupUser("u0f3a1.+8613800138044@phone.invalid", 0);
    await setPhone(target, "+8613800138044");
    const before = await userRow(target);

    const { status, body } = await unbindIdentity(cookie, target, "email");

    expect(status).toBe(409);
    expect(body.error?.message).toBe("No email address is bound");
    expect((await userRow(target)).email).toBe(before.email);
  });

  it("重复调用 → 409，且不再次改写地址", async () => {
    const cookie = await adminCookie("unbind-email-admin-4@test.dev");
    const target = await setupUser("unbind-email-twice@test.dev", 0);
    await insertAccount(target, "credential");
    await setPhone(target, "+8613800138055");

    const first = await unbindIdentity(cookie, target, "email");
    expect(first.status).toBe(200);
    const placeholder = (await userRow(target)).email;

    const second = await unbindIdentity(cookie, target, "email");
    expect(second.status).toBe(409);
    expect(second.body.error?.message).toBe("No email address is bound");
    expect((await userRow(target)).email).toBe(placeholder);
  });
});

// ============ 公共护栏 ============

describe("两个解绑端点的公共护栏", () => {
  it("不存在 id → 404", async () => {
    const cookie = await adminCookie("unbind-404-admin@test.dev");

    for (const kind of ["github", "email"] as const) {
      const { status, body } = await unbindIdentity(cookie, 999_999, kind);
      expect(status).toBe(404);
      expect(body.error?.message).toBe("User not found");
    }
  });
});
