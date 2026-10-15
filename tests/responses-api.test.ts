// OpenAI Responses API 适配测试（R1-R9 / D1-D8 / AC1-AC8）：纯函数转换单测 + 端到端（selfFetch）。
// 覆盖：buildInternalFromResponses（入站映射 + 拒绝 previous_response_id/conversation + 降级）、
// transformResponseToResponses（非流式全字段 + finish_reason 状态映射矩阵）、
// transformStreamToResponses（逐事件序列：无 [DONE]、sequence_number 递增、结构字段齐全、
// completed 含 usage、异常兜底 failed/error）、端到端（openai + anthropic 两类上游，非流式/流式）、
// 错误码（401/404/402/429/502/400，OpenAI 形态错误体）、流式结算、缓存（responses: 前缀隔离）。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { AdapterError } from "../src/providers/types";
import {
  assertStatelessResponsesBody,
  buildInternalFromResponses,
  transformResponseToResponses,
  transformStreamToResponses,
} from "../src/providers/responses";
import { createDb } from "../src/db";
import { providers } from "../src/db/schema";
import { encryptSecret } from "../src/lib/security";
import { buildCacheKey, hashRequestBody } from "../src/lib/response-cache";
import {
  applyMigrations,
  clearKv,
  countTxByType,
  getBalance,
  latestLogStatus,
  selfFetch,
  settleDelayedBilling,
  setupKey,
  setupPrice,
  setupProviderWithModel,
  setupUser,
} from "./helpers";

const MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-sonnet-test";
/** 测试价格（与 proxy-pipeline.test.ts 同口径）：输入 0.15/M、输出 0.6/M。 */
const INPUT_PRICE = 0.15;
const OUTPUT_PRICE = 0.6;
const EXPECTED_COST = (100 * INPUT_PRICE + 50 * OUTPUT_PRICE) / 1e6;

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

function responsesBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: MODEL,
    input: "hello",
    ...overrides,
  });
}

async function postResponses(
  plaintext: string,
  body?: string,
): Promise<Response> {
  return selfFetch("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${plaintext}`,
    },
    body: body ?? responsesBody(),
  });
}

/** OpenAI chat.completion 上游响应（含 usage）。 */
const CHAT_RESPONSE = {
  id: "chatcmpl-responses-api",
  object: "chat.completion",
  created: 1_700_000_000,
  model: MODEL,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "hi there" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
};

/** Anthropic message 上游响应（正向适配器回译路径）。 */
const ANTHROPIC_UPSTREAM_RESPONSE = {
  id: "msg_01upstream",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi from claude" }],
  model: ANTHROPIC_MODEL,
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50 },
};

/** 组装 SSE 字节流（OpenAI chat 形态，纯 data: 行 + [DONE]）。 */
function sseStream(sse: string): ReadableStream<Uint8Array> {
  const body = new Response(sse).body;
  if (body === null) {
    throw new Error("test response body is null");
  }
  return body;
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

/** 解析 Responses SSE 输出（纯 data: JSON 帧）为事件对象列表（断言用）。 */
function parseResponsesEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.trim().split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    events.push(JSON.parse(dataLines.join("\n")) as Record<string, unknown>);
  }
  return events;
}

// ============ 1. buildInternalFromResponses（入站 Responses → 内部 chat 形态） ============

