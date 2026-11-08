// DB → API 响应转换（type-safety spec：枚举列类型断言集中在转换工具，不散落在 handler）。
import type { User } from "../../../db/schema";
import type { UserRole, UserStatus } from "../../../types";
import type { InviteCodeResponse, UserResponse } from "../types";

/**
 * DB 用户行 → API 响应（时间戳 ISO 字符串；role/status 窄化为字面量类型）。
 *
 * `emailRegistered` 与 `githubLinked` **都是必填参数**（不是可选、不给默认值）：它们是
 * accounts 表的事实，本函数查不到 —— 设成可选会让漏传的调用点静默把邮箱注册账户报成
 * false（管理画面照常可点 = 假防线），或把已绑 GitHub 的账户报成未绑（解绑按钮永远灰着）。
 * 必填参数由编译器逼每个调用点显式传入（09-21-email-admin-promotion-switch / 11-08 R10）。
 */
export function toUserResponse(
  user: User,
  emailRegistered: boolean,
  githubLinked: boolean,
): UserResponse {
  return {
    id: String(user.id),
    email: user.email,
    name: user.name,
    role: user.role as UserRole,
    status: user.status as UserStatus,
    balance: user.balance,
    emailVerified: user.emailVerified,
    emailRegistered,
    phoneNumber: user.phoneNumber,
    phoneNumberVerified: user.phoneNumberVerified,
    githubLinked,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

/**
 * 邀请码行 → API 响应。
 * 完整 code 对 admin 返回（列表与创建响应一致）：管理页需展示/复制完整码分发，
 * 脱敏返回会使复制按钮复制出掩码废码（task 08-28-fix-invite-copy）。
 */
export function toInviteCodeResponse(invite: {
  id: number;
  code: string;
  /** 可空（09-22-seed-users-dev-only / D-F1）：dev 种子路由自铸的码无签发者（空库首张码不存在合法发起人）。 */
  createdBy: number | null;
  createdAt: Date;
  usedAt: Date | null;
  expiresAt: Date;
}): InviteCodeResponse {
  return {
    id: invite.id,
    code: invite.code,
    status: invite.usedAt !== null
      ? "used"
      : invite.expiresAt.getTime() < Date.now()
        ? "expired"
        : "active",
    createdBy: invite.createdBy,
    createdAt: invite.createdAt.toISOString(),
    usedAt: invite.usedAt?.toISOString() ?? null,
    expiresAt: invite.expiresAt.toISOString(),
  };
}
