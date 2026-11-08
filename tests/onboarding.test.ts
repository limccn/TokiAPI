// 首登赠金到账引导弹窗 —— 服务端端点测试（09-16-first-login-welcome，design §6）。
//
// 覆盖：AC9（未登录 401 + 响应形状）、AC1（有赠金流水 → pending + 金额）、AC10（金额取流水实际值
// 而非 env）、AC5（赠金关闭 → 无流水 → 不弹）、AC6（本功能上线前的存量用户 → 不弹）、AC7（已标记
// → 不弹）、AC2/AC3/AC4 的**服务端等价断言**（标记后换浏览器/设备同结论 —— 标记在服务端不在
// localStorage）、幂等与用户隔离，以及「真实邮箱注册后端点立即给出确定结论」的端到端连通
// （11-08-reward-semantics-overhaul 起建号不再赠金：注册后 = pending=false、无流水）。
//
// 刻意不覆盖（不是遗漏）：弹窗的出现/关闭/跳转动效与三条关闭路径的交互、Esc/遮罩关闭、
// 「标记请求失败仍能关闭」（R6/AC8）—— 这些是纯前端行为，仓库 app/ 下无测试基建（既有惯例），
// 由 Playwright / stg 人工验证覆盖。前端侧可自动化的部分（金额格式化）已有 format 单测。
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { balanceTx, inviteCodes, users } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

interface OnboardingBody {
  success: boolean;
  welcome: { pending: boolean; bonusAmount: number | null };
}

let ADMIN_ID = 0;
let inviteSeq = 0;

beforeAll(async () => {
  await applyMigrations();
  ADMIN_ID = await setupUser("ob-admin@test.dev", 0, "admin");
});

/** 造一张一次性邀请码（邮箱密码注册路径的准入门槛）。 */
async function insertInvite(): Promise<string> {
  const db = createDb(env);
  inviteSeq += 1;
  const code = `OBTEST${String(inviteSeq).padStart(2, "0")}`;
  await db.insert(inviteCodes).values({
    code,
    createdBy: ADMIN_ID,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return code;
}

/** 造一个「有注册赠金流水、未标记已读」的用户（赠金到账但还没看过弹窗的形态）。 */
async function userWithBonus(email: string, amount = 5): Promise<number> {
  const userId = await setupUser(email, amount);
  const db = createDb(env);
  await db.insert(balanceTx).values({
    userId,
    amount,
    type: "signup_bonus",
    note: "signup bonus",
  });
  return userId;
}

async function cookieFor(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

/** GET /api/me/onboarding（无 cookie = 未登录）。 */
async function getOnboarding(
  cookie?: string,
): Promise<{ status: number; body: OnboardingBody | null }> {
  const res = await selfFetch(
    "http://localhost/api/me/onboarding",
    cookie === undefined ? {} : { headers: { Cookie: cookie } },
  );
  const body = res.status === 200 ? ((await res.json()) as OnboardingBody) : null;
  return { status: res.status, body };
}

/** POST /api/me/onboarding/welcome-seen（空 body，无参数 —— 与前端 apiFetch 的调用形态一致）。 */
async function postWelcomeSeen(
  cookie?: string,
): Promise<{ status: number; body: { success?: boolean } | null }> {
  const res = await selfFetch(
    "http://localhost/api/me/onboarding/welcome-seen",
    cookie === undefined
      ? { method: "POST" }
      : { method: "POST", headers: { Cookie: cookie } },
  );
  const body = res.status === 200 ? ((await res.json()) as { success?: boolean }) : null;
  return { status: res.status, body };
}

async function welcomeSeenAt(userId: number): Promise<Date | null> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { welcomeSeenAt: true },
  });
  if (!row) {
    throw new Error("test user not found");
  }
  return row.welcomeSeenAt;
}

