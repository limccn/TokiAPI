// verbatim 保真回归（09-28-upstream-custom-type-passthrough 批次 4，AC8/AC9）。
// 真源：09-07-upstream-adapter-optimization/research/cc-auto-mode-safeguards-findings.md §4.3
// ——「Anthropic → OpenAI → Anthropic 往返，全面有损」清单。批次 4 的 verbatim 非流式路径
// 跳过两级转换（adapter.transformResponse / transformResponseToAnthropic），上表 9 行缺陷
// 全部不可达；本文件把每行钉成**逐项断言**（9 行拆出「多 text 合并」与「citations 丢失」
// 两项 = 10 项），并附**同一夹具的 convert 对照**——convert 路径仍按既有行为有损（零回归
// 红线的同时证明 verbatim 断言的判别力：每条 verbatim 断言都是 convert 实际行为的否定）。
// 另含 AC8 anthropic-version 锁（§5.3：客户端 pin 不透传，两条上游路径各一测）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { consumeBillingBatch, type BillingEvent } from "../src/lib/billing-queue";
import {
  applyMigrations,
  clearKv,
  getBalance,
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
  return `v4f-${prefix}-${modelSeq}`;
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

async function waitForBillingEvent(sent: BillingEvent[]): Promise<BillingEvent> {
  const deadline = Date.now() + 2000;
  while (sent.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const event = sent[0];
  if (event === undefined) {
    throw new Error("billing event was not enqueued within 2s");
  }
  return event;
}

async function consumeCaptured(sent: BillingEvent[]): Promise<void> {
  await consumeBillingBatch(makeBillingBatch(sent), env);
}

/** 全字段 Anthropic 响应夹具（§4.3 每行缺陷的判别值两两不等：thinking 有独立 signature、
 * 两个 text 块文本不同、stop_sequence 非空串、tool_use.input 是**数组**——convert 的
 * parseToolArguments 会把数组打成 {}，普通对象会无损往返而失去判别力）。 */
function fullFieldAnthropic(model: string): Record<string, unknown> {
  return {
    id: "msg_upstream_full_0001",
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "text",
        text: "first part",
        citations: [{ type: "web_search", url: "https://upstream.test/cite-a", title: "Cite A" }],
      },
      { type: "thinking", thinking: "step one reasoning", signature: "sig-abc-123" },
      { type: "redacted_thinking", data: "redacted-blob-base64" },
      { type: "text", text: "second part" },
      { type: "tool_use", id: "toolu_upstream_01", name: "get_weather", input: ["a", 1, true] },
    ],
    stop_reason: "stop_sequence",
    stop_sequence: "STOP_STRING_V4",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 42,
      cache_creation_input_tokens: 7,
    },
    safeguard_results: { checks: ["rule-a", "rule-b"], verdict: "allowed" },
    container: "ctr_full_0001",
    service_tier: "standard",
    context_management: { edits: [] },
  };
}

/** 夹具 → 上游原始串（手工拼接 + 双空格分隔：重序列化即被归一 ⇒ 字节全等断言有判别力）。 */
function rawFullField(model: string): string {
  return (
    `{"id":"msg_upstream_full_0001",  "type":"message",  "role":"assistant",` +
    `  "model":"${model}",` +
    `  "content":[{"type":"text","text":"first part",` +
    `"citations":[{"type":"web_search","url":"https://upstream.test/cite-a","title":"Cite A"}]},` +
    `{"type":"thinking","thinking":"step one reasoning","signature":"sig-abc-123"},` +
    `{"type":"redacted_thinking","data":"redacted-blob-base64"},` +
    `{"type":"text","text":"second part"},` +
    `{"type":"tool_use","id":"toolu_upstream_01","name":"get_weather","input":["a",1,true]}],` +
    `  "stop_reason":"stop_sequence",  "stop_sequence":"STOP_STRING_V4",` +
    `  "usage":{"input_tokens":100,"output_tokens":50,` +
    `"cache_read_input_tokens":42,"cache_creation_input_tokens":7},` +
    `  "safeguard_results":{"checks":["rule-a","rule-b"],"verdict":"allowed"},` +
    `  "container":"ctr_full_0001",  "service_tier":"standard",` +
    `  "context_management":{"edits":[]}}`
  );
}

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await clearKv();
});

