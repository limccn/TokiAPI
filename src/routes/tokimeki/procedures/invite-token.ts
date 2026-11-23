// POST /api/tokimeki/invites/:id/token — owner 重新生成 CLI 档 Session JWT。
// `:id` 是 DB 行 id（非秘密）；仅本人；active 才可签发；JWT exp <= invite.expiresAt。
import { and, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { tokimekiInvites } from "../../../db/schema";
import { inviteStatus } from "../lib/invites";
import {
  MAX_SESSION_JWT_TTL_SECONDS,
  readTokimekiJwtConfig,
  signSessionJwt,
} from "../lib/jwt";

const idParamSchema = z.object({ id: z.string().regex(/^[1-9][0-9]*$/u) });

export function inviteTokenRoute(app: Hono<AppEnv>): void {
  app.post("/invites/:id/token", zValidator("param", idParamSchema), async (c) => {
    const logger = c.get("logger");
    const config = readTokimekiJwtConfig(c.env);
    if (config === null) {
      throw new HTTPException(503, { message: "Tokimeki is not configured" });
    }
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const inviteId = Number(c.req.valid("param").id);
    const row = await createDb(c.env).query.tokimekiInvites.findFirst({
      where: and(eq(tokimekiInvites.id, inviteId), eq(tokimekiInvites.createdBy, userId)),
    });
    if (row === undefined || row === null) {
      throw new HTTPException(404, { message: "Invite not found" });
    }
    const now = new Date();
    if (inviteStatus(row, now) !== "active") {
      throw new HTTPException(410, { message: "Invite is no longer valid" });
    }
    const remaining = Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000);
    if (remaining <= 0) {
      throw new HTTPException(410, { message: "Invite is no longer valid" });
    }
    const mode = row.mode === "listener" ? "listener" : "viewer";
    const signed = await signSessionJwt(config, {
      sub: String(userId),
      namespace: row.namespace,
      session: row.session,
      scope: mode === "listener" ? "listen" : "attach",
      ttlSeconds: Math.min(MAX_SESSION_JWT_TTL_SECONDS, remaining),
    });
    logger.info("tokimeki_invite_token_issued", {
      inviteRowId: row.id,
      userId,
      mode,
      expiresAt: signed.expiresAt,
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      success: true as const,
      token: signed.token,
      session: row.session,
      mode,
      allowWeb: row.allowWeb,
      passcodeRequired: row.passcodeRequired,
      expiresAt: new Date(signed.expiresAt * 1000).toISOString(),
    });
  });
}
