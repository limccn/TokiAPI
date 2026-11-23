// Tokimeki invite / attach 集成测试（11-18-tokimeki-share-link-attach）：
// 鉴权、前缀、一次性 URL、列表脱敏、撤销、CLI Session JWT、公开 attach 410 矩阵、
// cookie 一次性与 WS 错误路径。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { tokimekiInvites } from "../src/db/schema";
import {
  consumeAttachTicket,
  createAttachTicket,
  hashInviteCode,
} from "../src/routes/tokimeki/lib/invites";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

const ORIGIN = "http://localhost:5173";

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
  return withSwitch("TOKIMEKI_JWT_PRIVATE_JWK", privateJwkJson, () =>
    withSwitch("TOKIMEKI_JWT_TTL_SECONDS", "900", () =>
      withSwitch("TOKIMEKI_RELAY_URL", "", fn),
    ),
  );
}

async function login(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

async function namespaceOf(cookie: string): Promise<string> {
  const res = await selfFetch("http://localhost/api/tokimeki/namespace", {
    headers: { Cookie: cookie },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { namespace: string };
  return body.namespace;
}

interface CreateInviteBody {
  success: boolean;
  invite: {
    id: number;
    session: string;
    mode: string;
    allowWeb: boolean;
    passcodeRequired: boolean;
    createdAt: string;
    expiresAt: string;
    status: string;
    url: string;
  };
}

async function createInvite(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return selfFetch("http://localhost/api/tokimeki/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function codeFromUrl(url: string): string {
  const marker = "#t-";
  const index = url.indexOf(marker);
  return index >= 0 ? url.slice(index + marker.length) : "";
}

describe("POST /api/tokimeki/invites", () => {
  it("creates a one-time URL, stores only the hash, and lists without the URL", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-invite-owner@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const res = await createInvite(cookie, { session: `${ns}.abc`, mode: "viewer" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as CreateInviteBody;
      expect(body.invite.session).toBe(`${ns}.abc`);
      expect(body.invite.allowWeb).toBe(true);
      expect(body.invite.passcodeRequired).toBe(false);
      expect(body.invite.status).toBe("active");
      expect(body.invite.url.startsWith(`${ORIGIN}/#t-`)).toBe(true);
      const code = codeFromUrl(body.invite.url);
      expect(code).toHaveLength(16);

      const db = createDb(env);
      const row = await db.query.tokimekiInvites.findFirst({
        where: eq(tokimekiInvites.id, body.invite.id),
      });
      expect(row?.createdBy).toBe(userId);
      expect(row?.namespace).toBe(ns);
      expect(row?.codeHash).toBe(await hashInviteCode(code));
      expect(row?.codeHash).not.toBe(code);

      const list = await selfFetch("http://localhost/api/tokimeki/invites", {
        headers: { Cookie: cookie },
      });
      expect(list.status).toBe(200);
      const listed = (await list.json()) as { items: Array<Record<string, unknown>> };
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0]?.url).toBeUndefined();
      expect(listed.items[0]?.id).toBe(body.invite.id);
    });
  });

  it("rejects unauthenticated, cross-namespace, and invalid TTL requests", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-invite-invalid@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);

      const anonymous = await selfFetch("http://localhost/api/tokimeki/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: `${ns}.abc`, mode: "viewer" }),
      });
      expect(anonymous.status).toBe(401);

      const wrongPrefix = await createInvite(cookie, {
        session: "other.abc",
        mode: "viewer",
      });
      expect(wrongPrefix.status).toBe(400);

      const badTtl = await createInvite(cookie, {
        session: `${ns}.abc`,
        mode: "viewer",
        ttlSeconds: 30,
      });
      expect(badTtl.status).toBe(400);

      const badMode = await createInvite(cookie, {
        session: `${ns}.abc`,
        mode: "admin",
      });
      expect(badMode.status).toBe(400);
    });
  });

  it("isolates invites per user and revokes idempotently", async () => {
    await withTokimeki(async () => {
      const ownerId = await setupUser("tk-invite-a@test.dev", 0);
      const otherId = await setupUser("tk-invite-b@test.dev", 0);
      const ownerCookie = await login(ownerId);
      const otherCookie = await login(otherId);
      const ns = await namespaceOf(ownerCookie);
      const created = (await (
        await createInvite(ownerCookie, { session: `${ns}.abc`, mode: "viewer" })
      ).json()) as CreateInviteBody;

      const otherList = await selfFetch("http://localhost/api/tokimeki/invites", {
        headers: { Cookie: otherCookie },
      });
      const items = ((await otherList.json()) as { items: unknown[] }).items;
      expect(items).toHaveLength(0);

      const otherRevoke = await selfFetch(
        `http://localhost/api/tokimeki/invites/${created.invite.id}`,
        { method: "DELETE", headers: { Cookie: otherCookie } },
      );
      expect(otherRevoke.status).toBe(404);

      const revoke = await selfFetch(
        `http://localhost/api/tokimeki/invites/${created.invite.id}`,
        { method: "DELETE", headers: { Cookie: ownerCookie } },
      );
      expect(revoke.status).toBe(200);
      const again = await selfFetch(
        `http://localhost/api/tokimeki/invites/${created.invite.id}`,
        { method: "DELETE", headers: { Cookie: ownerCookie } },
      );
      expect(again.status).toBe(200);

      const token = await selfFetch(
        `http://localhost/api/tokimeki/invites/${created.invite.id}/token`,
        { method: "POST", headers: { Cookie: ownerCookie } },
      );
      expect(token.status).toBe(410);
    });
  });
});

