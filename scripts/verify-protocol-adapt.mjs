// 11-20-protocol-adapt 本机 live E2E（分支 2：Responses 工具配对卫生）。
// 真实链路：npm run dev（Vite + Miniflare）→ 网关 → scripts/mock-upstream.mjs。
// 用法：
//   终端 A：npm run dev
//   终端 B：node scripts/verify-protocol-adapt.mjs --branch=2
// 脚本会自行拉起宽松 mock :8788 与严格 mock :8789（MOCK_STRICT_TOOL_PAIRS=1），
// 用严格 mock 复刻真实上游的 tool 配对 400，证明网关卫生修复端到端生效。
// 夹具隔离：唯一 email/provider 名前缀；只删自建行，不做全表 DELETE。
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER_JS = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const DB = "cf-ai-gateway-db";
const DEV_PORT = Number(process.env.DEV_PORT ?? 5173);
const BASE = `http://localhost:${DEV_PORT}`;
const MOCK_LENIENT = Number(process.env.MOCK_PORT ?? 8788);
const MOCK_STRICT = Number(process.env.MOCK_STRICT_PORT ?? 8789);
const BRANCH = process.argv.find((arg) => arg.startsWith("--branch="))?.slice(9) ?? "2";
const KEEP = process.argv.includes("--keep");

const ADMIN_EMAIL = "protocol-adapt-admin@example.com";
const ADMIN_NAME = "Protocol Adapt Admin";
const PROVIDER_PREFIX = "protocol-adapt-";
const KEY_NAME = "protocol-adapt-key";
const SYNTHETIC = "[tool result unavailable: call interrupted]";

const LENIENT_PROVIDER = {
  name: `${PROVIDER_PREFIX}openai`,
  type: "openai",
  baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/openai/v1`,
  apiKey: "sk-mock-openai",
  models: {
    "protocol-openai": "protocol-openai",
    "protocol-empty-tool-id": "empty-tool-id",
  },
};
const STRICT_PROVIDER = {
  name: `${PROVIDER_PREFIX}openai-strict`,
  type: "openai",
  baseUrl: `http://127.0.0.1:${MOCK_STRICT}/openai/v1`,
  apiKey: "sk-mock-openai",
  models: {
    "protocol-openai-strict": "protocol-openai-strict",
  },
};
const RESPONSES_VERBATIM_PROVIDER = {
  name: `${PROVIDER_PREFIX}responses-verbatim`,
  type: "custom",
  baseUrl: `http://127.0.0.1:${MOCK_STRICT}/openai/v1`,
  apiKey: "sk-mock-openai",
  models: { "protocol-responses-verbatim": "protocol-responses-verbatim" },
  protocols: { responses: { policy: "verbatim" } },
};
const CHAT_VERBATIM_PROVIDER = {
  name: `${PROVIDER_PREFIX}chat-verbatim`,
  type: "custom",
  baseUrl: `http://127.0.0.1:${MOCK_STRICT}/openai/v1`,
  apiKey: "sk-mock-openai",
  models: { "protocol-chat-verbatim": "protocol-chat-verbatim" },
  protocols: { chat: { policy: "verbatim" } },
};
const PRICE_MODELS = [
  "protocol-openai",
  "protocol-openai-strict",
  "protocol-empty-tool-id",
  "protocol-responses-verbatim",
  "protocol-chat-verbatim",
];

