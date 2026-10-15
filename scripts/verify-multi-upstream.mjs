// 多 Upstream 本地 E2E（08-27-multi-upstream）：真实 miniflare 运行时 + 双 mock 上游 + 管理 API 全链路。
// 验证（design.md AC）：哈希粘性（同 key 恒落同 provider）、权重比例（3:1 ≈ 75/25）、
// 5xx 故障转移（首选断 → 第二候选成功）、断路器跳过（断路 provider 不再被选）、
// 全断 502（All upstream providers are temporarily unavailable）、管理 API circuitBroken 展示。
//
// 拓扑：
//   mock A  :8788（Bearer sk-mock-openai；模型回显 gpt-4o-mini）
//   mock B  :8789（Bearer sk-mock-openai；模型回显 gpt-4o-mini-2）
//   wrangler dev（vite，默认 5173；DEV_PORT 可覆盖）
//   provider A → http://127.0.0.1:8788/openai  weight 3
//   provider B → http://127.0.0.1:8789/openai  weight 1
// 落点区分：响应体 system_fingerprint="mock:<上游模型名>"（disguise 层只重写 model/error.message，
//   不触碰该字段）—— 多上游与 disguise 共存后，model 字段恒为请求内部名 gpt-4o-e2e，
//   fingerprint 成为落点信号（mock-upstream.mjs 约定）。
//
// 用法：node scripts/verify-multi-upstream.mjs [--keep]
//   --keep：跑完不杀子进程（留现场排查）。
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WRANGLER_JS = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const DB = "cf-ai-gateway-db";
const DEV_PORT = Number(process.env.DEV_PORT ?? 5173);
// vite 默认绑定 IPv6 回环 [::1]，用 localhost（Node fetch 优先 IPv6）而非 127.0.0.1
const BASE = `http://localhost:${DEV_PORT}`;
const KEEP = process.argv.includes("--keep");

const MODEL = "gpt-4o-e2e";       // 网关内部模型名
const MODEL_A = "gpt-4o-mini";    // A 上游回显（mock 恒回显 body.model）
const MODEL_B = "gpt-4o-mini-2";  // B 上游回显
const FP_A = `mock:${MODEL_A}`;   // A 落点指纹（响应 system_fingerprint）
const FP_B = `mock:${MODEL_B}`;   // B 落点指纹
const MOCK_A = 8788;
const MOCK_B = 8789;
const FAIL_MODEL = "error-500";   // mock 约定：该模型恒返回 500

const ADMIN = { email: "e2e-admin@local.test", name: "E2E Admin", role: "admin", balance: 50 };
const MEMBER = { email: "e2e-user@local.test", name: "E2E User", role: "member", balance: 100 };

/** 读取 .dev.vars（KEY=VALUE 行）取本地 secret（BETTER_AUTH_SECRET 等不 commit 的配置）。 */
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

/** 与 src/lib/provider-router.ts 完全一致的 FNV-1a 32 位哈希（E2E 落点预测）。 */
function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 权重槽位落点预测（与 src/lib/provider-router.ts buildSlotMap 一致）：weight A=3/B=1 → totalSlots=4，槽 [A,A,A,B]；fnv1a32(id) % 4 < 3 → A。 */
function primaryIndex(keyId) {
  return fnv1a32(String(keyId)) % 4 < 3 ? 0 : 1;
}

/**
 * 批量插入 N 个 key（INSERT ... RETURNING 一次拿回全部 id；插入顺序与 plaintexts 一致）。
 * 关键：不要在 chat 请求之间跑 wrangler d1 execute —— 与 dev server 同一 SQLite 文件，
 * 跨进程锁会让 worker 的 D1 鉴权阻塞（实测触发 read ECONNRESET）。
 */
function insertKeys(memberId, now, name, plaintexts) {
  const rows = [];
  for (const k of plaintexts) {
    const kh = createHash("sha256").update(k).digest("hex");
    rows.push(`(${memberId}, '${name}', '${kh}', '${k.slice(0, 8)}', 'active', 60, 0, 3600, ${now})`);
  }
  const out = execFileSync(process.execPath,
    [WRANGLER_JS, "d1", "execute", DB, "--local", "--config", "wrangler.jsonc",
      "--command",
      `INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at) VALUES ${rows.join(",")} RETURNING id, name;`,
      "--json"], { encoding: "utf8", cwd: ROOT });
  return JSON.parse(out)[0]?.results ?? [];
}

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
    } catch (error) {
      if (i === tries - 1) console.log(`[warn] waitReady ${url} 最后尝试: ${String(error)}`);
    }
    await sleep(500);
  }
  return false;
}

