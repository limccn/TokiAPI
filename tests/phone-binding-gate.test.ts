// 手机号硬门禁测试（11-06-sms-alicloud-auth，PRD R19 / AC30 / AC38 / AC39，design §13.4）。
//
// 本文件钉的是**中间件的实际行为**，不是「函数返回了 true」：
//   - 每条被拦用例都断言 403 + 稳定 code `PHONE_BINDING_REQUIRED`（前端据此跳 /bind-phone，
//     不靠文案匹配）；
//   - 每条放行用例都给一个**只差一个变量**的对照（同端点、同账号、翻开关/翻验证状态），
//     避免「门禁恒放行」或「门禁恒拦截」也能全绿；
//   - `/api/auth/*`、公开端点、`/v1/*`、`/anthropic/*` 各取一个代表，证明作用面只有
//     requireSession 之后的 /api/* 会话面。
//
// 会话一律用 helpers.createSession（直插 sessions 行 + 签名 Cookie）—— 门禁只看
// getSession 下发的 user 行，不关心会话是怎么建立的。
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
  setupKey,
  setupUser,
  withAdminEmails,
  withSwitch,
} from "./helpers";

const ORIGIN = "http://localhost:5173";

beforeAll(async () => {
  await applyMigrations();
});

// ============ 工具 ============

async function cookieFor(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

/** 标记手机已通过短信验证（模拟 phone-number 插件 verify 链路写入的库内形状）。 */
async function markPhoneVerified(userId: number, phoneNumber: string): Promise<void> {
  const db = createDb(env);
  await db
    .update(users)
    .set({ phoneNumber, phoneNumberVerified: true })
    .where(eq(users.id, userId));
}

/**
 * 标记邮箱已验证（后门的安全边界，11-08 MEDIUM-1）。
 * GitHub OAuth 建号时 provider 的 verified 标志会写入该列；邮箱密码注册在
 * `EMAIL_VERIFICATION_ENABLED=false` 的部署上可能长期为 false —— 那种账号不享受后门。
 */
async function markEmailVerified(userId: number): Promise<void> {
  await createDb(env)
    .update(users)
    .set({ emailVerified: true })
    .where(eq(users.id, userId));
}

interface ErrorBody {
  error?: { message?: string; code?: string };
}

/** GET 一个受门禁保护的会话面端点（/api/keys）。 */
async function getKeys(cookie: string): Promise<{ status: number; body: unknown }> {
  const res = await selfFetch("http://localhost/api/keys", { headers: { Cookie: cookie } });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("phone gate：SMS 关闭（部署缺省）", () => {
  it("门禁整体不存在：未验证手机的账号照常访问管理面", async () => {
    const userId = await setupUser("gate-off@test.dev", 0);
    const cookie = await cookieFor(userId);

    // vitest pin SMS_AUTH_ENABLED="false"；不套 withSwitch
    const keys = await getKeys(cookie);
    expect(keys.status).toBe(200);

    const res = await selfFetch("http://localhost/api/me/usage", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe("phone gate：SMS 开启 + 未验证手机", () => {
  it("管理面端点一律 403 PHONE_BINDING_REQUIRED（带稳定 code 与统一错误体）", async () => {
    const userId = await setupUser("gate-blocked@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      const keys = await getKeys(cookie);
      expect(keys.status).toBe(403);
      const body = keys.body as ErrorBody;
      expect(body.error?.code).toBe("PHONE_BINDING_REQUIRED");
      expect(body.error?.message).toBe("Phone number verification required.");

      // 另一个模块路由（/api/me/usage 同样在门禁覆盖内）
      const usage = await selfFetch("http://localhost/api/me/usage", {
        headers: { Cookie: cookie },
      });
      expect(usage.status).toBe(403);
      expect(((await usage.json()) as ErrorBody).error?.code).toBe("PHONE_BINDING_REQUIRED");
    });
  });

  it("allowlist：GET /api/me/profile 与 POST /api/me/password 放行（绑定流程要用的两个端点）", async () => {
    const userId = await setupUser("gate-allowlist@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      const profile = await selfFetch("http://localhost/api/me/profile", {
        headers: { Cookie: cookie },
      });
      expect(profile.status).toBe(200);
      const body = (await profile.json()) as {
        profile?: { phoneNumberVerified?: boolean };
      };
      expect(body.profile?.phoneNumberVerified).toBe(false);

      const password = await selfFetch("http://localhost/api/me/password", {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          "Content-Type": "application/json",
          Cookie: cookie,
        },
        body: JSON.stringify({ newPassword: "gate-pass-123" }),
      });
      expect(password.status).toBe(200);
      expect(await password.json()).toEqual({ status: true });
    });
  });

  it("/api/auth/* 与公开端点不受影响（门禁只挂 requireSession 之后的 /api/*）", async () => {
    const userId = await setupUser("gate-public@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      // 会话读取：登录/绑定/改密等前端流程都靠它
      const session = await selfFetch("http://localhost/api/auth/get-session", {
        headers: { Cookie: cookie },
      });
      expect(session.status).toBe(200);
      const sessionBody = (await session.json()) as { user?: { id?: string } } | null;
      expect(sessionBody?.user?.id).toBe(String(userId));

      for (const path of ["/api/health", "/api/config"]) {
        const res = await selfFetch(`http://localhost${path}`);
        expect(res.status).toBe(200);
        await res.text();
      }
    });
  });

  it("AC39：/v1/* 与 /anthropic/* 不受门禁影响（已有 API 流量不因账号未绑手机中断）", async () => {
    const userId = await setupUser("gate-proxy@test.dev", 100);
    const { plaintext } = await setupKey(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      // 网关 Key 鉴权入口：用户未验证手机，仍应 200（门禁不覆盖 /v1）
      const models = await selfFetch("http://localhost/v1/models", {
        headers: { Authorization: `Bearer ${plaintext}` },
      });
      expect(models.status).toBe(200);
      await models.text();

      // /anthropic 同理：无 key 时返回的是 Anthropic 形态的 401，而不是门禁的 403
      const anthropic = await selfFetch("http://localhost/anthropic/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(anthropic.status).toBe(401);
      const anthropicBody = (await anthropic.json()) as ErrorBody;
      expect(anthropicBody.error?.code).not.toBe("PHONE_BINDING_REQUIRED");
    });
  });
});

describe("phone gate：SMS 开启 + 已验证手机", () => {
  it("同一账号验证手机后恢复管理面访问（A/A′ 对照：只翻验证状态这一个变量）", async () => {
    const userId = await setupUser("gate-verified@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      // A：未验证 → 403（同一账号、同一端点，先造出对照组）
      expect((await getKeys(cookie)).status).toBe(403);

      await markPhoneVerified(userId, "+8613800138099");

      // A′：验证后 → 200
      expect((await getKeys(cookie)).status).toBe(200);
    });
  });
});

