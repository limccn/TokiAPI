// Tokimeki invite 与一次性 attach ticket 的共享逻辑
// （11-18-tokimeki-share-link-attach）。
//
// 安全模型：invite code 只在创建响应中出现一次；DB 只存 SHA-256 哈希。
// 管理端点用行 id 做撤销/生成 CLI 凭证，因此刷新页面后无法恢复旧链接。
import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "../../../db";
import { tokimekiAttachTickets, tokimekiInvites } from "../../../db/schema";
import type { TokimekiInvite } from "../../../db/schema";
import { generateReadableCode } from "../../../lib/namespace";
import {
  INVITE_CODE_LENGTH,
  INVITE_CODE_PATTERN,
  isValidInviteCode,
} from "../../../lib/invite-code";

// Re-exported for existing worker imports and tests.
export { INVITE_CODE_LENGTH, INVITE_CODE_PATTERN, isValidInviteCode };

export const DEFAULT_INVITE_TTL_SECONDS = 86_400;
export const MIN_INVITE_TTL_SECONDS = 60;
export const MAX_INVITE_TTL_SECONDS = 604_800;
export const ATTACH_TICKET_TTL_SECONDS = 60;
export const INVITE_CLEANUP_RETENTION_DAYS = 7;

export type InviteMode = "viewer" | "listener";
export type InviteStatus = "active" | "expired" | "revoked";

export interface CreateInviteParams {
  readonly db: Db;
  /** Platform origin (BETTER_AUTH_URL/platformBaseUrl), never `c.req.url.origin`. */
  readonly origin: string;
  /** null for anonymous invites (task 3). */
  readonly createdBy: number | null;
  readonly namespace: string;
  readonly session: string;
  readonly mode: InviteMode;
  readonly allowWeb: boolean;
  readonly passcodeRequired?: boolean;
  readonly ttlSeconds: number;
  readonly now?: Date;
}

export interface CreatedInvite {
  readonly row: TokimekiInvite;
  readonly code: string;
  readonly url: string;
}

export interface InviteSummary {
  readonly id: number;
  readonly session: string;
  readonly mode: InviteMode;
  readonly allowWeb: boolean;
  readonly passcodeRequired: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: InviteStatus;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** SHA-256 hex of an invite code / attach ticket. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

export async function hashInviteCode(code: string): Promise<string> {
  return sha256Hex(code);
}

export async function hashTicket(ticket: string): Promise<string> {
  return sha256Hex(ticket);
}

/** 16-char readable invite code (30-char alphabet, ~78 bits). */
export function generateInviteCode(): string {
  return generateReadableCode(INVITE_CODE_LENGTH);
}

/** 32-byte random ticket, base64url encoded. */
export function generateTicket(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function inviteStatus(row: TokimekiInvite, now = new Date()): InviteStatus {
  if (row.revokedAt !== null) return "revoked";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

export function toInviteSummary(row: TokimekiInvite, now = new Date()): InviteSummary {
  return {
    id: row.id,
    session: row.session,
    mode: row.mode as InviteMode,
    allowWeb: row.allowWeb,
    passcodeRequired: row.passcodeRequired,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    status: inviteStatus(row, now),
  };
}

/**
 * Create the invite row and return the one-time URL.
 *
 * `origin` must be the platform origin resolved by the caller. Do not derive
 * it from the current request: workers.dev/API-domain origins would leak into
 * share links.
 */
export async function createInvite(params: CreateInviteParams): Promise<CreatedInvite> {
  const now = params.now ?? new Date();
  const code = generateInviteCode();
  const codeHash = await hashInviteCode(code);
  const expiresAt = new Date(now.getTime() + params.ttlSeconds * 1000);
  const inserted = await params.db
    .insert(tokimekiInvites)
    .values({
      codeHash,
      createdBy: params.createdBy,
      namespace: params.namespace,
      session: params.session,
      mode: params.mode,
      allowWeb: params.allowWeb,
      passcodeRequired: params.passcodeRequired === true,
      createdAt: now,
      expiresAt,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("failed to create tokimeki invite");
  }
  const origin = params.origin.replace(/\/+$/u, "");
  return { row, code, url: `${origin}/#t-${code}` };
}

/** Resolve an invite by plaintext code without leaking existence details. */
export async function resolveInviteByCode(
  db: Db,
  code: string,
): Promise<TokimekiInvite | null> {
  if (!isValidInviteCode(code)) {
    return null;
  }
  const codeHash = await hashInviteCode(code);
  const row = await db.query.tokimekiInvites.findFirst({
    where: eq(tokimekiInvites.codeHash, codeHash),
  });
  return row ?? null;
}

export async function findActiveInviteById(
  db: Db,
  inviteId: number,
  now = new Date(),
): Promise<TokimekiInvite | null> {
  const row = await db.query.tokimekiInvites.findFirst({
    where: eq(tokimekiInvites.id, inviteId),
  });
  if (row === undefined || row === null) return null;
  return inviteStatus(row, now) === "active" ? row : null;
}

/** Insert a 60-second, single-use attach ticket. */
export async function createAttachTicket(
  db: Db,
  inviteId: number,
  now = new Date(),
): Promise<{ ticket: string; expiresAt: Date }> {
  const ticket = generateTicket();
  const ticketHash = await hashTicket(ticket);
  const expiresAt = new Date(now.getTime() + ATTACH_TICKET_TTL_SECONDS * 1000);
  await db.insert(tokimekiAttachTickets).values({
    ticketHash,
    inviteId,
    createdAt: now,
    expiresAt,
  });
  return { ticket, expiresAt };
}

/**
 * Atomically consume a ticket. A single UPDATE ... WHERE consumed_at IS NULL
 * AND expires_at > now is the whole transaction (D1 has no BEGIN).
 */
export async function consumeAttachTicket(
  db: Db,
  ticket: string,
  now = new Date(),
): Promise<number | null> {
  const ticketHash = await hashTicket(ticket);
  const updated = await db
    .update(tokimekiAttachTickets)
    .set({ consumedAt: now })
    .where(
      and(
        eq(tokimekiAttachTickets.ticketHash, ticketHash),
        isNull(tokimekiAttachTickets.consumedAt),
        gt(tokimekiAttachTickets.expiresAt, now),
      ),
    )
    .returning({ inviteId: tokimekiAttachTickets.inviteId });
  return updated[0]?.inviteId ?? null;
}

/**
 * Daily cleanup: remove expired tickets first (FK topology), then invites.
 * Retention keeps revoked/expired rows for a short audit window.
 */
export async function runTokimekiCleanup(
  db: Db,
  now = new Date(),
  retentionDays = INVITE_CLEANUP_RETENTION_DAYS,
): Promise<{ tickets: number; invites: number }> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const tickets = await db
    .delete(tokimekiAttachTickets)
    .where(lt(tokimekiAttachTickets.expiresAt, cutoff))
    .run();
  const invites = await db
    .delete(tokimekiInvites)
    .where(lt(tokimekiInvites.expiresAt, cutoff))
    .run();
  return {
    tickets: tickets.meta.changes,
    invites: invites.meta.changes,
  };
}
