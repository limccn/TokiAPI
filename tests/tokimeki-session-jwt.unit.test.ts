// Session JWT 签发单测（11-18-tokimeki-share-link-attach）：claims、scope 空格串、
// 两档 TTL、用 JWKS 公钥验签。
import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_JWT_TTL_SECONDS,
  signHostJwt,
  signSessionJwt,
  type TokimekiJwtConfig,
  WEB_SESSION_JWT_TTL_SECONDS,
} from "../src/routes/tokimeki/lib/jwt";

function decodeBase64Url(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as Record<string, unknown>;
}

async function makeConfig(): Promise<{
  config: TokimekiJwtConfig;
  publicJwk: JsonWebKey;
}> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("expected key pair");
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (privateJwk instanceof ArrayBuffer || publicJwk instanceof ArrayBuffer) {
    throw new Error("expected JWK export");
  }
  return {
    config: {
      privateJwk: { ...privateJwk, kid: "test-kid" } as JsonWebKey,
      kid: "test-kid",
      issuer: "https://platform.example",
      audience: "tokimeki-relay",
      ttlSeconds: 900,
    },
    publicJwk,
  };
}

async function verify(token: string, publicJwk: JsonWebKey): Promise<boolean> {
  const [header, payload, signature] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    publicJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    decodeBase64Url(signature),
    new TextEncoder().encode(`${header}.${payload}`),
  );
}

describe("signSessionJwt", () => {
  it("签发 token_use=session、scope 空格串、session/namespace claim", async () => {
    const { config, publicJwk } = await makeConfig();
    const signed = await signSessionJwt(config, {
      sub: "42",
      namespace: "abcde",
      session: "abcde.demo",
      scope: "attach web",
      ttlSeconds: WEB_SESSION_JWT_TTL_SECONDS,
      nowSeconds: 1_700_000_000,
    });
    const parts = signed.token.split(".");
    expect(parts).toHaveLength(3);
    expect(decodeJson(parts[0] ?? "")).toMatchObject({
      alg: "ES256",
      typ: "JWT",
      kid: "test-kid",
    });
    const payload = decodeJson(parts[1] ?? "");
    expect(payload).toMatchObject({
      iss: "https://platform.example",
      aud: "tokimeki-relay",
      sub: "42",
      namespace: "abcde",
      session: "abcde.demo",
      token_use: "session",
      scope: "attach web",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_300,
    });
    expect(typeof payload.jti).toBe("string");
    expect(await verify(signed.token, publicJwk)).toBe(true);
  });

  it("clamps TTL to 60..86400 seconds", async () => {
    const { config } = await makeConfig();
    const tooShort = await signSessionJwt(config, {
      sub: "42",
      namespace: "abcde",
      session: "abcde.demo",
      scope: "listen",
      ttlSeconds: 5,
      nowSeconds: 1_700_000_000,
    });
    expect(tooShort.expiresAt - tooShort.issuedAt).toBe(60);

    const tooLong = await signSessionJwt(config, {
      sub: "anon:abc",
      namespace: "abcd",
      session: "abcd.demo",
      scope: "attach",
      ttlSeconds: 999_999,
      nowSeconds: 1_700_000_000,
    });
    expect(tooLong.expiresAt - tooLong.issuedAt).toBe(MAX_SESSION_JWT_TTL_SECONDS);
  });
});

describe("signHostJwt sub", () => {
  it("passes string subjects through unchanged (anon:<random>)", async () => {
    const { config } = await makeConfig();
    const signed = await signHostJwt(config, {
      sub: "anon:abcdefghijkl",
      namespace: "abcd",
      jti: "test-jti",
      nowSeconds: 1_700_000_000,
    });
    const payload = decodeJson(signed.token.split(".")[1] ?? "");
    expect(payload.sub).toBe("anon:abcdefghijkl");
    expect(payload.token_use).toBe("host");
  });
});
