// GET /api/admin/settings — 当前生效的运行时默认配置（admin 只读，无修改端点）。
// 数值来自各模块的唯一来源：DEFAULT_CACHE_TTL_SECONDS（schema 默认值）、
// WINDOW_SECONDS（rate-limit.ts）、parseRetentionDays（cleanup.ts，env 覆盖）、
// parseBonusAmount / isEmailVerificationEnabled（bonus.ts，env 覆盖）、
// isEmailAccountAdminPromotionEnabled（lib/admin-promotion-policy.ts，env 覆盖）。
// 赠金四项展示解析后的生效值（不是原始 env 字符串），与 requestLogRetentionDays 同口径。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { DEFAULT_CACHE_TTL_SECONDS } from "../../../db/schema";
import { WINDOW_SECONDS } from "../../v1/rate-limit";
import {
  DEFAULT_EMAIL_VERIFY_BONUS,
  DEFAULT_GITHUB_BIND_BONUS,
  DEFAULT_SIGNUP_BONUS,
  isEmailVerificationEnabled,
  parseBonusAmount,
} from "../../../lib/bonus";
import { parseRetentionDays } from "../../../lib/cleanup";
import { isEmailAccountAdminPromotionEnabled } from "../../../lib/admin-promotion-policy";

export function adminSettingsRoute(app: Hono<AppEnv>): void {
  app.get("/settings", async (c) => {
    const logger = c.get("logger");
    const requestLogRetentionDays = parseRetentionDays(
      c.env.REQUEST_LOG_RETENTION_DAYS,
    );
    const signupBonusAmount = parseBonusAmount(
      c.env.SIGNUP_BONUS_AMOUNT,
      DEFAULT_SIGNUP_BONUS,
    );
    const emailVerifyBonusAmount = parseBonusAmount(
      c.env.EMAIL_VERIFY_BONUS_AMOUNT,
      DEFAULT_EMAIL_VERIFY_BONUS,
    );
    const githubBindBonusAmount = parseBonusAmount(
      c.env.GITHUB_BIND_BONUS_AMOUNT,
      DEFAULT_GITHUB_BIND_BONUS,
    );
    const emailVerificationEnabled = isEmailVerificationEnabled(
      c.env.EMAIL_VERIFICATION_ENABLED,
    );
    const emailAccountAdminPromotionEnabled =
      isEmailAccountAdminPromotionEnabled(
        c.env.EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED,
      );

    logger.info("admin_settings_reported", {
      cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
      rateLimitWindowSeconds: WINDOW_SECONDS,
      requestLogRetentionDays,
      signupBonusAmount,
      emailVerifyBonusAmount,
      githubBindBonusAmount,
      emailVerificationEnabled,
      emailAccountAdminPromotionEnabled,
    });

    return c.json({
      success: true as const,
      settings: {
        cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
        rateLimitWindowSeconds: WINDOW_SECONDS,
        requestLogRetentionDays,
        signupBonusAmount,
        emailVerifyBonusAmount,
        githubBindBonusAmount,
        emailVerificationEnabled,
        emailAccountAdminPromotionEnabled,
      },
    });
  });
}
