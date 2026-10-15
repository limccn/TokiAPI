// Codex ≥0.149.0 / GPT-5.6 系 Responses Lite 全量适配 E2E（09-01-codex-responses-lite-full 批次）：
// 真实 HTTP 链路（npm run dev + scripts/mock-upstream.mjs :8788 + 本地 D1 + BILLING_QUEUE 消费者）。
// 场景：
//   1) lite 请求（additional_tools[functions namespace] + tool_search/web 命名空间 + reasoning 回放 +
//      function_call 往返 + 40k 上下文）→ 200；mock 上游收到扁平 function tools（exec/lookup，顶层优先）；
//      flag off（默认）→ 上游 assistant 消息无 reasoning_content
//   2) PATCH provider reasoningRoundtrip=true → 再发 → 上游 assistant 消息带 reasoning_content
//   3) 两条请求均落账（request_logs success）
// 用法：node scripts/mock-upstream.mjs & npm run dev（另一终端）; node scripts/verify-codex-lite.mjs
// 前置：本地 D1 已迁移（npm run db:migrate -- --local）+ seed 价格表（npm run db:seed -- --local）
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// stg 模式（E2E_STG=1，**遗留 / 已随 stg 脚手架拆除失效**）：BASE 指 stg 管理面、API_BASE 指
// stg 公开 API 面；D1 用 --remote --env staging —— stg 配置段已不存在（wrangler.toml 已删、
// wrangler.prod.jsonc 无 [env]），此模式会 fail-fast 而非误打生产；保留仅为历史调用记忆，
// 退役 runbook 见 .trellis/spec/governance/stg-retirement.md
const STG = process.env.E2E_STG === "1";
const BASE = STG ? "https://stg-platform.lmlh.net" : (process.env.BASE_URL ?? "http://localhost:5173");
// 公开 API 面（/v1、/anthropic）走独立域；本地模式下分流关闭（环回例外）⇒ 两者同域。
const API_BASE = STG ? "https://stg-api.lmlh.net" : BASE;
const target = (p) => (/^\/(v1|anthropic)(\/|$)/.test(p) ? API_BASE : BASE);
const MOCK_BASE = process.env.MOCK_URL ?? "http://127.0.0.1:8788";
const DB = STG ? "cf-ai-gateway-db-staging" : "cf-ai-gateway-db";
const D1_ARGS = STG
  ? ["--remote", "--env", "staging", "--config", "wrangler.toml"]
  : ["--local"];
const INVITE_ADMIN = "CODXVERIFY";
const ADMIN_EMAIL = "codex-lite-admin@example.com";
const PASSWORD = "testpass123";
const PROVIDER = {
  name: "codex-lite-mock",
  type: "openai",
  baseUrl: "http://127.0.0.1:8788/openai/v1",
  apiKey: "sk-mock-openai",
  models: { "gpt-5.6-codex": "gpt-5.6-codex" },
};
const MODEL = "gpt-5.6-codex";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

let passed = 0;
let failed = 0;
const lastFailures = [];