describe("invite token + attach", () => {
  it("issues a CLI Session JWT with the invite mode and cap", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-attach-owner@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const created = (await (
        await createInvite(cookie, {
          session: `${ns}.abc`,
          mode: "listener",
          ttlSeconds: 3600,
        })
      ).json()) as CreateInviteBody;

      const tokenRes = await selfFetch(
        `http://localhost/api/tokimeki/invites/${created.invite.id}/token`,
        { method: "POST", headers: { Cookie: cookie } },
      );
      expect(tokenRes.status).toBe(200);
      const tokenBody = (await tokenRes.json()) as {
        token: string;
        session: string;
        mode: string;
        allowWeb: boolean;
        passcodeRequired: boolean;
        expiresAt: string;
      };
      expect(tokenBody.session).toBe(`${ns}.abc`);
      expect(tokenBody.mode).toBe("listener");
      expect(tokenBody.allowWeb).toBe(true);
      expect(tokenBody.passcodeRequired).toBe(false);
      const payload = decodePayload(tokenBody.token);
      expect(payload).toMatchObject({
        token_use: "session",
        scope: "listen",
        session: `${ns}.abc`,
        namespace: ns,
      });
      expect(payload.exp as number).toBeLessThanOrEqual(
        Math.floor(new Date(created.invite.expiresAt).getTime() / 1000),
      );
      expect(new Date(tokenBody.expiresAt).toISOString()).toBe(tokenBody.expiresAt);
    });
  });

  it("attaches with an HttpOnly cookie and enforces the 410 matrix", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-attach-web@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const created = (await (
        await createInvite(cookie, { session: `${ns}.abc`, mode: "viewer" })
      ).json()) as CreateInviteBody;
      const code = codeFromUrl(created.invite.url);

      const attach = await selfFetch("http://localhost/api/tokimeki/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(attach.status).toBe(200);
      const attachBody = (await attach.json()) as {
        session: string;
        mode: string;
        passcodeRequired: boolean;
      };
      expect(attachBody.session).toBe(`${ns}.abc`);
      expect(attachBody.mode).toBe("viewer");
      expect(attachBody.passcodeRequired).toBe(false);
      const setCookie = attach.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("tokimeki_attach=");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/api/tokimeki/ws");
      expect(setCookie).toContain("Max-Age=60");

      const cli = await selfFetch("http://localhost/api/tokimeki/attach/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(cli.status).toBe(200);
      const cliBody = (await cli.json()) as {
        token: string;
        allowWeb: boolean;
        mode: string;
      };
      expect(cliBody.allowWeb).toBe(true);
      expect(cliBody.mode).toBe("viewer");
      expect(decodePayload(cliBody.token)).toMatchObject({
        token_use: "session",
        scope: "attach",
      });

      for (const raw of ["", "not-a-code", "0".repeat(16)]) {
        const bad = await selfFetch("http://localhost/api/tokimeki/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: raw }),
        });
        expect(bad.status).toBe(410);
        const body = (await bad.json()) as { error: { message: string } };
        expect(body.error.message).toBe("This link is invalid or has expired");
      }
    });
  });

  it("allowWeb=false blocks the browser but still signs CLI access", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-attach-noweb@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const created = (await (
        await createInvite(cookie, {
          session: `${ns}.abc`,
          mode: "viewer",
          allowWeb: false,
        })
      ).json()) as CreateInviteBody;
      const code = codeFromUrl(created.invite.url);

      const attach = await selfFetch("http://localhost/api/tokimeki/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(attach.status).toBe(410);

      const cli = await selfFetch("http://localhost/api/tokimeki/attach/cli", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      expect(cli.status).toBe(200);
      expect(((await cli.json()) as { allowWeb: boolean }).allowWeb).toBe(false);
    });
  });

  it("consumes an attach ticket exactly once", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-ticket@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const created = (await (
        await createInvite(cookie, { session: `${ns}.abc`, mode: "viewer" })
      ).json()) as CreateInviteBody;
      const db = createDb(env);
      const ticket = await createAttachTicket(db, created.invite.id);
      expect(await consumeAttachTicket(db, ticket.ticket)).toBe(created.invite.id);
      expect(await consumeAttachTicket(db, ticket.ticket)).toBeNull();
    });
  });
});

describe("GET /api/tokimeki/ws", () => {
  it("rejects missing cookies, cross-origin upgrades, and missing relay config", async () => {
    await withTokimeki(async () => {
      const userId = await setupUser("tk-ws@test.dev", 0);
      const cookie = await login(userId);
      const ns = await namespaceOf(cookie);
      const created = (await (
        await createInvite(cookie, { session: `${ns}.abc`, mode: "viewer" })
      ).json()) as CreateInviteBody;
      const code = codeFromUrl(created.invite.url);

      // The proxy compares Origin against the request URL origin, not the
      // platform origin used to build share links.
      const wsOrigin = "http://localhost";
      const noCookie = await selfFetch("http://localhost/api/tokimeki/ws", {
        headers: { Origin: wsOrigin },
      });
      expect(noCookie.status).toBe(401);

      const attach = await selfFetch("http://localhost/api/tokimeki/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const setCookie = attach.headers.get("set-cookie") ?? "";
      const ticketCookie = setCookie.split(";")[0] ?? "";

      const badOrigin = await selfFetch("http://localhost/api/tokimeki/ws", {
        headers: { Origin: "https://evil.example", Cookie: ticketCookie },
      });
      expect(badOrigin.status).toBe(403);

      const relayMissing = await selfFetch("http://localhost/api/tokimeki/ws", {
        headers: { Origin: wsOrigin, Cookie: ticketCookie },
      });
      expect(relayMissing.status).toBe(503);
    });
  });
});
