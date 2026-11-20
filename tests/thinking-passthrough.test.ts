// R1（09-01-thinking-passthrough）：Anthropic 入站顶层 thinking/output_config 透传通道测试。
// 覆盖：anthropicAdapter.buildRequest extras 逐字写回（纯函数）、无 extras 零回归、
// httpOptions.body 覆盖优先级、管道级（anthropic 入站 → anthropic 上游逐字到达 /
// → openai 上游零泄漏）、/v1/messages 统一入口 anthropic 分支透传。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { anthropicAdapter } from "../src/providers/anthropic";
import type { InternalRequest, ProviderConfig } from "../src/providers/types";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-sonnet-test";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 用 canned 上游响应替换全局 fetch（miniflare 内主 worker 与测试同 isolate）。 */
function stubUpstreamFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      handler(String(input), init ?? {}),
    ),
  );
}

/** 注册 anthropic 类型 Provider（mock 上游；模型路由键与 openai mock 隔离）。 */
async function setupAnthropicProviderWithModel(model: string): Promise<number> {
  const db = createDb(env);
  const apiKeyEnc = await encryptSecret("sk-mock", env.GATEWAY_SECRET_KEY);
  const existing = await db.query.providers.findFirst({
    where: eq(providers.name, "mock-anthropic-provider"),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(providers)
      .set({
        type: "anthropic",
        baseUrl: "http://127.0.0.1:1",
        apiKeyEnc,
        models: JSON.stringify({ [model]: model }),
      })
      .where(eq(providers.id, existing.id));
    return existing.id;
  }
  const inserted = await db
    .insert(providers)
    .values({
      name: "mock-anthropic-provider",
      type: "anthropic",
      baseUrl: "http://127.0.0.1:1",
      apiKeyEnc,
      models: JSON.stringify({ [model]: model }),
    })
    .returning({ id: providers.id });
  const row = inserted[0];
  if (!row) {
    throw new Error("failed to insert anthropic test provider");
  }
  return row.id;
}

/** Claude Code 逐请求携带的形态（现代自适应模型）。 */
const ADAPTIVE_EXTRAS = {
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "high" },
};

