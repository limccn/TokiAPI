// DELETE /api/tokimeki/invites/:id — 撤销本人 invite（幂等；非本人 404 防枚举）。
import { and, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { tokimekiInvites } from "../../../db/schema";

const idParamSchema = z.object({ id: z.string().regex(/^[1-9][0-9]*$/u) });

export function revokeInviteRoute(app: Hono<AppEnv>): void {
  app.delete("/invites/:id", zValidator("param", idParamSchema), async (c) => {
    const logger = c.get("logger");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const inviteId = Number(c.req.valid("param").id);
    const db = createDb(c.env);
    const existing = await db.query.tokimekiInvites.findFirst({
      where: and(eq(tokimekiInvites.id, inviteId), eq(tokimekiInvites.createdBy, userId)),
    });
    if (existing === undefined || existing === null) {
      throw new HTTPException(404, { message: "Invite not found" });
    }
    if (existing.revokedAt === null) {
      await db
        .update(tokimekiInvites)
        .set({ revokedAt: new Date() })
        .where(eq(tokimekiInvites.id, inviteId));
      logger.info("tokimeki_invite_revoked", { inviteRowId: inviteId, userId });
    }
    return c.json({ success: true as const });
  });
}
