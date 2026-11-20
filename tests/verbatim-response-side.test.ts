// verbatim 响应侧端到端（09-28-upstream-custom-type-passthrough 批次 4）。
// 钉四件事：
//   ① 边界 A（灰度前必修，09-28 check 边界记录）：useVerbatim / 流式直通门补第四要素
//      `endpoint.face === inboundFace` —— responses 入站 × 显式 verbatim chat 面候选
//      （selectEndpoint viaChat 规则可把 chat 面端点给 responses 入站）时**必须走转换链**，
//      Responses 体不能逐字节直通到 /chat/completions；附遗留等价断言（P2a 直通与显式
//      convert 行为与本批改动前一致——第四要素不影响它们的合取结果）；
//   ② 边界 B（灰度前必修）：verbatim 非流式读体/解析失败与 convert 同契约 —— 非 JSON /
//      idle 截断一律 502 + upstream_non_json_response + 错误行 + 不计费 + **不缓存**，
//      绝不把截断字节当 200；缓存断言带正对照（成功请求写进同一 cacheKey ⇒ 机制在线，
//      失败后的 null 不是「缓存本来就坏」的恒真假绿）；
//   ③ AC7（design §5.2）：verbatim 错误体逐字 + 上游状态码保留 + **跳过文案伪装**
//      （非恒等映射下上游模型名保留 —— 有意取舍，重试恢复靠匹配上游措辞）；三条保底：
//      不计费 / upstream_error 日志仍写 / 明细行仍落；429 单候选耗尽路径经 lastError 同语义；
//   ④ AC6 头转发实路：成功（流式/非流式）转发头透传 + deny 头不透传 + 网关 X-RateLimit-*
//      完好；convert 路径头集合零变化（不转发任何上游头）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { asc, eq } from "drizzle-orm";
import { createDb } from "../src/db";
import { providers, requestLogs } from "../src/db/schema";
import type { BillingEvent } from "../src/lib/billing-queue";
import { consumeBillingBatch } from "../src/lib/billing-queue";
import {
  buildCacheKey,
  buildCountKey,
  hashRequestBody,
  resetMissCountsForTest,
} from "../src/lib/response-cache";
import {
  applyMigrations,
  clearKv,
  makeBillingBatch,
  selfFetch,
  setupKey,
  setupPrice,
  setupProvider,
  setupUser,
} from "./helpers";

const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

