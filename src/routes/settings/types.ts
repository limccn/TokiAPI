// 系统设置模块（M8 journal 延期项 2）：GET /api/admin/settings（admin 只读）。
// 返回当前生效的运行时默认配置（代码常量聚合；无运行时修改机制 → 只读，PATCH 不做，
// 已记录为已知偏差，见 README）。时间戳不涉及；数值字段均为整数。
// 赠金四项（09-16-signup-bonus-grant；11-08-reward-semantics-overhaul 增第三档金额）
// 为 env 派生的**生效值**（金额可含两位小数）。
import { z } from "zod";

// ============= 输出 Schemas =============

export const runtimeSettingsSchema = z.object({
  /** 响应缓存默认 TTL（秒），对应 api_keys.cache_ttl 的 schema 默认值。 */
  cacheTtlSeconds: z.number().int().positive(),
  /** 限流固定窗口长度（秒），对应 src/routes/v1/rate-limit.ts WINDOW_SECONDS。 */
  rateLimitWindowSeconds: z.number().int().positive(),
  /** request_logs 明细保留天数（REQUEST_LOG_RETENTION_DAYS env 覆盖，缺省 30）。 */
  requestLogRetentionDays: z.number().int().positive(),
  /**
   * 注册赠金金额（USD，SIGNUP_BONUS_AMOUNT env；缺省 5，0 = 不赠）。
   * 11-08 起语义 = **手机验证赠金**（手机号注册 / 绑定手机时发放）。
   * 展示的是 parseBonusAmount 解析后的**生效值**（非原始 env 字符串）。
   */
  signupBonusAmount: z.number().nonnegative(),
  /**
   * 邮箱绑定赠金金额（USD，EMAIL_VERIFY_BONUS_AMOUNT env；缺省 5，0 = 不赠）。
   * 11-08 起语义 = **邮箱绑定并验证**时发放。同上为生效值。
   */
  emailVerifyBonusAmount: z.number().nonnegative(),
  /**
   * GitHub 绑定赠金金额（USD，GITHUB_BIND_BONUS_AMOUNT env；缺省 5，0 = 不赠）。
   * 11-08 新增：注册后绑定 GitHub 账户时发放（OAuth 直接注册不发）。同上为生效值。
   */
  githubBindBonusAmount: z.number().nonnegative(),
  /** 邮箱验证功能总开关（EMAIL_VERIFICATION_ENABLED env；缺省 false = 休眠）。 */
  emailVerificationEnabled: z.boolean(),
  /**
   * 账户安全总开关（EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED env；缺省 false）。
   * false = 邮件注册的账户（有 credential 凭据行）不能提升为 admin —— 管理画面据此置灰提升操作，
   * 与 PATCH /api/users/:id 的 403 门控取**同一个判据**（src/lib/admin-promotion-policy.ts）。
   */
  emailAccountAdminPromotionEnabled: z.boolean(),
});

export const settingsOutputSchema = z.object({
  success: z.literal(true),
  settings: runtimeSettingsSchema,
});

// ============= 类型导出 =============

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type SettingsOutput = z.infer<typeof settingsOutputSchema>;
