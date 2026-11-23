// invite code / ticket / relay URL 纯函数单测（11-18-tokimeki-share-link-attach）。
import { describe, expect, it } from "vitest";
import {
  generateInviteCode,
  generateTicket,
  hashInviteCode,
  hashTicket,
  INVITE_CODE_PATTERN,
  isValidInviteCode,
} from "../src/routes/tokimeki/lib/invites";
import {
  buildRelayWsUrl,
  isSafeSessionId,
  parseRelayBaseUrl,
} from "../src/routes/tokimeki/lib/relay-url";
import { sanitizeRelayText } from "../src/routes/tokimeki/public/common";

describe("invite code", () => {
  it("generates 16 readable chars and validates the alphabet", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(16);
    expect(code).toMatch(INVITE_CODE_PATTERN);
    expect(isValidInviteCode(code)).toBe(true);
    expect(isValidInviteCode("0".repeat(16))).toBe(false);
    expect(isValidInviteCode("a".repeat(15))).toBe(false);
  });

  it("hashes stably and produces distinct tickets", async () => {
    const code = "2356789abcdefghj";
    expect(await hashInviteCode(code)).toBe(await hashInviteCode(code));
    expect(await hashInviteCode(code)).toHaveLength(64);

    const ticket = generateTicket();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]+$/u);
    const decoded = atob(
      ticket.replace(/-/g, "+").replace(/_/g, "/").padEnd(
        ticket.length + ((4 - (ticket.length % 4)) % 4),
        "=",
      ),
    );
    expect(decoded.length).toBe(32);
    expect(await hashTicket(ticket)).toHaveLength(64);
    expect(generateTicket()).not.toBe(ticket);
  });
});

describe("relay URL", () => {
  it("normalizes https/wss and local http/ws, rejecting unsafe shapes", () => {
    expect(parseRelayBaseUrl("https://relay.example/")).toEqual({
      ok: true,
      url: "wss://relay.example",
    });
    expect(parseRelayBaseUrl("wss://relay.example/base")).toEqual({
      ok: true,
      url: "wss://relay.example",
    });
    expect(parseRelayBaseUrl("http://localhost:8787")).toEqual({
      ok: true,
      url: "ws://localhost:8787",
    });
    for (const raw of [
      undefined,
      "",
      "ftp://relay.example",
      "https://user:pass@relay.example",
      "https://relay.example/?x=1",
      "https://relay.example/#frag",
      "not a url",
    ]) {
      expect(parseRelayBaseUrl(raw).ok).toBe(false);
    }
  });

  it("builds /ws/<session> and rejects unsafe session ids", () => {
    expect(buildRelayWsUrl("wss://relay.example", "abcde.demo")).toBe(
      "wss://relay.example/ws/abcde.demo",
    );
    expect(buildRelayWsUrl("ws://localhost:8787", "abcd.wxyz")).toBe(
      "ws://localhost:8787/ws/abcd.wxyz",
    );
    expect(isSafeSessionId("abcde.demo")).toBe(true);
    expect(isSafeSessionId("../etc")).toBe(false);
    expect(() => buildRelayWsUrl("wss://relay.example", "bad/session")).toThrow();
  });
});

describe("TURN stripping", () => {
  it("removes ice fields from welcome and drops ice messages", () => {
    const welcome = sanitizeRelayText(
      JSON.stringify({
        v: 1,
        type: "welcome",
        session: "s",
        hostOnline: true,
        clients: [],
        iceServers: [{ urls: "turn:secret" }],
        iceProvider: "coturn",
        iceExpiresAt: 123,
      }),
    );
    expect(welcome).not.toBeNull();
    const parsed = JSON.parse(welcome ?? "{}") as Record<string, unknown>;
    expect(parsed.iceServers).toBeUndefined();
    expect(parsed.iceProvider).toBeUndefined();
    expect(parsed.iceExpiresAt).toBeUndefined();
    expect(parsed.hostOnline).toBe(true);

    expect(sanitizeRelayText(JSON.stringify({ v: 1, type: "ice" }))).toBeNull();
    expect(sanitizeRelayText('{"type":"presence"}')).toBe('{"type":"presence"}');
    expect(sanitizeRelayText("not json")).toBe("not json");
  });
});
