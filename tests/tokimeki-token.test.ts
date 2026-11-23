// Tokimeki master token API 集成测试（11-18-tokimeki-master-token）：
// 鉴权、功能开关、签发 claims、一次性明文、列表脱敏、用户隔离、JWKS、namespace 生成。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { users } from "../src/db/schema";
import {
  applyMigrations,
  createSession,
  selfFetch,
  sessionCookie,
  setupUser,
  withSwitch,
} from "./helpers";

const ORIGIN = "http://localhost:5173";

interface CreateBody {
  success: boolean;
  token: string;
  record: {
    id: number;
    name: string;
    jti: string;
    kid: string;
    namespace: string;
    createdAt: string;
    expiresAt: string;
  };
}

interface ListBody {
  success: boolean;
  items: CreateBody["record"][];
}

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodePayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1] ?? "";
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as Record<string, unknown>;
}

let privateJwkJson = "";
let publicJwk: JsonWebKey | null = null;

beforeAll(async () => {
  await applyMigrations();
  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) {
    throw new Error("expected a key pair");
  }
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const exportedPublic = await crypto.subtle.exportKey("jwk", generated.publicKey);
  if (privateJwk instanceof ArrayBuffer || exportedPublic instanceof ArrayBuffer) {
    throw new Error("expected JWK export");
  }
  publicJwk = exportedPublic;
  privateJwkJson = JSON.stringify({ ...privateJwk, kid: "test-kid" });
});

async function cookieFor(userId: number): Promise<string> {
  return sessionCookie(await createSession(userId));
}

function withTokimeki<T>(fn: () => Promise<T>): Promise<T> {
  return withSwitch("TOKIMEKI_JWT_PRIVATE_JWK", privateJwkJson, () =>
    withSwitch("TOKIMEKI_JWT_TTL_SECONDS", "900", fn),
  );
}

describe("POST /api/tokimeki/token", () => {
  it("未登录 → 401", async () => {
    const res = await selfFetch("http://localhost/api/tokimeki/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("未配置私钥 → 503（功能关闭）", async () => {
    const userId = await setupUser("tokimeki-disabled@test.dev", 0);
    const res = await selfFetch("http://localhost/api/tokimeki/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: await cookieFor(userId),
      },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(503);
  });

  it("签发 JWT：claims 正确、可验签、namespace 已持久化", async () => {
    const userId = await setupUser("tokimeki-create@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withTokimeki(async () => {
      const res = await selfFetch("http://localhost/api/tokimeki/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "laptop" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as CreateBody;
      expect(body.success).toBe(true);
      expect(body.record.name).toBe("laptop");
      expect(body.record.kid).toBe("test-kid");
      expect(body.record.namespace).toHaveLength(5);

      const payload = decodePayload(body.token);
      expect(payload).toMatchObject({
        iss: ORIGIN,
        aud: "tokimeki-relay",
        sub: String(userId),
        namespace: body.record.namespace,
        token_use: "host",
        scope: "host",
        jti: body.record.jti,
      });
      expect(Number(payload.exp) - Number(payload.iat)).toBe(900);

      if (publicJwk === null) {
        throw new Error("public key missing");
      }
      const key = await crypto.subtle.importKey(
        "jwk",
        publicJwk,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      const [header, claims, signature] = body.token.split(".");
      const valid = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        decodeBase64Url(signature ?? ""),
        new TextEncoder().encode(`${header}.${claims}`),
      );
      expect(valid).toBe(true);
    });

    const db = createDb(env);
    const row = await db.query.users.findFirst({ where: eq(users.id, userId) });
    expect(row?.namespaceShort).toHaveLength(5);
    expect(row?.namespaceId?.startsWith(row.namespaceShort ?? "")).toBe(true);
  });

  it("重复签发复用同一 namespace；列表只返回元数据", async () => {
    const userId = await setupUser("tokimeki-list@test.dev", 0);
    const cookie = await cookieFor(userId);

    await withTokimeki(async () => {
      const first = await selfFetch("http://localhost/api/tokimeki/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "first" }),
      });
      const firstBody = (await first.json()) as CreateBody;
      const second = await selfFetch("http://localhost/api/tokimeki/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "second" }),
      });
      const secondBody = (await second.json()) as CreateBody;
      expect(secondBody.record.namespace).toBe(firstBody.record.namespace);

      const list = await selfFetch("http://localhost/api/tokimeki/tokens", {
        headers: { Cookie: cookie },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as ListBody;
      expect(body.items).toHaveLength(2);
      expect(body.items.some((item) => "token" in item)).toBe(false);
      expect(body.items.every((item) => item.namespace === firstBody.record.namespace)).toBe(true);
    });
  });

  it("用户隔离：看不到他人的 token", async () => {
    const alice = await setupUser("tokimeki-alice@test.dev", 0);
    const bob = await setupUser("tokimeki-bob@test.dev", 0);
    const aliceCookie = await cookieFor(alice);
    const bobCookie = await cookieFor(bob);

    await withTokimeki(async () => {
      await selfFetch("http://localhost/api/tokimeki/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: aliceCookie },
        body: JSON.stringify({ name: "alice-token" }),
      });
      const res = await selfFetch("http://localhost/api/tokimeki/tokens", {
        headers: { Cookie: bobCookie },
      });
      const body = (await res.json()) as ListBody;
      expect(body.items).toHaveLength(0);
    });
  });
});

describe("GET /api/tokimeki/jwks.json", () => {
  it("公开可用，只含公钥", async () => {
    await withTokimeki(async () => {
      const res = await selfFetch("http://localhost/api/tokimeki/jwks.json");
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
      const body = (await res.json()) as { keys: Array<Record<string, unknown>> };
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0]).toMatchObject({
        kty: "EC",
        crv: "P-256",
        kid: "test-kid",
        use: "sig",
        alg: "ES256",
      });
      expect(body.keys[0] && "d" in body.keys[0]).toBe(false);
    });
  });

  it("未配置私钥 → 404", async () => {
    const res = await selfFetch("http://localhost/api/tokimeki/jwks.json");
    expect(res.status).toBe(404);
  });
});

describe("namespace 唯一性", () => {
  it("不同用户的 5 位短 id 互不相同", async () => {
    const first = await setupUser("tokimeki-ns-a@test.dev", 0);
    const second = await setupUser("tokimeki-ns-b@test.dev", 0);
    const firstCookie = await cookieFor(first);
    const secondCookie = await cookieFor(second);

    await withTokimeki(async () => {
      const a = await selfFetch("http://localhost/api/tokimeki/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: firstCookie },
        body: JSON.stringify({ name: "a" }),
      });
      const b = await selfFetch("http://localhost/api/tokimeki/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: secondCookie },
        body: JSON.stringify({ name: "b" }),
      });
      const aBody = (await a.json()) as CreateBody;
      const bBody = (await b.json()) as CreateBody;
      expect(aBody.record.namespace).not.toBe(bBody.record.namespace);
    });
  });
});
