// 生成 Tokimeki Host JWT 用的 ES256 私钥（private JWK JSON）。
//
// 用法：
//   node scripts/generate-tokimeki-key.mjs > tokimeki-jwk.json
//   npx wrangler secret put TOKIMEKI_JWT_PRIVATE_JWK < tokimeki-jwk.json
//
// 注意：输出是**私钥**。不要提交、不要贴进聊天记录；轮换时换一个新 kid 并保留旧公钥
// 一个 overlap 窗口（relay 的 JWKS 缓存刷新后旧 token 失效）。
const { subtle } = globalThis.crypto;

const pair = await subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);
const jwk = await subtle.exportKey("jwk", pair.privateKey);
const kid = `tokimeki-${new Date().toISOString().slice(0, 10)}`;

process.stdout.write(
  `${JSON.stringify({ ...jwk, kid, use: "sig", alg: "ES256" }, null, 2)}\n`,
);
