// R1/R2 本地 E2E（08-26-provider-config-enhance）：真实 miniflare 运行时 + DeepSeek 真实上游 + anthropic 面 mock。
// 验证（design.md AC）：
//   R1：`deepseek-chat[1m]` 请求 → 上游转发无后缀模型名连通 200（DeepSeek 拒绝 [1m] 后缀，
//       200 即证明剥离；Claude 5 家族原生 1M，[1m] 仅下游别名）、request_logs.model 剥离为无后缀；
//       anthropic 面（mock 上游）同样 [1m] → 无后缀转发 + 剥离。
//   R2：httpOptions userAgent/headers/body 配置经管理 API 加密落库 + GET 掩码回显；
//       headers.Authorization 强制覆盖（换成错误 key → 上游 401，证明覆盖生效）→ 恢复后 200。
//
// 拓扑：
//   DeepSeek 真实 API（openai 类型 provider）→ https://api.deepseek.com/v1
//   mock anthropic :8788（x-api-key sk-mock-anthropic；模型回显 body.model）
//   wrangler dev（vite，默认 5173；DEV_PORT 可覆盖）
//
// 用法：DEEPSEEK_API_KEY=sk-... node scripts/verify-config-enhance.mjs [--keep]
//   DEEPSEEK_MODEL 可覆盖上游模型名（默认 deepseek-chat）。
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const DB = "cf-ai-gateway-db";
const DEV_PORT = Number(process.env.DEV_PORT ?? 5173);
const BASE = `http://localhost:${DEV_PORT}`;
const KEEP = process.argv.includes("--keep");

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
// 2026 年 DeepSeek 支持列表：deepseek-v4-pro / deepseek-v4-flash / deepseek-v4-flash-vision-exp
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const MOCK_PORT = 8788;

const INTERNAL_DS = "deepseek-chat"; // 网关内部模型名（= 上游名，无后缀）
const INTERNAL_CLAUDE = "claude-sonnet";
const UPSTREAM_CLAUDE = "claude-sonnet-4.5";

const ADMIN = { email: "e2e-enh-admin@local.test", name: "E2E Enh Admin", role: "admin", balance: 50 };
const MEMBER = { email: "e2e-enh-user@local.test", name: "E2E Enh User", role: "member", balance: 100 };

/** 读取 .dev.vars（KEY=VALUE 行）取本地 secret。 */
function devVar(name) {
  const raw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  const line = raw.split("\n").map((l) => l.trim()).find((l) => l.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

let failures = 0;
function check(name, ok, detail = "") {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ============ 工具 ============

function q(sql) {
  const out = execFileSync(process.execPath,
    [WRANGLER_JS, "d1", "execute", DB, "--local", "--config", "wrangler.jsonc",
      "--command", sql, "--json"], { encoding: "utf8", cwd: ROOT });
  return JSON.parse(out)[0]?.results ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch { /* 未就绪 */ }
    await sleep(500);
  }
  return false;
}

/** agent: false —— 禁用 undici 连接池（与 wrangler d1 子进程交错时避免复用已关闭 socket）。 */
async function api(path, { method = "GET", cookie, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers["Cookie"] = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    agent: false,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** 网关代理请求（Bearer key）。 */
async function chat(plaintext, model, { stream = false } = {}) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], stream }),
    agent: false,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** anthropic 面请求（Bearer key，Anthropic Messages 形态）。 */
async function messages(plaintext, model) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "ping" }] }),
    agent: false,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// ============ 子进程 ============

const children = [];
function spawnBg(label, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (process.env.E2E_CHILD_LOG) {
    const out = createWriteStream(
      `${process.env.E2E_CHILD_LOG}${process.env.E2E_CHILD_LOG.endsWith("/") || process.env.E2E_CHILD_LOG.endsWith("\\") ? "" : "/"}${label}.log`,
      { flags: "a" },
    );
    child.stdout.pipe(out);
    child.stderr.pipe(out);
  } else {
    child.stdout.on("data", () => {});
    child.stderr.on("data", () => {});
  }
  children.push(child);
  return child;
}