function makeReq(extras?: InternalRequest["anthropicExtras"]): InternalRequest {
  return {
    kind: "chat",
    body: { model: MODEL, max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
    model: MODEL,
    stream: false,
    anthropicExtras: extras,
  };
}

function makeCfg(httpBody?: Record<string, unknown>): ProviderConfig {
  return {
    type: "anthropic",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "sk-mock",
    models: { [MODEL]: MODEL },
    httpOptions: httpBody ? { body: httpBody } : undefined,
  };
}

function upstreamBody(req: InternalRequest, cfg: ProviderConfig): Record<string, unknown> {
  const upstream = anthropicAdapter.buildRequest(req, cfg);
  return JSON.parse(String(upstream.init.body)) as Record<string, unknown>;
}

// ============ 1. buildRequest extras 写回（纯函数） ============

describe("anthropicAdapter.buildRequest（R1 extras 写回）", () => {
  it("extras → 上游 body 含 thinking/output_config 逐字（adaptive 形态）", () => {
    const body = upstreamBody(makeReq(ADAPTIVE_EXTRAS), makeCfg());
    expect(body["thinking"]).toEqual(ADAPTIVE_EXTRAS.thinking);
    expect(body["output_config"]).toEqual(ADAPTIVE_EXTRAS.output_config);
  });

  it("budget 形态（enabled + budget_tokens）逐字透传（旧模型线）", () => {
    const extras = { thinking: { type: "enabled", budget_tokens: 2048 } };
    const body = upstreamBody(makeReq(extras), makeCfg());
    expect(body["thinking"]).toEqual(extras.thinking);
    expect(body["output_config"]).toBeUndefined();
  });

  it("畸形形态逐字透传（不校验；上游 400 显式暴露）", () => {
    const extras = { output_config: "malformed" };
    const body = upstreamBody(makeReq(extras), makeCfg());
    expect(body["output_config"]).toBe("malformed");
    expect(body["thinking"]).toBeUndefined();
  });

  it("无 extras → 与现状 JSON 逐字节相同（零回归）", () => {
    const body = upstreamBody(makeReq(undefined), makeCfg());
    expect(body["thinking"]).toBeUndefined();
    expect(body["output_config"]).toBeUndefined();
    expect(body).toEqual({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  it("httpOptions.body 显式覆盖优先级高于 extras", () => {
    const body = upstreamBody(makeReq(ADAPTIVE_EXTRAS), makeCfg({ thinking: { type: "disabled" } }));
    expect(body["thinking"]).toEqual({ type: "disabled" });
    // 未被覆盖的 output_config 仍来自 extras
    expect(body["output_config"]).toEqual(ADAPTIVE_EXTRAS.output_config);
  });

  it("分支 3：extras thread/safeguards 逐字写回上游 body", () => {
    const thread = { type: "continue", thread_id: "thr_unit_01" };
    const safeguards = { policies: [{ id: "pol_1" }], mode: "server" };
    const body = upstreamBody(makeReq({ thread, safeguards }), makeCfg());
    expect(body["thread"]).toEqual(thread);
    expect(body["safeguards"]).toEqual(safeguards);
  });

  it("分支 3：anthropicBeta 逐字写入 anthropic-beta 头；httpOptions.headers 覆盖优先", () => {
    const req: InternalRequest = {
      ...makeReq(),
      anthropicBeta: "message-threads-2026-08-12, interleaved-thinking-2025-05-14",
    };
    const base = anthropicAdapter.buildRequest(req, makeCfg());
    expect((base.init.headers as Record<string, string>)["anthropic-beta"]).toBe(
      req.anthropicBeta,
    );
    const overridden = anthropicAdapter.buildRequest(req, {
      ...makeCfg(),
      httpOptions: { headers: { "anthropic-beta": "pinned-beta" } },
    });
    expect((overridden.init.headers as Record<string, string>)["anthropic-beta"]).toBe(
      "pinned-beta",
    );
  });
});

// ============ 2. 管道级：anthropic 入站 → 上游请求体断言 ============

describe("端到端：Anthropic 入站 thinking/output_config 透传", () => {
  const anthropicResponse = {
    id: "msg_01upstream",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "hi from claude" }],
    model: ANTHROPIC_MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  const openAiResponse = {
    id: "chatcmpl-r1",
    object: "chat.completion",
    created: 1_700_000_000,
    model: MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };

  function anthropicBody(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
      ...overrides,
    });
  }

  async function postAnthropic(
    path: string,
    plaintext: string,
    body?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    return selfFetch(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": plaintext,
        ...extraHeaders,
      },
      body: body ?? anthropicBody(),
    });
  }

  it("anthropic 上游：thinking/output_config 逐字到达上游（/anthropic/v1/messages）", async () => {
    const userId = await setupUser("r1-anthro-upstream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    let capturedBody = "";
    stubUpstreamFetch((url, init) => {
      capturedUrl = url;
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      anthropicBody(ADAPTIVE_EXTRAS),
    );
    expect(res.status).toBe(200);
    // 原生 anthropic 上游：直接命中 /v1/messages 路径（providerType 偏好 → anthropic 候选）
    expect(capturedUrl).toMatch(/\/v1\/messages$/);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thinking"]).toEqual(ADAPTIVE_EXTRAS.thinking);
    expect(upstream["output_config"]).toEqual(ADAPTIVE_EXTRAS.output_config);
  });

  it("分支 3：anthropic 上游收到 thread/safeguards 逐字 + anthropic-beta 头", async () => {
    const userId = await setupUser("r1-thread-upstream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    let capturedBeta = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      capturedBeta = new Headers(init.headers).get("anthropic-beta") ?? "";
      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const thread = { type: "continue", thread_id: "thr_unit_01" };
    const safeguards = { policies: [{ id: "pol_1" }], mode: "server" };
    const beta = "message-threads-2026-08-12, interleaved-thinking-2025-05-14";
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      anthropicBody({ thread, safeguards }),
      { "anthropic-beta": beta },
    );
    expect(res.status).toBe(200);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thread"]).toEqual(thread);
    expect(upstream["safeguards"]).toEqual(safeguards);
    expect(capturedBeta).toBe(beta);
  });

  it("openai 上游：extras 零泄漏（上游请求体不含 thinking/output_config）", async () => {
    // 独立模型名隔离：本用例只注册 openai provider 的该模型 → 路由回退命中 openai 适配器
    // （同文件其它用例注册的 anthropic provider 只映射 MODEL，不干扰）
    const openAiModel = "gpt-4o-mini-r1-openai";
    const userId = await setupUser("r1-openai-upstream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(openAiModel);
    await setupPrice(openAiModel, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(openAiResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      anthropicBody({ model: openAiModel, ...ADAPTIVE_EXTRAS }),
    );
    expect(res.status).toBe(200);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thinking"]).toBeUndefined();
    expect(upstream["output_config"]).toBeUndefined();
  });

  it("/v1/messages 统一入口 anthropic 分支（thinking 硬信号）同样透传", async () => {
    const userId = await setupUser("r1-unified@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    let capturedBody = "";
    stubUpstreamFetch((url, init) => {
      capturedUrl = url;
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postAnthropic(
      "/v1/messages",
      plaintext,
      anthropicBody(ADAPTIVE_EXTRAS),
    );
    expect(res.status).toBe(200);
    // thinking 顶层字段 → anthropic 硬信号 → 变体（passthroughAnthropicExtras: true）→ 原生上游
    expect(capturedUrl).toMatch(/\/v1\/messages$/);
    const upstream = JSON.parse(capturedBody) as Record<string, unknown>;
    expect(upstream["thinking"]).toEqual(ADAPTIVE_EXTRAS.thinking);
    expect(upstream["output_config"]).toEqual(ADAPTIVE_EXTRAS.output_config);
  });

  it("流式：thinking 参数 + stream → 上游 thinking SSE → 客户端响应含 thinking_delta（R1 直通链路）", async () => {
    const userId = await setupUser("r1-thinking-stream@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupAnthropicProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const thinkingSse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_01", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_01" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi with thinking" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");

    stubUpstreamFetch(() => {
      return new Response(thinkingSse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      anthropicBody({ thinking: { type: "enabled", budget_tokens: 1024 }, stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    // P2a 直通：thinking 块/事件原样到达客户端（Claude Code 流式续接依赖该序列）
    expect(text).toContain('"type":"thinking"');
    expect(text).toContain("Let me reason");
    expect(text).toContain("signature_delta");
    expect(text).toContain('"type":"message_stop"');
  });
});