describe("buildInternalFromResponses（入站映射）", () => {
  it("input 字符串简写 → 单条 user 消息", () => {
    const result = buildInternalFromResponses({ model: MODEL, input: "hello" });
    expect(result).toEqual({
      model: MODEL,
      messages: [{ role: "user", content: "hello" }],
    });
  });

  it("message items（user/assistant/developer）→ 对应 role 消息；input_text 多块拼接为字符串", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { role: "user", content: [{ type: "input_text", text: "What is" }] },
        {
          role: "user",
          content: [{ type: "input_text", text: " this?" }],
        },
        { role: "assistant", content: "hi" },
        { role: "developer", content: "be brief" },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "user", content: "What is" },
      { role: "user", content: " this?" },
      { role: "assistant", content: "hi" },
      { role: "system", content: "be brief" },
    ]);
  });

  it("input_text + input_image → parts 数组（image_url data URL 形态）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this?" },
            { type: "input_image", image_url: "data:image/png;base64,iVBORw0KGgo=" },
          ],
        },
      ],
    });
    expect(result["messages"]).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
        ],
      },
    ]);
  });

  it("function_call item → assistant tool_calls；连续多个合并为一条 assistant 消息", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"shanghai"}' },
        { type: "function_call", call_id: "call_2", name: "get_time", arguments: "{}" },
      ],
    });
    expect(result["messages"]).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"shanghai"}' } },
          { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
    ]);
  });

  it("function_call_output item → tool 消息；output 数组 → JSON.stringify", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "function_call_output", call_id: "call_1", output: "42" },
        { type: "function_call_output", call_id: "call_2", output: [{ type: "output_text", text: "a" }] },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "42" },
      { role: "tool", tool_call_id: "call_2", content: '[{"type":"output_text","text":"a"}]' },
    ]);
  });

  it("reasoning item → 丢弃（不进 messages）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("未知 input item 类型 → AdapterError", () => {
    expect(() =>
      buildInternalFromResponses({
        model: MODEL,
        input: [{ type: "computer_call", name: "open_app" }],
      }),
    ).toThrow(AdapterError);
  });

  // ===== Workstream A：Responses Lite 输入项面（namespace 平面化 / tool_search 降级 / client_metadata） =====

  it("additional_tools functions 命名空间 → 平面化提取 function 叶子进 tools（carrier 不产生消息）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                {
                  type: "function",
                  name: "exec",
                  description: "run code",
                  parameters: { type: "object", properties: {} },
                },
                {
                  type: "function",
                  name: "lookup",
                  description: "lookup",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
        { role: "user", content: "hi" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
    const tools = result["tools"] as Array<{ type: string; function: { name: string } }>;
    expect(tools.map((t) => t["function"]["name"])).toEqual(["exec", "lookup"]);
  });

  it("非 functions 命名空间（web / tool_search / collaboration）→ 原样传递 → buildTools 丢弃、tools 不输出", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            { type: "namespace", name: "web", tools: [{ type: "web_search", name: "web" }] },
            { type: "namespace", name: "tool_search", tools: [{ type: "tool_search", name: "search" }] },
            { type: "namespace", name: "collaboration", tools: [{ type: "function", name: "slack_post" }] },
          ],
        },
        { role: "user", content: "hi" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(result["tools"]).toBeUndefined();
  });

  it("functions 命名空间递归嵌套 → 提取最深层 function 叶子", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                {
                  type: "namespace",
                  name: "inner",
                  tools: [
                    { type: "function", name: "deep_fn", parameters: { type: "object", properties: {} } },
                  ],
                },
                { type: "function", name: "top_fn", parameters: { type: "object", properties: {} } },
              ],
            },
          ],
        },
        { role: "user", content: "hi" },
      ],
    });
    const tools = result["tools"] as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t["function"]["name"])).toEqual(["deep_fn", "top_fn"]);
  });

  it("functions 命名空间叶子与顶层 tools 重名 → 顶层优先（按名去重）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [
                {
                  type: "function",
                  name: "get_weather",
                  description: "from namespace",
                  parameters: { type: "object", properties: {} },
                },
              ],
            },
          ],
        },
        { role: "user", content: "hi" },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "from top-level",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const tools = result["tools"] as Array<{ function: { name: string; description?: string } }>;
    expect(tools.map((t) => t["function"]["name"])).toEqual(["get_weather"]);
    expect(tools[0]?.["function"]["description"]).toBe("from top-level");
  });

  it("tool_search_call / tool_search_output 输入项 → 识别 + 丢弃（不再 400）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "tool_search_call", id: "tsc_1", name: "search", arguments: { query: "x" } },
        { type: "tool_search_output", id: "tso_1", tools: [{ type: "function", name: "found" }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("web_search_call 等 8 类服务端执行 item → 识别 + 丢弃（不再 400）", () => {
    // 白名单逐类型验证：无 Chat 对应物且无 call_id 配对，丢弃不产生孤儿 tool 消息；
    // web_search_call 用 Codex 真实重放形态（action 字段），其余类型最小形态即可
    const replayShapes: Record<string, Record<string, unknown>> = {
      web_search_call: {
        type: "web_search_call",
        id: "ws_1",
        status: "completed",
        action: { type: "search", query: "OpenAI Responses API" },
      },
    };
    for (const type of [
      "web_search_call",
      "file_search_call",
      "code_interpreter_call",
      "image_generation_call",
      "mcp_call",
      "mcp_list_tools",
      "mcp_approval_request",
      "mcp_approval_response",
    ]) {
      const result = buildInternalFromResponses({
        model: MODEL,
        input: [replayShapes[type] ?? { type }, { role: "user", content: "hi" }],
      });
      expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
    }
  });

  it("custom_tool_call / custom_tool_call_output → call_id 配对类型保持 400（fail-closed）", () => {
    // 配对类型成对降级需专门设计（孤儿 tool 消息风险）；computer_call 未知类型钉子已有，勿动
    expect(() =>
      buildInternalFromResponses({
        model: MODEL,
        input: [{ type: "custom_tool_call", call_id: "call_1", name: "run", input: "x" }],
      }),
    ).toThrow(AdapterError);
    expect(() =>
      buildInternalFromResponses({
        model: MODEL,
        input: [{ type: "custom_tool_call_output", call_id: "call_1", output: "x" }],
      }),
    ).toThrow(AdapterError);
  });

  it("[reasoning, web_search_call, assistant] → pending reasoning 在 dropped item 处一并丢弃", () => {
    // 与 tool_search 先例一致：pending reasoning 不跨越 dropped item 挂给后续 assistant
    // （reasoning 只挂 assistant 消息，不做保真增强）
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] },
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "OpenAI Responses API" },
        },
        { role: "assistant", content: "answer" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "assistant", content: "answer" }]);
    const messages = result["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("client_metadata 顶层字段 → 丢弃（不进内部形态）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      client_metadata: { turn_id: "turn_1" },
    });
    expect(result["client_metadata"]).toBeUndefined();
  });

  // ===== Workstream B：reasoning 输入项回传（thinking round-trip） =====

  it("reasoning + 下一条 assistant message → 消息附 reasoning_content（summary_text 提取）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking out loud" }] },
        { role: "assistant", content: "answer" },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "assistant", content: "answer", reasoning_content: "thinking out loud" },
    ]);
  });

  it("reasoning + function_call → tool_calls 消息附 reasoning_content；连续 function_call 合并幂等", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "planning" }] },
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
        { type: "function_call", call_id: "call_2", name: "get_time", arguments: "{}" },
      ],
    });
    expect(result["messages"]).toEqual([
      {
        role: "assistant",
        content: null,
        reasoning_content: "planning",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "get_time", arguments: "{}" } },
        ],
      },
    ]);
  });

  it("reasoning raw string 兜底（无 summary）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", raw: "raw thinking" },
        { role: "assistant", content: "answer" },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "assistant", content: "answer", reasoning_content: "raw thinking" },
    ]);
  });

  it("reasoning 后跟 user 消息 → pending 丢弃（user 消息无 reasoning_content）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] },
        { role: "user", content: "hi" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("reasoning 位于 input 尾部（无下一条 assistant）→ 丢弃", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "orphan" }] }],
    });
    expect(result["messages"]).toEqual([]);
  });

  it("reasoning summary 无文本 → 丢弃 + 不挂载", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        { type: "reasoning", id: "rs_1", summary: [] },
        { role: "assistant", content: "answer" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "assistant", content: "answer" }]);
  });

  it("additional_tools item（Codex Responses Lite）→ 工具 hoist 进 tools，carrier 不产生消息", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          type: "additional_tools",
          id: "at_1",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "get_weather",
              description: "weather lookup",
              parameters: { type: "object", properties: { city: { type: "string" } } },
              strict: true,
            },
          ],
        },
        { role: "user", content: "hi" },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "user", content: "hi" }]);
    expect(result["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
      },
    ]);
  });

  it("additional_tools 与顶层 tools 并存 → 按函数名去重（顶层优先）", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: [
        {
          type: "additional_tools",
          role: "developer",
          tools: [
            {
              type: "function",
              name: "get_weather",
              description: "from additional_tools",
              parameters: { type: "object", properties: {} },
            },
            {
              type: "function",
              name: "get_time",
              description: "from additional_tools",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        { role: "user", content: "hi" },
      ],
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "from top-level",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    const tools = result["tools"] as Array<{
      type: string;
      function: { name: string; description?: string; parameters: object };
    }>;
    expect(tools.map((t) => t["function"]["name"])).toEqual(["get_weather", "get_time"]);
    expect(tools[0]?.["function"]["description"]).toBe("from top-level");
    expect(tools[1]?.["function"]["description"]).toBe("from additional_tools");
  });

  it("instructions → 顶部 system 消息", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      instructions: "Be brief.",
      input: "hello",
    });
    expect(result["messages"]).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ]);
  });

  it("max_output_tokens → max_completion_tokens；temperature/top_p/parallel_tool_calls/stream 直通", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      max_output_tokens: 128,
      temperature: 0.5,
      top_p: 0.9,
      parallel_tool_calls: false,
      stream: true,
    });
    expect(result["max_completion_tokens"]).toBe(128);
    expect(result["temperature"]).toBe(0.5);
    expect(result["top_p"]).toBe(0.9);
    expect(result["parallel_tool_calls"]).toBe(false);
    expect(result["stream"]).toBe(true);
  });

  it("tools（扁平）→ function 嵌套；strict 挪入 function.strict；非 function 工具丢弃", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      tools: [
        {
          type: "function",
          name: "get_weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
        { type: "web_search_preview", search_context_size: "medium" },
      ],
    });
    expect(result["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
          strict: true,
        },
      },
    ]);
  });

  it("tool_choice：字符串直通；{type:function} → 嵌套", () => {
    const tools = [
      { type: "function", name: "f", parameters: { type: "object", properties: {} } },
    ];
    const base = { model: MODEL, input: "hi", tools };
    expect(buildInternalFromResponses({ ...base, tool_choice: "auto" })["tool_choice"]).toBe("auto");
    expect(buildInternalFromResponses({ ...base, tool_choice: "none" })["tool_choice"]).toBe("none");
    expect(buildInternalFromResponses({ ...base, tool_choice: "required" })["tool_choice"]).toBe("required");
    expect(buildInternalFromResponses({ ...base, tool_choice: { type: "function", name: "f" } })["tool_choice"]).toEqual({
      type: "function",
      function: { name: "f" },
    });
  });

  it("tool_choice 降级：required 无工具 → auto；函数不在工具列表 → auto；custom → auto", () => {
    const base = { model: MODEL, input: "hi" };
    expect(buildInternalFromResponses({ ...base, tool_choice: "required" })["tool_choice"]).toBe("auto");
    expect(
      buildInternalFromResponses({
        ...base,
        tools: [{ type: "function", name: "f", parameters: {} }],
        tool_choice: { type: "function", name: "missing" },
      })["tool_choice"],
    ).toBe("auto");
    expect(buildInternalFromResponses({ ...base, tool_choice: { type: "custom", name: "x" } })["tool_choice"]).toBe("auto");
  });

  it("text.format json_schema / json_object → response_format", () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const jsonSchemaResult = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      text: { format: { type: "json_schema", name: "resp", schema, strict: true } },
    });
    expect(jsonSchemaResult["response_format"]).toEqual({
      type: "json_schema",
      json_schema: { name: "resp", schema, strict: true },
    });
    const jsonObjectResult = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      text: { format: { type: "json_object" } },
    });
    expect(jsonObjectResult["response_format"]).toEqual({ type: "json_object" });
  });

  it("reasoning.effort → reasoning_effort；top_logprobs → logprobs:true 配合", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      reasoning: { effort: "high", summary: "concise" },
      top_logprobs: 3,
    });
    expect(result["reasoning_effort"]).toBe("high");
    expect(result["logprobs"]).toBe(true);
    expect(result["top_logprobs"]).toBe(3);
  });

  it("拒绝：previous_response_id → AdapterError（提示无状态 input items 用法）", () => {
    expect(() =>
      buildInternalFromResponses({
        model: MODEL,
        input: "hi",
        previous_response_id: "resp_123",
      }),
    ).toThrow(AdapterError);
    expect(() =>
      buildInternalFromResponses({ model: MODEL, input: "hi", conversation: "conv_1" }),
    ).toThrow(AdapterError);
  });

  it("assertStatelessResponsesBody：两字段各自抛出、文案逐字节精确；干净体（含未知字段）不抛（批次 9 前置，边界 C）", () => {
    // 文案逐字节精确：toThrow(new AdapterError(...)) 断言 message **相等**（非子串）
    expect(() =>
      assertStatelessResponsesBody({ input: "hi", previous_response_id: "resp_prev-x" }),
    ).toThrow(
      new AdapterError(
        "previous_response_id is not supported by this gateway; include the full input items in each request (stateless mode)",
      ),
    );
    expect(() =>
      assertStatelessResponsesBody({ input: "hi", conversation: "conv-x" }),
    ).toThrow(
      new AdapterError(
        "conversation is not supported by this gateway; include the full input items in each request (stateless mode)",
      ),
    );
    // 类钉：proxy 候选循环的 catch 与 toInternalSafe 都靠 instanceof AdapterError 归一 400
    // （verbatimRequest 的显式执行走前者）——类丢了 = 400 语义丢失，必须单独钉
    expect(() => assertStatelessResponsesBody({ conversation: "conv-x" })).toThrow(AdapterError);
    // 干净体（未知字段 + 随机标记值 ≠ 任何已知常量）→ 不抛：红线只看两字段，开集字段不拦
    const marker = `rnd-${crypto.randomUUID()}`;
    expect(() =>
      assertStatelessResponsesBody({ input: "hi", vendor_stateless_probe: marker }),
    ).not.toThrow();
  });

  it("平台专属字段（store/metadata/include 等）丢弃，不进内部形态", () => {
    const result = buildInternalFromResponses({
      model: MODEL,
      input: "hi",
      store: true,
      metadata: { user_id: "u1" },
      include: ["message.output_text.logprobs"],
      service_tier: "auto",
      background: false,
      moderation: { model: "omni-moderation-latest" },
    });
    expect(result["store"]).toBeUndefined();
    expect(result["metadata"]).toBeUndefined();
    expect(result["include"]).toBeUndefined();
    expect(result["service_tier"]).toBeUndefined();
    expect(result["background"]).toBeUndefined();
    expect(result["moderation"]).toBeUndefined();
  });

  it("message item 非法 role → AdapterError", () => {
    expect(() =>
      buildInternalFromResponses({
        model: MODEL,
        input: [{ role: "tool", content: "hi" }],
      }),
    ).toThrow(AdapterError);
  });
});

