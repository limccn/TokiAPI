// 测试辅助：D1/KV 准备（迁移、用户、Key、Provider、价格）与断言查询。
import { applyD1Migrations, env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { consumeBillingBatch } from "../src/lib/billing-queue";
import type { BillingEvent } from "../src/lib/billing-queue";
import {
  apiKeys,
  balanceTx,
  models,
  providers,
  requestLogs,
  sessions,
  users,
} from "../src/db/schema";
import { encryptSecret, hashToken } from "../src/lib/security";

/** 通过同一 isolate 内主 worker 的 default export 发请求（v0.22 中弃用的 SELF 在此环境不可用）。 */
export function selfFetch(input: string, init?: RequestInit): Promise<Response> {
  const app = exports.default as { fetch(request: Request): Promise<Response> };
  return app.fetch(new Request(input, init));
}

/** 应用 drizzle 迁移建表（miniflare 测试 D1 为空库）。 */
export async function applyMigrations(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

/** 清空 KV（防跨文件/用例残留计数器与缓存）。 */
export async function clearKv(): Promise<void> {
  const listed = await env.CACHE_KV.list();
  await Promise.all(listed.keys.map((k) => env.CACHE_KV.delete(k.name)));
}

/**
 * 计数 KV 包装：拦截指定前缀键的 get/put（其余键透明转发），供 KV 操作数断言
 * （防回潮：O1 限流每请求 1 读 0 写、O4.2 断路读请求内 memo 去重等，09-11-kv-ops-optimization）。
 * 用法：`const kv = countKvOps("rate:"); try { ...断言 kv.gets/kv.puts... } finally { kv.unwrap(); }`
 */
export function countKvOps(prefix: string): {
  gets: string[];
  puts: string[];
  unwrap: () => void;
} {
  const original = env.CACHE_KV;
  const gets: string[] = [];
  const puts: string[] = [];
  const wrapped = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (key: string, options?: { cacheTtl?: number }) => {
          if (key.startsWith(prefix)) {
            gets.push(key);
          }
          return target.get(key, options);
        };
      }
      if (prop === "put") {
        return async (key: string, value: string, options?: { expirationTtl?: number }) => {
          if (key.startsWith(prefix)) {
            puts.push(key);
          }
          return target.put(key, value, options);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  env.CACHE_KV = wrapped;
  return {
    gets,
    puts,
    unwrap: () => {
      env.CACHE_KV = original;
    },
  };
}

/**
 * 在指定开关值下跑一段用例，结束（含抛错）后还原 —— 09-21-email-admin-promotion-switch。
 *
 * 为什么可以这样改：**实测**（2026-09-21）`env.X = "true"` 对同一 isolate 的主 worker 可见
 * （观测：改前 `GET /api/admin/settings` 读到 false、改后读到 true，与 countKvOps 改写
 * `env.CACHE_KV` 同一机制）。两条边界：① 可见性仅限本 isolate —— pool-workers 每个测试文件一个
 * isolate，故不跨文件泄漏；② **同文件内会残留** —— 所有翻转必须走本函数（try/finally），
 * 否则污染同文件其余依赖 pinned 值的用例。
 *
 * key 取值范围是**白名单**（不是任意键）：只在 vitest.config.ts 里 pin 过、且确实需要逐用例
 * 翻转的键才登记 —— 未被 pin 的键无法保证可写。08-27-email-notification 追加了邮件通道三键
 * （RESEND_API_KEY / EMAIL_ALLOWED_RECIPIENTS / EMAIL_VERIFICATION_ENABLED）；
 * 09-21-dual-domain-split 追加 API_DOMAIN（域名分流的开关，pin "" = 未配置）。
 */
export async function withSwitch<T>(
  key:
    | "EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED"
    | "EMAIL_VERIFICATION_ENABLED"
    | "RESEND_API_KEY"
    | "EMAIL_ALLOWED_RECIPIENTS"
    | "API_DOMAIN"
    // 11-06-sms-alicloud-auth：开关 + 白名单 + 两个约束键 + 模板映射 + AK 对，
    // 全部在 vitest.config.ts pin 过（未被 pin 的键无法保证可写）。
    | "SMS_AUTH_ENABLED"
    | "SMS_ALLOWED_PHONES"
    | "SMS_SIGN_NAME"
    | "SMS_TEMPLATE_CODE"
    | "SMS_TEMPLATE_CODE_RESET"
    | "SMS_TEMPLATE_PARAM"
    | "SMS_ACCESS_KEY_ID"
    | "SMS_ACCESS_KEY_SECRET",
  value: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const original = env[key];
  try {
    // 这些键在 Cloudflare.Env 里都是 string | undefined（清空 = 复原「未配置」形态），
    // 故这里无需断言
    env[key] = value;
    return await fn();
  } finally {
    env[key] = original;
  }
}

/**
 * 逐用例改写 `BETTER_AUTH_URL`（09-21-dual-domain-split）。
 *
 * 为什么不并进上面的 withSwitch：`BETTER_AUTH_URL` 在 Cloudflare.Env 里是**必填 string**
 * （不是 `string | undefined`），塞进同一个联合类型会让 `env[key] = value` 的类型检查失败。
 * 分流的**平台域**由它派生（`new URL(BETTER_AUTH_URL).hostname`，见 src/lib/domains.ts），
 * 故「prod / stg 两套配置产生各自目标域」的判别性用例必须能翻转它。
 *
 * 与 withSwitch 同一套纪律：只在本 isolate 内可见、try/finally 还原。
 * ⚠ 它会同时影响 Better Auth 的 baseURL / trustedOrigins（createAuth 每次请求重建，故是即时生效的）
 * —— 该函数只在 domain-split.test.ts 里用，且一律在 finally 内还原。
 */
export async function withBetterAuthUrl<T>(url: string, fn: () => Promise<T>): Promise<T> {
  const original = env.BETTER_AUTH_URL;
  try {
    env.BETTER_AUTH_URL = url;
    return await fn();
  } finally {
    env.BETTER_AUTH_URL = original;
  }
}

// ============ 延迟计费（08-31-perf-v2）测试辅助 ============
// 请求路径成功时只向 BILLING_QUEUE 发事件（不写 D1）；单测环境不自动投递队列消息，
// 与 usage.test.ts 的 consumeUsageBatch 驱动模式一致：构造批 → 手动驱动消费者。

export interface BillingEventInput {
  userId: number;
  keyId: number;
  providerId: number | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  latencyMs?: number;
  upstreamLatencyMs?: number | null;
  ts?: number;
}

/**
 * 构造 Queues 计费批（模拟消费者收到的 MessageBatch<unknown>）。
 *
 * 批名在这里**只是标签**：本文件与 billing-queue.test.ts 都直驱 `consumeBillingBatch(batch, env)`，
 * 而该函数不读 `batch.queue` —— 批名改成什么都不影响这些用例（2026-09-22 变异验证：改回旧名
 * "billing-aggregation"，billing-queue.test.ts 仍 8/8 全绿）。队列名分流的**唯一**护栏在
 * tests/queue-dispatch.test.ts（经真实的 queue() 入口）。这里保持与 env 同名只为可读性；
 * env 值由 vitest.config.ts 显式 pin、**不读** `.dev.vars` 渲染产物 —— 那是为了测试自洽，
 * 不是为了检测漂移。
 */
export function makeBillingBatch(events: BillingEvent[]): MessageBatch<unknown> {
  return {
    queue: "cf-ai-gateway-billing",
    messages: events.map((body, index) => ({
      id: `billing-msg-${index}`,
      timestamp: new Date(body.ts),
      body,
      attempts: 1,
      retry: () => {},
      ack: () => {},
    })),
    metadata: {
      metrics: {
        backlogCount: events.length,
        backlogBytes: 0,
        oldestMessageTimestamp: new Date(),
      },
    },
    retryAll: () => {},
    ackAll: () => {},
  };
}

/**
 * 驱动延迟计费消费者（模拟 Queues 投递 → consumeBillingBatch）。
 * 成功请求的响应路径只 enqueue 事件；测试侧按已知结算数据构造事件后手动消费，
 * 断言余额/流水/明细在消费者批内落定。
 */
export async function settleDelayedBilling(events: BillingEventInput[]): Promise<void> {
  await consumeBillingBatch(
    makeBillingBatch(
      events.map((e) => ({
        requestId: crypto.randomUUID(),
        userId: e.userId,
        keyId: e.keyId,
        providerId: e.providerId,
        model: e.model,
        promptTokens: e.promptTokens,
        completionTokens: e.completionTokens,
        ...(e.cachedTokens !== undefined ? { cachedTokens: e.cachedTokens } : {}),
        status: "success" as const,
        latencyMs: e.latencyMs ?? 0,
        upstreamLatencyMs: e.upstreamLatencyMs ?? null,
        ts: e.ts ?? Date.now(),
      })),
    ),
    env,
  );
}

export async function setupUser(
  email: string,
  balance: number,
  role: "admin" | "member" = "member",
): Promise<number> {
  const db = createDb(env);
  const inserted = await db
    .insert(users)
    .values({ email, name: email.split("@")[0] ?? email, role, balance })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test user");
  }
  return row.id;
}

export interface SetupKeyOptions {
  qpsLimit?: number;
  cacheEnabled?: boolean;
  cacheTtl?: number;
}

export async function setupKey(
  userId: number,
  opts: SetupKeyOptions = {},
): Promise<{ keyId: number; plaintext: string }> {
  const db = createDb(env);
  const plaintext = `sk-test-${crypto.randomUUID().replaceAll("-", "")}`;
  const hash = await hashToken(plaintext);
  const inserted = await db
    .insert(apiKeys)
    .values({
      userId,
      name: "test-key",
      hash,
      prefix: plaintext.slice(0, 8),
      qpsLimit: opts.qpsLimit ?? 60,
      cacheEnabled: opts.cacheEnabled ?? false,
      cacheTtl: opts.cacheTtl ?? 3600,
    })
    .returning();
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test api key");
  }
  return { keyId: row.id, plaintext };
}

/** 注册一个 openai 类型 Provider（base_url 不可达，仅用于模型路由解析）。同名 Provider 幂等（providers.name 无唯一约束，先查后改）。返回 provider id。 */
export async function setupProviderWithModel(model: string): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, "mock-provider"),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(providers)
      .set({
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKeyEnc,
        models: JSON.stringify({ [model]: model }),
      })
      .where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({
      name: "mock-provider",
      type: "openai",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKeyEnc,
      models: JSON.stringify({ [model]: model }),
    })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test provider");
  }
  return row.id;
}

