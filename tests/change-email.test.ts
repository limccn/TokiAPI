// 邮箱绑定（POST /api/auth/change-email）后端接线测试（11-06-sms-alicloud-auth，
// design §13.5 / PRD R15 屏 3 / AC35 的服务端前置）。
//
// 这里只钉**配置接线与服务端分支**（user.changeEmail.enabled +
// updateEmailWithoutVerification），不钉邮件投递与验证链接点击 ——
// 后两者由 tests/email-verification-send.test.ts 与赠金单测覆盖。
//
// 判别性纪律：
//   - 「立即写入」必须直查 D1（响应 {status:true} 在两条不同分支上都会返回，
//     光看响应区分不出「写库了」与「只发了验证信」）；
//   - emailVerified 保持 false —— 证明这一步只是「绑定」，验证仍要点击邮件链接；
//   - 目标邮箱已被占用时**不写库**（库的枚举保护分支），与上面的成功用例只差目标邮箱。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
} from "./helpers";

// Better Auth formCsrfMiddleware 校验 Origin 与 baseURL 一致（vitest env: BETTER_AUTH_URL=http://localhost:5173）
const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  await applyMigrations();
});

async function cookieFor(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

async function changeEmail(
  cookie: string,
  newEmail: string,
): Promise<{ status: number; json: unknown }> {
  const res = await selfFetch("http://localhost/api/auth/change-email", {
    method: "POST",
    headers: {
      Origin: ORIGIN,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ newEmail }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function emailRow(userId: number): Promise<{ email: string; emailVerified: boolean }> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { email: true, emailVerified: true },
  });
  if (!row) {
    throw new Error("test user not found");
  }
  return row;
}

describe("POST /api/auth/change-email（user.changeEmail 接线）", () => {
  it("未验证邮箱的账号：新邮箱立即写入，emailVerified 仍为 false（等验证信）", async () => {
    const userId = await setupUser("ce-basic@test.dev", 0);
    const cookie = await cookieFor(userId);

    const { status, json } = await changeEmail(cookie, "ce-basic-new@test.dev");
    expect(status).toBe(200);
    expect(json).toEqual({ status: true });

    // 效果断言：真的写了库（不是只发了一封信）
    const row = await emailRow(userId);
    expect(row.email).toBe("ce-basic-new@test.dev");
    // 绑定 ≠ 验证：点击邮件链接前仍是未验证状态（AC35 的前半）
    expect(row.emailVerified).toBe(false);
  });

  it("目标邮箱已被他人占用：返回 200 但不写库（库的枚举保护；与上例只差目标邮箱）", async () => {
    const userId = await setupUser("ce-dup-a@test.dev", 0);
    await setupUser("ce-dup-b@test.dev", 0); // 占用目标邮箱
    const cookie = await cookieFor(userId);

    const { status, json } = await changeEmail(cookie, "ce-dup-b@test.dev");
    expect(status).toBe(200);
    expect(json).toEqual({ status: true });

    // A 的邮箱必须原封不动（否则就是静默覆盖/串号）
    expect((await emailRow(userId)).email).toBe("ce-dup-a@test.dev");
  });
});