async function setWelcomeSeenAt(userId: number, at: Date): Promise<void> {
  const db = createDb(env);
  await db.update(users).set({ welcomeSeenAt: at }).where(eq(users.id, userId));
}

describe("GET /api/me/onboarding（首登欢迎状态）", () => {
  it("AC9：未登录 → 401（不泄露任何欢迎状态）", async () => {
    const { status, body } = await getOnboarding();
    expect(status).toBe(401);
    expect(body).toBeNull();
  });

  it("AC1：有注册赠金流水且未标记 → pending=true，金额取自流水实际值", async () => {
    const userId = await userWithBonus("ob-basic@test.dev", 5);
    const { status, body } = await getOnboarding(await cookieFor(userId));

    expect(status).toBe(200);
    expect(body?.success).toBe(true);
    expect(body?.welcome.pending).toBe(true);
    expect(body?.welcome.bonusAmount).toBe(5);
    // 响应形状契约（design §2.1）：顶层 success + welcome{pending,bonusAmount}，无多余字段
    expect(Object.keys(body ?? {}).sort()).toEqual(["success", "welcome"]);
    expect(Object.keys(body?.welcome ?? {}).sort()).toEqual([
      "bonusAmount",
      "pending",
    ]);
  });

  it("AC10：金额来自实际流水（8）而非 env 配置（测试绑定为 5）", async () => {
    const userId = await userWithBonus("ob-amount@test.dev", 8);
    const { body } = await getOnboarding(await cookieFor(userId));
    expect(body?.welcome).toEqual({ pending: true, bonusAmount: 8 });
  });

  it("AC5 / AC6：无 signup_bonus 流水（赠金关闭 / 存量用户 / 发放失败）→ 不弹", async () => {
    // 存量用户：本功能上线前注册，余额可能非零，但无赠金流水
    const legacy = await setupUser("ob-legacy@test.dev", 42);
    const legacyBody = (await getOnboarding(await cookieFor(legacy))).body;
    expect(legacyBody?.welcome).toEqual({ pending: false, bonusAmount: null });

    // 赠金关闭（SIGNUP_BONUS_AMOUNT=0 / 非法值）或发放失败：注册后余额为 0 且无流水
    const noBonus = await setupUser("ob-nobonus@test.dev", 0);
    const noBonusBody = (await getOnboarding(await cookieFor(noBonus))).body;
    expect(noBonusBody?.welcome).toEqual({ pending: false, bonusAmount: null });
  });

  it("AC7：welcome_seen_at 已写入 → pending=false（即便赠金流水存在）", async () => {
    const userId = await userWithBonus("ob-seen@test.dev", 5);
    await setWelcomeSeenAt(userId, new Date("2026-09-16T00:00:00Z"));

    const { body } = await getOnboarding(await cookieFor(userId));
    expect(body?.welcome).toEqual({ pending: false, bonusAmount: null });
  });

  it("端到端连通：真实邮箱注册后立即 pending=false、金额 null，且无 signup_bonus 流水（11-08 新语义）", async () => {
    // 走 Better Auth 真实注册端点（邀请码准入）。11-08-reward-semantics-overhaul 起，
    // 赠金触发点从「建号」移到「手机验证」—— 邮箱注册后立即查询的结果是确定的 pending=false，
    // 无竞态问题（响应返回即可判定）。
    // 正向路径（手机注册 → 验证响应返回时流水已存在）由 tests/sms-auth.test.ts 的 AC7 覆盖。
    const email = "ob-signup@test.dev";
    const inviteCode = await insertInvite();
    const res = await selfFetch("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "testpass123",
        name: "ob-signup",
        inviteCode,
      }),
    });
    expect([200, 201]).toContain(res.status);

    const db = createDb(env);
    const row = await db.query.users.findFirst({
      where: eq(users.email, email),
      columns: { id: true },
    });
    if (!row) {
      throw new Error("signup did not create user");
    }

    const { status, body } = await getOnboarding(await cookieFor(row.id));
    expect(status).toBe(200);
    expect(body?.welcome).toEqual({ pending: false, bonusAmount: null });
    expect(await welcomeSeenAt(row.id)).toBeNull();

    // 「不发」是因为**没有流水**，不是「有流水但读空」—— 直接对库取证
    const txRows = await db
      .select()
      .from(balanceTx)
      .where(and(eq(balanceTx.userId, row.id), eq(balanceTx.type, "signup_bonus")));
    expect(txRows).toHaveLength(0);
  });

  it("用户隔离：他人已标记不影响自己（判定按会话 userId，不按全局状态）", async () => {
    const marked = await userWithBonus("ob-iso-a@test.dev", 5);
    const fresh = await userWithBonus("ob-iso-b@test.dev", 5);
    await postWelcomeSeen(await cookieFor(marked));

    expect((await getOnboarding(await cookieFor(marked))).body?.welcome.pending).toBe(false);
    expect((await getOnboarding(await cookieFor(fresh))).body?.welcome).toEqual({
      pending: true,
      bonusAmount: 5,
    });
  });
});

