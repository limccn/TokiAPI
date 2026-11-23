// POST /api/tokimeki/anon-host — 公开：一次返回匿名 Host JWT + namespace/session + invite URL。
//
// namespace/slug 完全由服务端生成（4 位 namespace + 双词 slug），不读用户表、不写 tokimeki_tokens；
// invite 的 created_by 为 NULL。TTL 由 TOKIMEKI_ANON_HOST_TTL_SECONDS 控制（默认 24h）。
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { platformBaseUrl } from "../../../lib/domains";
import { generateReadableCode } from "../../../lib/namespace";
import { generateWordSlug } from "../../../lib/word-slug";
import { createInvite, DEFAULT_INVITE_TTL_SECONDS } from "../lib/invites";
import {
  parseAnonHostTtl,
  readTokimekiJwtConfig,
  signHostJwt,
} from "../lib/jwt";

export async function anonHostHandler(c: Context<AppEnv>): Promise<Response> {
  const logger = c.get("logger");
  const config = readTokimekiJwtConfig(c.env);
  if (config === null) {
    return c.json({ error: { message: "Tokimeki is not configured" } }, 503);
  }

  const namespace = generateReadableCode(4);
  const slug = generateWordSlug();
  const session = `${namespace}.${slug}`;
  const ttlSeconds = parseAnonHostTtl(c.env.TOKIMEKI_ANON_HOST_TTL_SECONDS);
  const sub = `anon:${generateReadableCode(12)}`;
  const jti = crypto.randomUUID();
  const signed = await signHostJwt(config, {
    sub,
    namespace,
    jti,
    ttlSeconds,
  });

  const origin = platformBaseUrl(c.env, new URL(c.req.url).origin);
  const invite = await createInvite({
    db: createDb(c.env),
    origin,
    createdBy: null,
    namespace,
    session,
    mode: "viewer",
    allowWeb: true,
    passcodeRequired: false,
    ttlSeconds: DEFAULT_INVITE_TTL_SECONDS,
  });

  // Never log the token, invite URL, or code.
  logger.info("tokimeki_anon_host_created", {
    namespace,
    session,
    inviteRowId: invite.row.id,
    expiresAt: signed.expiresAt,
  });

  c.header("Cache-Control", "no-store");
  return c.json({
    success: true as const,
    token: signed.token,
    namespace,
    session,
    inviteUrl: invite.url,
    expiresAt: new Date(signed.expiresAt * 1000).toISOString(),
  });
}
