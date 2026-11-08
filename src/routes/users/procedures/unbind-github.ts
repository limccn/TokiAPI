// DELETE /api/users/:id/github — 解绑目标用户的 GitHub 账号（admin，11-08 R10 / design §14.2）。
//
// 为什么由管理员做、而不是自助：GitHub 是登录方式之一，解绑是「减少登录入口」的操作，
// 与停用/删除同属账户治理面；自助解绑需要二次验证（GitHub 侧本身没有服务端可撤销的会话），
// 本轮不做。
//
// 护栏（D9）：**不允许解掉最后一个登录方式**。判据 = 目标既没有手机号、也没有邮件凭据行
// —— 此时 GitHub 是唯一入口，解绑后账号将永久无法登录（不可自愈）。
// 判定顺序：404 → 未绑定 409 → 最后登录方式 409 → 条件删除（并发下 deleted 为空再加一道 409）。
//
// 刻意**不删 sessions**：解绑 GitHub 不等于登出，管理员也不应顺带踢掉用户当前会话。
import { and, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { accounts, users } from "../../../db/schema";
import { createDb } from "../../../db";
import {
  GITHUB_PROVIDER_ID,
  hasEmailCredential,
  hasGithubAccount,
} from "../lib/email-credential";
import { userIdParamSchema } from "../types";
import { toUserResponse } from "../lib/convert";

export function unbindGithubRoute(app: Hono<AppEnv>): void {
  app.delete("/:id/github", zValidator("param", userIdParamSchema), async (c) => {
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

    const [targetGithubLinked, targetHasCredential] = await Promise.all([
      hasGithubAccount(db, target.id),
      hasEmailCredential(db, target.id),
    ]);
    if (!targetGithubLinked) {
      throw new HTTPException(409, {
        message: "GitHub account is not linked",
      });
    }
    if (target.phoneNumber === null && !targetHasCredential) {
      throw new HTTPException(409, {
        message: "Cannot unlink the last sign-in method",
      });
    }

    // 条件删除 + returning：并发下另一个请求可能已删掉同一行，此时返回空数组 ⇒ 409，
    // 而不是「假装成功」地回一个已解绑的响应。
    const deleted = await db
      .delete(accounts)
      .where(
        and(
          eq(accounts.userId, target.id),
          eq(accounts.providerId, GITHUB_PROVIDER_ID),
        ),
      )
      .returning({ id: accounts.id });
    if (deleted.length === 0) {
      throw new HTTPException(409, {
        message: "GitHub account is not linked",
      });
    }

    logger.info("user_github_unbound", {
      targetUserId: target.id,
      byUserId: currentUserId,
    });
    return c.json({
      success: true as const,
      user: toUserResponse(target, targetHasCredential, false),
    });
  });
}
