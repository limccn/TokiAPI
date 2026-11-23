// GET /api/tokimeki/namespace — 当前用户的 5 位 namespace_short。
// 前端组装默认 session 名（`${namespace}.${random3}`）的唯一数据源；
// `ensureNamespace` 懒回填存量用户。轻量只读，不依赖 JWT 私钥配置。
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { ensureNamespace } from "../../../lib/namespace";

export function namespaceRoute(app: Hono<AppEnv>): void {
  app.get("/namespace", async (c) => {
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const namespace = await ensureNamespace(createDb(c.env), userId);
    if (namespace === null) {
      throw new HTTPException(404, { message: "User not found" });
    }
    return c.json({ success: true as const, namespace: namespace.namespaceShort });
  });
}