// agent: false —— 禁用 undici 连接池：循环中请求与 wrangler d1 子进程交错，池中空闲 socket 可能已被
// vite dev 侧关闭，复用会触发 read ECONNRESET（实测稳定复现；每请求新连接可确定性规避）。
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
async function chat(plaintext, stream = false) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], stream }),
    agent: false,
  });
  return { status: res.status, json: await res.json().catch(() => null), text: await res.text().catch(() => "") };
}

// ============ 子进程 ============

const children = [];
function spawnBg(label, cmd, args, env = {}) {
  // Windows 上 npm 是 npm.cmd，需 shell 执行；mock/node 直接 spawn 无碍
  const child = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  if (process.env.E2E_CHILD_LOG) {
    // 诊断模式：子进程输出落盘（E2E_CHILD_LOG 为目录，按 label 分文件）
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
  const started = Date.now();
  // 1. mock 上游 A/B
  spawnBg("mock-a", process.execPath, ["scripts/mock-upstream.mjs"], { MOCK_PORT: String(MOCK_A) });
  spawnBg("mock-b", process.execPath, ["scripts/mock-upstream.mjs"], { MOCK_PORT: String(MOCK_B) });
  check("mock A 就绪", await waitReady(`http://127.0.0.1:${MOCK_A}/openai/v1/models`, 20));
  check("mock B 就绪", await waitReady(`http://127.0.0.1:${MOCK_B}/openai/v1/models`, 20));

  // 2. wrangler dev（vite）
  spawnBg("dev", "npm", ["run", "dev", "--", "--port", String(DEV_PORT), "--strictPort"]);
  check("wrangler dev 就绪", await waitReady(`${BASE}/v1/models`));

  // 3. D1 直插夹具（幂等清理，按外键依赖逆序：balance_tx.ref_request_id → request_logs，request_logs.key_id → api_keys / provider_id → providers，usage_daily.key_id → api_keys，均 → users）
  const now = Math.floor(Date.now() / 1000);
  q(`DELETE FROM balance_tx WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM request_logs WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM usage_daily WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM api_keys WHERE name LIKE 'e2e-multi%'; DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}')); DELETE FROM providers WHERE name IN ('multi-e2e-a','multi-e2e-b'); DELETE FROM models WHERE model='${MODEL}'; DELETE FROM users WHERE email IN ('${ADMIN.email}','${MEMBER.email}');`);
  for (const u of [ADMIN, MEMBER]) {
    q(`INSERT INTO users (email, name, role, status, balance, email_verified, created_at, updated_at)
       VALUES ('${u.email}', '${u.name}', '${u.role}', 'active', ${u.balance}, 1, ${now}, ${now});`);
  }
  const memberId = q(`SELECT id FROM users WHERE email='${MEMBER.email}';`)[0]?.id;
  const adminId = q(`SELECT id FROM users WHERE email='${ADMIN.email}';`)[0]?.id;
  const keyPlain = `sk-e2e-${randomBytes(16).toString("hex")}`;
  const keyHash = createHash("sha256").update(keyPlain).digest("hex");
  q(`INSERT INTO api_keys (user_id, name, hash, prefix, status, qps_limit, cache_enabled, cache_ttl, created_at)
     VALUES (${memberId}, 'e2e-multi', '${keyHash}', '${keyPlain.slice(0, 8)}', 'active', 60, 0, 3600, ${now});`);
  const keyId = q(`SELECT id FROM api_keys WHERE name='e2e-multi';`)[0]?.id;
  q(`INSERT INTO models (model, input_price_short, input_price_long, input_price_cached, output_price_short, output_price_long, created_at, updated_at)
     VALUES ('${MODEL}', 1.0, 1.0, 0.25, 3.0, 3.0, ${now}, ${now});`);

  // 4. 伪造 admin 会话（better-auth：token 明文落库 + `${token}.${hmac}` 签名 cookie）
  const sessPlain = `sess_${randomBytes(16).toString("hex")}`;
  q(`INSERT INTO sessions (token, user_id, expires_at, created_at, updated_at)
     VALUES ('${sessPlain}', ${adminId}, ${now + 3600}, ${now}, ${now});`);
  const sig = Buffer.from(await crypto.subtle.sign(
    "HMAC",
    await crypto.subtle.importKey("raw", new TextEncoder().encode(devVar("BETTER_AUTH_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    new TextEncoder().encode(sessPlain),
  )).toString("base64");
  const adminCookie = `better-auth.session_token=${encodeURIComponent(`${sessPlain}.${sig}`)}`;

  // 5. 管理 API 创建 provider A（weight 3）/ B（weight 1）
  const mkProvider = async (name, port, weight, upstreamModel) => {
    const res = await api("/api/providers", {
      method: "POST",
      cookie: adminCookie,
      body: {
        name,
        type: "openai",
        baseUrl: `http://127.0.0.1:${port}/openai/v1`,
        apiKey: "sk-mock-openai",
        models: { [MODEL]: upstreamModel },
        weight,
      },
    });
    return res.json?.provider?.id;
  };
  const providerA = await mkProvider("multi-e2e-a", MOCK_A, 3, MODEL_A);
  const providerB = await mkProvider("multi-e2e-b", MOCK_B, 1, MODEL_B);
  check("管理 API 创建 provider A/B（weight 3/1）", Number.isInteger(providerA) && Number.isInteger(providerB),
    `A=${providerA} B=${providerB}`);
  const listRes = await api("/api/providers", { cookie: adminCookie });
  const weights = (listRes.json?.items ?? []).filter((p) => [providerA, providerB].includes(p.id)).map((p) => p.weight).sort();
  check("管理 API 回显 weight [1,3]", JSON.stringify(weights) === "[1,3]", JSON.stringify(weights));

  // 6. 粘性：同一 key 连续 5 次 → 落点指纹恒同（无状态哈希，无共享存储）；
  //    disguise 生效：响应 model 恒为请求内部名
  const stickyFps = [];
  const stickyModels = [];
  for (let i = 0; i < 5; i++) {
    const r = await chat(keyPlain);
    stickyFps.push(r.json?.system_fingerprint);
    stickyModels.push(r.json?.model);
  }
  check("粘性：同一 key 恒落同一 provider", stickyFps.every((fp) => fp === stickyFps[0]),
    stickyFps.join(","));
  check("disguise：响应 model 恒为请求内部名", stickyModels.every((m) => m === MODEL),
    stickyModels.join(","));

  // 7. 权重 3:1：50 个 key → 落 A（gpt-4o-mini）比例 ≈ 75%
  //    一次批量 INSERT ... RETURNING 拿全部 id（避免在请求间隙跑 wrangler d1 execute → 跨进程文件锁）
  const weightKeys = Array.from({ length: 50 }, () => `sk-e2e-${randomBytes(16).toString("hex")}`);
  const weightRows = insertKeys(memberId, now, "e2e-multi-weight", weightKeys);
  const hitCount = { A: 0, B: 0 };
  for (let i = 0; i < weightRows.length; i++) {
    const id = weightRows[i]?.id;
    let r;
    try {
      r = await chat(weightKeys[i]);
    } catch (error) {
      console.log(`[warn] 权重迭代 ${i}（keyId=${id}）fetch 失败: ${String(error)} cause=${error.cause?.code ?? error.cause?.message ?? ""}`);
      // 探针：2s 后重连，区分「服务器存活（瞬时 RST）」与「服务器死亡（ECONNREFUSED）」
      await sleep(2000);
      const t0 = Date.now();
      try {
        const probe = await fetch(`${BASE}/v1/models`, { agent: false });
        console.log(`[probe] 服务器存活 — status=${probe.status}（探针耗时 ${Date.now() - t0}ms）`);
      } catch (probeError) {
        console.log(`[probe] 服务器不可达 — ${String(probeError)} cause=${probeError.cause?.code ?? ""}（探针耗时 ${Date.now() - t0}ms）`);
      }
      throw error;
    }
    const fp = r.json?.system_fingerprint;
    if (fp === FP_A) hitCount.A++;
    else if (fp === FP_B) hitCount.B++;
    else console.log(`[warn] unexpected fp=${fp} model=${r.json?.model} status=${r.status}`);
    // 预测校验：每个 key 的落点应与纯函数一致（顺带验证粘性预测）
    if (Number.isInteger(id) && fp) {
      const predicted = primaryIndex(id) === 0 ? FP_A : FP_B;
      if (predicted !== fp) check(`key ${id} 落点与 FNV-1a 预测一致`, false, `${predicted} != ${fp}`);
    }
  }
  const total = hitCount.A + hitCount.B;
  const ratio = hitCount.A / total;
  check("权重 3:1：A 占比 75%（±10% 防 flake）", ratio > 0.65 && ratio < 0.85,
    `A=${hitCount.A} B=${hitCount.B} ratio=${(ratio * 100).toFixed(1)}%`);

  // 8. 故障转移：把 B 的模型映射改为 error-500（mock 恒 500）
  //    取首选落 B 的 key → 500 转移 A → 200 + gpt-4o-mini
  await api(`/api/providers/${providerB}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { models: { [MODEL]: FAIL_MODEL } },
  });
  // 复用权重测试 key 的 id 预测：批量插入后取首个首选落 B 的 key
  const failKeys = Array.from({ length: 50 }, () => `sk-e2e-fail-${randomBytes(16).toString("hex")}`);
  const failRows = insertKeys(memberId, now, "e2e-multi-fail", failKeys);
  let failKey = null;
  let failKeyId = null;
  for (let i = 0; i < failRows.length && failKey === null; i++) {
    if (primaryIndex(failRows[i]?.id) === 1) { failKey = failKeys[i]; failKeyId = failRows[i]?.id; }
  }
  check("取到首选落 B 的 key", failKey !== null, `keyId=${failKeyId}`);
  if (failKey !== null) {
    const r1 = await chat(failKey);
    check("failover：B 5xx → 转移 A 成功（200 + 指纹 A + model 伪装）",
      r1.status === 200 && r1.json?.system_fingerprint === FP_A && r1.json?.model === MODEL,
      `status=${r1.status} fp=${r1.json?.system_fingerprint} model=${r1.json?.model}`);
    const r2 = await chat(failKey);
    check("断路器跳过：B 断路后不再被选（仍落 A）",
      r2.status === 200 && r2.json?.system_fingerprint === FP_A,
      `status=${r2.status} fp=${r2.json?.system_fingerprint}`);
  }

  // 9. 管理 API 断路状态展示
  const brokenRes = await api("/api/providers", { cookie: adminCookie });
  const bItem = (brokenRes.json?.items ?? []).find((p) => p.id === providerB);
  check("管理 API：B 显示 circuitBroken + circuitReason=5xx",
    bItem?.circuitBroken === true && bItem?.circuitReason === "5xx",
    JSON.stringify({ circuitBroken: bItem?.circuitBroken, circuitReason: bItem?.circuitReason }));

  // 10. 恢复窗口内：A/B 恢复正常映射（TTL 60s 未到期，B 仍断路 → 落 B 的 key 继续转移 A）
  //    注意：必须先做本步再做全断 —— 全断会打开 A 的断路器，若倒序则恢复请求也会撞 A 断路。
  await api(`/api/providers/${providerA}`, { method: "PATCH", cookie: adminCookie, body: { models: { [MODEL]: MODEL_A } } });
  await api(`/api/providers/${providerB}`, { method: "PATCH", cookie: adminCookie, body: { models: { [MODEL]: MODEL_B } } });
  if (failKey !== null) {
    const r = await chat(failKey);
    check("恢复窗口内：上游已恢复但 B 仍断路 → 继续转移 A",
      r.status === 200 && r.json?.system_fingerprint === FP_A,
      `status=${r.status} fp=${r.json?.system_fingerprint}`);
  }

  // 11. 全断：A 也切 error-500 → 首选落 A 的 key
  //    第 1 次请求：B 已断路 → 仅尝试 A → 500 透传（真实错误语义）+ 打开 A 断路器；
  //    第 2 次请求：A/B 均断路 → allCircuitsOpen → 502（open 态拒绝语义）。
  await api(`/api/providers/${providerA}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { models: { [MODEL]: FAIL_MODEL } },
  });
  let openKey = null;
  let openKeyId = null;
  const openKeys = Array.from({ length: 50 }, () => `sk-e2e-open-${randomBytes(16).toString("hex")}`);
  const openRows = insertKeys(memberId, now, "e2e-multi-open", openKeys);
  for (let i = 0; i < openRows.length && openKey === null; i++) {
    if (primaryIndex(openRows[i]?.id) === 0) { openKey = openKeys[i]; openKeyId = openRows[i]?.id; }
  }
  check("取到首选落 A 的 key", openKey !== null, `keyId=${openKeyId}`);
  if (openKey !== null) {
    const r1 = await chat(openKey);
    check("全断第 1 次：仅 A 可用且 5xx → 500 透传（真实错误语义）",
      r1.status === 500 && typeof r1.json?.error?.message === "string",
      `status=${r1.status} msg=${r1.json?.error?.message}`);
    const r2 = await chat(openKey);
    check("全断第 2 次：A/B 均断路 → 502 All upstream providers are temporarily unavailable",
      r2.status === 502 && r2.json?.error?.message === "All upstream providers are temporarily unavailable",
      `status=${r2.status} msg=${r2.json?.error?.message}`);
  }

  // 12. TTL 自动恢复：等 62s（KV expirationTtl 60s + 余量）→ 断路器到期 → 落 B 的 key 回到 B
  console.log("[info] 等待断路器 TTL 过期（62s）……");
  await sleep(62_000);
  if (failKey !== null) {
    const r = await chat(failKey);
    check("TTL 到期自动恢复：请求回到首选 B（指纹 B + model 伪装）",
      r.status === 200 && r.json?.system_fingerprint === FP_B && r.json?.model === MODEL,
      `status=${r.status} fp=${r.json?.system_fingerprint} model=${r.json?.model}`);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nE2E 结果：${failures === 0 ? "全部通过" : `${failures} 项失败`}（${elapsed}s）`);
  await cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

/** 杀子进程树：Windows 上 shell spawn 的 npm 壳 kill 不传子进程，需 taskkill /T。 */
async function cleanup() {
  if (KEEP) {
    console.log("[keep] 子进程保持运行（mock A/B + dev server），请手动清理");
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