let modelSeq = 0;
function uniqueModel(prefix: string): string {
  modelSeq++;
  return `v4r-${prefix}-${modelSeq}`;
}

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function stubUpstreamFetch(
  handler: (call: CapturedCall) => Response | Promise<Response>,
): CapturedCall[] {
  const calls: CapturedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: CapturedCall = { url: String(input), init: init ?? {} };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

function upstreamJson(call: CapturedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function captureBillingQueue(): { sent: BillingEvent[]; restore: () => void } {
  const sent: BillingEvent[] = [];
  const original = env.BILLING_QUEUE;
  const recorder = {
    send: async (event: BillingEvent) => {
      sent.push(event);
    },
    sendBatch: async (messages: Array<{ body: BillingEvent }>) => {
      for (const message of messages) {
        sent.push(message.body);
      }
    },
  };
  env.BILLING_QUEUE = recorder as unknown as typeof original;
  return {
    sent,
    restore: () => {
      env.BILLING_QUEUE = original;
    },
  };
}

/** 驱动计费消费者处理捕获的事件（成功明细由消费者批内写入）。 */
async function consumeCaptured(sent: BillingEvent[]): Promise<void> {
  await consumeBillingBatch(makeBillingBatch(sent), env);
}

/** 等待一小段真实时间（waitUntil 旁路异步于响应返回；「无事件」断言的轮询窗口）。 */
async function settleWindow(ms = 300): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function logsFor(keyId: number): Promise<Array<{ providerId: number | null; status: string }>> {
  const db = createDb(env);
  const rows = await db
    .select({ providerId: requestLogs.providerId, status: requestLogs.status })
    .from(requestLogs)
    .where(eq(requestLogs.keyId, keyId))
    .orderBy(asc(requestLogs.id));
  return rows.map((r) => ({ providerId: r.providerId, status: r.status }));
}

/** 复写 providers.models 为非恒等映射（alias → upstream）。 */
async function rewireModels(
  providerId: number,
  alias: string,
  upstream: string,
): Promise<void> {
  const db = createDb(env);
  await db
    .update(providers)
    .set({ models: JSON.stringify({ [alias]: upstream }) })
    .where(eq(providers.id, providerId));
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await clearKv();
  resetMissCountsForTest();
});

// ============ ① 边界 A：面不匹配 ⇒ 转换链（Responses 体不被直通吞掉） ============
describe("边界 A：responses 入站 × verbatim chat 面候选 ⇒ convert 转换链", () => {
  it("/v1/responses 打 chat 面（默认 verbatim）候选：上游收重建体（messages、无 input），客户端拿 Responses 形态", async () => {
    const model = uniqueModel("bA");
    // chat 面 policy 缺省 = verbatim —— 若无 face===inboundFace 第四要素，useVerbatim 会
    // 为真（方言合取已满足：openai === dialectForFace("responses")），Responses 体被逐字
    // 发往 /chat/completions（边界 A 的缺陷形态）。
    await setupProvider("v4r-ba", model, {
      type: "custom",
      baseUrl: "http://v4r-ba.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser(`v4r-ba-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch(() => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-ba",
          object: "chat.completion",
          created: 1_700_000_000,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ba ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await selfFetch("http://localhost/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model, input: "hi", stream: false }),
    });
    expect(res.status).toBe(200);
    // 转换链证据（非 verbatim）：上游收到 toInternal 重建体 —— messages 形态、input 键不存
    //（verbatim 会把入站 rawBody 原样上抛：有 input、无 messages）
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    const upstreamBody = upstreamJson(call);
    expect(upstreamBody["input"]).toBeUndefined();
    expect(Array.isArray(upstreamBody["messages"])).toBe(true);
    // 客户端拿协议出站转换产物（Responses 形态）而非上游原始字节
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("response");
  });

  it("遗留等价：legacy anthropic 记录 messages 入站流式仍字节直通（P2a 恒等复现），且不转发上游头", async () => {
    const model = uniqueModel("bAp2a");
    await setupProvider("v4r-ba-p2a", model, {
      type: "anthropic",
      baseUrl: "http://v4r-ba-p2a.test",
    });
    const userId = await setupUser(`v4r-ba-p2a-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse =
      `event: message_start\n` +
      `data: {"type":"message_start","message":{"id":"msg_up_p2a","type":"message","role":"assistant","model":"${model}","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":1}}}\n\n` +
      `event: content_block_delta\n` +
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n` +
      `event: message_delta\n` +
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}\n\n` +
      `event: message_stop\n` +
      `data: {"type":"message_stop"}\n\n`;
    stubUpstreamFetch(() => {
      return new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-p2a-must-not-forward",
        },
      });
    });

    const res = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(res.status).toBe(200);
    // P2a 直通：字节全等（本批第四要素不改变该合取结果 —— face 相等）
    expect(await res.text()).toBe(sse);
    // 头集合零变化：convert（P2a 属转换管线，头不转发）
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("x-request-id")).toBeNull();
  });

  it("遗留等价：显式 convert 声明（messages 面 policy=convert）⇒ 走转换链不逐字", async () => {
    const model = uniqueModel("bAconv");
    await setupProvider("v4r-ba-conv", model, {
      type: "custom",
      baseUrl: "http://v4r-ba-conv.test",
      protocols: JSON.stringify({ messages: { policy: "convert" } }),
    });
    const userId = await setupUser(`v4r-ba-conv-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch(() => {
      return new Response(
        JSON.stringify({
          id: "msg_up_conv",
          type: "message",
          role: "assistant",
          model,
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const res = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
        vendor_marker: "MUST_BE_DROPPED",
      }),
    });
    expect(res.status).toBe(200);
    // convert：未知字段被白名单重建丢弃；分支 3 起真实响应 id 透传（message threads 的
    // previous_message_id 依赖上游真值，DESIGN §3.4）——convert 的判别力由 vendor_marker 丢弃承担。
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    expect(upstreamJson(call)["vendor_marker"]).toBeUndefined();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["type"]).toBe("message");
    expect(body["id"]).toBe("msg_up_conv");
  });
});

// ============ ② 边界 B：verbatim 非流式读体/解析失败与 convert 同契约 ============
describe("边界 B：verbatim 上游 200 但体不可用 ⇒ 502 + 错误行 + 不计费 + 不缓存", () => {
  it("非 JSON 体 ⇒ 502 + upstream_non_json_response + 明细错误行 + 计费 0 + 缓存键缺席（含成功正对照）", async () => {
    const model = uniqueModel("bB1");
    await setupProvider("v4r-bb1", model, {
      type: "custom",
      baseUrl: "http://v4r-bb1.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser(`v4r-bb1-${modelSeq}@test.dev`, 10);
    // cacheEnabled：缓存不写断言需要缓存机制在线（正对照在第 3 步）
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const requestPayload = { model, messages: [{ role: "user", content: "hi" }] };
    const bodyHash = await hashRequestBody(requestPayload);
    const cacheKey = buildCacheKey(keyId, model, bodyHash);
    const countKey = buildCountKey(keyId, model, bodyHash);

    const okBody = JSON.stringify({
      id: "chatcmpl-bb1",
      object: "chat.completion",
      created: 1_700_000_000,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    let respondJson = true;
    const calls = stubUpstreamFetch(() => {
      return respondJson
        ? new Response(okBody, { status: 200, headers: { "Content-Type": "application/json" } })
        : new Response("<html>bad gateway flavor</html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
    });

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 计费捕获覆盖全程：成功请求的事件经消费者落成功明细；失败请求必须零事件
    const billing = captureBillingQueue();

    let failed: Response;
    try {
      // 第 1 步：成功（miss 计数 1，未达阈值 2 → 无缓存写）
      respondJson = true;
      const first = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(requestPayload),
      });
      expect(first.status).toBe(200);
      expect(billing.sent).toHaveLength(1);

      // 第 2 步：失败（上游 200 但体非 JSON）→ 502 契约；正确行为下不 bump（计数仍 1）、不写缓存
      respondJson = false;
      failed = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(requestPayload),
      });
      // 判别窗口：失败请求若被误当成功（截断字节当 200 的缺陷形态），此刻必已写缓存
      await settleWindow();
      // 不计费（错误路径零计费事件：此刻仅有第 1 步成功事件）
      expect(billing.sent).toHaveLength(1);
      // 不缓存：失败后 cacheKey 缺席（若失败体被误当成功写缓存，此刻必然在场）
      expect(await env.CACHE_KV.get(cacheKey)).toBeNull();

      // 第 3 步：正对照 —— 再次成功到达阈值 2 ⇒ cacheKey 出现（缓存机制在线，
      // 上面的 null 断言因此有判别力）
      respondJson = true;
      const third = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify(requestPayload),
      });
      expect(third.status).toBe(200);
      await vi.waitFor(async () => {
        expect(await env.CACHE_KV.get(cacheKey)).not.toBeNull();
      });
    } finally {
      billing.restore();
    }
    expect(calls.length).toBe(3);
    expect(failed.status).toBe(502);
    expect(((await failed.json()) as { error: { message: string } }).error.message).toBe(
      "Upstream returned a non-JSON response",
    );
    // upstream_non_json_response（logger.error → console.error）
    const nonJsonLogs = errSpy.mock.calls
      .map((callLine) => JSON.parse(String(callLine[0])) as { message: string })
      .filter((line) => line.message === "upstream_non_json_response");
    expect(nonJsonLogs.length).toBe(1);
    errSpy.mockRestore();
    // 全程恰 2 个计费事件（两次成功；失败请求零事件），消费后落 3 行明细。
    // （行序 = 插入序：错误行在请求路径同步落库，成功行由消费者批内落库 ⇒ error 在前。）
    expect(billing.sent).toHaveLength(2);
    await consumeCaptured(billing.sent);
    expect((await logsFor(keyId)).map((r) => r.status)).toEqual(["error", "success", "success"]);
    // 不缓存失败体（阈值语义下失败也绝不先写进 KV；上面正对照已证机制在线）
    expect(await env.CACHE_KV.get(countKey)).toBeNull();
  });

  it("体中途截断（idle 超时）⇒ 同契约 502，绝不把截断字节当 200", async () => {
    const model = uniqueModel("bB2");
    const providerId = await setupProvider("v4r-bb2", model, {
      type: "custom",
      baseUrl: "http://v4r-bb2.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser(`v4r-bb2-${modelSeq}@test.dev`, 10);
    const { keyId, plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    // per-provider 上游超时（U7）：idle 阈值 150ms —— TTFB 即回、体中途停顿
    await createDb(env)
      .update(providers)
      .set({ upstreamTimeoutMs: 150 })
      .where(eq(providers.id, providerId));

    // 上游体只发一个合法 JSON 前缀后永不关闭（截断形态：等下去只会 done，字节永远不完整）
    const encoder = new TextEncoder();
    stubUpstreamFetch(() => {
      const stalled = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"id":"chatcmpl-cut","object":"chat.comple'));
          // 不 close：挂起等待 idle 超时
        },
      });
      return new Response(stalled, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      });
      await settleWindow();
    } finally {
      billing.restore();
    }
    // 同契约：502 + 归一错误体 + 明细错误行 + 零计费（绝不返回截断字节的 200）
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "Upstream returned a non-JSON response",
    );
    expect((await logsFor(keyId)).map((r) => r.status)).toEqual(["error"]);
    expect(billing.sent).toHaveLength(0);
  });
});

