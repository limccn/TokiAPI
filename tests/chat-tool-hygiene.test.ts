// 分支 1：OpenAI Chat 入站工具调用配对卫生（design §1.2 / §2）。
// 纯函数单测 + 路由级端到端（/v1/chat/completions → 上游请求体断言）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  sanitizeResponsesInput,
  sanitizeToolCallPairs,
} from "../src/lib/tool-call-hygiene";
import type { Logger } from "../src/lib/logger";
import {
  applyMigrations,
  clearKv,
  selfFetch,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini-chat-hygiene";
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
const SYNTHETIC = "[tool result unavailable: call interrupted]";

beforeAll(async () => {
  await applyMigrations();
  await clearKv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function captureLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => {},
      warn: (message) => {
        warnings.push(message);
      },
      error: () => {},
    },
  };
}

const CHAT_RESPONSE = {
  id: "chatcmpl-mock",
  object: "chat.completion",
  created: 1_700_000_000,
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

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

async function chatRequest(
  plaintext: string,
  messages: unknown[],
): Promise<Response> {
  return selfFetch("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${plaintext}`,
    },
    body: JSON.stringify({ model: MODEL, messages }),
  });
}

describe("sanitizeToolCallPairs（纯函数）", () => {
  it("孤儿 tool 消息 → 丢弃 + 告警", () => {
    const { logger, warnings } = captureLogger();
    const messages: Array<Record<string, unknown>> = [
      { role: "tool", tool_call_id: "call_orphan", content: "stale" },
      { role: "user", content: "hi" },
    ];
    sanitizeToolCallPairs(messages, logger);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
    expect(warnings).toContain("orphan_tool_message_dropped");
  });

  it("孤儿 tool_calls → 连续 tool 消息块之后注入合成响应 + 告警", () => {
    const { logger, warnings } = captureLogger();
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "user", content: "continue" },
    ];
    sanitizeToolCallPairs(messages, logger);
    expect(messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: SYNTHETIC },
      { role: "user", content: "continue" },
    ]);
    expect(warnings).toContain("orphan_tool_call_synthesized");
  });

  it("完整配对 → 数组顺序与对象引用不变（零回归）", () => {
    const { logger, warnings } = captureLogger();
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "12:00" },
      { role: "user", content: "hi" },
    ];
    const snapshot = [...messages];
    sanitizeToolCallPairs(messages, logger);
    expect(messages).toEqual(snapshot);
    expect(messages[0]).toBe(snapshot[0]);
    expect(warnings).toEqual([]);
  });

  it("空 call_id / 空 output → 确定性重命名并 FIFO 配对", () => {
    const { logger } = captureLogger();
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "existing", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "", type: "function", function: { name: "empty", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "", content: "recovered" },
    ];
    sanitizeToolCallPairs(messages, logger);
    const secondCall = (messages[2]?.["tool_calls"] as Array<Record<string, unknown>>)[0];
    expect(secondCall?.["id"]).toBe("call_2");
    expect(messages[3]?.["tool_call_id"]).toBe("call_2");
  });

  it("重复 tool 消息 → 首个保留，其余丢弃", () => {
    const { logger, warnings } = captureLogger();
    const messages: Array<Record<string, unknown>> = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_dup", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_dup", content: "first" },
      { role: "tool", tool_call_id: "call_dup", content: "second" },
    ];
    sanitizeToolCallPairs(messages, logger);
    expect(messages).toHaveLength(2);
    expect(messages[1]?.["content"]).toBe("first");
    expect(warnings).toContain("orphan_tool_message_dropped");
  });
});

describe("sanitizeResponsesInput（Responses verbatim 面）", () => {
  it("孤儿 function_call → 紧随其后注入合成 function_call_output + 告警", () => {
    const { logger, warnings } = captureLogger();
    const input = [
      {
        type: "function_call",
        call_id: "request_permissions:0",
        name: "request_permissions",
        arguments: "{}",
      },
      { role: "user", content: "continue" },
    ];
    expect(sanitizeResponsesInput(input, logger)).toEqual([
      {
        type: "function_call",
        call_id: "request_permissions:0",
        name: "request_permissions",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "request_permissions:0",
        output: SYNTHETIC,
      },
      { role: "user", content: "continue" },
    ]);
    expect(warnings).toContain("orphan_responses_call_synthesized");
  });

  it("孤儿 output 丢弃；完整配对零改动", () => {
    const { logger, warnings } = captureLogger();
    const input = [
      { type: "function_call", call_id: "call_full", name: "get_time", arguments: "{}" },
      { type: "function_call_output", call_id: "call_full", output: "12:00" },
      { type: "function_call_output", call_id: "call_orphan", output: "stale" },
    ];
    expect(sanitizeResponsesInput(input, logger)).toEqual([
      { type: "function_call", call_id: "call_full", name: "get_time", arguments: "{}" },
      { type: "function_call_output", call_id: "call_full", output: "12:00" },
    ]);
    expect(warnings).toContain("orphan_responses_output_dropped");
  });

  it("空 call_id / 空 output → 确定性重命名并 FIFO 配对", () => {
    const { logger } = captureLogger();
    const input = [
      { type: "function_call", call_id: "", name: "get_time", arguments: "{}" },
      { type: "function_call_output", call_id: "", output: "recovered" },
    ];
    const result = sanitizeResponsesInput(input, logger) as Array<
      Record<string, unknown>
    >;
    expect(result[0]?.["call_id"]).toBe("call_1");
    expect(result[1]?.["call_id"]).toBe("call_1");
    expect(result[1]?.["output"]).toBe("recovered");
  });
});

describe("/v1/chat/completions 入站卫生（路由级）", () => {
  it("孤儿 tool_calls → 上游收到合成 tool 消息", async () => {
    const userId = await setupUser("chat-hygiene-call@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let captured = "";
    stubUpstreamFetch((_url, init) => {
      captured = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await chatRequest(plaintext, [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "user", content: "continue" },
    ]);
    expect(res.status).toBe(200);
    const upstream = JSON.parse(captured) as { messages: Array<Record<string, unknown>> };
    expect(upstream.messages).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: SYNTHETIC },
      { role: "user", content: "continue" },
    ]);
  });

  it("孤儿 tool 消息 → 上游不再收到", async () => {
    const userId = await setupUser("chat-hygiene-tool@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let captured = "";
    stubUpstreamFetch((_url, init) => {
      captured = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await chatRequest(plaintext, [
      { role: "tool", tool_call_id: "call_orphan", content: "stale" },
      { role: "user", content: "hi" },
    ]);
    expect(res.status).toBe(200);
    const upstream = JSON.parse(captured) as { messages: Array<Record<string, unknown>> };
    expect(upstream.messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