export interface SetupProviderOptions {
  /** 负载均衡权重（多 provider 供同一模型时按比例分配；缺省 1）。 */
  weight?: number;
  /** 上游 baseUrl（缺省 127.0.0.1:1 不可达，仅供路由解析）。 */
  baseUrl?: string;
  type?: "openai" | "anthropic" | "custom";
  /** 声明面 JSON（providers.protocols 列，批次 1+；缺省 NULL = 遗留隐式面表）。 */
  protocols?: string | null;
}

/** 注册一个具名 Provider（多 upstream 测试用）：models 映射 model -> model，weight 可配。幂等（同名先查后改）。 */
export async function setupProvider(
  name: string,
  model: string,
  opts: SetupProviderOptions = {},
): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, name),
    columns: { id: true },
  });
  const values = {
    type: opts.type ?? "openai",
    baseUrl: opts.baseUrl ?? "http://127.0.0.1:1/v1",
    apiKeyEnc,
    models: JSON.stringify({ [model]: model }),
    weight: opts.weight ?? 1,
    // 缺省 undefined = 不动列（新插入时落 NULL）——与「显式 null 清除」区分开
    ...(opts.protocols !== undefined ? { protocols: opts.protocols } : {}),
  };
  if (existing) {
    await db.update(providers).set(values).where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db.insert(providers).values({ name, ...values }).returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert test provider");
  }
  return row.id;
}