// ============ 2. transformResponseToResponses（内部 chat 响应 → Responses response） ============

describe("transformResponseToResponses（非流式出站）", () => {
  it("文本响应全字段：resp_ id / object / status / output message item / output_text / usage 换算", () => {
    const result = transformResponseToResponses(CHAT_RESPONSE, MODEL) as Record<string, unknown>;
    expect(String(result["id"])).toMatch(/^resp_/);
    expect(result["object"]).toBe("response");
    expect(typeof result["created_at"]).toBe("number");
    expect(result["status"]).toBe("completed");
    expect(result["model"]).toBe(MODEL);
    expect(result["output_text"]).toBe("hi there");
    expect(result["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    const output = result["output"] as Array<Record<string, unknown>>;
    expect(output[0]).toMatchObject({
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "hi there", annotations: [] }],
    });
    expect(String(output[0]?.["id"])).toMatch(/^msg_/);
  });

  it("finish_reason → status / incomplete_details 映射矩阵", () => {
    const base = { id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [] };
    const cases: Array<[string | null, string, Record<string, unknown> | undefined]> = [
      ["stop", "completed", undefined],
      ["tool_calls", "completed", undefined],
      ["length", "incomplete", { reason: "max_output_tokens" }],
      ["content_filter", "incomplete", { reason: "content_filter" }],
      [null, "completed", undefined],
    ];
    for (const [finish, status, incompleteDetails] of cases) {
      const result = transformResponseToResponses({
        ...base,
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: finish }],
      }) as Record<string, unknown>;
      expect(result["status"]).toBe(status);
      if (incompleteDetails !== undefined) {
        expect(result["incomplete_details"]).toEqual(incompleteDetails);
      } else {
        expect(result["incomplete_details"]).toBeUndefined();
      }
      // item 级 status 与 response 级同步（OR §1.2）：截断 → message item incomplete
      const output = result["output"] as Array<Record<string, unknown>>;
      expect(output[0]?.["status"]).toBe(status === "completed" ? "completed" : "incomplete");
    }
  });

  it("refusal → completed + refusal content 块（SDK 不崩溃口径）", () => {
    const result = transformResponseToResponses({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, refusal: "I can't help with that" },
          finish_reason: "refusal",
        },
      ],
    }) as Record<string, unknown>;
    expect(result["status"]).toBe("completed");
    const output = result["output"] as Array<Record<string, unknown>>;
    expect((output[0]?.["content"] as Array<Record<string, unknown>>)?.[0]).toEqual({
      type: "refusal",
      refusal: "I can't help with that",
    });
  });

  it("tool_calls → function_call items（id/call_id 同源）", () => {
    const result = transformResponseToResponses({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "calling",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":"shanghai"}' },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    }) as Record<string, unknown>;
    const output = result["output"] as Array<Record<string, unknown>>;
    expect(output[1]).toEqual({
      type: "function_call",
      id: "call_1",
      call_id: "call_1",
      name: "get_weather",
      arguments: '{"city":"shanghai"}',
      status: "completed",
    });
    expect(result["status"]).toBe("completed");
  });

  it("usage details 透传：cached_tokens / reasoning_tokens 对应字段；output_tokens 不重复加 reasoning", () => {
    const result = transformResponseToResponses({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    }) as Record<string, unknown>;
    expect(result["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 20 },
      output_tokens_details: { reasoning_tokens: 30 },
    });
  });

  it("usage 缺失 → 不输出 usage（免计路径）；model 回退上游 model", () => {
    const result = transformResponseToResponses({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: "upstream-model",
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    }) as Record<string, unknown>;
    expect(result["usage"]).toBeUndefined();
    expect(result["model"]).toBe("upstream-model");
    expect(result["output_text"]).toBe("");
  });
});

