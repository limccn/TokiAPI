// M8 /api/admin/settings 单测（journal 延期项 2）：admin 只读端点返回当前生效的
// 运行时默认配置（缓存 TTL / 限流窗口 / 明细保留天数，与代码常量一致）；
// 未登录 401、member 403（PRD AC6 权限隔离）。
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

interface SettingsBody {
  success: boolean;
  settings: {
    cacheTtlSeconds: number;
    rateLimitWindowSeconds: number;
    requestLogRetentionDays: number;
    signupBonusAmount: number;
    emailVerifyBonusAmount: number;
    githubBindBonusAmount: number;
    emailVerificationEnabled: boolean;
    emailAccountAdminPromotionEnabled: boolean;
  };
}

describe("GET /api/admin/settings", () => {
  it("未登录 → 401", async () => {
    const res = await selfFetch("http://localhost/api/admin/settings");
    expect(res.status).toBe(401);
  });

  it("member → 403", async () => {
    const memberId = await setupUser("settings-member@test.dev", 0);
    const cookie = sessionCookie(await createSession(memberId));
    const res = await selfFetch("http://localhost/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(403);
  });

  it("admin → 200，返回全部运行时默认配置（与代码常量/env 生效值一致）", async () => {
    const adminId = await setupUser("settings-admin@test.dev", 0, "admin");
    const cookie = sessionCookie(await createSession(adminId));
    const res = await selfFetch("http://localhost/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SettingsBody;
    expect(body.success).toBe(true);
    expect(body.settings.cacheTtlSeconds).toBe(3600); // api_keys.cache_ttl schema 默认
    expect(body.settings.rateLimitWindowSeconds).toBe(60); // rate-limit.ts WINDOW_SECONDS
    expect(body.settings.requestLogRetentionDays).toBe(30); // cleanup.ts 默认（测试 env 无覆盖）
    // 赠金四项（09-16-signup-bonus-grant AC11；11-08-reward-semantics-overhaul 增 GitHub 绑定档）：
    // 金额为解析后的生效值，开关为布尔
    expect(body.settings.signupBonusAmount).toBe(5); // bonus.ts 默认（测试 env 无覆盖）
    expect(body.settings.emailVerifyBonusAmount).toBe(5);
    expect(body.settings.githubBindBonusAmount).toBe(5);
    expect(body.settings.emailVerificationEnabled).toBe(true); // 测试绑定显式开启（vitest.config.ts）
    // 账户安全总开关（09-21-email-admin-promotion-switch）：测试绑定显式 pin 成部署缺省（关闭）
    expect(body.settings.emailAccountAdminPromotionEnabled).toBe(false);
  });

  it("AC11 账户安全总开关随 env 翻转（管理画面的开关值只此一个来源）", async () => {
    const adminId = await setupUser("settings-admin-promo@test.dev", 0, "admin");
    const cookie = sessionCookie(await createSession(adminId));

    const reported = await withSwitch(
      "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED",
      "true",
      async () => {
        const res = await selfFetch("http://localhost/api/admin/settings", {
          headers: { Cookie: cookie },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as SettingsBody;
        return body.settings.emailAccountAdminPromotionEnabled;
      },
    );

    // 只断言 true 不够（pin 值本就是 false，写死也过）——上面 200 与这里 true 合起来才说明「读的是 env」
    expect(reported).toBe(true);
    // 还原后再读一次：证明翻转确实来自 env 而不是常量
    const after = await selfFetch("http://localhost/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    const afterBody = (await after.json()) as SettingsBody;
    expect(afterBody.settings.emailAccountAdminPromotionEnabled).toBe(false);
  });

  it("赠金金额随 env 翻转（GITHUB_BIND_BONUS_AMOUNT=0 = 关闭；还原后回 5）", async () => {
    // 与上一条同形：只断言 0 不够（pin 值 5 与本例目标值不等，写死也会红，但还原后回 5
    // 才证明端点读的是 env 而不是某条缓存/常量）。
    const adminId = await setupUser("settings-admin-bonus@test.dev", 0, "admin");
    const cookie = sessionCookie(await createSession(adminId));

    const reported = await withSwitch("GITHUB_BIND_BONUS_AMOUNT", "0", async () => {
      const res = await selfFetch("http://localhost/api/admin/settings", {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as SettingsBody;
      return body.settings.githubBindBonusAmount;
    });
    expect(reported).toBe(0);

    const after = await selfFetch("http://localhost/api/admin/settings", {
      headers: { Cookie: cookie },
    });
    const afterBody = (await after.json()) as SettingsBody;
    expect(afterBody.settings.githubBindBonusAmount).toBe(5);
  });
});
