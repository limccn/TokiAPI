// POST /api/tokimeki/token — 签发 Host JWT（master token）。
// 明文 JWT 只在本次响应返回一次；DB 只记录元数据（design.md §2.2）。
import { zValidator } from "@hono/zod-validator";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { tokimekiTokens } from "../../../db/schema";
import { ensureNamespace } from "../../../lib/namespace";
import { readTokimekiJwtConfig, signHostJwt } from "../lib/jwt";
import { toTokimekiTokenRecord } from "../lib/convert";
import { createTokimekiTokenInputSchema } from "../types";

export function createTokimekiTokenRoute(app: Hono<AppEnv>): void {
  app.post("/token", zValidator("json", createTokimekiTokenInputSchema), async (c) => {
    const logger = c.get("logger");
    const config = readTokimekiJwtConfig(c.env);
    if (config === null) {
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

    const jti = crypto.randomUUID();
    const signed = await signHostJwt(config, {
      sub: String(userId),
      namespace: namespace.namespaceShort,
      jti,
    });

    const inserted = await db
      .insert(tokimekiTokens)
      .values({
        userId,
        name: body.name,
        jti,
        kid: config.kid,
        namespace: namespace.namespaceShort,
        expiresAt: new Date(signed.expiresAt * 1000),
      })
      .returning();

    const row = inserted[0];
    if (!row) {
      throw new HTTPException(500, { message: "Failed to record Tokimeki token" });
    }

    logger.info("tokimeki_token_created", {
      tokenId: row.id,
      userId,
      jti,
      kid: config.kid,
      namespace: namespace.namespaceShort,
      expiresAt: signed.expiresAt,
    });

    return c.json({
      success: true as const,
      token: signed.token,
      record: toTokimekiTokenRecord(row),
    });
  });
}
