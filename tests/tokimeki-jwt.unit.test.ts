// Host JWT 签发单测（11-18-tokimeki-master-token）：
// 用 WebCrypto 生成 ES256 密钥对，签发后用公钥验签 —— 钉住 P1363 签名格式与 claims。
import { describe, expect, it } from "vitest";
import {
  buildJwks,
  readTokimekiJwtConfig,
  signHostJwt,
  type TokimekiJwtConfig,
} from "../src/routes/tokimeki/lib/jwt";

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(value: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as Record<string, unknown>;
}

async function makeKeyPair(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in generated)) {
    throw new Error("expected a key pair");
  }
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  if (privateJwk instanceof ArrayBuffer || publicJwk instanceof ArrayBuffer) {
    throw new Error("expected JWK export");
  }
  return { privateJwk, publicJwk };
}

function configFor(privateJwk: JsonWebKey): TokimekiJwtConfig {
  const withKid: JsonWebKey & { kid: string } = { ...privateJwk, kid: "test-kid" };
  return {
    privateJwk: withKid,
    kid: "test-kid",
    issuer: "https://platform.example",
    audience: "tokimeki-relay",
    ttlSeconds: 900,
  };
}

describe("signHostJwt", () => {
  it("签发 ES256 JWT，claims 正确且可用公钥验签", async () => {
    const { privateJwk, publicJwk } = await makeKeyPair();
    const config = configFor(privateJwk);
    const signed = await signHostJwt(config, {
      sub: "42",
      namespace: "abcde",
      jti: "11111111-2222-3333-4444-555555555555",
      nowSeconds: 1_700_000_000,
    });

    const parts = signed.token.split(".");
    expect(parts).toHaveLength(3);
    const header = decodeJson(parts[0] ?? "");
    const payload = decodeJson(parts[1] ?? "");
    expect(header).toMatchObject({ alg: "ES256", typ: "JWT", kid: "test-kid" });
    expect(payload).toMatchObject({
      iss: "https://platform.example",
      aud: "tokimeki-relay",
      sub: "42",
      namespace: "abcde",
      token_use: "host",
      scope: "host",
      iat: 1_700_000_000,
      nbf: 1_700_000_000,
      exp: 1_700_000_900,
      jti: "11111111-2222-3333-4444-555555555555",
    });
    expect(signed.expiresAt).toBe(1_700_000_900);

    const key = await crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = decodeBase64Url(parts[2] ?? "");
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    expect(valid).toBe(true);
  });
});

describe("buildJwks", () => {
  it("只输出公钥字段（不含 d）", async () => {
    const { privateJwk } = await makeKeyPair();
    const jwks = buildJwks(configFor(privateJwk));
    expect(jwks.keys).toHaveLength(1);
    const key = jwks.keys[0] ?? {};
    expect(key).toMatchObject({
      kty: "EC",
      crv: "P-256",
      kid: "test-kid",
      use: "sig",
      alg: "ES256",
    });
    expect("d" in key).toBe(false);
  });
});

describe("readTokimekiJwtConfig", () => {
  const baseEnv = {
    BETTER_AUTH_URL: "http://localhost:5173",
  } as unknown as Env;

  it("未配置私钥 → null（功能关闭）", () => {
    expect(readTokimekiJwtConfig(baseEnv)).toBeNull();
  });

  it("私钥 JSON 非法 / 缺 kid → null", () => {
    const invalid = { ...baseEnv, TOKIMEKI_JWT_PRIVATE_JWK: "{}" } as Env;
    expect(readTokimekiJwtConfig(invalid)).toBeNull();
  });

  it("合法私钥 → iss 回落 BETTER_AUTH_URL origin，TTL 有上下界", async () => {
    const { privateJwk } = await makeKeyPair();
    const env = {
      ...baseEnv,
      TOKIMEKI_JWT_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "kid-1" }),
      TOKIMEKI_JWT_TTL_SECONDS: "1",
    } as unknown as Env;
    const config = readTokimekiJwtConfig(env);
    expect(config).not.toBeNull();
    expect(config?.issuer).toBe("http://localhost:5173");
    expect(config?.audience).toBe("tokimeki-relay");
    expect(config?.ttlSeconds).toBe(300); // clamp 最小值
  });

  // 长度上限与 relay 侧校验一致（kid 128 / iss 512 / aud 256）：超限 = 未配置（fail-closed）。
  it("kid 超过 128 字符 → null（relay 侧 looksLikeJwt 不认）", async () => {
    const { privateJwk } = await makeKeyPair();
    const env = {
      ...baseEnv,
      TOKIMEKI_JWT_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "k".repeat(129) }),
    } as unknown as Env;
    expect(readTokimekiJwtConfig(env)).toBeNull();
  });

  it("TOKIMEKI_JWT_ISSUER 超过 512 字符 → null", async () => {
    const { privateJwk } = await makeKeyPair();
    const env = {
      ...baseEnv,
      TOKIMEKI_JWT_PRIVATE_JWK: JSON.stringify({ ...privateJwk, kid: "kid-1" }),
      TOKIMEKI_JWT_ISSUER: `https://${"i".repeat(600)}.example`,
    } as unknown as Env;
    expect(readTokimekiJwtConfig(env)).toBeNull();
  });

  it("TOKIMEKI_JWT_AUDIENCE 超过 256 字符 → null；恰好 256 合法", async () => {
    const { privateJwk } = await makeKeyPair();
    const key = JSON.stringify({ ...privateJwk, kid: "kid-1" });
    const oversize = {
      ...baseEnv,
      TOKIMEKI_JWT_PRIVATE_JWK: key,
      TOKIMEKI_JWT_AUDIENCE: "a".repeat(257),
    } as unknown as Env;
    expect(readTokimekiJwtConfig(oversize)).toBeNull();

    const boundary = {
      ...baseEnv,
      TOKIMEKI_JWT_PRIVATE_JWK: key,
      TOKIMEKI_JWT_AUDIENCE: "a".repeat(256),
    } as unknown as Env;
    expect(readTokimekiJwtConfig(boundary)?.audience).toBe("a".repeat(256));
  });
});