// ============ 3. transformStreamToResponses（上游 OpenAI chat SSE → Responses SSE） ============

describe("transformStreamToResponses（流式出站）", () => {
  const CHUNK_BASE =
    '{"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini"';

  function openaiChunk(payload: string): string {
    return `data: ${CHUNK_BASE},"choices":${payload}}`;
  }

  it("文本流：created → in_progress → 文本事件系列 → completed（usage 换算并入）；无 [DONE]；sequence_number 递增", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      openaiChunk('[]').replace('"choices":[]', '"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToResponses(sseStream(sse)));
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("event:");
    const events = parseResponsesEvents(text);
    expect(events.map((e) => e["type"])).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);

    // sequence_number 单调递增（从 0 开始）
    events.forEach((event, index) => {
      expect(event["sequence_number"]).toBe(index);
    });

    const created = events[0] as Record<string, unknown>;
    const createdResponse = created["response"] as Record<string, unknown>;
    expect(String(createdResponse["id"])).toMatch(/^resp_/);
    expect(createdResponse["object"]).toBe("response");
    expect(createdResponse["status"]).toBe("in_progress");
    expect(createdResponse["model"]).toBe("gpt-4o-mini");
    expect(createdResponse["output"]).toEqual([]);

    const itemAdded = events[2] as Record<string, unknown>;
    expect(itemAdded["output_index"]).toBe(0);
    const item = itemAdded["item"] as Record<string, unknown>;
    expect(String(item["id"])).toMatch(/^msg_/);
    expect(item["type"]).toBe("message");
    expect(item["content"]).toEqual([]);

    const partAdded = events[3] as Record<string, unknown>;
    expect(partAdded["item_id"]).toBe(item["id"]);
    expect(partAdded["output_index"]).toBe(0);
    expect(partAdded["content_index"]).toBe(0);
    expect(partAdded["part"]).toEqual({ type: "output_text", text: "", annotations: [] });

    expect(events[4]?.["delta"]).toBe("Hel");
    expect(events[5]?.["delta"]).toBe("lo");
    expect(events[6]?.["text"]).toBe("Hello");
    expect((events[7]?.["part"] as Record<string, unknown>)?.["text"]).toBe("Hello");

    const done = events[8] as Record<string, unknown>;
    const doneItem = done["item"] as Record<string, unknown>;
    expect(doneItem["status"]).toBe("completed");
    expect(doneItem["content"]).toEqual([
      { type: "output_text", text: "Hello", annotations: [] },
    ]);

    const completed = events[9] as Record<string, unknown>;
    const completedResponse = completed["response"] as Record<string, unknown>;
    expect(completedResponse["status"]).toBe("completed");
    expect(completedResponse["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(completedResponse["output"]).toEqual([
      {
        type: "message",
        id: doneItem["id"],
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello", annotations: [] }],
      },
    ]);
  });

  it("工具流：output_item.added（function_call）→ function_call_arguments.delta×N → done 系列 → completed", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"sha"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nghai\\"}"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"tool_calls"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToResponses(sseStream(sse)));
    const events = parseResponsesEvents(text);
    expect(events.map((e) => e["type"])).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);

    const itemAdded = events[2] as Record<string, unknown>;
    const item = itemAdded["item"] as Record<string, unknown>;
    expect(item["type"]).toBe("function_call");
    expect(String(item["id"])).toMatch(/^call_/);
    expect(item["call_id"]).toBe("call_1");
    expect(item["name"]).toBe("get_weather");
    expect(item["arguments"]).toBe("");
    expect(item["status"]).toBe("in_progress");

    expect(events[3]?.["item_id"]).toBe(item["id"]);
    expect(events[3]?.["delta"]).toBe('{"city":"sha');
    expect(events[4]?.["delta"]).toBe('nghai"}');

    const done = events[5] as Record<string, unknown>;
    expect(done["name"]).toBe("get_weather");
    expect(done["arguments"]).toBe('{"city":"shanghai"}');

    const itemDone = events[6] as Record<string, unknown>;
    expect((itemDone["item"] as Record<string, unknown>)["status"]).toBe("completed");

    const completed = events[7] as Record<string, unknown>;
    expect((completed["response"] as Record<string, unknown>)["status"]).toBe("completed");
  });

  it("无 usage 尾包：completed 不带 usage（免计路径）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToResponses(sseStream(sse)));
    const events = parseResponsesEvents(text);
    const completed = events.find((e) => e["type"] === "response.completed");
    const completedResponse = completed?.["response"] as Record<string, unknown> | undefined;
    expect(completedResponse?.["usage"]).toBeUndefined();
  });

  it("流内错误：error 事件注入并终止（无 response.completed）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      'data: {"error":{"message":"upstream broke"}}',
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToResponses(sseStream(sse)));
    const events = parseResponsesEvents(text);
    expect(events.map((e) => e["type"])).toContain("error");
    expect(events.map((e) => e["type"])).not.toContain("response.completed");
    const errorEvent = events.find((e) => e["type"] === "error");
    expect(errorEvent?.["code"]).toBeNull();
    expect(errorEvent?.["message"]).toBe("upstream broke");
    expect(errorEvent?.["param"]).toBeNull();
  });

  it("上游流在未收到 finish_reason 时结束 → 尽力合成 response.failed（避免 SDK 挂死）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToResponses(sseStream(sse)));
    const events = parseResponsesEvents(text);
    const types = events.map((e) => e["type"]);
    expect(types).toContain("response.failed");
    expect(types).not.toContain("response.completed");
    const failed = events.find((e) => e["type"] === "response.failed");
    const failedResponse = failed?.["response"] as Record<string, unknown>;
    expect(failedResponse["status"]).toBe("failed");
    expect(failedResponse["error"]).toEqual({
      code: "server_error",
      message: "Upstream stream ended without a finish_reason",
    });
    // item 仍被完整关闭（done 系列事件先于 failed）
    expect(types).toContain("response.output_text.done");
    expect(types).toContain("response.output_item.done");
  });

  it("finish_reason length → response.incomplete（incomplete_details max_output_tokens）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"length"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToResponses(sseStream(sse)));
    const events = parseResponsesEvents(text);
    expect(events.map((e) => e["type"])).not.toContain("response.completed");
    const incomplete = events.find((e) => e["type"] === "response.incomplete");
    const response = incomplete?.["response"] as Record<string, unknown>;
    expect(response["status"]).toBe("incomplete");
    expect(response["incomplete_details"]).toEqual({ reason: "max_output_tokens" });
    // item 级 status 与 response 级同步（OR §1.2）：截断 → message item incomplete
    const itemDone = events.find((e) => e["type"] === "response.output_item.done");
    expect((itemDone?.["item"] as Record<string, unknown>)?.["status"]).toBe("incomplete");
  });
});

