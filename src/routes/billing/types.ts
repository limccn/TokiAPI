// 计费流水模块（M8 journal 延期项 3）：GET /api/me/transactions（member 自己）、
// GET /api/admin/transactions（admin，可选 userId 过滤，复用同一查询）。
// 约定：from/to 为 YYYY-MM-DD（含当日，UTC 日界，与 usage 报表口径一致）；
// 时间戳统一 ISO 字符串（type-safety spec）；响应格式 { success, items, total, limit, offset }。
import { z } from "zod";

// 取值真源（筛选参数校验 + 输出校验共用）：新增 type 必须同步此 enum，
// 否则前端筛选该 type 会被 zValidator 拒绝（400）。赠金三档（09-16-signup-bonus-grant；
// 11-08-reward-semantics-overhaul 增第三档）对应 users.signup_bonus_granted_at /
// email_verify_bonus_granted_at / github_bind_bonus_granted_at 的幂等标记：
// 注册赠金=手机验证、邮箱赠金=邮箱绑定、GitHub 赠金=注册后绑定 GitHub。
export const balanceTxTypeSchema = z.enum([
  "recharge",
  "usage",
  "adjust",
  "signup_bonus",
  "email_verify_bonus",
  "github_bind_bonus",
]);

export const meTransactionsQuerySchema = z.object({
  type: balanceTxTypeSchema.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const adminTransactionsQuerySchema = meTransactionsQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
});

// ============= 输出 Schemas =============

export const transactionItemSchema = z.object({
  id: z.number().int(),
  type: balanceTxTypeSchema,
  amount: z.number(), // 带符号：充值/调整 +，扣费 -
  note: z.string().nullable(),
  refRequestId: z.number().int().nullable(),
  createdAt: z.string(), // ISO
});

export const transactionsOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(transactionItemSchema),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

// ============= 类型导出 =============

export type BalanceTxType = z.infer<typeof balanceTxTypeSchema>;
export type MeTransactionsQuery = z.infer<typeof meTransactionsQuerySchema>;
export type AdminTransactionsQuery = z.infer<typeof adminTransactionsQuerySchema>;
export type TransactionItem = z.infer<typeof transactionItemSchema>;
export type TransactionsOutput = z.infer<typeof transactionsOutputSchema>;