// ============ ADMIN_EMAILS 后门（11-08 R8 / D7 / AC14–AC15）============
//
// 判据 = 会话邮箱命中 ADMIN_EMAILS，与前一轮「登录时自动提权」同一份名单、同一个
// isAdminEmail 纯函数。注意 withAdminEmails 而非 withSwitch：ADMIN_EMAILS 在 Env 里是
// 必填 string，只有前者能表达「空名单」且不触发类型问题（helpers 头注有原因）。
describe("phone gate：ADMIN_EMAILS 后门", () => {
  it("AC14 A/A′：同一账号只翻名单 → 名单外 403、名单内 200", async () => {
    const email = "gate-bypass@test.dev";
    const userId = await setupUser(email, 0);
    // 后门只对已验证邮箱生效（GitHub 登录的真实形状）；未验证的对照见下一条安全边界用例。
    await markEmailVerified(userId);
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      // A：名单不含该邮箱（也不为空，避免与下一条「空名单」用例混淆）→ 拦
      const blocked = await withAdminEmails("someone-else@test.dev", () =>
        getKeys(cookie),
      );
      expect(blocked.status).toBe(403);
      expect((blocked.body as ErrorBody).error?.code).toBe("PHONE_BINDING_REQUIRED");

      // A′：同一账号、同一端点，只把该邮箱加入名单 → 放行
      const allowed = await withAdminEmails(email, () => getKeys(cookie));
      expect(allowed.status).toBe(200);
    });
  });

  it("AC14 空名单 = 无后门（fail-closed）：未验手机仍 403", async () => {
    const userId = await setupUser("gate-bypass-empty@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      const res = await withAdminEmails("", () => getKeys(cookie));
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error?.code).toBe("PHONE_BINDING_REQUIRED");
    });
  });

  it("AC14 安全边界：名单命中但邮箱**未验证** → 仍 403；只翻 emailVerified 后放行", async () => {
    // MEDIUM-1：changeEmail 在 updateEmailWithoutVerification 下会把未验证地址立即写库。
    // 若后门只比字符串，任何手机号账号都能把邮箱改成名单地址「自证」管理员。
    const email = "gate-bypass-unverified@test.dev";
    const userId = await setupUser(email, 0); // setupUser 默认 emailVerified=false
    const cookie = await cookieFor(userId);

    await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
      const blocked = await withAdminEmails(email, () => getKeys(cookie));
      expect(blocked.status).toBe(403);
      expect((blocked.body as ErrorBody).error?.code).toBe("PHONE_BINDING_REQUIRED");

      // 对照：同一行只把 emailVerified 翻成 true → 200（证明拦截原因就是邮箱未验证）
      await markEmailVerified(userId);
      const allowed = await withAdminEmails(email, () => getKeys(cookie));
      expect(allowed.status).toBe(200);
    });
  });

  it("AC15 phoneGateBypassed 四态：未命中 / 命中未验证 / 命中已验证 / SMS 关闭", async () => {
    const email = "gate-profile-bypass@test.dev";
    const userId = await setupUser(email, 0);
    const cookie = await cookieFor(userId);

    const readBypassed = async (): Promise<boolean> => {
      const res = await selfFetch("http://localhost/api/me/profile", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        profile?: { phoneGateBypassed?: boolean };
      };
      return body.profile?.phoneGateBypassed === true;
    };

    // 未命中：SMS 开启但名单里没有这个邮箱
    await withAdminEmails("someone-else@test.dev", async () => {
      await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
        expect(await readBypassed()).toBe(false);
      });
    });

    await withAdminEmails(email, async () => {
      // 名单命中但邮箱未验证 → false（与中间件同一边界：未验证地址不能自证管理员）
      await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
        expect(await readBypassed()).toBe(false);
      });

      await markEmailVerified(userId);

      // 命中：SMS 开启 + 名单包含 + 邮箱已验证
      await withSwitch("SMS_AUTH_ENABLED", "true", async () => {
        expect(await readBypassed()).toBe(true);
      });
      // SMS 关闭：门禁整体不存在 ⇒ 即使名单命中，字段也必须是 false
      // （「无门禁」不等于「被跳过」；若这里为 true，前端会误以为存在后门语义）
      await withSwitch("SMS_AUTH_ENABLED", "false", async () => {
        expect(await readBypassed()).toBe(false);
      });
    });

    // 还原守卫：两个 helper 的 finally 都失效时，后面的文件会读到脏 env
    expect(env.ADMIN_EMAILS).toBe("");
    expect(env.SMS_AUTH_ENABLED).toBe("false");
  });
});
