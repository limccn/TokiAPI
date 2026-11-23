// Pure input helpers for the /tokimeki hub wizard.
// Added with the 2026-11-22 tri-task audit: the hub must compose session ids with the
// signed-in namespace prefix and accept both bare invite codes and share links.
import { isValidInviteCode } from "../../../../src/lib/invite-code";

/** Mirrors the server-side createInvite session schema (max 64 chars). */
export const HOST_SESSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export function isValidHostSessionName(value: string): boolean {
  return HOST_SESSION_NAME_PATTERN.test(value);
}

/**
 * Compose the session id sent to POST /api/tokimeki/invites.
 * The server requires `<namespace>.`; bare names are prefixed instead of rejected.
 */
export function resolveHostSessionName(
  override: string,
  namespace: string,
  generatedSlug: string,
): string {
  if (namespace.length === 0) {
    throw new Error("namespace is required to build a session id");
  }
  const trimmed = override.trim();
  const base = trimmed.length > 0 ? trimmed : generatedSlug;
  const prefix = `${namespace}.`;
  return base.startsWith(prefix) ? base : `${prefix}${base}`;
}

export type ParsedAttachInput =
  | { readonly kind: "link"; readonly code: string }
  | { readonly kind: "code"; readonly code: string }
  | { readonly kind: "session"; readonly session: string };

/**
 * Accept a share URL / `#t-<code>` fragment, a bare 16-char invite code, or a bare
 * session id. Returns null for empty input.
 */
export function parseAttachInput(raw: string): ParsedAttachInput | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const marker = trimmed.indexOf("#t-");
  if (marker >= 0) {
    return { kind: "link", code: trimmed.slice(marker + 3) };
  }
  if (isValidInviteCode(trimmed)) {
    return { kind: "code", code: trimmed };
  }
  return { kind: "session", session: trimmed };
}