// ============ 4. 端到端（selfFetch）：非流式 / 流式 / 错误码 / 双上游 / 缓存 ============

describe("端到端：非流式（openai 上游）", () => {
  it("Responses 请求 → 翻译转发 /chat/completions → Responses 响应 + usage 入账", async () => {
    const userId = await setupUser("resp-openai@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    let capturedBody = "";
    stubUpstreamFetch((url, init) => {
      capturedUrl = url;
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: MODEL, input: "hello", instructions: "Be brief." }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      object: string;
      status: string;
      output_text: string;
      usage: { input_tokens: number; output_tokens: number; total_tokens: number };
      output: Array<{ type: string; status: string; role: string }>;
    };
    expect(json["object"]).toBe("response");
    expect(json["status"]).toBe("completed");
    expect(json["output_text"]).toBe("hi there");
    expect(json["output"]).toEqual([
      {
        type: "message",
        id: expect.stringMatching(/^msg_/),
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "hi there", annotations: [] }],
      },
    ]);
    expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });

    // 入站翻译后的上游请求：/chat/completions 路径 + instructions → system 消息
    expect(capturedUrl).toMatch(/\/v1\/chat\/completions$/);
    const upstreamBody = JSON.parse(capturedBody) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(upstreamBody["model"]).toBe(MODEL);
    expect(upstreamBody["messages"]).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ]);

    // 计费入账（usage 从上游 raw body 提取；延迟计费：消费者批内落账）
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("additional_tools 输入项（Codex Responses Lite）→ hoist 到上游 tools 且不产生消息", async () => {
    const userId = await setupUser("resp-atools@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postResponses(
      plaintext,
      JSON.stringify({
        model: MODEL,
        input: [
          {
            type: "additional_tools",
            role: "developer",
            tools: [
              {
                type: "function",
                name: "get_weather",
                description: "weather lookup",
                parameters: { type: "object", properties: { city: { type: "string" } } },
              },
            ],
          },
          { role: "user", content: "what's the weather?" },
        ],
      }),
    );
    expect(res.status).toBe(200);

    // 上游 chat 请求：无 carrier 消息；工具已 hoist 进请求级 tools
    const upstreamBody = JSON.parse(capturedBody) as {
      messages: Array<{ role: string; content: string }>;
      tools: Array<{ type: string; function: { name: string } }>;
    };
    expect(upstreamBody["messages"]).toEqual([
      { role: "user", content: "what's the weather?" },
    ]);
    expect(upstreamBody["tools"]).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "weather lookup",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      },
    ]);
  });
});

