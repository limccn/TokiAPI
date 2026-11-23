// GET /api/tokimeki/tokens — 本人已签发的 master token 元数据列表。
// 不返回 JWT 明文；ES256 无撤销列表，删除记录不代表 token 失效（UI 需明示）。
import { desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { tokimekiTokens } from "../../../db/schema";
import { toTokimekiTokenRecord } from "../lib/convert";

export function listTokimekiTokensRoute(app: Hono<AppEnv>): void {
  app.get("/tokens", async (c) => {
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    const db = createDb(c.env);
    const rows = await db
      .select()
      .from(tokimekiTokens)
      .where(eq(tokimekiTokens.userId, userId))
      .orderBy(desc(tokimekiTokens.createdAt));

    return c.json({
      success: true as const,
      items: rows.map(toTokimekiTokenRecord),
    });
  });
}
