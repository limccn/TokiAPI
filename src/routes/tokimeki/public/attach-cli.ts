// POST /api/tokimeki/attach/cli — 公开：code 换 CLI 档 Session JWT。
// `allow_web` 不限制 CLI，但必须回传供前端决定是否显示 "Open in browser"。
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import {
  inviteStatus,
  resolveInviteByCode,
} from "../lib/invites";
import {
  MAX_SESSION_JWT_TTL_SECONDS,
  readTokimekiJwtConfig,
  signSessionJwt,
} from "../lib/jwt";
import { attachInputSchema } from "../types";
import { invalidLink } from "./common";

export async function attachCliHandler(c: Context<AppEnv>): Promise<Response> {
  const parsed = attachInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return invalidLink(c);
  }
  const config = readTokimekiJwtConfig(c.env);
  if (config === null) {
    return c.json({ error: { message: "Tokimeki is not configured" } }, 503);
  }
  const db = createDb(c.env);
  const invite = await resolveInviteByCode(db, parsed.data.code);
  const now = new Date();
  if (invite === null || inviteStatus(invite, now) !== "active") {
    return invalidLink(c);
  }
  const remaining = Math.floor((invite.expiresAt.getTime() - now.getTime()) / 1000);
  if (remaining <= 0) {
    return invalidLink(c);
  }
  const mode = invite.mode === "listener" ? "listener" : "viewer";
  const signed = await signSessionJwt(config, {
    sub: String(invite.createdBy ?? "anon"),
    namespace: invite.namespace,
    session: invite.session,
    scope: mode === "listener" ? "listen" : "attach",
    ttlSeconds: Math.min(MAX_SESSION_JWT_TTL_SECONDS, remaining),
  });
  c.header("Cache-Control", "no-store");
  c.get("logger").info("tokimeki_attach_cli_issued", {
    inviteRowId: invite.id,
    mode,
    expiresAt: signed.expiresAt,
  });
  return c.json({
    success: true as const,
    token: signed.token,
    session: invite.session,
    mode,
    allowWeb: invite.allowWeb,
    passcodeRequired: invite.passcodeRequired,
    expiresAt: new Date(signed.expiresAt * 1000).toISOString(),
  });
}