describe("POST /api/me/onboarding/welcome-seen（标记已读）", () => {
  it("AC9：未登录 → 401（且不写入任何标记）", async () => {
    const { status, body } = await postWelcomeSeen();
    expect(status).toBe(401);
    expect(body).toBeNull();
  });

  it("AC2/AC3/AC4 服务端等价：标记后任意次查询恒 pending=false（跨浏览器/设备同结论）", async () => {
    const userId = await userWithBonus("ob-mark@test.dev", 5);
    const cookie = await cookieFor(userId);

    expect((await getOnboarding(cookie)).body?.welcome.pending).toBe(true);

    const marked = await postWelcomeSeen(cookie);
    expect(marked.status).toBe(200);
    expect(marked.body).toEqual({ success: true }); // 空 body 调用形态（前端 POST 不带参数）

    const seen = await welcomeSeenAt(userId);
    expect(seen).not.toBeNull();

    // 同一会话再次查询 + 另起一个会话（模拟换浏览器/设备）→ 都不再弹
    expect((await getOnboarding(cookie)).body?.welcome).toEqual({
      pending: false,
      bonusAmount: null,
    });
    const otherDeviceCookie = await cookieFor(userId);
    expect((await getOnboarding(otherDeviceCookie)).body?.welcome).toEqual({
      pending: false,
      bonusAmount: null,
    });
  });

  it("幂等：重复标记不改写首次阅读时间，且都返回 success", async () => {
    const userId = await userWithBonus("ob-idem@test.dev", 5);
    const cookie = await cookieFor(userId);
    const first = new Date("2026-09-16T00:00:00Z");
    // 直接置一个已知的历史值：条件 UPDATE（WHERE welcome_seen_at IS NULL）不得覆盖它
    await setWelcomeSeenAt(userId, first);

    const again = await postWelcomeSeen(cookie);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ success: true });
    expect(await welcomeSeenAt(userId)).toEqual(first);

    // 首次标记路径同样返回 success（与重复调用不可区分 —— 前端无需分支）
    const fresh = await userWithBonus("ob-idem-fresh@test.dev", 5);
    const firstMark = await postWelcomeSeen(await cookieFor(fresh));
    expect(firstMark.status).toBe(200);
    expect(firstMark.body).toEqual({ success: true });
    expect(await welcomeSeenAt(fresh)).not.toBeNull();
  });

  it("仅影响本人：标记不写他人行", async () => {
    const mine = await userWithBonus("ob-scope-a@test.dev", 5);
    const other = await userWithBonus("ob-scope-b@test.dev", 5);

    await postWelcomeSeen(await cookieFor(mine));

    expect(await welcomeSeenAt(mine)).not.toBeNull();
    expect(await welcomeSeenAt(other)).toBeNull();
  });
});
