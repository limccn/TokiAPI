// POST /api/tokimeki/attach — 公开、匿名可调用：code 换一次性 cookie。
// 任何失败统一 410，不区分「不存在/过期/撤销」，防链接预言机。
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { tokimekiAttachTickets } from "../../../db/schema";
import { lt } from "drizzle-orm";
import {
  ATTACH_TICKET_TTL_SECONDS,
  createAttachTicket,
  inviteStatus,
  resolveInviteByCode,
} from "../lib/invites";
import { attachInputSchema } from "../types";
import { ATTACH_COOKIE_NAME, invalidLink } from "./common";

export async function attachHandler(c: Context<AppEnv>): Promise<Response> {
  const parsed = attachInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return invalidLink(c);
  }
  const db = createDb(c.env);
  const invite = await resolveInviteByCode(db, parsed.data.code);
  const now = new Date();
  if (
    invite === null ||
    inviteStatus(invite, now) !== "active" ||
    !invite.allowWeb
  ) {
    return invalidLink(c);
  }

  // Opportunistic cleanup of tickets older than one hour; the daily cron
  // handles the long tail.
  await db
    .delete(tokimekiAttachTickets)
    .where(lt(tokimekiAttachTickets.expiresAt, new Date(now.getTime() - 3_600_000)))
    .run();

  const ticket = await createAttachTicket(db, invite.id, now);
  const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
  c.header(
    "Set-Cookie",
    `${ATTACH_COOKIE_NAME}=${ticket.ticket}; HttpOnly; SameSite=Strict; Path=/api/tokimeki/ws; Max-Age=${ATTACH_TICKET_TTL_SECONDS}${secure}`,
  );
  c.header("Cache-Control", "no-store");
  c.get("logger").info("tokimeki_attach_ticket_issued", {
    inviteRowId: invite.id,
    session: invite.session,
  });
  return c.json({
    success: true as const,
    session: invite.session,
    mode: invite.mode === "listener" ? "listener" : "viewer",
    passcodeRequired: invite.passcodeRequired,
  });
}
