// Shared helpers for the public Tokimeki attach surface.
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { parseRelayBaseUrl } from "../lib/relay-url";

export const ATTACH_COOKIE_NAME = "tokimeki_attach";
export const INVALID_LINK_MESSAGE = "This link is invalid or has expired";

export function invalidLink(c: Context<AppEnv>): Response {
  return c.json({ error: { message: INVALID_LINK_MESSAGE } }, 410);
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined || header.length === 0) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

export function relayBaseUrl(env: AppEnv["Bindings"]): string | null {
  const parsed = parseRelayBaseUrl(env.TOKIMEKI_RELAY_URL);
  return parsed.ok ? parsed.url : null;
}

/** Strip TURN credentials from upstream text frames (relay-only web viewer). */
export function sanitizeRelayText(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return text;
  }
  const message = parsed as Record<string, unknown>;
  if (message.type === "welcome") {
    delete message.iceServers;
    delete message.iceProvider;
    delete message.iceExpiresAt;
    return JSON.stringify(message);
  }
  if (message.type === "ice") {
    // Browsers only use the relay; never hand them TURN credentials.
    return null;
  }
  return JSON.stringify(message);
}