// ============ ③ AC7：verbatim 错误体逐字（design §5.2） ============
describe("AC7 verbatim 错误体逐字：原样 + 上游状态码 + 跳过文案伪装 + 三条保底", () => {
  it("非可转移 400：原样错误体（含上游模型名不伪装）+ x-should-retry 转发 + 不计费/日志/明细行", async () => {
    const alias = uniqueModel("err400");
    const upstreamName = `v4r-err400-${modelSeq}-up-real`;
    const providerId = await setupProvider("v4r-err400", alias, {
      type: "custom",
      baseUrl: "http://v4r-err400.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    await rewireModels(providerId, alias, upstreamName);
    const userId = await setupUser(`v4r-err400-${modelSeq}@test.dev`, 10);
    const { keyId, plaintext } = await setupKey(userId);
    await setupPrice(alias, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 错误体含上游真实模型名：convert 会把名字伪装成请求名；verbatim 有意跳过（§5.2）
    const rawError = JSON.stringify({
      error: {
        message: `quota exhausted for model ${upstreamName} region us-west`,
        type: "insufficient_quota",
      },
    });
    stubUpstreamFetch(() => {
      return new Response(rawError, {
        status: 400,
        headers: { "Content-Type": "application/json", "x-should-retry": "true" },
      });
    });

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model: alias, messages: [{ role: "user", content: "hi" }] }),
      });
      await settleWindow();
    } finally {
      billing.restore();
    }

    // 逐字：状态码保留 + 字节全等（文案伪装被跳过 ⇒ 上游模型名原样出现在客户端体里）
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe(rawError);
    expect(text).toContain(upstreamName);
    // §5.1 错误响应头：重试恢复依据转发；上游 content-type 同真
    expect(res.headers.get("x-should-retry")).toBe("true");
    expect(res.headers.get("Content-Type")).toBe("application/json");
    // 三条保底：不计费 / 上游错误日志仍写 / 明细行仍落。
    // （既有日志形态取证：upstream_error 的 warn 行里 message 字段被错误文案字段同名覆盖
    // —— logger.write 的 {message, ...fields} 展开序使 "upstream_error" 标记不落输出，
    // 既有行为、零回归红线不改；断言锚在其可观测形态：warn 级 + status 400 + 上游文案。）
    expect(billing.sent).toHaveLength(0);
    const upstreamErrLogs = logSpy.mock.calls
      .map(
        (callLine) =>
          JSON.parse(String(callLine[0])) as { level: string; message: string; status?: number },
      )
      .filter((line) => line.level === "warn" && line.status === 400);
    expect(upstreamErrLogs.length).toBe(1);
    expect(upstreamErrLogs[0]?.message).toContain(upstreamName);
    logSpy.mockRestore();
    expect((await logsFor(keyId)).map((r) => [r.providerId, r.status])).toEqual([
      [providerId, "error"],
    ]);
  });

  it("429 单候选耗尽：lastError 携 verbatim 原文回传 + retry-after 转发 + 三条保底", async () => {
    const model = uniqueModel("err429");
    const providerId = await setupProvider("v4r-err429", model, {
      type: "custom",
      baseUrl: "http://v4r-err429.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser(`v4r-err429-${modelSeq}@test.dev`, 10);
    const { keyId, plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const rawError = JSON.stringify({ error: { message: "rate limited by upstream" } });
    stubUpstreamFetch(() => {
      return new Response(rawError, {
        status: 429,
        headers: { "Content-Type": "application/json", "retry-after": "7" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      });
      await settleWindow();
    } finally {
      billing.restore();
    }
    // 可转移（429）但无次选 ⇒ 候选耗尽，lastError 的 verbatim 原文与转发头回传
    expect(res.status).toBe(429);
    expect(await res.text()).toBe(rawError);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(billing.sent).toHaveLength(0);
    expect((await logsFor(keyId)).map((r) => [r.providerId, r.status])).toEqual([
      [providerId, "error"],
    ]);
  });
});

// ============ ④ AC6：头转发实路（成功路径，verbatim on / convert off） ============
describe("AC6 头转发：成功路径放行头透传、deny 头不透传、网关限流头完好", () => {
  it("非流式 verbatim：x-request-id/retry-after/anthropic-beta/anthropic-ratelimit-* 透传；set-cookie/authorization/x-ratelimit-* 不透传", async () => {
    const model = uniqueModel("hdr-ok");
    await setupProvider("v4r-hdr-ok", model, {
      type: "custom",
      baseUrl: "http://v4r-hdr-ok.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser(`v4r-hdr-ok-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch(() => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-hdr",
          object: "chat.completion",
          created: 1_700_000_000,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "req-fwd-ok",
            "retry-after": "3",
            "anthropic-beta": "safeguards-2026-08-30",
            "anthropic-ratelimit-unified-5m-input-token-remaining": "5000",
            "set-cookie": "upstream_session=leak; Path=/",
            authorization: "Bearer upstream-secret",
            "x-ratelimit-remaining": "5",
          },
        },
      );
    });

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    // 放行（开集四类 + anthropic-* 前缀开集）
    expect(res.headers.get("x-request-id")).toBe("req-fwd-ok");
    expect(res.headers.get("retry-after")).toBe("3");
    expect(res.headers.get("anthropic-beta")).toBe("safeguards-2026-08-30");
    expect(res.headers.get("anthropic-ratelimit-unified-5m-input-token-remaining")).toBe("5000");
    // deny（凭据类 + 前缀拒绝）
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("authorization")).toBeNull();
    // Headers 查名大小写不敏感 ⇒ 前缀拒绝的判别式是「网关自己的值原样在场」：
    // 上游 "5" 既没覆盖也没 append 合并（若透传将是 "5" 或 "5, 59"）
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("59");
    // 网关自有限流头完好（前缀拒绝的意义：上游同名头不覆盖网关承诺）
    expect(res.headers.get("X-RateLimit-Limit")).not.toBeNull();
  });

  it("流式 verbatim：SSE Content-Type 恰为 text/event-stream（上游 content-type 不与之合并复合值）+ 放行头透传", async () => {
    const model = uniqueModel("hdr-sse");
    await setupProvider("v4r-hdr-sse", model, {
      type: "custom",
      baseUrl: "http://v4r-hdr-sse.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
    const userId = await setupUser(`v4r-hdr-sse-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse =
      `data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n` +
      `data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: {"id":"chatcmpl-sse","object":"chat.completion.chunk","created":1700000000,"model":"${model}","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n` +
      `data: [DONE]\n\n`;
    stubUpstreamFetch(() => {
      return new Response(sse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-fwd-sse",
        },
      });
    });

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    expect(res.status).toBe(200);
    // 精确相等断言（合并退化即复合值 "a, b"——must-not 形态）
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("x-request-id")).toBe("req-fwd-sse");
    const text = await res.text();
    expect(text).toContain("data: [DONE]");
  });

  it("convert 零回归：遗留 openai 提供方成功响应不转发任何上游头", async () => {
    const model = uniqueModel("hdr-conv");
    await setupProvider("v4r-hdr-conv", model, {
      type: "openai",
      baseUrl: "http://v4r-hdr-conv.test/v1",
    });
    const userId = await setupUser(`v4r-hdr-conv-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch(() => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-conv",
          object: "chat.completion",
          created: 1_700_000_000,
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "x-request-id": "req-conv-must-not-forward",
            "retry-after": "9",
          },
        },
      );
    });

    const res = await selfFetch("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    // 头行为与改动前逐字段一致：零转发
    expect(res.headers.get("x-request-id")).toBeNull();
    expect(res.headers.get("retry-after")).toBeNull();
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["object"]).toBe("chat.completion");
  });
});
