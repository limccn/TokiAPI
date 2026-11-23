// Tokimeki master token 模块：Zod schema 与类型（spec api-module / type-safety）。
import { z } from "zod";

// ============= 输入 =============

export const createTokimekiTokenInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(100, "Max 100 characters")
    .default("Master token"),
});

// ============= 输出 =============

export const tokimekiTokenSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  /** JWT `jti`（完整值；UI 只展示前 8 位）。 */
  jti: z.string(),
  kid: z.string(),
  namespace: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
});

export const createTokimekiTokenOutputSchema = z.object({
  success: z.literal(true),
  /** 明文 JWT：仅本响应返回一次。 */
  token: z.string(),
  record: tokimekiTokenSchema,
});

export const listTokimekiTokensOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(tokimekiTokenSchema),
});

// ============= 类型导出 =============

export type CreateTokimekiTokenInput = z.infer<typeof createTokimekiTokenInputSchema>;
export type TokimekiTokenRecord = z.infer<typeof tokimekiTokenSchema>;
export type CreateTokimekiTokenOutput = z.infer<typeof createTokimekiTokenOutputSchema>;
export type ListTokimekiTokensOutput = z.infer<typeof listTokimekiTokensOutputSchema>;

// ============= 11-18-tokimeki-share-link-attach =============

export const inviteModeSchema = z.enum(["viewer", "listener"]);

export const createInviteInputSchema = z.object({
  session: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Invalid session id"),
  mode: inviteModeSchema,
  ttlSeconds: z.number().int().min(60).max(604_800).default(86_400),
  allowWeb: z.boolean().default(true),
  passcodeRequired: z.boolean().default(false),
});

export const inviteSummarySchema = z.object({
  id: z.number().int(),
  session: z.string(),
  mode: inviteModeSchema,
  allowWeb: z.boolean(),
  passcodeRequired: z.boolean(),
  createdAt: z.string(),
  expiresAt: z.string(),
  status: z.enum(["active", "expired", "revoked"]),
});

export const createInviteOutputSchema = z.object({
  success: z.literal(true),
  invite: inviteSummarySchema.extend({ url: z.string() }),
});

export const listInvitesOutputSchema = z.object({
  success: z.literal(true),
  items: z.array(inviteSummarySchema),
});

export const inviteTokenOutputSchema = z.object({
  success: z.literal(true),
  token: z.string(),
  session: z.string(),
  mode: inviteModeSchema,
  allowWeb: z.boolean(),
  passcodeRequired: z.boolean(),
  expiresAt: z.string(),
});

export const attachInputSchema = z.object({
  code: z.string().trim().min(1).max(64),
});

export const attachOutputSchema = z.object({
  success: z.literal(true),
  session: z.string(),
  mode: inviteModeSchema,
  passcodeRequired: z.boolean(),
});

export const attachCliOutputSchema = inviteTokenOutputSchema;

export const namespaceOutputSchema = z.object({
  success: z.literal(true),
  namespace: z.string(),
});

export type CreateInviteInput = z.infer<typeof createInviteInputSchema>;
export type InviteSummaryOutput = z.infer<typeof inviteSummarySchema>;
export type AttachInput = z.infer<typeof attachInputSchema>;
