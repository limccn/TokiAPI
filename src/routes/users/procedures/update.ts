// PATCH /api/users/:id — 角色变更 / 停用启用（admin）。
// 防护（按此顺序，先报哪个由优先级决定）：
//   ① 404 目标不存在；
//   ② 400 自锁（不允许 admin 停用自己或将自己降级为 member）；
//   ③ 403 账户安全总开关（09-21-email-admin-promotion-switch）：开关关闭时邮件注册的账户不能
//      提升为 admin。**显式拒绝**而非静默忽略 role 字段 —— 静默会让调用方以为改成功了。
// 门控位置刻意在 UPDATE **之前**：被拒时 D1 里一行都不动（AC1 断言的是这个效果，不是状态码）。
import { eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { users } from "../../../db/schema";
import { createDb } from "../../../db";
import {
  ADMIN_PROMOTION_BLOCKED_MESSAGE,
  isEmailAccountAdminPromotionEnabled,
  shouldBlockAdminPromotion,
  type PromotionRole,
} from "../../../lib/admin-promotion-policy";
import { hasEmailCredential, hasGithubAccount } from "../lib/email-credential";
import { updateUserInputSchema, userIdParamSchema } from "../types";
import { toUserResponse } from "../lib/convert";

export function updateUserRoute(app: Hono<AppEnv>): void {
  app.patch(
    "/:id",
    zValidator("param", userIdParamSchema),
    zValidator("json", updateUserInputSchema),
    async (c) => {
      const logger = c.get("logger");
      const params = c.req.valid("param");
      const body = c.req.valid("json");
      const currentUserId = c.get("userId");
      const db = createDb(c.env);

      const existing = await db.query.users.findFirst({
        where: eq(users.id, params.id),
      });
      if (!existing) {
        throw new HTTPException(404, { message: "User not found" });
      }

      const isSelf = currentUserId === String(existing.id);
      if (isSelf && body.status === "disabled") {
        throw new HTTPException(400, {
          message: "Cannot disable your own account",
        });
      }
      if (isSelf && body.role !== undefined && body.role !== "admin") {
        throw new HTTPException(400, {
          message: "Cannot demote your own account",
        });
      }

      // ③ 账户安全总开关：开关关闭 ⇒ 邮件注册的账户永远不能提升为 admin。
      // 一次查询两处用（门控 + 响应体的 emailRegistered 是同一个事实，不查第二遍）。
      // 角色窄化照 src/middleware/auth.ts 的写法，未知值一律落到 "member"（fail-closed：
      // 门控里 currentRole !== "admin" 才是「提升」，落到 member 就是拦住的那一侧）。
      const currentRole: PromotionRole =
        existing.role === "admin" ? "admin" : "member";
      const targetEmailRegistered = await hasEmailCredential(db, existing.id);
      // GitHub 绑定事实（11-08 R10）：响应体与列表契约同字段，一次查询
      const targetGithubLinked = await hasGithubAccount(db, existing.id);
      if (
        shouldBlockAdminPromotion({
          promotionEnabled: isEmailAccountAdminPromotionEnabled(
            c.env.EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED,
          ),
          requestedRole: body.role,
          currentRole,
          targetHasEmailCredential: targetEmailRegistered,
        })
      ) {
        // 可审计：谁想把谁提成 admin、因何被拒（不记邮箱/姓名，只记 id 与原因）
        logger.warn("admin_promotion_blocked", {
          targetUserId: existing.id,
          byUserId: currentUserId,
          reason: "email_account_policy",
        });
        throw new HTTPException(403, {
          message: ADMIN_PROMOTION_BLOCKED_MESSAGE,
        });
      }

      const [updated] = await db
        .update(users)
        .set({
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, params.id))
        .returning();
      if (!updated) {
        throw new HTTPException(404, { message: "User not found" });
      }

      logger.info("user_updated", {
        targetUserId: updated.id,
        byUserId: currentUserId,
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      return c.json({
        success: true as const,
        user: toUserResponse(updated, targetEmailRegistered, targetGithubLinked),
      });
    },
  );
}
