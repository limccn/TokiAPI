// DELETE /api/users/:id — 硬删除用户（admin）+ 应用层级联清理。
// 防护：不允许删除自己或任何其他 admin（先降级再删）；级联经 D1 batch 原子提交
// （batch = 隐式事务，全成全败），父表 users 最后删除（FK 强制约束，无 ON DELETE CASCADE）。
import { eq, inArray } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import {
  accounts,
  apiKeys,
  balanceTx,
  inviteCodes,
  requestLogs,
  sessions,
  tokimekiAttachTickets,
  tokimekiInvites,
  tokimekiTokens,
  usageDaily,
  users,
} from "../../../db/schema";
import { createDb } from "../../../db";
import { userIdParamSchema } from "../types";

export function deleteUserRoute(app: Hono<AppEnv>): void {
  app.delete("/:id", zValidator("param", userIdParamSchema), async (c) => {
    const logger = c.get("logger");
    const params = c.req.valid("param");
    const currentUserId = c.get("userId");
    const db = createDb(c.env);

    const existing = await db.query.users.findFirst({
      where: eq(users.id, params.id),
    });
    if (!existing) {
      throw new HTTPException(404, { message: "User not found" });
    }

    const isSelf = currentUserId === String(existing.id);
    if (isSelf) {
      throw new HTTPException(400, {
        message: "Cannot delete your own account",
      });
    }
    if (existing.role === "admin") {
      throw new HTTPException(400, {
        message: "Cannot delete another admin — demote first",
      });
    }

    // 拓扑序（叶子先行）：balanceTx.refRequestId → requestLogs.id；
    // requestLogs.keyId / usageDaily.keyId → apiKeys.id；其余子表 → users.id。
    // 父行先删会触发 SQLite 即时外键约束，故 balanceTx → usageDaily → requestLogs
    // → sessions/accounts/inviteCodes → apiKeys → users。
    await db.batch([
      db.delete(balanceTx).where(eq(balanceTx.userId, existing.id)),
      db.delete(usageDaily).where(eq(usageDaily.userId, existing.id)),
      db.delete(requestLogs).where(eq(requestLogs.userId, existing.id)),
      db.delete(sessions).where(eq(sessions.userId, existing.id)),
      db.delete(accounts).where(eq(accounts.userId, existing.id)),
      db.delete(inviteCodes).where(eq(inviteCodes.createdBy, existing.id)),
      // Tokimeki invites: tickets first (FK topology), then invites.
      db
        .delete(tokimekiAttachTickets)
        .where(
          inArray(
            tokimekiAttachTickets.inviteId,
            db
              .select({ id: tokimekiInvites.id })
              .from(tokimekiInvites)
              .where(eq(tokimekiInvites.createdBy, existing.id)),
          ),
        ),
      db.delete(tokimekiInvites).where(eq(tokimekiInvites.createdBy, existing.id)),
      db.delete(tokimekiTokens).where(eq(tokimekiTokens.userId, existing.id)),
      db.delete(apiKeys).where(eq(apiKeys.userId, existing.id)),
      db.delete(users).where(eq(users.id, existing.id)),
    ]);

    logger.info("user_deleted", {
      targetUserId: existing.id,
      byUserId: currentUserId,
    });
    return c.json({ success: true as const });
  });
}
