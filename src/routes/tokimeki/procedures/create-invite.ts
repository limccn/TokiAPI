// POST /api/tokimeki/invites — 登录用户创建分享链接（一次性 code）。
// 创建逻辑下沉 lib/invites.createInvite；本 procedure 只做鉴权/前缀校验/日志。
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { platformBaseUrl } from "../../../lib/domains";
import { ensureNamespace } from "../../../lib/namespace";
import { createInvite, toInviteSummary } from "../lib/invites";
import { readTokimekiJwtConfig } from "../lib/jwt";
import { createInviteInputSchema } from "../types";

export function createInviteRoute(app: Hono<AppEnv>): void {
  app.post("/invites", zValidator("json", createInviteInputSchema), async (c) => {
    const logger = c.get("logger");
    if (readTokimekiJwtConfig(c.env) === null) {
      throw new HTTPException(503, { message: "Tokimeki is not configured" });
    }
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const body = c.req.valid("json");
    const db = createDb(c.env);
    const namespace = await ensureNamespace(db, userId);
    if (namespace === null) {
      throw new HTTPException(404, { message: "User not found" });
    }
    if (!body.session.startsWith(`${namespace.namespaceShort}.`)) {
      throw new HTTPException(400, {
        message: `session must start with "${namespace.namespaceShort}."`,
      });
    }

    const origin = platformBaseUrl(c.env, new URL(c.req.url).origin);
    const created = await createInvite({
      db,
      origin,
      createdBy: userId,
      namespace: namespace.namespaceShort,
      session: body.session,
      mode: body.mode,
      allowWeb: body.allowWeb,
      passcodeRequired: body.passcodeRequired,
      ttlSeconds: body.ttlSeconds,
    });

    logger.info("tokimeki_invite_created", {
      inviteRowId: created.row.id,
      userId,
      mode: created.row.mode,
      expiresAt: created.row.expiresAt.toISOString(),
    });

    c.header("Cache-Control", "no-store");
    return c.json({
      success: true as const,
      invite: {
        ...toInviteSummary(created.row),
        url: created.url,
      },
    });
  });
}