function report(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    lastFailures.push({ name, detail });
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function runSql(sql) {
  execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB, ...D1_ARGS, "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
}

function query(sql) {
  const out = execFileSync(
    process.execPath,
    [WRANGLER_JS, "d1", "execute", DB, ...D1_ARGS, "--json", "--command", sql],
    { stdio: "pipe", encoding: "utf8" },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

async function api(path, { method = "GET", headers = {}, body, cookie } = {}) {
  const requestHeaders = {
    "Content-Type": "application/json",
    Origin: new URL(BASE).origin,
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers,
  };
  let res;
  try {
    res = await fetch(`${target(path)}${path}`, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    console.log(`  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`);
    await sleep(500);
    res = await fetch(`${target(path)}${path}`, {
      method,
      headers: requestHeaders,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（如 SSE 原样）→ json 保持 null
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function signup(email, inviteCode) {
  return api("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, inviteCode, name: email.split("@")[0] ?? "codex" },
  });
}

async function signin(email) {
  const res = await api("/api/auth/sign-in/email", { method: "POST", body: { email, password: PASSWORD } });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";")[0] ?? null;
  return { status: res.status, cookie };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 取 mock 上游最近一次 /openai/v1/chat/completions 收到的 body。 */
async function lastUpstreamChatBody() {
  const res = await fetch(`${MOCK_BASE}/__requests`);
  const { requests } = await res.json();
  const chat = requests.findLast(
    (r) => r.path === "/openai/v1/chat/completions" && r.method === "POST",
  );
  return chat?.body ?? null;
}

/** Codex lite 请求体：additional_tools[functions namespace] + tool_search/web 命名空间 + reasoning 回放 + 往返 + 40k 上下文。 */
function codexLiteBody(nonce) {
  const bigContext = `${nonce}|` + "x".repeat(40_000);
  return {
    model: MODEL,
    instructions: [
      { type: "message", role: "developer", content: "You are a coding agent." },
    ],
    input: [
      {
        type: "additional_tools",
        id: "at_1",
        role: "developer",
        tools: [
          {
            type: "namespace",
            name: "functions",
            tools: [
              {
                type: "function",
                name: "exec",
                description: "run a command",
                parameters: { type: "object", properties: { cmd: { type: "string" } } },
              },
              {
                type: "function",
                name: "lookup",
                description: "look up info",
                parameters: { type: "object", properties: {} },
              },
            ],
          },
          { type: "namespace", name: "tool_search", tools: [{ type: "tool_search", name: "tool_search" }] },
          { type: "namespace", name: "web", tools: [{ type: "web_search", name: "web" }] },
        ],
      },
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "previous round thinking" }],
      },
      { role: "assistant", content: "I checked the code." },
      { type: "function_call", call_id: "call_1", name: "exec", arguments: '{"cmd":"ls"}' },
      { type: "function_call_output", call_id: "call_1", output: "src/" },
      { role: "user", content: bigContext },
    ],
  };
}

async function main() {
  console.log(`\n=== codex responses-lite verify @ ${BASE} ===`);

  // ---------- 0. 准备本地 D1（幂等可重跑） ----------
  console.log("\n[setup] prepare local D1");
  runSql(
    `DELETE FROM invite_codes;` +
      `DELETE FROM accounts;` +
      `DELETE FROM sessions;` +
      `DELETE FROM balance_tx;` +
      `DELETE FROM usage_daily;` +
      `DELETE FROM request_logs;` +
      `DELETE FROM api_keys;` +
      `DELETE FROM providers;` +
      `DELETE FROM models;` +
      `DELETE FROM users WHERE email <> 'bootstrap@example.com';`,
  );
  runSql(
    `INSERT OR IGNORE INTO users (id, email, name, role, status, balance, email_verified, created_at, updated_at) ` +
      `VALUES (1,'bootstrap@example.com','Bootstrap','admin','active',100,1,unixepoch(),unixepoch());`,
  );
  runSql(
    `INSERT OR IGNORE INTO invite_codes (code, created_by, expires_at, created_at) VALUES ` +
      `('${INVITE_ADMIN}',1,unixepoch()+86400,unixepoch());`,
  );

  // ---------- 1. auth + 资源 ----------
  console.log("\n[1] auth + provider + key");
  const signupAdmin = await signup(ADMIN_EMAIL, INVITE_ADMIN);
  report("admin signup", signupAdmin.status === 200 || signupAdmin.status === 201, `status=${signupAdmin.status}`);
  runSql(`UPDATE users SET role='admin', balance=100 WHERE email='${ADMIN_EMAIL}';`);
  const signinAdmin = await signin(ADMIN_EMAIL);
  report("admin signin", signinAdmin.status === 200 && signinAdmin.cookie !== null, `status=${signinAdmin.status}`);
  const authApi = { cookie: signinAdmin.cookie };

  const p1 = await api("/api/providers", { method: "POST", ...authApi, body: PROVIDER });
  report("create openai provider", p1.status === 200, `status=${p1.status}`);
  const providerId = p1.json?.provider?.id ?? null;

  const price = await api("/api/models", {
    method: "POST",
    ...authApi,
    body: { model: MODEL, inputPriceShort: INPUT_PRICE, inputPriceLong: INPUT_PRICE, inputPriceCached: 0, outputPriceShort: OUTPUT_PRICE, outputPriceLong: OUTPUT_PRICE },
  });
  report(`price ${MODEL}`, price.status === 200, `status=${price.status}`);

  const createKey = await api("/api/keys", { method: "POST", ...authApi, body: { name: "codex-lite-key" } });
  const plaintext = createKey.json?.plaintext ?? "";
  report("create gateway key", createKey.status === 200 && plaintext.startsWith("sk-"), `status=${createKey.status}`);
  const proxyAuth = { Authorization: `Bearer ${plaintext}` };

  // ---------- 2. lite 请求（flag off 默认）：200 + 扁平 tools + 无 reasoning_content ----------
  console.log("\n[2] lite request (flag off)");
  const b0 = query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
  const r1 = await api("/v1/responses", {
    method: "POST",
    headers: proxyAuth,
    body: codexLiteBody("ROUND1"),
  });
  report("lite 请求 → 200", r1.status === 200, `status=${r1.status} body=${r1.text.slice(0, 120)}`);
  report(
    "响应含 output_text",
    typeof r1.json?.output_text === "string" && r1.json.output_text.length > 0,
    `output_text=${JSON.stringify(r1.json?.output_text ?? null)}`,
  );

  // 上游收到的 body：扁平 function tools（仅 functions 命名空间；web/tool_search 被丢弃）
  const upstream1 = await lastUpstreamChatBody();
  const upstreamTools = (upstream1?.tools ?? []).map((t) => t?.function?.name);
  report(
    "上游收到扁平 function tools = [exec, lookup]（web/tool_search 命名空间丢弃）",
    JSON.stringify(upstreamTools) === JSON.stringify(["exec", "lookup"]),
    `tools=${JSON.stringify(upstreamTools)}`,
  );
  const assistantMsg1 = (upstream1?.messages ?? []).find((m) => m?.role === "assistant");
  report(
    "flag off（默认）：上游 assistant 消息无 reasoning_content",
    upstream1 !== null && assistantMsg1?.["reasoning_content"] === undefined,
    `reasoning_content=${JSON.stringify(assistantMsg1?.["reasoning_content"] ?? undefined)}`,
  );
  report(
    "40k 上下文直通上游（messages 含 40k user 消息）",
    (upstream1?.messages ?? []).some(
      (m) => typeof m?.content === "string" && m.content.startsWith("ROUND1|") && m.content.length > 40_000,
    ),
    `messages=${(upstream1?.messages ?? []).length} maxContentLen=${Math.max(
      ...(upstream1?.messages ?? []).map((m) => String(m?.content ?? "").length),
      0,
    )}`,
  );
  report(
    "function_call 往返已入上游 messages（exec 调用 + output）",
    JSON.stringify((upstream1?.messages ?? []).map((m) => m?.role)).includes("tool") ||
      (upstream1?.messages ?? []).some((m) => m?.role === "tool"),
    `roles=${JSON.stringify((upstream1?.messages ?? []).map((m) => m?.role))}`,
  );

  // ---------- 3. flag on：PATCH provider → 上游收到 reasoning_content ----------
  console.log("\n[3] lite request (flag on)");
  const patch = await api(`/api/providers/${providerId}`, {
    method: "PATCH",
    ...authApi,
    body: { reasoningRoundtrip: true },
  });
  report("PATCH reasoningRoundtrip=true", patch.status === 200, `status=${patch.status}`);

  const r2 = await api("/v1/responses", {
    method: "POST",
    headers: proxyAuth,
    body: codexLiteBody("ROUND2"),
  });
  report("lite 请求（flag on）→ 200", r2.status === 200, `status=${r2.status}`);
  const upstream2 = await lastUpstreamChatBody();
  const assistantMsg2 = (upstream2?.messages ?? []).find((m) => m?.role === "assistant");
  report(
    "flag on：上游 assistant 消息 reasoning_content = 'previous round thinking'",
    assistantMsg2?.["reasoning_content"] === "previous round thinking",
    `reasoning_content=${JSON.stringify(assistantMsg2?.["reasoning_content"] ?? null)}`,
  );
  const upstreamTools2 = (upstream2?.tools ?? []).map((t) => t?.function?.name);
  report(
    "flag on 不破坏工具平面化（tools 仍 [exec, lookup]）",
    JSON.stringify(upstreamTools2) === JSON.stringify(["exec", "lookup"]),
    `tools=${JSON.stringify(upstreamTools2)}`,
  );

  // ---------- 4. 结算 ----------
  console.log("\n[4] settlement");
  const settled = await poll(async () => {
    const rows = query(`SELECT status FROM request_logs WHERE user_id=(SELECT id FROM users WHERE email='${ADMIN_EMAIL}') AND status='success' ORDER BY id;`);
    const balance = query(`SELECT balance FROM users WHERE email='${ADMIN_EMAIL}';`)[0]?.balance;
    if (rows.length >= 2 && balance !== null && balance < b0) {
      return { rows: rows.length, balance };
    }
    return null;
  }, 120000);
  report("两条 lite 请求均落账（request_logs ≥2 success + 余额扣减）", settled !== null, JSON.stringify(settled ?? null));

  console.log(`\n=== codex responses-lite verify: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.log("\nFailed checks:");
    for (const failure of lastFailures) {
      console.log(`  - ${failure.name}: ${failure.detail}`);
    }
    process.exitCode = 1;
  }
}

function poll(fn, timeoutMs = 15000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = async () => {
      const result = await fn();
      if (result !== null) {
        resolve(result);
        return;
      }
      if (Date.now() > deadline) {
        resolve(null);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

main().catch((error) => {
  console.error("verify-codex-lite crashed:", error);
  process.exitCode = 1;
});