/** 价格表 upsert（同名模型幂等）。5 列对应 M9 分层：short/long 输入、cached 输入、short/long 输出。 */
export async function setupPrice(
  model: string,
  inputPriceShort: number,
  inputPriceLong: number,
  inputPriceCached: number,
  outputPriceShort: number,
  outputPriceLong: number,
): Promise<void> {
  const db = createDb(env);
  await db
    .insert(models)
    .values({
      model,
      inputPriceShort,
      inputPriceLong,
      inputPriceCached,
      outputPriceShort,
      outputPriceLong,
    })
    .onConflictDoUpdate({
      target: models.model,
      set: {
        inputPriceShort,
        inputPriceLong,
        inputPriceCached,
        outputPriceShort,
        outputPriceLong,
      },
    });
}

/**
 * 翻转价格行的两个标记（批次 P，09-14-admin-ui-adjustments-2）：免费模式 / 对 member 隐藏。
 *
 * 刻意**只写标记列**：`setupPrice` 的 onConflictDoUpdate 只管 5 个价列，两者互补 ——
 * 「开关不等于改价」那条断言正是靠这个分工（先 setupPrice 定价、再 setModelFlags 打标、
 * 回查价列逐字节未变）。
 *
 * 刻意**不做 upsert**：找不到行就抛错。若写成 upsert，`setModelFlags("typo-model", …)` 会静默
 * 造出一行 0 价模型，测试随即以「member 看不到它」的假象变绿 —— 最难查的一类假绿。
 */
