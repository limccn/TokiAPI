// TokiAPI implicit Tokimeki switch: /api/config, endpoint matrix, WS gates.
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { tokimekiInvites, tokimekiTokens } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

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

function withValidJwk<T>(fn: () => Promise<T>): Promise<T> {
  return withSwitch("TOKIMEKI_JWT_PRIVATE_JWK", privateJwkJson, fn);
}

async function login(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

async function namespaceOf(cookie: string): Promise<string> {
  const res = await selfFetch("http://localhost/api/tokimeki/namespace", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { namespace: string }).namespace;
}

function codeFromUrl(url: string): string {
  const marker = "#t-";
  const index = url.indexOf(marker);
  return index >= 0 ? url.slice(index + marker.length) : "";
}

describe("GET /api/config", () => {
  it("reports the runtime switch and relay URL", async () => {
    await withValidJwk(() =>
      withSwitch("TOKIMEKI_RELAY_URL", "wss://relay.example", async () => {
        const res = await selfFetch("http://localhost/api/config");
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          tokimekiEnabled: boolean;
          tokimekiRelayUrl: string;
        };
        expect(body.tokimekiEnabled).toBe(true);
        expect(body.tokimekiRelayUrl).toBe("wss://relay.example");
      }),
    );
  });

  it("reports false for an invalid JWK", async () => {
    await withSwitch("TOKIMEKI_JWT_PRIVATE_JWK", "{}", async () => {
      const res = await selfFetch("http://localhost/api/config");
      const body = (await res.json()) as { tokimekiEnabled: boolean };
      expect(body.tokimekiEnabled).toBe(false);
    });
  });
});

describe("unconfigured endpoint matrix", () => {
  it("returns 503 for host/invite/attach endpoints and 404 for JWKS", async () => {
    const userId = await setupUser("tk-switch-matrix@test.dev", 0);
    const cookie = await login(userId);
    const ok = await selfFetch("http://localhost/api/tokimeki/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ name: "x" }),
    });
    expect(ok.status).toBe(503);

    const invite = await selfFetch("http://localhost/api/tokimeki/invites", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ session: "abcde.abc", mode: "viewer" }),
    });
    expect(invite.status).toBe(503);

    const inviteToken = await selfFetch("http://localhost/api/tokimeki/invites/1/token", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(inviteToken.status).toBe(503);

    const anon = await selfFetch("http://localhost/api/tokimeki/anon-host", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(anon.status).toBe(503);

    const attachCli = await selfFetch("http://localhost/api/tokimeki/attach/cli", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "aaaaaaaaaaaaaaaa" }),
    });
    expect(attachCli.status).toBe(503);

    const jwks = await selfFetch("http://localhost/api/tokimeki/jwks.json");
    expect(jwks.status).toBe(404);
  });
});

describe("WS second gate", () => {
  it("distinguishes relay_not_configured from an unconfigured JWK", async () => {
    let cookie = "";
    await withValidJwk(async () => {
      const userId = await setupUser("tk-switch-ws@test.dev", 0);
      cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const created = (await (
        await selfFetch("http://localhost/api/tokimeki/invites", {
          method: "POST",
          headers: { "Content-Type": "application/json", Cookie: cookie },
          body: JSON.stringify({ session: `${ns}.abc`, mode: "viewer" }),
        })
      ).json()) as { invite: { url: string } };
      const attach = await selfFetch("http://localhost/api/tokimeki/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: codeFromUrl(created.invite.url) }),
      });
      cookie = (attach.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    });

    await withSwitch("TOKIMEKI_JWT_PRIVATE_JWK", "{}", () =>
      withSwitch("TOKIMEKI_RELAY_URL", "wss://relay.example", async () => {
        const res = await selfFetch("http://localhost/api/tokimeki/ws", {
          headers: { Origin: "http://localhost", Cookie: cookie },
        });
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error?: { message?: string } };
        expect(body.error?.message).toBe("Tokimeki is not configured");
      }),
    );
  });
});

describe("registered user anon-host", () => {
  it("is allowed and still creates an anonymous namespace without token rows", async () => {
    await withValidJwk(async () => {
      const userId = await setupUser("tk-switch-anon@test.dev", 0);
      const cookie = await login(userId);
      const res = await selfFetch("http://localhost/api/tokimeki/anon-host", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: "{}",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { namespace: string; session: string };
      expect(body.namespace).toHaveLength(4);
      expect(body.session.split(".")[1]).toMatch(/^[a-z]{3,8}-[a-z]{3,8}$/u);
      const db = createDb(env);
      const invite = await db.query.tokimekiInvites.findFirst({
        where: eq(tokimekiInvites.session, body.session),
      });
      expect(invite?.createdBy).toBeNull();
      expect(await db.select().from(tokimekiTokens)).toHaveLength(0);
    });
  });
});
