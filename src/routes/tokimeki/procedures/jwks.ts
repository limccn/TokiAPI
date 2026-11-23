// GET /api/tokimeki/jwks.json — 公开 JWKS（relay 离线验签用）。
// 必须注册在 requireSession 之前（见 src/index.ts），因此本 handler 不读取会话。
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { buildJwks, readTokimekiJwtConfig } from "../lib/jwt";

export function jwksHandler(c: Context<AppEnv>) {
  const config = readTokimekiJwtConfig(c.env);
  if (config === null) {
    return c.json({ error: { message: "Tokimeki is not configured" } }, 404);
  }
  return c.json(buildJwks(config), 200, {
    "Cache-Control": "public, max-age=3600",
  });
}