describe("端到端：非流式（anthropic 上游自洽闭环）", () => {
  it("上游 Anthropic message → 正向回译 → Responses 响应（usage 换算入账）", async () => {
    const userId = await setupUser("resp-anthropic@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupAnthropicProviderWithModel(ANTHROPIC_MODEL);
    await setupPrice(ANTHROPIC_MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    stubUpstreamFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify(ANTHROPIC_UPSTREAM_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: ANTHROPIC_MODEL, input: "hello" }),
    );
    expect(res.status).toBe(200);
    // 上游地址为 Anthropic 形态（正向适配器构造 /v1/messages）
    expect(capturedUrl).toMatch(/\/v1\/messages$/);

    const json = (await res.json()) as {
      object: string;
      model: string;
      output_text: string;
      usage: { input_tokens: number; output_tokens: number };
      output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
    };
    expect(json["object"]).toBe("response");
    expect(json["model"]).toBe(ANTHROPIC_MODEL);
    expect(json["output_text"]).toBe("hi from claude");
    expect(json["output"][0]?.["content"]).toEqual([
      { type: "output_text", text: "hi from claude", annotations: [] },
    ]);
    expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });

    // 延迟计费：消费者批内落账（anthropic 上游换算 usage）
    await settleDelayedBilling([
      { userId, keyId, providerId, model: ANTHROPIC_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("端到端：流式", () => {
  it("openai 上游 SSE → Responses SSE 事件序列 + 尾包结算", async () => {
    const userId = await setupUser("resp-openai-stream@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const sse = [
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postResponses(
      plaintext,
      responsesBody({ stream: true }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain('"type":"response.created"');
    expect(text).toContain('"type":"response.output_text.delta","sequence_number"');
    expect(text).toContain('"type":"response.completed"');
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain("event:");

    // 流式尾包结算（usage 从内部 OpenAI 尾包提取；延迟计费：消费者批内落账）
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("anthropic 上游 SSE → 正向转换 → 结算 → Responses SSE", async () => {
    const userId = await setupUser("resp-anthropic-stream@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupAnthropicProviderWithModel(ANTHROPIC_MODEL);
    await setupPrice(ANTHROPIC_MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const upstreamSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01s","type":"message","role":"assistant","content":[],"model":"claude-sonnet-test","stop_reason":null,"usage":{"input_tokens":100}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":50}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
    ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(upstreamSse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: ANTHROPIC_MODEL, input: "hello", stream: true }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("[DONE]");
    const events = parseResponsesEvents(text);
    expect(events.map((e) => e["type"])).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = events[9] as Record<string, unknown>;
    expect((completed["response"] as Record<string, unknown>)["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });

    // 延迟计费：消费者批内落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: ANTHROPIC_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("端到端：错误码（OpenAI 形态错误体）", () => {
  it("错误 Key → 401", async () => {
    const res = await postResponses("sk-wrong-key");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toBeTruthy();
  });

  it("404 模型不可路由", async () => {
    const userId = await setupUser("resp-404@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: "no-such-model", input: "hi" }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toContain("no-such-model");
    expect(await latestLogStatus(userId)).toBe("rejected");
  });

  it("402 余额为负（D2 债务）", async () => {
    const userId = await setupUser("resp-402@test.dev", -1);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postResponses(plaintext);
    expect(res.status).toBe(402);
  });

  it("429 限流", async () => {
    const userId = await setupUser("resp-429@test.dev", 10);
    const { plaintext } = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const first = await postResponses(plaintext);
    expect(first.status).toBe(200);
    const second = await postResponses(plaintext);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toBeTruthy();
  });

  it("502 上游不可达（不扣费，明细 error）", async () => {
    const userId = await setupUser("resp-502@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const res = await postResponses(plaintext);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toBeTruthy();
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("400 previous_response_id → OpenAI 形态错误体（提示无状态用法）", async () => {
    const userId = await setupUser("resp-400@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: MODEL, input: "hi", previous_response_id: "resp_123" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toContain("stateless");
    expect(await countTxByType(userId, "usage")).toBe(0);
  });

  it("400 conversation → 同一红线同文案（路由级；与 previous_response_id 各自命中同一提取函数）", async () => {
    const userId = await setupUser("resp-400-conv@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: MODEL, input: "hi", conversation: "conv_route_x" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toContain("stateless");
    expect(await countTxByType(userId, "usage")).toBe(0);
  });

  it("400 未知 input item 类型", async () => {
    const userId = await setupUser("resp-400-item@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postResponses(
      plaintext,
      JSON.stringify({ model: MODEL, input: [{ type: "computer_call", name: "open_app" }] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toContain("computer_call");
  });

  it("400 zod 校验（缺失 input）", async () => {
    const userId = await setupUser("resp-zod@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await postResponses(plaintext, JSON.stringify({ model: MODEL }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body["error"]?.["message"]).toContain("input");
  });
});

describe("端到端：Codex Responses Lite 全量适配（namespace 平面化 + reasoning 回传）", () => {
  /** 模拟 Codex ≥0.149.0 / GPT-5.6 lite 请求：additional_tools[functions namespace] +
   *  tool_search/web 命名空间（应丢弃）+ reasoning 回放 + function_call 往返 + 40k 上下文。 */
  function codexLiteBody(): string {
    const bigContext = "x".repeat(40_000);
    return JSON.stringify({
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
    });
  }

  it("lite 请求 → 200；上游收到扁平 function tools；reasoning 默认剥离（flag off）", async () => {
    const userId = await setupUser("resp-lite-off@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postResponses(plaintext, codexLiteBody());
    expect(res.status).toBe(200);

    const upstreamBody = JSON.parse(capturedBody) as {
      messages: Array<Record<string, unknown>>;
      tools: Array<{ function: { name: string } }>;
    };
    // namespace 平面化：仅 functions 提取；web/tool_search 命名空间被 buildTools 丢弃
    expect(upstreamBody["tools"]?.map((t) => t["function"]["name"])).toEqual(["exec", "lookup"]);
    // flag off（默认）：上游 messages 无 reasoning_content（openai 适配器剥离）
    const assistantMsg = upstreamBody["messages"].find((m) => m["role"] === "assistant");
    expect(assistantMsg?.["reasoning_content"]).toBeUndefined();
  });

  it("reasoning_roundtrip=true → 上游收到 assistant.reasoning_content", async () => {
    const userId = await setupUser("resp-lite-on@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const providerId = await setupProviderWithModel(MODEL);
    // 打开回传开关（openai 面生效）
    const db = createDb(env);
    await db
      .update(providers)
      .set({ reasoningRoundtrip: true })
      .where(eq(providers.id, providerId));
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedBody = "";
    stubUpstreamFetch((_url, init) => {
      capturedBody = String(init.body ?? "");
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postResponses(plaintext, codexLiteBody());
    expect(res.status).toBe(200);

    const upstreamBody = JSON.parse(capturedBody) as {
      messages: Array<Record<string, unknown>>;
    };
    // 挂载位置：reasoning 之后第一条 assistant 消息（function_call 前的 assistant message）
    const assistantMsg = upstreamBody["messages"].find((m) => m["role"] === "assistant");
    expect(assistantMsg?.["reasoning_content"]).toBe("previous round thinking");
  });
});

describe("端到端：缓存（responses: 前缀隔离）", () => {
  it("预置缓存命中 → 返回 Responses 形态缓存体、不转发、不扣费", async () => {
    const userId = await setupUser("resp-cache@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const body = { model: MODEL, input: "hello" };
    const bodyHash = await hashRequestBody(body);
    const cacheKey = buildCacheKey(keyId, MODEL, bodyHash, "responses:");
    const cachedPayload = {
      id: "resp_cached",
      object: "response",
      created_at: 1_700_000_000,
      status: "completed",
      model: MODEL,
      output: [
        {
          type: "message",
          id: "msg_cached",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: "cached responses reply", annotations: [] }],
        },
      ],
      output_text: "cached responses reply",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    };
    await env.CACHE_KV.put(cacheKey, JSON.stringify(cachedPayload));

    let upstreamCalled = false;
    stubUpstreamFetch(() => {
      upstreamCalled = true;
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postResponses(plaintext, JSON.stringify(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; output_text: string };
    expect(json["id"]).toBe("resp_cached");
    expect(json["output_text"]).toBe("cached responses reply");
    expect(upstreamCalled).toBe(false);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("cached");
  });
});