async function main() {
  if (!DEEPSEEK_KEY) {
    console.error("[E2E] 缺少 DEEPSEEK_API_KEY 环境变量（真实上游测试必填）");
    process.exit(2);
  }
  const started = Date.now();

  // 0. 本地 D1 迁移（幂等；drizzle 新迁移如 0005 http_options_enc 需先于 dev 应用）
  try {
    execFileSync(process.execPath,
      [WRANGLER_JS, "d1", "migrations", "apply", DB, "--local", "--config", "wrangler.jsonc"],
      { encoding: "utf8", cwd: ROOT, stdio: "pipe" });
  } catch (error) {
    console.error("[E2E] 迁移失败:", String(error));
    process.exit(2);
  }

  // 1. mock anthropic 上游 + wrangler dev
  spawnBg("mock", process.execPath, ["scripts/mock-upstream.mjs"], { MOCK_PORT: String(MOCK_PORT) });
  check("mock 就绪", await waitReady(`http://127.0.0.1:${MOCK_PORT}/openai/v1/models`, 20));
  spawnBg("dev", "npm", ["run", "dev", "--", "--port", String(DEV_PORT), "--strictPort"]);
  check("wrangler dev 就绪", await waitReady(`${BASE}/v1/models`));

  // 2. D1 直插夹具（幂等清理：balance_tx → request_logs/usage_daily → api_keys/sessions/providers → models → users）
  const now = Math.floor(Date.now() / 1000);
  q(`DELETE FROM balance_tx WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM request_logs WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM usage_daily WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM api_keys WHERE name LIKE 'e2e-enh%'; DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM providers WHERE name IN ('enh-deepseek','enh-anthropic-mock'); DELETE FROM models WHERE model IN ('${INTERNAL_DS}','${INTERNAL_CLAUDE}'); DELETE FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}');`);
  for (const u of [ADMIN, MEMBER]) {
    q(`INSERT INTO users (email, name, role, status, balance, email_verified, created_at, updated_at)
       VALUES ('${u.email}', '${u.name}', '${u.role}', 'active', ${u.balance}, 1, ${now}, ${now});`);
  }
  const memberId = q(`SELECT id FROM users WHERE email='${MEMBER.email}';`)[0]?.id;
  const adminId = q(`SELECT id FROM users WHERE email='${ADMIN.email}';`)[0]?.id;
  const keyPlain = `sk-e2e-${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(keyPlain).digest("hex");
  q(`INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at)
     VALUES (${memberId}, 'e2e-enh', '${keyHash}', '${keyPlain.slice(0, 8)}', 'active', 60, 0, 3600, ${now});`);
  for (const m of [INTERNAL_DS, INTERNAL_CLAUDE]) {
    q(`INSERT INTO models (model, input_price_short, input_price_long, input_price_cached, output_price_short, output_price_long, created_at, updated_at)
       VALUES ('${m}', 1.0, 1.0, 0.25, 3.0, 3.0, ${now}, ${now});`);
  }

  // 3. 伪造 admin 会话
  const sessPlain = `sess_${randomBytes(16).toString("hex")}`;
  q(`INSERT INTO sessions (token, user_id, expires_at, created_at, updated_at)
     VALUES ('${sessPlain}', ${adminId}, ${now + 3600}, ${now}, ${now});`);
  const sig = Buffer.from(await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", new TextEncoder().encode(devVar("BETTER_AUTH_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(sessPlain),
  )).toString("base64");
  const adminCookie = `better-auth.session_token=${encodeURIComponent(`${sessPlain}.${sig}`)}`;

  // 4. 管理 API 创建 provider：deepseek（openai 面，真实上游）+ anthropic mock
  const DS_HTTP_OPTIONS = {
    userAgent: "E2E-Gateway/1.0",
    headers: { "X-Provider": "e2e-deepseek" },
    body: { temperature: 0.1 },
  };
  const dsRes = await api("/api/providers", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "enh-deepseek",
      type: "openai",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: DEEPSEEK_KEY,
      models: { [INTERNAL_DS]: DEEPSEEK_MODEL },
      httpOptions: DS_HTTP_OPTIONS,
    },
  });
  const dsProviderId = dsRes.json?.provider?.id;
  check("创建 deepseek provider（httpOptions 加密落库）", Number.isInteger(dsProviderId) && dsRes.status === 200,
    `id=${dsProviderId} resp=${JSON.stringify(dsRes.json)}`);
  const claudeRes = await api("/api/providers", {
    method: "POST",
    cookie: adminCookie,
    body: {
      name: "enh-anthropic-mock",
      type: "anthropic",
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/anthropic/v1`,
      apiKey: "sk-mock-anthropic",
      models: { [INTERNAL_CLAUDE]: UPSTREAM_CLAUDE },
    },
  });
  const claudeProviderId = claudeRes.json?.provider?.id;
  check("创建 anthropic mock provider", Number.isInteger(claudeProviderId) && claudeRes.status === 200,
    `id=${claudeProviderId}`);

  // 5. GET 回显：headers 掩码、userAgent/body 明文
  const listRes = await api("/api/providers", { cookie: adminCookie });
  const dsItem = (listRes.json?.items ?? []).find((p) => p.id === dsProviderId);
  check("GET 回显：X-Provider 掩码", dsItem?.httpOptions?.headers?.["X-Provider"] === "****seek",
    JSON.stringify(dsItem?.httpOptions?.headers));
  check("GET 回显：userAgent/body 明文", dsItem?.httpOptions?.userAgent === "E2E-Gateway/1.0"
    && JSON.stringify(dsItem?.httpOptions?.body) === JSON.stringify({ temperature: 0.1 }));

  // 6. R1 真实上游：[1m] 请求 → 网关转发无后缀模型名（[1m] 仅下游别名；DeepSeek 拒绝 [1m] 后缀，
  //    200 即证明无后缀转发）+ 明细剥离。
  const ds1m = await chat(keyPlain, `${INTERNAL_DS}[1m]`);
  check("deepseek [1m]：上游转发无后缀模型名 → 200", ds1m.status === 200,
    `status=${ds1m.status} msg=${ds1m.json?.error?.message ?? ""}`.slice(0, 160));
  check("deepseek [1m]：上游响应 model 为无后缀名", ds1m.json?.model === DEEPSEEK_MODEL,
    `model=${ds1m.json?.model ?? ""}`);
  const logRow = q(`SELECT model, status FROM request_logs WHERE user_id=${memberId} ORDER BY id DESC LIMIT 1;`)[0];
  check("deepseek [1m]：明细 model 剥离为无后缀", logRow?.model === INTERNAL_DS,
    JSON.stringify(logRow));

  // 7. R2 强制覆盖：Authorization 换错误 key → 上游 401（覆盖生效）；恢复 → 200
  await api(`/api/providers/${dsProviderId}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: {
      httpOptions: {
        ...DS_HTTP_OPTIONS,
        headers: { "X-Provider": "e2e-deepseek", Authorization: "Bearer sk-wrong-override" },
      },
    },
  });
  const badAuth = await chat(keyPlain, INTERNAL_DS);
  check("httpOptions 覆盖 Authorization：错误 key → 上游 401", badAuth.status === 401,
    `status=${badAuth.status}`);
  await api(`/api/providers/${dsProviderId}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { httpOptions: DS_HTTP_OPTIONS },
  });
  const restored = await chat(keyPlain, INTERNAL_DS);
  check("恢复 httpOptions 后 deepseek 200", restored.status === 200,
    `status=${restored.status}`);

  // 8. R1 anthropic 面（mock）：[1m] → 无后缀转发（mock 回显 model = 上游无后缀名）+ 剥离
  const claude1m = await messages(keyPlain, `${INTERNAL_CLAUDE}[1m]`);
  check("anthropic 面 [1m]：200", claude1m.status === 200 && Array.isArray(claude1m.json?.content),
    `status=${claude1m.status} msg=${claude1m.json?.error?.message ?? ""}`.slice(0, 160));
  check("anthropic 面 [1m]：上游收到无后缀模型名", claude1m.json?.model === UPSTREAM_CLAUDE,
    `model=${claude1m.json?.model ?? ""}`);
  const claudeLog = q(`SELECT model, status FROM request_logs WHERE user_id=${memberId} ORDER BY id DESC LIMIT 1;`)[0];
  check("anthropic 面 [1m]：明细 model 剥离", claudeLog?.model === INTERNAL_CLAUDE && claudeLog?.status === "success",
    JSON.stringify(claudeLog));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nE2E 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`}（${elapsed}s）`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

async function cleanup() {
  if (KEEP) {
    console.log("[keep] 子进程保持运行（mock + dev server），请手动清理");
    return;
  }
  for (const c of children) {
    try {
      if (process.platform === "win32" && c.pid) {
        execFileSync("taskkill", ["/PID", String(c.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        c.kill();
      }
    } catch { /* 已退出 */ }
  }
}

main().catch(async (error) => {
  console.error("[E2E] 异常终止:", error);
  await cleanup();
  process.exit(1);
});
