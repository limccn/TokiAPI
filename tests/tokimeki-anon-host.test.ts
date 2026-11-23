// POST /api/tokimeki/anon-host 集成测试（11-18-tokimeki-getting-started）：
// 无会话可访问、响应形状、不写 tokens 表、匿名 invite、TTL clamp、限流桶、日志脱敏。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db";
import { tokimekiInvites, tokimekiTokens } from "../src/db/schema";
import { authRateLimitBucket } from "../src/middleware/auth-rate-limit";
import { applyMigrations, selfFetch, withSwitch } from "./helpers";

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as Record<string, unknown>;
}

let privateJwkJson = "";

beforeAll(async () => {
  await applyMigrations();
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("expected key pair");
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  if (privateJwk instanceof ArrayBuffer) throw new Error("expected JWK export");
  privateJwkJson = JSON.stringify({ ...privateJwk, kid: "test-kid" });
});

function withTokimeki<T>(fn: () => Promise<T>): Promise<T> {
  return withSwitch("TOKIMEKI_JWT_PRIVATE_JWK", privateJwkJson, fn);
}

function anonHost(ip?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip !== undefined) headers["cf-connecting-ip"] = ip;
  return selfFetch("http://localhost/api/tokimeki/anon-host", {
    method: "POST",
    headers,
    body: "{}",
  });
}

describe("POST /api/tokimeki/anon-host", () => {
  it("is public and returns a Host JWT + generated namespace/session + invite URL", async () => {
    await withTokimeki(async () => {
      const res = await anonHost();
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        token: string;
        namespace: string;
        session: string;
        inviteUrl: string;
        expiresAt: string;
      };
      expect(body.success).toBe(true);
      expect(body.namespace).toHaveLength(4);
      expect(body.session).toBe(`${body.namespace}.${body.session.split(".")[1]}`);
      expect(body.session.split(".")[1]).toMatch(/^[a-z]{3,8}-[a-z]{3,8}$/u);
      expect(body.inviteUrl).toMatch(/#t-[2356789abcdefghjkmnpqrstuvwxyz]{16}$/u);
      expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);

      const payload = decodePayload(body.token);
      expect(payload).toMatchObject({
        token_use: "host",
        scope: "host",
        namespace: body.namespace,
      });
      expect(String(payload.sub)).toMatch(/^anon:/u);
      const ttl = Number(payload.exp) - Number(payload.iat);
      expect(ttl).toBe(86_400);

      const db = createDb(env);
      const invite = await db.query.tokimekiInvites.findFirst({
        where: eq(tokimekiInvites.session, body.session),
      });
      expect(invite?.createdBy).toBeNull();
      expect(invite?.mode).toBe("viewer");
      expect(invite?.allowWeb).toBe(true);
      expect(invite?.namespace).toBe(body.namespace);
      expect(await db.select().from(tokimekiTokens)).toHaveLength(0);
    });
  });

  it("clamps TOKIMEKI_ANON_HOST_TTL_SECONDS to 600..604800", async () => {
    await withTokimeki(async () => {
      for (const [raw, expected] of [
        ["1", 600],
        ["9999999", 604_800],
        ["1200", 1200],
      ] as const) {
        await withSwitch("TOKIMEKI_ANON_HOST_TTL_SECONDS", raw, async () => {
          const res = await anonHost();
          const body = (await res.json()) as { token: string };
          const payload = decodePayload(body.token);
          expect(Number(payload.exp) - Number(payload.iat)).toBe(expected);
        });
      }
    });
  });

  it("returns 503 when the private key is not configured", async () => {
    const res = await anonHost();
    expect(res.status).toBe(503);
  });

  it("maps the endpoint to the dedicated rate-limit bucket", () => {
    expect(authRateLimitBucket("/api/tokimeki/anon-host")).toBe("tokimeki-anon");
  });

  it("rate-limits per IP with a readable 429", async () => {
    await withTokimeki(async () => {
      const ip = "203.0.113.9";
      const statuses: number[] = [];
      for (let i = 0; i < 21; i += 1) {
        statuses.push((await anonHost(ip)).status);
      }
      // Window-boundary tolerant, like tests/auth-rate-limit.test.ts: the first
      // 10 always pass, and a 429 must appear at/after the 11th call.
      expect(statuses.slice(0, 10)).not.toContain(429);
      expect(statuses.indexOf(429)).toBeGreaterThanOrEqual(10);
      const limited = await anonHost(ip);
      if (limited.status === 429) {
        expect(limited.headers.get("retry-after")).toBe("60");
      }
    });
  });

  it("never logs the token, invite URL, or code", async () => {
    await withTokimeki(async () => {
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const res = await anonHost("203.0.113.10");
        const body = (await res.json()) as { token: string; inviteUrl: string };
        const code = body.inviteUrl.split("#t-")[1] ?? "";
        const logged = spy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(logged).toContain("tokimeki_anon_host_created");
        expect(logged).not.toContain(body.token);
        expect(logged).not.toContain(body.inviteUrl);
        expect(logged).not.toContain(code);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
