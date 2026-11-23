// GET /api/tokimeki/invites — 本人 invite 列表（不含 URL；code 不可恢复）。
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { tokimekiInvites } from "../../../db/schema";
import { toInviteSummary } from "../lib/invites";

export function listInvitesRoute(app: Hono<AppEnv>): void {
  app.get("/invites", async (c) => {
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const rows = await createDb(c.env)
      .select()
      .from(tokimekiInvites)
      .where(eq(tokimekiInvites.createdBy, userId))
      .orderBy(desc(tokimekiInvites.createdAt))
      .limit(50);
    return c.json({
      success: true as const,
      items: rows.map((row) => toInviteSummary(row)),
    });
  });
}