// ============ AC9：十项保真（①-⑨ 成功路径逐项 + 字节全等 + 计费同源） ============
describe("AC9 十项保真：verbatim 非流式 anthropic 面逐项原样（§4.3 缺陷清单全部不可达）", () => {
  const model = uniqueModel("fidelity");
  let raw = "";
  let clientText = "";
  let body: Record<string, unknown>;
  let event: BillingEvent;
  let fidelityUserId = 0;

  beforeAll(async () => {
    await setupProvider("v4f-fidelity", model, {
      type: "custom",
      baseUrl: "http://v4f-fidelity.test",
      protocols: JSON.stringify({ messages: {} }),
    });
    fidelityUserId = await setupUser(`v4f-fidelity-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(fidelityUserId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    raw = rawFullField(model);
    stubUpstreamFetch(() => {
      return new Response(raw, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const billing = captureBillingQueue();
    let res: Response;
    try {
      res = await selfFetch("http://localhost/anthropic/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({
          model,
          max_tokens: 128,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(200);
      clientText = await res.text();
      event = await waitForBillingEvent(billing.sent);
      await consumeCaptured(billing.sent);
    } finally {
      billing.restore();
    }
    body = JSON.parse(clientText) as Record<string, unknown>;
  });

  it("字节全等：客户端收到上游原始字节（不重序列化；双空格分隔未被归一）", () => {
    expect(clientText).toBe(raw);
  });

  it("① id 不重写：上游 msg_ id 原样到达（convert 会重写为 msg_<uuid 去连字符>）", () => {
    expect(body["id"]).toBe("msg_upstream_full_0001");
  });

  it("② stop_sequence 不恒 null：命中的停止串原样（convert 恒 null）", () => {
    expect(body["stop_sequence"]).toBe("STOP_STRING_V4");
  });

  it("③ stop_reason 不塌缩：上游 stop_sequence 原样（convert 经 OpenAI finish_reason 往返成 end_turn）", () => {
    expect(body["stop_reason"]).toBe("stop_sequence");
  });

  it("④ thinking/redacted_thinking 块与 signature 不丢（convert 只处理 text/tool_use）", () => {
    const content = body["content"] as Array<Record<string, unknown>>;
    const thinking = content.find((b) => b["type"] === "thinking");
    expect(thinking).toEqual({
      type: "thinking",
      thinking: "step one reasoning",
      signature: "sig-abc-123",
    });
    expect(content.find((b) => b["type"] === "redacted_thinking")).toEqual({
      type: "redacted_thinking",
      data: "redacted-blob-base64",
    });
  });

  it("⑤ cache token 不丢：cache_read/cache_creation 原样（convert 只写 input/output 三字段）", () => {
    expect(body["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 42,
      cache_creation_input_tokens: 7,
    });
  });

  it("⑥ 多 text 块不合并：两个 text 块文本各自原样（convert 无分隔符拼接成一个块）", () => {
    const content = body["content"] as Array<Record<string, unknown>>;
    const texts = content.filter((b) => b["type"] === "text");
    expect(texts).toHaveLength(2);
    expect(texts[0]?.["text"]).toBe("first part");
    expect(texts[1]?.["text"]).toBe("second part");
  });

  it("⑦ citations 不丢：text 块的引用数组原样（convert 丢弃）", () => {
    const content = body["content"] as Array<Record<string, unknown>>;
    const first = content.find((b) => b["type"] === "text");
    expect(first?.["citations"]).toEqual([
      { type: "web_search", url: "https://upstream.test/cite-a", title: "Cite A" },
    ]);
  });

  it("⑧ tool_use.input 不往返成 {}：数组输入原样（convert 经 stringify→parseToolArguments 打成 {}）", () => {
    const content = body["content"] as Array<Record<string, unknown>>;
    const toolUse = content.find((b) => b["type"] === "tool_use");
    expect(toolUse?.["input"]).toEqual(["a", 1, true]);
    expect(toolUse?.["id"]).toBe("toolu_upstream_01");
    expect(toolUse?.["name"]).toBe("get_weather");
  });

  it("⑨ 未知顶层键不丢：safeguard_results/container/service_tier/context_management 原样", () => {
    expect(body["safeguard_results"]).toEqual({ checks: ["rule-a", "rule-b"], verdict: "allowed" });
    expect(body["container"]).toBe("ctr_full_0001");
    expect(body["service_tier"]).toBe("standard");
    expect(body["context_management"]).toEqual({ edits: [] });
  });

  it("计费同源：usage 提取自原始体（100/50），余额按价表扣减", async () => {
    expect(event.promptTokens).toBe(100);
    expect(event.completionTokens).toBe(50);
    // 夹具带 cache_read=42（保真项⑤的判别值）⇒ 期望费用按真实结算公式分档：
    // (cached×缓存价 + 非缓存输入×输入价 + 输出×输出价)/1e6 = (42×0.0375+58×0.15+50×0.6)/1e6
    const cached = 42;
    const expectedCost =
      (cached * (INPUT_PRICE / 4) +
        (100 - cached) * INPUT_PRICE +
        50 * OUTPUT_PRICE) /
      1e6;
    expect(await getBalance(fidelityUserId)).toBeCloseTo(10 - expectedCost, 10);
  });
});

// ============ convert 对照：同一夹具经遗留 anthropic 面往返 ⇒ 逐项有损（判别力 + 零回归锁） ============
describe("convert 对照：同一夹具走遗留 anthropic 面，十项逐一有损（既有行为原样，零回归）", () => {
  it("id 重写 / stop_sequence null / stop_reason 塌缩 / thinking 丢 / text 合并 / citations 丢 / input={} / cache token 丢 / 未知键丢", async () => {
    const model = uniqueModel("convert");
    await setupProvider("v4f-convert", model, {
      type: "anthropic",
      baseUrl: "http://v4f-convert.test",
    });
    const userId = await setupUser(`v4f-convert-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    stubUpstreamFetch(() => {
      return new Response(JSON.stringify(fullFieldAnthropic(model)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model,
        max_tokens: 128,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    // ① id 透传上游真值（分支 3 起：message threads 的 previous_message_id 依赖真实 id；
    //    convert 的判别力由下方字段重建/丢弃承担）
    expect(body["id"]).toBe("msg_upstream_full_0001");
    // ② stop_sequence 恒 null
    expect(body["stop_sequence"]).toBeNull();
    // ③ stop_reason 塌缩：上游 stop_sequence → OpenAI stop → 回 end_turn
    expect(body["stop_reason"]).toBe("end_turn");
    // ④ thinking/redacted_thinking 全丢（连空壳都没有）
    const content = body["content"] as Array<Record<string, unknown>>;
    expect(content.some((b) => b["type"] === "thinking")).toBe(false);
    expect(content.some((b) => b["type"] === "redacted_thinking")).toBe(false);
    // ⑥ 多 text 块合并成一个（无分隔符拼接）
    const texts = content.filter((b) => b["type"] === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.["text"]).toBe("first partsecond part");
    // ⑦ citations 丢失
    expect(texts[0]?.["citations"]).toBeUndefined();
    // ⑧ tool_use.input 往返成 {}（数组被 parseToolArguments 拒绝）
    const toolUse = content.find((b) => b["type"] === "tool_use");
    expect(toolUse?.["input"]).toEqual({});
    // ⑤ cache token 丢失（usage 只剩 input/output）
    expect(body["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });
    // ⑨ 未列入透传通道的顶层键全丢；safeguard_results 为分支 3 已知透传（逐字回写）
    expect(body["safeguard_results"]).toEqual({
      checks: ["rule-a", "rule-b"],
      verdict: "allowed",
    });
    expect(body["container"]).toBeUndefined();
    expect(body["service_tier"]).toBeUndefined();
    expect(body["context_management"]).toBeUndefined();
  });
});

// ============ 十项之⑩（§4.3 第 9 行）：错误体逐字 —— 上游自有 error.type 不被状态码重算 ============
describe("AC9 之⑩：verbatim 错误体逐字，上游 error.type 原样（convert 按 HTTP 状态重算）", () => {
  it("上游 400 anthropic 形态错误体原样到达：type/message 双保留 + 字节全等", async () => {
    const model = uniqueModel("errtype");
    await setupProvider("v4f-errtype", model, {
      type: "custom",
      baseUrl: "http://v4f-errtype.test",
      protocols: JSON.stringify({ messages: {} }),
    });
    const userId = await setupUser(`v4f-errtype-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    // 上游自有错误 type（非任何 HTTP 状态映射产物）：逐字语义下必须原样到达
    const rawError =
      `{"type":"error",  "error":{"type":"upstream_flavor_error",` +
      `  "message":"flavor-specific wording XYZ"}}`;
    stubUpstreamFetch(() => {
      return new Response(rawError, {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${plaintext}` },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    // 字节全等 + type 不被重算（convert 会按状态 400 重算成 invalid_request_error）
    const text = await res.text();
    expect(text).toBe(rawError);
    const parsed = JSON.parse(text) as { error: { type: string; message: string } };
    expect(parsed.error.type).toBe("upstream_flavor_error");
    expect(parsed.error.message).toBe("flavor-specific wording XYZ");
  });
});

// ============ AC8：anthropic-version 版本锁（客户端 pin 不透传，两条上游路径各一测） ============
describe("AC8 anthropic-version 锁：客户端自定义 pin ⇒ 上游仍收固定 2023-06-01", () => {
  it("convert 路径（遗留 anthropic 面）：pin 被丢弃，上游收 2023-06-01", async () => {
    const model = uniqueModel("lock-conv");
    await setupProvider("v4f-lock-conv", model, {
      type: "anthropic",
      baseUrl: "http://v4f-lock-conv.test",
    });
    const userId = await setupUser(`v4f-lock-conv-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch(() => {
      return new Response(JSON.stringify(fullFieldAnthropic(model)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintext}`,
        // 客户端自定义 pin（≠ 网关固定值）：必须不透传（§5.3 有意取舍，防被当 bug「修」掉）
        "anthropic-version": "2023-01-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    const headers = call.init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("verbatim 路径（custom messages 面）：pin 同样不透传，上游收 2023-06-01", async () => {
    const model = uniqueModel("lock-verb");
    await setupProvider("v4f-lock-verb", model, {
      type: "custom",
      baseUrl: "http://v4f-lock-verb.test",
      protocols: JSON.stringify({ messages: {} }),
    });
    const userId = await setupUser(`v4f-lock-verb-${modelSeq}@test.dev`, 10);
    const { plaintext } = await setupKey(userId);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const calls = stubUpstreamFetch(() => {
      return new Response(rawFullField(model), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintext}`,
        "anthropic-version": "2023-01-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) {
      throw new Error("upstream was not called");
    }
    const headers = call.init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });
});
