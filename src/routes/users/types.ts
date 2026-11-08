// 用户管理模块（M2 2.6，admin）：Zod schema + 类型定义（api-module spec）。
// 时间戳一律 ISO 字符串（type-safety spec：全 API 统一格式）。
import { z } from "zod";

// ============= 输入 Schemas =============

export const listUsersQuerySchema = z.object({
  search: z.string().max(100).optional(),
  role: z.enum(["admin", "member"]).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const updateUserInputSchema = z
  .object({
    role: z.enum(["admin", "member"]).optional(),
    status: z.enum(["active", "disabled"]).optional(),
  })
  .refine((value) => value.role !== undefined || value.status !== undefined, {
    message: "At least one of role or status is required",
  });

export const createInviteInputSchema = z.object({
  expiresInDays: z.coerce.number().int().min(1).max(90).default(30),
});

export const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/** 管理员代充/扣减（R5.1）：amount 带符号（±），不允许 0。 */
export const adjustBalanceInputSchema = z.object({
  amount: z.number().refine((v) => v !== 0, {
    message: "amount must not be zero",
  }),
  note: z.string().max(500).optional(),
});

// ============= 输出 Schemas =============

export const userResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(["admin", "member"]),
  status: z.enum(["active", "disabled"]),
  balance: z.number(),
  emailVerified: z.boolean(),
  /**
   * 是否为邮件注册的账户（accounts 表有 provider_id='credential' 行）。
   * 管理画面据它决定提升操作是否置灰 —— 与写边界门控取同一个事实，
   * 否则会出现「画面能点、API 拒绝」或「画面灰着、API 放行」（09-21-email-admin-promotion-switch）。
   */
  emailRegistered: z.boolean(),
  /**
   * 规范形手机号（`+861…`）；未绑定 null（11-08 R10 / design §14.1）。
   * 管理台据此展示绑定状态与解绑按钮的可用性 —— 与 profile 契约的 phoneNumber 同列。
   */
  phoneNumber: z.string().nullable(),
  /**
   * 号码是否已验证（phone-number 插件写入）。
   * 解绑护栏只看「有没有号码」，**不要求已验证**（design §14.3 D8：号码本身即登录标识，
   * 未验证号码仍可走短信验证码登录）。本字段只供列表展示 `unverified` 徽章。
   */
  phoneNumberVerified: z.boolean(),
  /**
   * 是否已绑定 GitHub（accounts 存在 providerId='github' 行；11-08 R10）。
   * 与 GET /api/me/profile 的 githubLinked 同口径、同事实来源。
   */
  githubLinked: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const listUsersOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(userResponseSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

export const updateUserOutputSchema = z.object({
  success: z.literal(true),
  user: userResponseSchema,
});

export const deleteUserOutputSchema = z.object({
  success: z.literal(true),
});

export const adjustBalanceOutputSchema = z.object({
  success: z.literal(true),
  balance: z.number(),
  tx: z.object({
    id: z.number().int(),
    amount: z.number(),
    type: z.literal("adjust"),
    note: z.string().nullable(),
    createdAt: z.string(), // ISO
  }),
});

export const inviteCodeResponseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  status: z.enum(["active", "used", "expired"]),
  // 可空：dev 种子路由自铸的码没有签发者（09-22-seed-users-dev-only / D-F1）；生产恒为数字。
  createdBy: z.number().int().nullable(),
  createdAt: z.string(),
  usedAt: z.string().nullable(),
  expiresAt: z.string(),
});

export const createInviteOutputSchema = z.object({
  success: z.literal(true),
  invite: inviteCodeResponseSchema,
});

export const listInvitesOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(inviteCodeResponseSchema),
});

// ============= 类型导出 =============

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;
export type DeleteUserOutput = z.infer<typeof deleteUserOutputSchema>;
export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;
export type AdjustBalanceInput = z.infer<typeof adjustBalanceInputSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
export type InviteCodeResponse = z.infer<typeof inviteCodeResponseSchema>;
