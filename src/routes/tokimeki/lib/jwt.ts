// Tokimeki Host JWT（ES256）签发与 JWKS。
//
// 设计要点（11-18-tokimeki-master-token / design.md §3-4）：
// - 私钥只来自 Worker secret `TOKIMEKI_JWT_PRIVATE_JWK`（ES256 private JWK JSON）。
// - 公钥由 private JWK 派生，JWKS 只输出公钥。
// - WebCrypto 的 ECDSA 签名返回 64 字节 r||s（P1363），正是 JWT ES256 的签名格式，无需 DER 转换。

export const DEFAULT_TOKIMEKI_JWT_AUDIENCE = "tokimeki-relay";
export const DEFAULT_TOKIMEKI_JWT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 天

// 长度上限与 relay 侧（tokimeki 11-19-v1-2-cli-tokiapi-host-jwt）的校验一致：
// 超限值在 relay 必然被拒，这里提前判为「未配置」让配置错误在本地可见
// （/api/config.tokimekiEnabled=false），而不是签发后到 relay 才 401。
const MAX_KID_LENGTH = 128;
const MAX_ISSUER_LENGTH = 512;
const MAX_AUDIENCE_LENGTH = 256;

const JWT_ALG = "ES256";
const JWT_TYPE = "JWT";

/** 匿名 Host JWT TTL：默认与 relay session 最大生命周期一致（24h）。 */
export const DEFAULT_ANON_HOST_TTL_SECONDS = 86_400;
const MIN_ANON_HOST_TTL_SECONDS = 600;
const MAX_ANON_HOST_TTL_SECONDS = 604_800;

/**
 * Parse `TOKIMEKI_ANON_HOST_TTL_SECONDS`.
 *
 * Deliberately separate from the login host TTL parser: anonymous hosts must
 * outlive a relay session (default 24h) or reconnects fail permanently after
 * the JWT expires. Deployments must not set this below the relay's
 * `TOKIMEKI_SESSION_MAX_TTL_SECONDS`.
 */
export function parseAnonHostTtl(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value)) {
    return DEFAULT_ANON_HOST_TTL_SECONDS;
  }
  return Math.min(Math.max(Math.trunc(value), MIN_ANON_HOST_TTL_SECONDS), MAX_ANON_HOST_TTL_SECONDS);
}