export async function setModelFlags(
  model: string,
  flags: { freeMode?: boolean; hiddenFromMembers?: boolean },
): Promise<void> {
  if (flags.freeMode === undefined && flags.hiddenFromMembers === undefined) {
    throw new Error("setModelFlags: 至少要给一个标记");
  }
  const db = createDb(env);
  const updated = await db
    .update(models)
    .set(flags)
    .where(eq(models.model, model))
    .returning({ id: models.id });
  if (updated.length === 0) {
    throw new Error(`setModelFlags: 价格表里没有 "${model}"（先 setupPrice 建行）`);
  }
}

export async function getBalance(userId: number): Promise<number> {
  const db = createDb(env);
  const row = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true },
  });
  if (!row) {
    throw new Error("test user not found");
  }
  return row.balance;
}

export async function countTxByType(userId: number, type: string): Promise<number> {
  const db = createDb(env);
  const rows = await db
    .select()
    .from(balanceTx)
    .where(and(eq(balanceTx.userId, userId), eq(balanceTx.type, type)));
  return rows.length;
}

export async function latestLogStatus(userId: number): Promise<string | null> {
  const db = createDb(env);
  const rows = await db
    .select({ status: requestLogs.status, cost: requestLogs.cost })
    .from(requestLogs)
    .where(eq(requestLogs.userId, userId))
    .orderBy(desc(requestLogs.id))
    .limit(1);
  const row = rows[0];
  return row ? row.status : null;
}

/**
 * 创建 Better Auth 会话（直接落库；M5 usage 报表测试用）。
 * 本版本 better-auth 会话 token 明文入库（createSession 不哈希，getSession 直接按 token 查询）。
 * 返回签名 Cookie 值（格式 `${token}.${hmac-sha256-base64}`，URL 编码），配合 sessionCookie 使用。
 */
export async function createSession(userId: number): Promise<string> {
  const db = createDb(env);
  const plain = `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  await db.insert(sessions).values({
    token: plain,
    userId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(plain),
  );
  const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return encodeURIComponent(`${plain}.${signatureB64}`);
}

/** 组装 Better Auth 会话 Cookie 头值。 */
export function sessionCookie(cookieValue: string): string {
  return `better-auth.session_token=${cookieValue}`;
}

/**
 * 逐用例改写管理员邮箱名单（11-06-sms-alicloud-auth）。
 *
 * 为什么不并进 withSwitch：`ADMIN_EMAILS` 在 Env 里是**必填 string**（与 wrangler types 生成的
 * __BaseEnv_Env 一致；写成可选会与生成声明冲突），塞进同一个联合类型会让
 * `env[key] = value`（value 可为 undefined）的类型检查失败 —— 与 withBetterAuthUrl 同一处境。
 *
 * 纪律与 withSwitch 相同：只在本 isolate 内可见、try/finally 还原（同文件用例共享 env）。
 */
export async function withAdminEmails<T>(raw: string, fn: () => Promise<T>): Promise<T> {
  const original = env.ADMIN_EMAILS;
  try {
    env.ADMIN_EMAILS = raw;
    return await fn();
  } finally {
    env.ADMIN_EMAILS = original;
  }
}