const ANTHROPIC_PROVIDER = {
  name: `${PROVIDER_PREFIX}anthropic`,
  type: "anthropic",
  baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/anthropic/v1`,
  apiKey: "sk-mock-anthropic",
  models: { "protocol-anthropic": "protocol-anthropic" },
};
const ANTHROPIC_VERBATIM_PROVIDER = {
  name: `${PROVIDER_PREFIX}anthropic-verbatim`,
  type: "custom",
  baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/anthropic/v1`,
  apiKey: "sk-mock-anthropic",
  models: { "protocol-anthropic-verbatim": "protocol-anthropic-verbatim" },
  protocols: {
    messages: { baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/anthropic/v1` },
  },
};
const OPENAI_THREAD_PROVIDER = {
  name: `${PROVIDER_PREFIX}openai-thread`,
  type: "openai",
  baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/openai/v1`,
  apiKey: "sk-mock-openai",
  models: { "protocol-openai-thread": "protocol-openai-thread" },
};
const THREAD_MIXED_OPENAI_PROVIDER = {
  name: `${PROVIDER_PREFIX}thread-mixed-openai`,
  type: "openai",
  baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/openai/v1`,
  apiKey: "sk-mock-openai",
  weight: 10,
  models: { "protocol-thread-mixed": "protocol-thread-mixed-openai" },
};
const THREAD_MIXED_ANTHROPIC_PROVIDER = {
  name: `${PROVIDER_PREFIX}thread-mixed-anthropic`,
  type: "anthropic",
  baseUrl: `http://127.0.0.1:${MOCK_LENIENT}/anthropic/v1`,
  apiKey: "sk-mock-anthropic",
  weight: 1,
  models: { "protocol-thread-mixed": "protocol-thread-mixed-anthropic" },
};
const BRANCH3_PRICE_MODELS = [
  "protocol-anthropic",
  "protocol-anthropic-verbatim",
  "protocol-openai-thread",
  "protocol-thread-mixed",
];

let passed = 0;
let failures = 0;
const failedNames = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    failedNames.push(name);
    console.log(`  FAIL  ${name}${detail ? `  <- ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读取 .dev.vars（KEY=VALUE 行）取本地 secret。 */
function devVar(name) {
  const raw = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
  const line = raw
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() : "";
}

function d1(sql) {
  const out = execFileSync(
    process.execPath,
    [
      WRANGLER_JS,
      "d1",
      "execute",
      DB,
      "--local",
      "--config",
      "wrangler.jsonc",
      "--command",
      sql,
      "--json",
    ],
    { encoding: "utf8", cwd: ROOT },
  );
  return JSON.parse(out)[0]?.results ?? [];
}

function applyMigrations() {
  execFileSync(
    process.execPath,
    [
      WRANGLER_JS,
      "d1",
      "migrations",
      "apply",
      DB,
      "--local",
      "--config",
      "wrangler.jsonc",
    ],
    { encoding: "utf8", cwd: ROOT, stdio: "pipe" },
  );
}

async function waitReady(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return true;
    } catch {
      // 未就绪
    }
    await sleep(500);
  }
  return false;
}

/** mock 专属就绪检查：必须返回 `/__requests` 的 `{ requests: [] }` 形态，
 * 防止端口被其他 workerd/服务占用时 status<500 的误判。 */
async function waitMockReady(port, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__requests`);
      if (res.status === 200) {
        const json = await res.json();
        if (Array.isArray(json.requests)) return true;
      }
    } catch {
      // 未就绪
    }
    await sleep(500);
  }
  return false;
}

async function api(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const doFetch = () =>
    fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(BASE).origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  let res;
  try {
    res = await doFetch();
  } catch (error) {
    // 与 wrangler d1 子进程交错时 undici 连接池可能复用已关闭 socket（ECONNRESET）→ 重试一次
    console.log(
      `  [retry] ${method} ${path} failed (${error.cause?.code ?? error.message}), retrying...`,
    );
    await sleep(500);
    res = await doFetch();
  }
  const text = await res.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // 非 JSON（SSE 等）
  }
  return { status: res.status, json, text, headers: res.headers };
}

async function upstreamRequests(port) {
  const res = await fetch(`http://127.0.0.1:${port}/__requests`);
  const json = await res.json();
  return json.requests ?? [];
}

async function lastUpstream(port, path) {
  const requests = await upstreamRequests(port);
  return requests.findLast(
    (request) => request.path === path && request.method === "POST",
  ) ?? null;
}

function messagesOf(upstream) {
  return upstream?.body?.messages ?? [];
}

function toolMessage(messages, callId) {
  return messages.find(
    (message) => message?.role === "tool" && message?.tool_call_id === callId,
  );
}

function assistantWithCalls(messages) {
  return messages.find(
    (message) => message?.role === "assistant" && Array.isArray(message?.tool_calls),
  );
}

const children = [];
function spawnMock(port, strict) {
  const child = spawn(process.execPath, ["scripts/mock-upstream.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      MOCK_PORT: String(port),
      ...(strict ? { MOCK_STRICT_TOOL_PAIRS: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  children.push(child);
  return child;
}

function cleanupFixtures() {
  d1(
    `DELETE FROM balance_tx WHERE user_id IN (SELECT id FROM users WHERE email='${ADMIN_EMAIL}');` +
      `DELETE FROM request_logs WHERE user_id IN (SELECT id FROM users WHERE email='${ADMIN_EMAIL}');` +
      `DELETE FROM usage_daily WHERE user_id IN (SELECT id FROM users WHERE email='${ADMIN_EMAIL}');` +
      `DELETE FROM api_keys WHERE name LIKE '${PROVIDER_PREFIX}%';` +
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email='${ADMIN_EMAIL}');` +
      `DELETE FROM providers WHERE name LIKE '${PROVIDER_PREFIX}%';` +
      `DELETE FROM models WHERE model LIKE 'protocol-%';` +
      `DELETE FROM users WHERE email='${ADMIN_EMAIL}';`,
  );
}

async function setupAdmin() {
  cleanupFixtures();
  // 本地 .dev.vars 可能 SMS_AUTH_ENABLED=true；夹具给一个已验证手机号以通过 /api/* 硬门禁。
  const phone = `+86139${randomInt(0, 100_000_000).toString().padStart(8, "0")}`;
  d1(
    `INSERT INTO users (email, name, role, status, balance, email_verified, phone_number, phone_number_verified, created_at, updated_at) ` +
      `VALUES ('${ADMIN_EMAIL}', '${ADMIN_NAME}', 'admin', 'active', 1000, 1, '${phone}', 1, unixepoch(), unixepoch());`,
  );
  const rows = d1(`SELECT id FROM users WHERE email='${ADMIN_EMAIL}';`);
  const adminId = rows[0]?.id;
  if (typeof adminId !== "number") {
    throw new Error("failed to create protocol-adapt admin fixture");
  }
  const token = `sess_${randomBytes(16).toString("hex")}`;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  d1(
    `INSERT INTO sessions (token, user_id, expires_at, created_at, updated_at) ` +
      `VALUES ('${token}', ${adminId}, ${expires}, unixepoch(), unixepoch());`,
  );
  const signature = createHmac("sha256", devVar("BETTER_AUTH_SECRET"))
    .update(token)
    .digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function createProvider(cookie, body) {
  const res = await api("/api/providers", { method: "POST", cookie, body });
  const id = res.json?.provider?.id;
  if (res.status !== 200 || typeof id !== "number") {
    throw new Error(`create provider ${body.name} failed: ${res.status} ${res.text}`);
  }
  return id;
}

async function createPrice(cookie, model) {
  const res = await api("/api/models", {
    method: "POST",
    cookie,
    body: {
      model,
      inputPriceShort: 0.15,
      inputPriceLong: 0.15,
      inputPriceCached: 0,
      outputPriceShort: 0.6,
      outputPriceLong: 0.6,
    },
  });
  if (res.status !== 200) {
    throw new Error(`create price ${model} failed: ${res.status} ${res.text}`);
  }
}

async function responsesRequest(key, model, input, stream = false) {
  return api("/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: { model, input, stream },
  });
}

async function anthropicRequest(key, model, overrides = {}, headers = {}) {
  return api("/anthropic/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, ...headers },
    body: {
      model,
      max_tokens: 64,
      system: "Be brief.",
      messages: [{ role: "user", content: "probe" }],
      ...overrides,
    },
  });
}

async function chatRequest(key, model, messages) {
  return api("/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: { model, messages },
  });
}

async function runBranch2(key) {
  console.log("\n=== 分支 2：Responses 工具配对卫生 ===");

  // 2.1 孤儿 function_call（request_permissions:0）→ 严格上游 200 + 合成 tool 消息
  const res21 = await responsesRequest(key, "protocol-openai-strict", [
    {
      type: "function_call",
      call_id: "request_permissions:0",
      name: "request_permissions",
      arguments: "{}",
    },
    { role: "user", content: "probe-2.1" },
  ]);
  const up21 = await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions");
  const msgs21 = messagesOf(up21);
  const synthetic21 = toolMessage(msgs21, "request_permissions:0");
  check(
    "2.1 孤儿 function_call → 上游 200",
    res21.status === 200,
    `status=${res21.status} body=${res21.text.slice(0, 200)}`,
  );
  check(
    "2.1 上游收到配对完整的合成 tool 响应",
    synthetic21?.content === SYNTHETIC,
    JSON.stringify(msgs21),
  );

  // 2.2 并行双 call + 单 output → 只为缺失 id 合成
  const res22 = await responsesRequest(key, "protocol-openai-strict", [
    { type: "function_call", call_id: "call_a", name: "alpha", arguments: "{}" },
    { type: "function_call", call_id: "call_b", name: "beta", arguments: "{}" },
    { type: "function_call_output", call_id: "call_a", output: "ok" },
    { role: "user", content: "probe-2.2" },
  ]);
  const msgs22 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "2.2 并行双 call + 单 output → 上游 200",
    res22.status === 200,
    `status=${res22.status}`,
  );
  check(
    "2.2 只补缺失的 call_b（call_a 保留原 output）",
    toolMessage(msgs22, "call_a")?.content === "ok" &&
      toolMessage(msgs22, "call_b")?.content === SYNTHETIC,
    JSON.stringify(msgs22),
  );

  // 2.3 孤儿 function_call_output → 丢弃
  const res23 = await responsesRequest(key, "protocol-openai-strict", [
    { type: "function_call_output", call_id: "call_orphan", output: "stale" },
    { role: "user", content: "probe-2.3" },
  ]);
  const msgs23 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "2.3 孤儿 function_call_output → 上游 200",
    res23.status === 200,
    `status=${res23.status}`,
  );
  check(
    "2.3 孤儿 tool 消息被丢弃",
    toolMessage(msgs23, "call_orphan") === undefined,
    JSON.stringify(msgs23),
  );

  // 2.4 完整配对 → messages 逐字节等价（零回归）
  const res24 = await responsesRequest(key, "protocol-openai-strict", [
    { type: "function_call", call_id: "call_full", name: "get_time", arguments: "{}" },
    { type: "function_call_output", call_id: "call_full", output: "12:00" },
    { role: "user", content: "probe-2.4" },
  ]);
  const msgs24 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "2.4 完整配对 → 上游 200",
    res24.status === 200,
    `status=${res24.status}`,
  );
  check(
    "2.4 完整配对零改动（assistant → tool → user）",
    JSON.stringify(msgs24) ===
      JSON.stringify([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_full", type: "function", function: { name: "get_time", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "call_full", content: "12:00" },
        { role: "user", content: "probe-2.4" },
      ]),
    JSON.stringify(msgs24),
  );

  // 2.5 入站空 call_id + 空 output → 确定性重命名 + FIFO 配对
  const res25 = await responsesRequest(key, "protocol-openai-strict", [
    { type: "function_call", call_id: "", name: "get_time", arguments: "{}" },
    { type: "function_call_output", call_id: "", output: "recovered" },
    { role: "user", content: "probe-2.5" },
  ]);
  const msgs25 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  const assistant25 = assistantWithCalls(msgs25);
  const normalizedId = assistant25?.tool_calls?.[0]?.id;
  check(
    "2.5 入站空 call_id → 上游 200",
    res25.status === 200,
    `status=${res25.status}`,
  );
  check(
    "2.5 空 call/output 重命名并配对",
    typeof normalizedId === "string" &&
      normalizedId.startsWith("call_") &&
      toolMessage(msgs25, normalizedId)?.content === "recovered",
    JSON.stringify(msgs25),
  );

  // 2.6 出站空 id → 网关合成非空 call_id
  const res26 = await responsesRequest(key, "protocol-empty-tool-id", [
    { role: "user", content: "probe-2.6" },
  ]);
  const output26 = Array.isArray(res26.json?.output) ? res26.json.output : [];
  const call26 = output26.find((item) => item?.type === "function_call");
  check(
    "2.6 出站空 id → 响应含 function_call",
    res26.status === 200 && call26 !== undefined,
    `status=${res26.status} body=${res26.text.slice(0, 200)}`,
  );
  check(
    "2.6 合成 call_id 非空且 call_ 前缀",
    typeof call26?.call_id === "string" &&
      /^call_/.test(call26.call_id) &&
      call26.call_id === call26.id,
    JSON.stringify(call26 ?? null),
  );

  // 2.7 Responses 面 verbatim（stg 实际配置）：孤儿 function_call 在原始 input 上修复
  const res27 = await responsesRequest(key, "protocol-responses-verbatim", [
    {
      type: "function_call",
      call_id: "request_permissions:0",
      name: "request_permissions",
      arguments: "{}",
    },
    { role: "user", content: "probe-2.7" },
  ]);
  const up27 = await lastUpstream(MOCK_STRICT, "/openai/v1/responses");
  const input27 = up27?.body?.input ?? [];
  check(
    "2.7 responses verbatim 孤儿 call → 严格上游 200",
    res27.status === 200,
    `status=${res27.status} body=${res27.text.slice(0, 200)}`,
  );
  check(
    "2.7 原始 input 注入合成 function_call_output",
    input27.some(
      (item) =>
        item?.type === "function_call_output" &&
        item?.call_id === "request_permissions:0" &&
        item?.output === SYNTHETIC,
    ),
    JSON.stringify(input27),
  );

  // 2.8 Responses 面 verbatim：孤儿 function_call_output 丢弃
  const res28 = await responsesRequest(key, "protocol-responses-verbatim", [
    { type: "function_call_output", call_id: "call_orphan", output: "stale" },
    { role: "user", content: "probe-2.8" },
  ]);
  const up28 = await lastUpstream(MOCK_STRICT, "/openai/v1/responses");
  const input28 = up28?.body?.input ?? [];
  check(
    "2.8 responses verbatim 孤儿 output → 严格上游 200",
    res28.status === 200,
    `status=${res28.status} body=${res28.text.slice(0, 200)}`,
  );
  check(
    "2.8 原始 input 孤儿 output 被丢弃",
    !input28.some(
      (item) =>
        item?.type === "function_call_output" &&
        item?.call_id === "call_orphan",
    ),
    JSON.stringify(input28),
  );

  // 2.9 Responses verbatim：custom_tool_call 配对明确降级（不 400；原始 input 保留）
  const res29 = await responsesRequest(key, "protocol-responses-verbatim", [
    {
      type: "custom_tool_call",
      call_id: "custom_call_1",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
    },
    {
      type: "custom_tool_call_output",
      call_id: "custom_call_1",
      output: "ok",
    },
    { role: "user", content: "probe-2.9" },
  ]);
  const up29 = await lastUpstream(MOCK_STRICT, "/openai/v1/responses");
  const input29 = up29?.body?.input ?? [];
  check(
    "2.9 responses verbatim custom_tool_call → 上游 200",
    res29.status === 200,
    `status=${res29.status} body=${res29.text.slice(0, 200)}`,
  );
  check(
    "2.9 verbatim 原始 input 保留 custom 配对",
    input29.some(
      (item) =>
        item?.type === "custom_tool_call" &&
        item?.call_id === "custom_call_1",
    ) &&
      input29.some(
        (item) =>
          item?.type === "custom_tool_call_output" &&
          item?.call_id === "custom_call_1",
      ),
    JSON.stringify(input29),
  );

  // 2.10 convert 路径：custom_tool_call 配对丢弃（内部 messages 仅剩 user，不 400）
  const res210 = await responsesRequest(key, "protocol-openai-strict", [
    {
      type: "custom_tool_call",
      call_id: "custom_call_2",
      name: "apply_patch",
      input: "x",
    },
    {
      type: "custom_tool_call_output",
      call_id: "custom_call_2",
      output: "ok",
    },
    { role: "user", content: "probe-2.10" },
  ]);
  const msgs210 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "2.10 convert custom_tool_call → 上游 200",
    res210.status === 200,
    `status=${res210.status} body=${res210.text.slice(0, 200)}`,
  );
  check(
    "2.10 convert 内部 messages 仅剩 user（配对丢弃）",
    JSON.stringify(msgs210) === JSON.stringify([{ role: "user", content: "probe-2.10" }]),
    JSON.stringify(msgs210),
  );
}

async function runBranch1(key) {
  console.log("\n=== 分支 1：Chat 入站工具配对卫生 ===");

  // 1.1 孤儿 tool 消息 → 严格上游 200 + 消息被丢弃
  const res11 = await chatRequest(key, "protocol-openai-strict", [
    { role: "tool", tool_call_id: "call_orphan", content: "stale" },
    { role: "user", content: "probe-1.1" },
  ]);
  const msgs11 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "1.1 孤儿 tool 消息 → 上游 200",
    res11.status === 200,
    `status=${res11.status} body=${res11.text.slice(0, 200)}`,
  );
  check(
    "1.1 孤儿 tool 消息被丢弃",
    toolMessage(msgs11, "call_orphan") === undefined,
    JSON.stringify(msgs11),
  );

  // 1.2 孤儿 tool_calls → 合成 tool 响应
  const res12 = await chatRequest(key, "protocol-openai-strict", [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_chat", type: "function", function: { name: "get_time", arguments: "{}" } },
      ],
    },
    { role: "user", content: "probe-1.2" },
  ]);
  const msgs12 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "1.2 孤儿 tool_calls → 上游 200",
    res12.status === 200,
    `status=${res12.status} body=${res12.text.slice(0, 200)}`,
  );
  check(
    "1.2 合成 tool 响应",
    toolMessage(msgs12, "call_chat")?.content === SYNTHETIC,
    JSON.stringify(msgs12),
  );

  // 1.3 完整配对 → 零改动
  const fullMessages = [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_full_chat",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_full_chat", content: "12:00" },
    { role: "user", content: "probe-1.3" },
  ];
  const res13 = await chatRequest(key, "protocol-openai-strict", fullMessages);
  const msgs13 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "1.3 完整配对 → 上游 200",
    res13.status === 200,
    `status=${res13.status} body=${res13.text.slice(0, 200)}`,
  );
  check(
    "1.3 完整配对零改动",
    JSON.stringify(msgs13) === JSON.stringify(fullMessages),
    JSON.stringify(msgs13),
  );

  // 1.4 chat 面 verbatim（生产 custom providers 的 chat face）：原始 messages 卫生
  const res14 = await chatRequest(key, "protocol-chat-verbatim", [
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_chat_verbatim",
          type: "function",
          function: { name: "get_time", arguments: "{}" },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_orphan", content: "stale" },
    { role: "user", content: "probe-1.4" },
  ]);
  const msgs14 = messagesOf(
    await lastUpstream(MOCK_STRICT, "/openai/v1/chat/completions"),
  );
  check(
    "1.4 chat verbatim 孤儿 tool → 上游 200",
    res14.status === 200,
    `status=${res14.status} body=${res14.text.slice(0, 200)}`,
  );
  check(
    "1.4 chat verbatim 原始 messages 注入合成 tool / 丢弃孤儿",
    toolMessage(msgs14, "call_chat_verbatim")?.content === SYNTHETIC &&
      toolMessage(msgs14, "call_orphan") === undefined,
    JSON.stringify(msgs14),
  );
}

async function runBranch3(key) {
  console.log("\n=== 分支 3：Anthropic 协议适配 ===");
  const beta = "message-threads-2026-08-12, interleaved-thinking-2025-05-14";
  const thread = { type: "continue", thread_id: "thr_live_01" };
  const safeguards = { policies: [{ id: "pol_live_1" }], mode: "server" };
  const expectedSafeguards = [
    { type: "safeguard_result", safeguard: "mock", result: "allow" },
  ];

  // 3.1 convert anthropic：beta 头 + thread/safeguards 透传 + 真实 id/safeguard_results 回写
  const res31 = await anthropicRequest(
    key,
    "protocol-anthropic",
    { thread, safeguards },
    { "anthropic-beta": beta },
  );
  const up31 = await lastUpstream(MOCK_LENIENT, "/anthropic/v1/messages");
  check(
    "3.1 convert anthropic → 200",
    res31.status === 200,
    `status=${res31.status} body=${res31.text.slice(0, 200)}`,
  );
  check(
    "3.1 anthropic-beta 头逐字转发",
    up31?.headers?.["anthropic-beta"] === beta,
    JSON.stringify(up31?.headers ?? null),
  );
  check(
    "3.1 thread/safeguards 逐字到上游",
    JSON.stringify(up31?.body?.thread) === JSON.stringify(thread) &&
      JSON.stringify(up31?.body?.safeguards) === JSON.stringify(safeguards),
    JSON.stringify(up31?.body ?? null),
  );
  check(
    "3.1 响应 id 为上游真实 id",
    res31.json?.id === "msg_mock_anthropic",
    JSON.stringify(res31.json?.id ?? null),
  );
  check(
    "3.1 safeguard_results 逐字回写",
    JSON.stringify(res31.json?.safeguard_results) ===
      JSON.stringify(expectedSafeguards),
    JSON.stringify(res31.json?.safeguard_results ?? null),
  );

  // 3.2 verbatim anthropic：请求逐字，非流式响应原样
  const res32 = await anthropicRequest(
    key,
    "protocol-anthropic-verbatim",
    { thread, safeguards },
    { "anthropic-beta": beta },
  );
  const up32 = await lastUpstream(MOCK_LENIENT, "/anthropic/v1/messages");
  check(
    "3.2 verbatim anthropic → 200",
    res32.status === 200,
    `status=${res32.status} body=${res32.text.slice(0, 200)}`,
  );
  check(
    "3.2 beta/thread/safeguards 逐字到上游",
    up32?.headers?.["anthropic-beta"] === beta &&
      JSON.stringify(up32?.body?.thread) === JSON.stringify(thread) &&
      JSON.stringify(up32?.body?.safeguards) === JSON.stringify(safeguards),
    JSON.stringify({ headers: up32?.headers, body: up32?.body }),
  );
  check(
    "3.2 非流式响应原样（id/safeguard_results）",
    res32.json?.id === "msg_mock_anthropic" &&
      JSON.stringify(res32.json?.safeguard_results) ===
        JSON.stringify(expectedSafeguards),
    JSON.stringify({
      id: res32.json?.id,
      safeguard_results: res32.json?.safeguard_results,
    }),
  );

  // 3.3 openai 方言 + thread（单候选）→ 400 fail-closed，且不触达上游
  const beforeCount = (await upstreamRequests(MOCK_LENIENT)).length;
  const res33 = await anthropicRequest(key, "protocol-openai-thread", { thread });
  const afterCount = (await upstreamRequests(MOCK_LENIENT)).length;
  check(
    "3.3 openai + thread → 400",
    res33.status === 400,
    `status=${res33.status} body=${res33.text.slice(0, 200)}`,
  );
  check(
    "3.3 错误文案含 message threads",
    res33.text.includes("message threads"),
    res33.text.slice(0, 200),
  );
  check(
    "3.3 未触达上游",
    afterCount === beforeCount,
    `${beforeCount} -> ${afterCount}`,
  );

  // 3.4 多候选（openai + anthropic）：跳过 openai 候选，anthropic 承载
  const res34 = await anthropicRequest(
    key,
    "protocol-thread-mixed",
    { thread, safeguards },
    { "anthropic-beta": beta },
  );
  const up34 = await lastUpstream(MOCK_LENIENT, "/anthropic/v1/messages");
  check(
    "3.4 多候选 thread → 200",
    res34.status === 200,
    `status=${res34.status} body=${res34.text.slice(0, 200)}`,
  );
  check(
    "3.4 anthropic 候选收到 thread",
    JSON.stringify(up34?.body?.thread) === JSON.stringify(thread),
    JSON.stringify(up34?.body ?? null),
  );
}

async function main() {
  if (!["1", "2", "3"].includes(BRANCH)) {
    console.error(
      `[verify-protocol-adapt] 分支 ${BRANCH} 尚未实现（当前支持 --branch=1|2|3）`,
    );
    process.exit(2);
  }

  console.log(`\n=== protocol-adapt live verify @ ${BASE} (branch ${BRANCH}) ===`);

  if (devVar("BETTER_AUTH_SECRET").length === 0) {
    console.error("[verify-protocol-adapt] .dev.vars 缺少 BETTER_AUTH_SECRET");
    process.exit(2);
  }

  const health = await api("/api/health");
  if (health.status !== 200) {
    console.error("[verify-protocol-adapt] 网关未就绪：先运行 npm run dev");
    process.exit(2);
  }

  applyMigrations();

  spawnMock(MOCK_LENIENT, false);
  spawnMock(MOCK_STRICT, true);
  const lenientReady = await waitMockReady(MOCK_LENIENT);
  const strictReady = await waitMockReady(MOCK_STRICT);
  if (!lenientReady || !strictReady) {
    console.error("[verify-protocol-adapt] mock 上游未就绪");
    process.exit(2);
  }

  console.log("  [setup] admin fixture");
  const cookie = await setupAdmin();
  console.log("  [setup] providers + prices");
  if (BRANCH === "1" || BRANCH === "2") {
    await createProvider(cookie, LENIENT_PROVIDER);
    await createProvider(cookie, STRICT_PROVIDER);
    await createProvider(cookie, RESPONSES_VERBATIM_PROVIDER);
    await createProvider(cookie, CHAT_VERBATIM_PROVIDER);
    for (const model of PRICE_MODELS) {
      await createPrice(cookie, model);
    }
  } else {
    await createProvider(cookie, ANTHROPIC_PROVIDER);
    await createProvider(cookie, ANTHROPIC_VERBATIM_PROVIDER);
    await createProvider(cookie, OPENAI_THREAD_PROVIDER);
    await createProvider(cookie, THREAD_MIXED_OPENAI_PROVIDER);
    await createProvider(cookie, THREAD_MIXED_ANTHROPIC_PROVIDER);
    for (const model of BRANCH3_PRICE_MODELS) {
      await createPrice(cookie, model);
    }
  }
  console.log("  [setup] gateway key");
  const keyRes = await api("/api/keys", {
    method: "POST",
    cookie,
    body: { name: KEY_NAME },
  });
  const key = keyRes.json?.plaintext ?? "";
  if (keyRes.status !== 200 || !key.startsWith("sk-")) {
    throw new Error(`create gateway key failed: ${keyRes.status} ${keyRes.text}`);
  }
  console.log(`  网关 key: ${key.slice(0, 6)}…（明文不落日志）`);

  if (BRANCH === "1") {
    await runBranch1(key);
  } else if (BRANCH === "2") {
    await runBranch2(key);
  } else {
    await runBranch3(key);
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failures} failed ===`);
  if (failures > 0) {
    console.log("Failed:", failedNames.join(" | "));
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error("[verify-protocol-adapt] fatal:", error);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const child of children) {
      child.kill();
    }
    if (!KEEP) {
      try {
        cleanupFixtures();
      } catch (error) {
        console.error("[verify-protocol-adapt] cleanup failed:", error);
      }
    }
  });