export interface TokimekiJwtConfig {
  privateJwk: JsonWebKey;
  kid: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

interface PrivateJwk extends JsonWebKey {
  kid?: unknown;
}

/** 配置是否可用（私钥存在且结构合法）。 */
export function isTokimekiConfigured(env: Env): boolean {
  return readTokimekiJwtConfig(env) !== null;
}

function parseTtl(raw: string | undefined): number {
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(value)) {
    return DEFAULT_TOKIMEKI_JWT_TTL_SECONDS;
  }
  return Math.min(Math.max(Math.trunc(value), MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

function resolveIssuer(env: Env): string {
  const explicit = env.TOKIMEKI_JWT_ISSUER?.trim() ?? "";
  if (explicit.length > 0) {
    return explicit;
  }
  try {
    return new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return "";
  }
}

function parsePrivateJwk(raw: string | undefined): { jwk: JsonWebKey; kid: string } | null {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const jwk = parsed as PrivateJwk;
    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      typeof jwk.d !== "string"
    ) {
      return null;
    }
    const kid = typeof jwk.kid === "string" ? jwk.kid.trim() : "";
    if (kid.length === 0 || kid.length > MAX_KID_LENGTH) {
      return null;
    }
    return { jwk, kid };
  } catch {
    return null;
  }
}

/** 读取并校验配置；缺失/非法返回 null（功能整体关闭）。 */
export function readTokimekiJwtConfig(env: Env): TokimekiJwtConfig | null {
  const parsed = parsePrivateJwk(env.TOKIMEKI_JWT_PRIVATE_JWK);
  if (parsed === null) {
    return null;
  }
  const issuer = resolveIssuer(env);
  if (issuer.length === 0 || issuer.length > MAX_ISSUER_LENGTH) {
    return null;
  }
  const audience = env.TOKIMEKI_JWT_AUDIENCE?.trim() || DEFAULT_TOKIMEKI_JWT_AUDIENCE;
  if (audience.length > MAX_AUDIENCE_LENGTH) {
    return null;
  }
  return {
    privateJwk: parsed.jwk,
    kid: parsed.kid,
    issuer,
    audience,
    ttlSeconds: parseTtl(env.TOKIMEKI_JWT_TTL_SECONDS),
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export interface HostJwtInput {
  /**
   * JWT `sub`. Logged-in hosts use the numeric user id as a string; anonymous
   * hosts (task 3) use `anon:<random>` so the relay never treats it as an id.
   */
  sub: string;
  namespace: string;
  jti: string;
  /** Optional TTL override (anonymous hosts use TOKIMEKI_ANON_HOST_TTL_SECONDS). */
  ttlSeconds?: number;
  /** epoch seconds；默认当前时间。 */
  nowSeconds?: number;
}

export interface SignedHostJwt {
  token: string;
  issuedAt: number;
  expiresAt: number;
}

/** Web 代理档 Session JWT TTL（design §4.2）。 */
export const WEB_SESSION_JWT_TTL_SECONDS = 300;
/** CLI attach 档 Session JWT TTL 上限（design §4.2）。 */
export const MAX_SESSION_JWT_TTL_SECONDS = 86_400;

export type SessionJwtScope = "attach" | "listen";

export interface SessionJwtInput {
  sub: string;
  namespace: string;
  /** Must be `<namespace>.<slug>`. */
  session: string;
  /** Space-separated scopes; `attach` or `listen`, plus `web` for the proxy. */
  scope: string;
  ttlSeconds: number;
  /** epoch seconds；默认当前时间。 */
  nowSeconds?: number;
}

async function signJwt(
  config: TokimekiJwtConfig,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = { alg: JWT_ALG, typ: JWT_TYPE, kid: config.kid };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    config.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/** 签发 Host JWT（`token_use=host`、`scope=host`）。 */
export async function signHostJwt(
  config: TokimekiJwtConfig,
  input: HostJwtInput,
): Promise<SignedHostJwt> {
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + (input.ttlSeconds ?? config.ttlSeconds);
  const token = await signJwt(config, {
    iss: config.issuer,
    aud: config.audience,
    sub: input.sub,
    namespace: input.namespace,
    token_use: "host",
    scope: "host",
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAt,
    jti: input.jti,
  });
  return { token, issuedAt, expiresAt };
}

/**
 * 签发 Session JWT（`token_use=session`）。
 *
 * `scope` 是空格分隔字符串（与 Host JWT 的 `"host"` 同类型）；relay 按空格
 * 拆分做精确匹配。TTL clamp 到 60..86400 秒。
 */
export async function signSessionJwt(
  config: TokimekiJwtConfig,
  input: SessionJwtInput,
): Promise<SignedHostJwt> {
  const issuedAt = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.min(
    Math.max(Math.trunc(input.ttlSeconds), 60),
    MAX_SESSION_JWT_TTL_SECONDS,
  );
  const expiresAt = issuedAt + ttl;
  const token = await signJwt(config, {
    iss: config.issuer,
    aud: config.audience,
    sub: input.sub,
    namespace: input.namespace,
    session: input.session,
    token_use: "session",
    scope: input.scope,
    iat: issuedAt,
    nbf: issuedAt,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  });
  return { token, issuedAt, expiresAt };
}

export interface JwkSet {
  keys: Array<{
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
    kid: string;
    use: "sig";
    alg: "ES256";
  }>;
}

/** 只含公钥的 JWKS（供 relay 离线验签）。 */
export function buildJwks(config: TokimekiJwtConfig): JwkSet {
  const { x, y } = config.privateJwk;
  if (typeof x !== "string" || typeof y !== "string") {
    // readTokimekiJwtConfig 已保证存在；此处是类型收窄的防御。
    return { keys: [] };
  }
  return {
    keys: [
      {
        kty: "EC",
        crv: "P-256",
        x,
        y,
        kid: config.kid,
        use: "sig",
        alg: "ES256",
      },
    ],
  };
}
