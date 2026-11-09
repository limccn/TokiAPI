// DELETE /api/users/:id/email — 解绑目标用户的邮箱凭据（admin，11-08 R10 / design §14.3）。
//
// 语义 = 「移除邮箱登录方式 + 把地址重置成占位邮箱」，不是「删邮箱字段」：
// users.email 是 NOT NULL UNIQUE，且 Better Auth 的账户模型以它作为身份展示与唯一约束。
// 重置为占位地址（`u<5hex>.+86<11位>@phone.invalid`，与手机号注册同形、同一个生成函数）
// 让账号从「邮箱注册账户」退回「手机号账户」：emailRegistered 变 false，重新绑邮箱即恢复。
//
// 前置条件（D8，需求原文）：目标必须**已绑定手机号** —— 否则解绑邮箱后既没有邮箱凭据、
// 也没有手机号，账号永久无法登录。手机号不必已验证：它仍是可用的登录标识
// （验证状态由 phoneNumberVerified 展示，不由本端点改变）。
//
// 刻意**不动**任何赠金标记（email_verify_bonus_granted_at 等）与 balance_tx：
// 解绑不回收已发放的赠金，重新绑定时幂等标记仍在 ⇒ 不会二次发放。
// 刻意**不删 sessions**：解绑是「换一种登录方式」，不是登出。
import { and, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { accounts, users } from "../../../db/schema";
import { createDb } from "../../../db";
import { buildPhonePlaceholderEmail } from "../../../lib/phone";
import {
  EMAIL_CREDENTIAL_PROVIDER_ID,
  hasEmailCredential,
  hasGithubAccount,
} from "../lib/email-credential";
import { userIdParamSchema } from "../types";
import { toUserResponse } from "../lib/convert";

export function unbindEmailRoute(app: Hono<AppEnv>): void {
  app.delete("/:id/email", zValidator("param", userIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const currentUserId = c.get("userId");
    const db = createDb(c.env);

    const target = await db.query.users.findFirst({
      where: eq(users.id, params.id),
    });
    if (!target) {
      throw new HTTPException(404, { message: "User not found" });
    }

    // 无 credential 行 = 本来就没有邮箱登录方式（含手机号注册的占位邮箱账号）
    if (!(await hasEmailCredential(db, target.id))) {
      throw new HTTPException(409, {
        message: "No email address is bound",
      });
    }
    // D8 前置：没有手机号就没有替代登录标识
    if (target.phoneNumber === null) {
      throw new HTTPException(409, {
        message: "Bind a phone number before unbinding email",
      });
    }

    // GitHub 绑定事实在解绑前后不变（与列表契约同字段），用于响应体
    const targetGithubLinked = await hasGithubAccount(db, target.id);
    const placeholderEmail = buildPhonePlaceholderEmail(target.phoneNumber);
    const now = new Date();

    // batch = 隐式事务（全成全败）：要么「凭据行消失 + 地址已重置」，要么一行都不动。
    // 父表 users 后写（先删子表行，避免 SQLite 即时外键约束）。
    await db.batch([
      db
        .delete(accounts)
        .where(
          and(
            eq(accounts.userId, target.id),
            eq(accounts.providerId, EMAIL_CREDENTIAL_PROVIDER_ID),
          ),
        ),
      db
        .update(users)
        .set({
          email: placeholderEmail,
          emailVerified: false,
          updatedAt: now,
        })
        .where(eq(users.id, target.id)),
    ]);

    logger.info("user_email_unbound", {
      // 不记邮箱/号码：日志不落 PII（占位地址里也带号码，故整体不记）
      targetUserId: target.id,
      byUserId: currentUserId,
    });
    return c.json({
      success: true as const,
      user: toUserResponse(
        { ...target, email: placeholderEmail, emailVerified: false, updatedAt: now },
        false,
        targetGithubLinked,
      ),
    });
  });
}
