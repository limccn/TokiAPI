// POST /api/me/password 测试（11-06-sms-alicloud-auth；design §5.4，PRD AC23）。
//
// 这条端点存在的唯一理由：手机号注册的账号**最初没有密码**（phone-number 插件建号时不写
// credential account），而库的 `setPassword` 是 serverOnly、客户端 SDK 上根本没有这个方法。
// 于是这里钉三件事：
//   1. 正向链路真的落下凭据行（不是「返回 200 但什么都没做」）；
//   2. **只设置、不覆盖** —— 已有密码的账号再调一次必须是 400 PASSWORD_ALREADY_SET，
//      否则「会话在手就能静默换密码」会让一次会话劫持变成永久接管；
//   3. 会话是硬前提（未登录 401），且设置完能用「手机号 + 新密码」登录（AC23 的实质判据）。
//
// 账号形态用 `setupUser` 直接落库（无 credential account）+ D1 补 phone_number，
// 与 phone-number 插件建号的库内形状一致 —— 但**不**走一遍真实短信（本文件只测设置密码，
// 发码链路由 tests/sms-auth.test.ts 覆盖）。密码正确性一律用真实登录端点验证，不比对哈希。
import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { accounts, users } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

// Better Auth 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";
const NEW_PASSWORD = "newpass456";

beforeAll(async () => {
  await applyMigrations();
});

/** POST /api/me/password（cookie 省略 = 未登录）。 */
async function setPassword(
  cookie: string | undefined,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Origin: ORIGIN,
    "Content-Type": "application/json",
  };
  if (cookie !== undefined) {
    headers.Cookie = cookie;
  }
  const res = await selfFetch("http://localhost/api/me/password", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}

/** 凭据行的密码哈希（无行 ⇒ null）—— 用来区分「真的写了」与「只是返回 200」。 */
async function credentialHash(userId: number): Promise<string | null> {
  const db = createDb(env);
  const row = await db.query.accounts.findFirst({
    where: and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")),
    columns: { password: true },
  });
  return row?.password ?? null;
}

/** 给已存在的 users 行补手机号（模拟手机号注册后的库内形状）。 */
async function setPhone(userId: number, phoneNumber: string): Promise<void> {
  const db = createDb(env);
  await db
    .update(users)
    .set({ phoneNumber, phoneNumberVerified: true })
    .where(eq(users.id, userId));
}

function errorCode(json: unknown): string {
  if (typeof json !== "object" || json === null) {
    return "";
  }
  const code = (json as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  const nested = (json as { error?: { code?: unknown } }).error;
  return typeof nested?.code === "string" ? nested.code : "";
}

describe("POST /api/me/password", () => {
  it("无会话 → 401（requireSession 先于路由），且不写任何凭据行", async () => {
    const userId = await setupUser("mp-anon@test.dev", 0);
    const { status } = await setPassword(undefined, { newPassword: NEW_PASSWORD });
    expect(status).toBe(401);
    expect(await credentialHash(userId)).toBeNull();
  });

  it("AC23 正向：首次设置成功 → credential 行落库、hasPassword 翻转，且可重复读", async () => {
    const userId = await setupUser("mp-happy@test.dev", 0);
    const cookie = sessionCookie(await createSession(userId));
    expect(await credentialHash(userId)).toBeNull();

    const { status, json } = await setPassword(cookie, { newPassword: NEW_PASSWORD });
    expect(status).toBe(200);
    expect(json).toEqual({ status: true });

    // 判别点：哈希真的落库了（库建 providerId='credential' 行 + 真实哈希）
    expect(await credentialHash(userId)).not.toBeNull();

    // profile 的 hasPassword 是前端「改密区块」的唯一判据 —— 设置后必须翻成 true
    const profileRes = await selfFetch("http://localhost/api/me/profile", {
      headers: { Origin: ORIGIN, Cookie: cookie },
    });
    expect(profileRes.status).toBe(200);
    const profile = (await profileRes.json()) as { profile?: { hasPassword?: boolean } };
    expect(profile.profile?.hasPassword).toBe(true);
  });

  it("只设置不覆盖：二次调用 → 400 PASSWORD_ALREADY_SET，哈希逐字节未变", async () => {
    const userId = await setupUser("mp-twice@test.dev", 0);
    const cookie = sessionCookie(await createSession(userId));

    expect((await setPassword(cookie, { newPassword: NEW_PASSWORD })).status).toBe(200);
    const first = await credentialHash(userId);
    expect(first).not.toBeNull();

    const { status, json } = await setPassword(cookie, { newPassword: "another-pass-789" });
    // 400 而不是 200：媒体上「会话在手就能换密码」是这条端点最大的误用方式
    expect(status).toBe(400);
    expect(errorCode(json)).toBe("PASSWORD_ALREADY_SET");
    expect(await credentialHash(userId)).toBe(first);
  });

  it("低于下限 → 400，且不建凭据行（Zod 闸先于库）", async () => {
    const userId = await setupUser("mp-short@test.dev", 0);
    const cookie = sessionCookie(await createSession(userId));

    const { status } = await setPassword(cookie, { newPassword: "short" });
    expect(status).toBe(400);
    expect(await credentialHash(userId)).toBeNull();
  });

  it("AC23 闭环：设置后「手机号 + 新密码」经 sign-in/phone-number 登录成功", async () => {
    const userId = await setupUser("mp-phone@test.dev", 0);
    const phoneNumber = "+8613800138011";
    await setPhone(userId, phoneNumber);

    // 插件由 SMS_AUTH_ENABLED 门控（关闭时 sign-in/phone-number 结构性 404），
    // 本用例只用到「密码登录」分支，不会触发任何外发短信（不用 sendOTP 路径）。
    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      const cookie = sessionCookie(await createSession(userId));
      expect((await setPassword(cookie, { newPassword: NEW_PASSWORD })).status).toBe(200);

      const res = await selfFetch("http://localhost/api/auth/sign-in/phone-number", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber, password: NEW_PASSWORD }),
      });
      const body = (await res.json().catch(() => null)) as
        | { user?: { id?: unknown; phoneNumber?: unknown } }
        | null;
      expect(res.status).toBe(200);
      // 登录的是**同一行**用户，且号码是规范形（不是被插件另建了账号）
      expect(String(body?.user?.id)).toBe(String(userId));
      expect(body?.user?.phoneNumber).toBe(phoneNumber);

      // 反向对照：错误密码必须 401（证明上面 200 是密码校验通过，而不是分支漏判）
      const wrong = await selfFetch("http://localhost/api/auth/sign-in/phone-number", {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ phoneNumber, password: "definitely-wrong" }),
      });
      await wrong.text();
      expect(wrong.status).toBe(401);
    });
  });
});
