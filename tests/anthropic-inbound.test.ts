// Anthropic 入站适配测试（R1-R10 / D1-D12）：纯函数转换单测 + 端到端（selfFetch）。
// 覆盖：buildInternalFromAnthropic（入站映射 + 守卫/拒绝）、transformResponseToAnthropic
// （非流式全字段）、transformStreamToAnthropic（逐事件序列）、三路径等价、
// x-api-key/Bearer 鉴权、错误重写（401/404/402/429/502/400）、openai 与 anthropic 两类上游、
// 流式结算、缓存（anthropic: 前缀隔离）。
// 09-03-cc-stg-reasoning-400（reasoning_content 双向闭环）：assistant thinking 块 →
// 内部 reasoning_content（R1）、message.reasoning_content → thinking 块（R3 非流式）、
// delta.reasoning_content → thinking 块事件（R2 流式）、E2E flag 剥/留裁决。
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "cloudflare:test";
import { AdapterError } from "../src/providers/types";
import {
  buildInternalFromAnthropic,
  extractAnthropicExtras,
  transformResponseToAnthropic,
  transformStreamToAnthropic,
} from "../src/providers/anthropic-inbound";
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
  setupProvider,
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

function anthropicBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    system: "Be brief.",
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

/** OpenAI chat.completion 上游响应（含 usage）。 */
const CHAT_RESPONSE = {
  id: "chatcmpl-anthropic-inbound",
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

/** 解析 Anthropic SSE 输出为 {event, data} 列表（断言用）。 */
function parseSseEvents(
  text: string,
): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  for (const block of text.trim().split("\n\n")) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    events.push({ event, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> });
  }
  return events;
}

// ============ 1. buildInternalFromAnthropic（入站 Anthropic → 内部 chat 形态） ============

describe("buildInternalFromAnthropic（入站映射）", () => {
  it("system string + user/assistant 消息 → 内部 chat body（model/max_tokens 直通）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 100,
      system: "Be brief.",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    expect(result).toEqual({
      model: MODEL,
      max_tokens: 100,
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
  });

  it("system 多 block → 多条 system 消息合并到最前；非 text block 丢弃", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      system: [
        { type: "text", text: "A" },
        { type: "text", text: "B" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
      ],
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result["messages"]).toEqual([
      { role: "system", content: "A" },
      { role: "system", content: "B" },
      { role: "user", content: "hello" },
    ]);
  });

  it("user content blocks：text + base64 image → parts（data URL 形态）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
            },
          ],
        },
      ],
    });
    const userMsg = (result["messages"] as Array<Record<string, unknown>>).find(
      (m) => m["role"] === "user",
    );
    expect(userMsg?.["content"]).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
    ]);
  });

  it("image source url → AdapterError（零 SSRF 面）", () => {
    expect(() =>
      buildInternalFromAnthropic({
        model: MODEL,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "http://evil.example/x.png" } },
            ],
          },
        ],
      }),
    ).toThrow(AdapterError);
  });

  it("tool_result → tool 消息（tool_use_id 关联 tool_call_id）；无文本时不出 user 消息", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "42" }],
        },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "tool", tool_call_id: "toolu_01", content: "42" },
    ]);
  });

  it("assistant：thinking + text + tool_use → content + reasoning_content + tool_calls（R1 不再丢弃；signature 不映射）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal chain", signature: "sig_mock_01" },
            { type: "text", text: "sure" },
            { type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "shanghai" } },
          ],
        },
      ],
    });
    expect(result["messages"]).toEqual([
      {
        role: "assistant",
        content: "sure",
        reasoning_content: "internal chain",
        tool_calls: [
          {
            id: "toolu_01",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"shanghai"}' },
          },
        ],
      },
    ]);
    // signature 不泄漏进内部形态
    expect(JSON.stringify(result)).not.toContain("sig_mock_01");
  });

  it("assistant 多 thinking 块 → reasoning_content 按序直接拼接（无分隔符，跨 text 块顺序保持）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "step one " },
            { type: "text", text: "working" },
            { type: "thinking", thinking: "then step two" },
          ],
        },
      ],
    });
    expect(result["messages"]).toEqual([
      { role: "assistant", content: "working", reasoning_content: "step one then step two" },
    ]);
  });

  it("assistant 无 thinking 块 → 内部消息与现状逐字节一致（零回归：不新增 reasoning_content 字段）", () => {
    const textOnly = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        { role: "assistant", content: [{ type: "text", text: "sure" }] },
      ],
    });
    expect(textOnly["messages"]).toEqual([{ role: "assistant", content: "sure" }]);

    const toolOnly = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "shanghai" } },
          ],
        },
      ],
    });
    expect(toolOnly["messages"]).toEqual([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "toolu_01",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"shanghai"}' },
          },
        ],
      },
    ]);
  });

  it("thinking 块畸形（thinking 非 string / 缺失 / 空串）→ 跳过，不新增 reasoning_content", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking" },
            { type: "thinking", thinking: 42 },
            { type: "thinking", thinking: "" },
            { type: "text", text: "fine" },
          ],
        },
      ],
    });
    expect(result["messages"]).toEqual([{ role: "assistant", content: "fine" }]);
  });

  it("tools（扁平）→ function 嵌套（input_schema → parameters）；description 保留", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "get_weather",
          description: "weather lookup",
          input_schema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
    });
    expect(result["tools"]).toEqual([
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

  it("tool_choice 逆向：auto/any/none/{type:tool} → OpenAI 形态", () => {
    const tools = [{ name: "f", input_schema: { type: "object", properties: {} } }];
    const base = {
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools,
    };
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "auto" } })["tool_choice"]).toBe("auto");
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "any" } })["tool_choice"]).toBe("required");
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "none" } })["tool_choice"]).toBe("none");
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "tool", name: "f" } })["tool_choice"]).toEqual({
      type: "function",
      function: { name: "f" },
    });
  });

  it("D8 守卫：any 无 tools → 降级 none；{type:tool} 无 tools → AdapterError", () => {
    const base = {
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    };
    expect(buildInternalFromAnthropic({ ...base, tool_choice: { type: "any" } })["tool_choice"]).toBe("none");
    expect(() =>
      buildInternalFromAnthropic({ ...base, tool_choice: { type: "tool", name: "f" } }),
    ).toThrow(AdapterError);
  });

  it("stop_sequences → stop；temperature/top_p/stream 直通", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      stop_sequences: ["END", "STOP"],
      temperature: 0.5,
      top_p: 0.9,
      stream: true,
    });
    expect(result["stop"]).toEqual(["END", "STOP"]);
    expect(result["temperature"]).toBe(0.5);
    expect(result["top_p"]).toBe(0.9);
    expect(result["stream"]).toBe(true);
  });

  it("平台专属字段（top_k/metadata/service_tier）丢弃；thinking/output_config 不进内部形态（R1 透传通道接管，经 extractAnthropicExtras）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      top_k: 5,
      metadata: { user_id: "u1" },
      service_tier: "standard",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    expect(result["top_k"]).toBeUndefined();
    expect(result["metadata"]).toBeUndefined();
    expect(result["service_tier"]).toBeUndefined();
    // R1：顶层 thinking/output_config 不再走丢弃清单（也不进内部 body）——由
    // extractAnthropicExtras 提取 → InternalRequest.anthropicExtras → anthropic 适配器写回
    expect(result["thinking"]).toBeUndefined();
    expect(result["output_config"]).toBeUndefined();
  });

  it("分支 3：thread/safeguards 不进内部形态（extras 通道接管）", () => {
    const result = buildInternalFromAnthropic({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      thread: { type: "create" },
      safeguards: { policies: [{ id: "pol_1" }] },
    });
    expect(result["thread"]).toBeUndefined();
    expect(result["safeguards"]).toBeUndefined();
  });

  it("extractAnthropicExtras：逐字提取 thinking/output_config（畸形形态原样），无则 undefined", () => {
    expect(extractAnthropicExtras({
      model: MODEL,
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    })).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    // 单出现 + 畸形形态（string 而非 object）→ 逐字，不校验
    expect(extractAnthropicExtras({
      messages: [],
      output_config: "malformed",
    })).toEqual({ output_config: "malformed" });
    // 无任一字段 → 空对象
    expect(extractAnthropicExtras({ messages: [] })).toEqual({});
  });

  it("分支 3：extractAnthropicExtras 逐字提取 thread/safeguards（畸形形态原样）", () => {
    const thread = { type: "continue", thread_id: "thr_unit_01" };
    const safeguards = { policies: [{ id: "pol_1" }], mode: "server" };
    expect(extractAnthropicExtras({ messages: [], thread, safeguards })).toEqual({
      thread,
      safeguards,
    });
    // 畸形形态逐字，不校验（上游 400 显式暴露）
    expect(extractAnthropicExtras({ messages: [], thread: "malformed" })).toEqual({
      thread: "malformed",
    });
  });

  it("未知消息 role → AdapterError", () => {
    expect(() =>
      buildInternalFromAnthropic({
        model: MODEL,
        max_tokens: 10,
        messages: [{ role: "developer", content: "hi" }],
      }),
    ).toThrow(AdapterError);
  });
});

// ============ 2. transformResponseToAnthropic（内部 chat 响应 → Anthropic message） ============

describe("transformResponseToAnthropic（非流式出站）", () => {
  it("文本响应全字段：msg_ id / type / role / content / stop_reason / usage 换算", () => {
    const result = transformResponseToAnthropic(CHAT_RESPONSE) as Record<string, unknown>;
    expect(String(result["id"])).toMatch(/^msg_/);
    expect(result["type"]).toBe("message");
    expect(result["role"]).toBe("assistant");
    expect(result["content"]).toEqual([{ type: "text", text: "hi there" }]);
    expect(result["stop_reason"]).toBe("end_turn");
    expect(result["stop_sequence"]).toBeNull();
    expect(result["model"]).toBe(MODEL);
    expect(result["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it("分支 3：保留键 _gateway_anthropic_passthrough → 真实 id / safeguard_results 逐字回写", () => {
    const safeguardResults = [
      { type: "safeguard_result", safeguard: "mock", result: "allow" },
    ];
    const result = transformResponseToAnthropic({
      ...CHAT_RESPONSE,
      _gateway_anthropic_passthrough: {
        id: "msg_upstream_real",
        safeguard_results: safeguardResults,
      },
    }) as Record<string, unknown>;
    expect(result["id"]).toBe("msg_upstream_real");
    expect(result["safeguard_results"]).toEqual(safeguardResults);
  });

  it("finish_reason → stop_reason 映射矩阵", () => {
    const base = { id: "x", object: "chat.completion", created: 1, model: MODEL, choices: [] };
    const cases: Array<[string | null, string]> = [
      ["stop", "end_turn"],
      ["tool_calls", "tool_use"],
      ["length", "max_tokens"],
      ["refusal", "refusal"],
      ["content_filter", "end_turn"],
      [null, "end_turn"],
    ];
    for (const [finish, expected] of cases) {
      const result = transformResponseToAnthropic({
        ...base,
        choices: [{ index: 0, message: { role: "assistant", content: "x" }, finish_reason: finish }],
      }) as Record<string, unknown>;
      expect(result["stop_reason"]).toBe(expected);
    }
  });

  it("tool_calls → tool_use blocks（arguments JSON 解析为 input）", () => {
    const result = transformResponseToAnthropic({
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
    expect(result["stop_reason"]).toBe("tool_use");
    expect(result["content"]).toEqual([
      { type: "text", text: "calling" },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "shanghai" } },
    ]);
  });

  it("reasoning_content → content 首个 thinking 块（text 紧随其后）；tool_calls 共存时顺序 thinking → text → tool_use（R3）", () => {
    const result = transformResponseToAnthropic({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "answer",
            reasoning_content: "let me reason",
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
    expect(result["stop_reason"]).toBe("tool_use");
    expect(result["content"]).toEqual([
      { type: "thinking", thinking: "let me reason" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "shanghai" } },
    ]);
  });

  it("reasoning_content 缺失/空串 → 无 thinking 块（零回归：content 与现状逐字节一致）", () => {
    const base = {
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        { index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" },
      ],
    };
    const plain = transformResponseToAnthropic(base) as Record<string, unknown>;
    const emptyReasoning = transformResponseToAnthropic({
      ...base,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi there", reasoning_content: "" },
          finish_reason: "stop",
        },
      ],
    }) as Record<string, unknown>;
    expect(plain["content"]).toEqual([{ type: "text", text: "hi there" }]);
    // 空串 reasoning_content 与缺失等价（id 每次随机生成，仅比较 content 等有效载荷）
    expect(emptyReasoning["content"]).toEqual(plain["content"]);
  });

  it("arguments 非法 JSON → input 降级空对象；usage.cached_tokens → cache_read_input_tokens", () => {
    const result = transformResponseToAnthropic({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: "{broken" },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }) as Record<string, unknown>;
    const content = result["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["input"]).toEqual({});
    expect(result["usage"]).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 20,
    });
  });

  it("usage 缺失 → 不输出 usage（免计路径）", () => {
    const result = transformResponseToAnthropic({
      id: "x",
      object: "chat.completion",
      created: 1,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    }) as Record<string, unknown>;
    expect(result["usage"]).toBeUndefined();
    expect(result["content"]).toEqual([]);
  });
});

// ============ 3. transformStreamToAnthropic（上游 OpenAI SSE → Anthropic SSE） ============

describe("transformStreamToAnthropic（流式出站）", () => {
  const CHUNK_BASE =
    '{"id":"chatcmpl-s","object":"chat.completion.chunk","created":1700000000,"model":"gpt-4o-mini"';

  function openaiChunk(payload: string): string {
    return `data: ${CHUNK_BASE},"choices":${payload}}`;
  }

  it("文本流：message_start → content_block 系列 → message_delta（output_tokens 尾包值）→ message_stop；无 [DONE]", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"Hel"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      openaiChunk('[]').replace('"choices":[]', '"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    expect(text).not.toContain("[DONE]");
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events[0]?.data as Record<string, unknown>;
    const startMessage = start["message"] as Record<string, unknown>;
    expect(String(startMessage["id"])).toMatch(/^msg_/);
    expect(startMessage["type"]).toBe("message");
    expect(startMessage["role"]).toBe("assistant");
    expect(startMessage["content"]).toEqual([]);
    expect(startMessage["stop_reason"]).toBeNull();
    expect(startMessage["model"]).toBe("gpt-4o-mini");
    expect((startMessage["usage"] as Record<string, unknown>)["input_tokens"]).toBe(0);

    const blockStart = events[1]?.data as Record<string, unknown>;
    expect(blockStart["index"]).toBe(0);
    expect(blockStart["content_block"]).toEqual({ type: "text" });
    expect(events[2]?.data["delta"]).toEqual({ type: "text_delta", text: "Hel" });
    expect(events[3]?.data["delta"]).toEqual({ type: "text_delta", text: "lo" });
    expect(events[4]?.data["index"]).toBe(0);

    const delta = events[5]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(delta["usage"]).toEqual({ output_tokens: 50 });
    expect(events[6]?.event).toBe("message_stop");
  });

  it("工具流：tool_use start（id/name）→ input_json_delta 逐段透传 → done；message_delta stop_reason=tool_use", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"sha"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"nghai\\"}"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"tool_calls"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const blockStart = events[1]?.data as Record<string, unknown>;
    expect(blockStart["index"]).toBe(0);
    expect(blockStart["content_block"]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
    });
    expect(events[2]?.data["delta"]).toEqual({
      type: "input_json_delta",
      partial_json: '{"city":"sha',
    });
    expect(events[3]?.data["delta"]).toEqual({
      type: "input_json_delta",
      partial_json: 'nghai"}',
    });
    const delta = events[5]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "tool_use", stop_sequence: null });
  });

  it("思考流（R2）：delta.reasoning_content → thinking 块事件（start{thinking} → thinking_delta×N → stop），text 块紧随其后 index 递增", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"reasoning_content":"Let me reason"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"reasoning_content":" about the plan"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"content":"Answer"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      openaiChunk('[]').replace('"choices":[]', '"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const thinkingStart = events[1]?.data as Record<string, unknown>;
    expect(thinkingStart["index"]).toBe(0);
    expect(thinkingStart["content_block"]).toEqual({ type: "thinking", thinking: "" });
    expect(events[2]?.data["delta"]).toEqual({
      type: "thinking_delta",
      thinking: "Let me reason",
    });
    expect(events[3]?.data["delta"]).toEqual({
      type: "thinking_delta",
      thinking: " about the plan",
    });
    expect(events[4]?.data["index"]).toBe(0);
    const textStart = events[5]?.data as Record<string, unknown>;
    expect(textStart["index"]).toBe(1);
    expect(textStart["content_block"]).toEqual({ type: "text" });
    expect(events[6]?.data["delta"]).toEqual({ type: "text_delta", text: "Answer" });
  });

  it("思考 + 工具交错（R2）：thinking 块先收口再开 tool_use 块（index 按开启顺序递增）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":null},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"reasoning_content":"need to search"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"tool_calls"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const thinkingStart = events[1]?.data as Record<string, unknown>;
    expect(thinkingStart["index"]).toBe(0);
    expect(thinkingStart["content_block"]).toEqual({ type: "thinking", thinking: "" });
    expect(events[2]?.data["delta"]).toEqual({
      type: "thinking_delta",
      thinking: "need to search",
    });
    expect(events[3]?.data["index"]).toBe(0); // thinking 收口
    const toolStart = events[4]?.data as Record<string, unknown>;
    expect(toolStart["index"]).toBe(1);
    expect(toolStart["content_block"]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "get_weather",
    });
    expect(events[5]?.data["delta"]).toEqual({
      type: "input_json_delta",
      partial_json: "{}",
    });
    const delta = events[7]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "tool_use", stop_sequence: null });
  });

  it("防御（R2）：reasoning 晚于 text 到达 → text 块先收口，thinking 块独立成序", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"early"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{"reasoning_content":"late thinking"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";

    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    // 事件序：text 块（idx0）先收口 → thinking 块（idx1）才开启
    expect(events[2]?.data["delta"]).toEqual({ type: "text_delta", text: "early" });
    expect((events[3]?.data as Record<string, unknown>)["index"]).toBe(0);
    expect(events[4]?.data["content_block"]).toEqual({ type: "thinking", thinking: "" });
    expect(events[5]?.data["delta"]).toEqual({
      type: "thinking_delta",
      thinking: "late thinking",
    });
  });

  it("无 usage 尾包：message_delta output_tokens 兜底 0", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      openaiChunk('[{"index":0,"delta":{},"finish_reason":"stop"}]'),
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    const delta = events.find((e) => e["event"] === "message_delta");
    expect((delta?.data["usage"] as Record<string, unknown>)["output_tokens"]).toBe(0);
  });

  it("流内错误：error 事件注入并终止（无 message_stop）", async () => {
    const sse = [
      openaiChunk('[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]'),
      'data: {"error":{"message":"upstream broke"}}',
    ].join("\n\n") + "\n\n";
    const text = await streamToText(transformStreamToAnthropic(sseStream(sse)));
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toContain("error");
    expect(events.map((e) => e["event"])).not.toContain("message_stop");
    const errorEvent = events.find((e) => e["event"] === "error");
    expect(errorEvent?.data["error"]).toEqual({ type: "api_error", message: "upstream broke" });
  });
});

// ============ 4. 端到端（selfFetch）：三路径 / 鉴权 / 错误重写 / 双上游 / 流式 / 缓存 ============

describe("端到端：三路径等价（openai 上游）", () => {
  it("/anthropic/v1/messages 与 /anthropic/messages 与 /v1/messages 均返回 Anthropic message 形态", async () => {
    const userId = await setupUser("anthro-paths@test.dev", 10);
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

    const paths = ["/anthropic/v1/messages", "/anthropic/messages", "/v1/messages"];
    for (const path of paths) {
      const res = await postAnthropic(path, plaintext);
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        type: string;
        role: string;
        content: Array<{ type: string; text: string }>;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(json["type"]).toBe("message");
      expect(json["role"]).toBe("assistant");
      expect(json["content"]).toEqual([{ type: "text", text: "hi there" }]);
      expect(json["stop_reason"]).toBe("end_turn");
      expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });
    }

    // 入站翻译后的上游请求：system → 顶部 system 消息、max_tokens 直通、/chat/completions 路径
    expect(capturedUrl).toMatch(/\/v1\/chat\/completions$/);
    const upstreamBody = JSON.parse(capturedBody) as {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string }>;
    };
    expect(upstreamBody["model"]).toBe(MODEL);
    expect(upstreamBody["max_tokens"]).toBe(100);
    expect(upstreamBody["messages"]).toEqual([
      { role: "system", content: "Be brief." },
      { role: "user", content: "hello" },
    ]);

    // 延迟计费：三路径各发一次计费事件，响应路径 0 同步 D1 写
    expect(await latestLogStatus(userId)).toBeNull();

    // 消费者批内落账（usage 从上游 raw body 提取）：三路径各计费一次
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - 3 * EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(3);
    expect(await latestLogStatus(userId)).toBe("success");
  });
});

describe("端到端：message threads 需要 anthropic 方言上游（分支 3）", () => {
  it("openai 方言上游 + thread → 400 fail-closed，且不触达上游", async () => {
    const model = "gpt-4o-mini-thread-openai";
    const userId = await setupUser("anthro-thread-openai@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(model);
    await setupPrice(model, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let upstreamCalled = false;
    stubUpstreamFetch(() => {
      upstreamCalled = true;
      return new Response(JSON.stringify(CHAT_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postAnthropic(
      "/v1/messages",
      plaintext,
      anthropicBody({
        model,
        thread: { type: "continue", thread_id: "thr_unit_01" },
      }),
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("message threads");
    expect(upstreamCalled).toBe(false);
  });
});

describe("端到端：鉴权（x-api-key / Bearer）与错误重写", () => {
  it("x-api-key 与 Authorization: Bearer 均可鉴权", async () => {
    const userId = await setupUser("anthro-auth@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const viaXKey = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(viaXKey.status).toBe(200);
    const viaBearer = await selfFetch("http://localhost/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${plaintext}`,
      },
      body: anthropicBody(),
    });
    expect(viaBearer.status).toBe(200);
  });

  it("错误 Key → Anthropic 形态 401（authentication_error）", async () => {
    const res = await postAnthropic("/anthropic/v1/messages", "sk-wrong-key");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("authentication_error");
  });

  it("/v1/messages 缺失 Key → 同样 Anthropic 形态 401（error-adapt 先于全局 gatewayAuth）", async () => {
    const res = await selfFetch("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: anthropicBody(),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("authentication_error");
  });

  it("404 模型不可路由 → Anthropic not_found_error", async () => {
    const userId = await setupUser("anthro-404@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({ model: "no-such-model", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type?: string; error?: { type?: string; message?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("not_found_error");
    expect(body["error"]?.["message"]).toContain("no-such-model");
    expect(await latestLogStatus(userId)).toBe("rejected");
  });

  it("402 余额为负（D2 债务）→ Anthropic permission_error（保留 402 状态码）", async () => {
    const userId = await setupUser("anthro-402@test.dev", -1);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(res.status).toBe(402);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("permission_error");
  });

  it("429 限流 → Anthropic rate_limit_error", async () => {
    const userId = await setupUser("anthro-429@test.dev", 10);
    const { plaintext } = await setupKey(userId, { qpsLimit: 1 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);
    stubUpstreamFetch(() => new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 }));

    const first = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(first.status).toBe(200);
    const second = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(second.status).toBe(429);
    const body = (await second.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("rate_limit_error");
  });

  it("502 上游不可达 → Anthropic api_error（不扣费，明细 error）", async () => {
    const userId = await setupUser("anthro-502@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const res = await postAnthropic("/anthropic/v1/messages", plaintext);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("api_error");
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("error");
  });

  it("400 入站转换拒绝（image url source）→ Anthropic invalid_request_error", async () => {
    const userId = await setupUser("anthro-400@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupProviderWithModel(MODEL);
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({
        model: MODEL,
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "url", url: "http://evil.example/x.png" } },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string; error?: { type?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("invalid_request_error");
  });

  it("zod 400（缺失 max_tokens）→ Anthropic invalid_request_error", async () => {
    const userId = await setupUser("anthro-zod@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { type?: string; error?: { type?: string; message?: string } };
    expect(body["type"]).toBe("error");
    expect(body["error"]?.["type"]).toBe("invalid_request_error");
    expect(body["error"]?.["message"]).toContain("max_tokens");
  });
});

describe("端到端：anthropic 上游（正向适配器自洽闭环）", () => {
  it("非流式：上游 Anthropic message → 回译 Anthropic message（usage 换算入账）", async () => {
    const userId = await setupUser("anthro-upstream@test.dev", 10);
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

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(res.status).toBe(200);
    // 上游地址为 Anthropic 形态（正向适配器构造 /v1/messages）
    expect(capturedUrl).toMatch(/\/v1\/messages$/);

    const json = (await res.json()) as {
      type: string;
      role: string;
      content: Array<{ type: string; text: string }>;
      stop_reason: string;
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(json["type"]).toBe("message");
    expect(json["content"]).toEqual([{ type: "text", text: "hi from claude" }]);
    expect(json["stop_reason"]).toBe("end_turn");
    expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });

    // 延迟计费：消费者批内落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: ANTHROPIC_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });

  it("流式：anthropic 上游 → P2a 协议短路（原样透传）+ Anthropic 提取器结算", async () => {
    const userId = await setupUser("anthro-upstream-stream@test.dev", 10);
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

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 100,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).not.toContain("[DONE]");
    const events = parseSseEvents(text);
    expect(events.map((e) => e["event"])).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    const start = events[0]?.data["message"] as Record<string, unknown>;
    // P2a 短路：事件原样透传（id/usage 来自上游原值；旧行为为合成 msg_ id + input_tokens:0，
    // 见 design §3.3 兼容性变更 1）
    expect(String(start["id"])).toBe("msg_01s");
    expect((start["usage"] as Record<string, unknown>)["input_tokens"]).toBe(100);
    const delta = events[5]?.data as Record<string, unknown>;
    expect(delta["delta"]).toEqual({ stop_reason: "end_turn", stop_sequence: null });
    expect(delta["usage"]).toEqual({ output_tokens: 50 });

    // 结算：Anthropic 提取器（message_start 100 + message_delta 50 合成）→ 延迟计费消费者落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: ANTHROPIC_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });
});

describe("端到端：openai 上游流式", () => {
  it("上游 OpenAI SSE → Anthropic SSE（message_start…message_stop）+ 尾包结算", async () => {
    const userId = await setupUser("anthro-openai-stream@test.dev", 10);
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

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      anthropicBodyWithStream(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta","text":"Hel"');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");

    // 延迟计费：消费者批内落账
    await settleDelayedBilling([
      { userId, keyId, providerId, model: MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
  });
});

describe("端到端：assistant thinking 历史 → 内部 reasoning_content（R1 + flag 门，09-03-cc-stg-reasoning-400）", () => {
  // 防 flag 状态泄漏：flag-on 测试后复位 mock-provider（setupProviderWithModel 复用行
  // 不重置该列；后续同文件测试不携带 reasoning_content，泄漏无害但属隐性顺序依赖）。
  afterEach(async () => {
    const db = createDb(env);
    const provider = await db.query.providers.findFirst({
      where: eq(providers.name, "mock-provider"),
      columns: { id: true },
    });
    if (provider) {
      await db.update(providers).set({ reasoningRoundtrip: false }).where(eq(providers.id, provider.id));
    }
  });

  /** Claude Code thinking 模式两轮 body：轮 1 带 thinking+tool_use，轮 2 带 thinking+text。 */
  function thinkingRoundtripBody(): string {
    return JSON.stringify({
      model: MODEL,
      max_tokens: 100,
      messages: [
        { role: "user", content: "weather in shanghai?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "need to call the tool", signature: "sig_mock_01" },
            { type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "shanghai" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "20C" }],
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "got the reading" },
            { type: "text", text: "It is 20C in shanghai." },
          ],
        },
      ],
    });
  }

  async function setupThinkingRoundtrip(email: string): Promise<{
    plaintext: string;
    captureBody: () => string;
  }> {
    const userId = await setupUser(email, 10);
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
    return { plaintext, captureBody: () => capturedBody };
  }

  function parseUpstreamMessages(body: string): Array<Record<string, unknown>> {
    return (JSON.parse(body) as { messages: Array<Record<string, unknown>> })["messages"];
  }

  it("flag off（默认）→ openai 适配器剥离 reasoning_content（上游零回归现状语义）", async () => {
    const { plaintext, captureBody } = await setupThinkingRoundtrip("anthro-rt-off@test.dev");
    // 显式关 flag（防测试顺序依赖；默认即 false）
    const db = createDb(env);
    const provider = await db.query.providers.findFirst({
      where: eq(providers.name, "mock-provider"),
      columns: { id: true },
    });
    if (provider) {
      await db.update(providers).set({ reasoningRoundtrip: false }).where(eq(providers.id, provider.id));
    }

    const res = await postAnthropic("/anthropic/v1/messages", plaintext, thinkingRoundtripBody());
    expect(res.status).toBe(200);

    const messages = parseUpstreamMessages(captureBody());
    // R1 入站映射已产生 reasoning_content，但 flag off → 剥净：上游不可见该字段
    const assistantMsgs = messages.filter((m) => m["role"] === "assistant");
    expect(assistantMsgs.length).toBe(2);
    for (const msg of assistantMsgs) {
      expect(msg["reasoning_content"]).toBeUndefined();
    }
    // 工具轮转结构不受影响（tool_calls / tool / content 正常透出）
    expect(assistantMsgs[0]?.["tool_calls"]).toBeDefined();
    expect(messages.some((m) => m["role"] === "tool")).toBe(true);
    expect(assistantMsgs[1]?.["content"]).toBe("It is 20C in shanghai.");
  });

  it("reasoning_roundtrip=true → 上游保留 reasoning_content（纯文本与 tool_calls 消息均携带）", async () => {
    const { plaintext, captureBody } = await setupThinkingRoundtrip("anthro-rt-on@test.dev");
    const db = createDb(env);
    const provider = await db.query.providers.findFirst({
      where: eq(providers.name, "mock-provider"),
      columns: { id: true },
    });
    if (provider) {
      await db.update(providers).set({ reasoningRoundtrip: true }).where(eq(providers.id, provider.id));
    }

    const res = await postAnthropic("/anthropic/v1/messages", plaintext, thinkingRoundtripBody());
    expect(res.status).toBe(200);

    const messages = parseUpstreamMessages(captureBody());
    const assistantMsgs = messages.filter((m) => m["role"] === "assistant");
    expect(assistantMsgs.length).toBe(2);
    // 轮 1：thinking+tool_use 消息携带 reasoning_content（thinking 文本、signature 不泄漏）
    expect(assistantMsgs[0]?.["reasoning_content"]).toBe("need to call the tool");
    expect(assistantMsgs[0]?.["tool_calls"]).toBeDefined();
    // 轮 2：thinking+text 消息携带 reasoning_content
    expect(assistantMsgs[1]?.["reasoning_content"]).toBe("got the reading");
    expect(assistantMsgs[1]?.["content"]).toBe("It is 20C in shanghai.");
    expect(captureBody()).not.toContain("sig_mock_01");
  });
});

describe("端到端：缓存（anthropic: 前缀隔离，R10/D9）", () => {
  it("预置缓存命中 → 返回 Anthropic 形态缓存体、不转发、不扣费", async () => {
    const userId = await setupUser("anthro-cache@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId, { cacheEnabled: true, cacheTtl: 3600 });
    await setupProviderWithModel(MODEL);
    await setupPrice(MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const body = {
      model: MODEL,
      max_tokens: 100,
      messages: [{ role: "user", content: "hello" }],
    };
    const bodyHash = await hashRequestBody(body);
    const cacheKey = buildCacheKey(keyId, MODEL, bodyHash, "anthropic:");
    const cachedPayload = {
      id: "msg_cached",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "cached anthropic reply" }],
      model: MODEL,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    await env.CACHE_KV.put(cacheKey, JSON.stringify(cachedPayload));

    let upstreamCalled = false;
    stubUpstreamFetch(() => {
      upstreamCalled = true;
      return new Response(JSON.stringify(CHAT_RESPONSE), { status: 200 });
    });

    const res = await postAnthropic("/anthropic/v1/messages", plaintext, JSON.stringify(body));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { id: string; content: Array<{ type: string; text: string }> };
    expect(json["id"]).toBe("msg_cached");
    expect(json["content"]).toEqual([{ type: "text", text: "cached anthropic reply" }]);
    expect(upstreamCalled).toBe(false);
    expect(await getBalance(userId)).toBe(10);
    expect(await countTxByType(userId, "usage")).toBe(0);
    expect(await latestLogStatus(userId)).toBe("cached");
  });
});

/** 流式 Anthropic 入站 body（model 用 openai 测试模型）。 */
function anthropicBodyWithStream(): string {
  return JSON.stringify({
    model: MODEL,
    max_tokens: 100,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
}

// ============= 批次 2（09-28-upstream-custom-type-passthrough）：声明面路由回归 =============
//
// 锁两件零回归红线之外的新面行为：
//   1. §4.2 回退趟转换兜底——custom 行只声明 chat 面（openai 方言）时，messages 入站在偏好趟
//      不命中，必须由回退趟收进来并走 openai 适配器转换转发（候选池为空 404 = 回退趟被错误面过滤）；
//   2. 直通门合取的**方言支**（design §4.1）——chat 面 verbatim ⇒ streamPassthrough=true，但端点
//      方言（openai）≠ 入站面方言（messages → anthropic），门必须不命中：否则帧级转换被跳过，
//      anthropic 客户端收到原始 openai 分帧（判别点 = 出站字节形态）。
// 用独立模型名（本文件其他用例未用）：mock-provider 也服务 MODEL，会混入候选池污染判别。
describe("端到端：custom 声明面（回退趟转换兜底 + 直通门方言合取）", () => {
  /** 仅声明 chat 面（policy 缺省 = verbatim ⇒ streamPassthrough=true）的 custom provider。 */
  async function setupCustomChatProvider(model: string): Promise<number> {
    return setupProvider("mock-custom-chat-provider", model, {
      type: "custom",
      baseUrl: "http://custom-chat-upstream.test/v1",
      protocols: JSON.stringify({ chat: {} }),
    });
  }

  const FALLBACK_MODEL = "custom-chat-fallback-model";
  const GATE_MODEL = "custom-chat-gate-model";
  const EXPECTED_CUSTOM_URL = "http://custom-chat-upstream.test/v1/chat/completions";

  it("非流式：chat 面 custom 行服务 /anthropic/v1/messages（偏好趟不中 → 回退趟 openai 转换转发 + 计费）", async () => {
    const userId = await setupUser("custom-chat-fallback@test.dev", 10);
    const { keyId, plaintext } = await setupKey(userId);
    const providerId = await setupCustomChatProvider(FALLBACK_MODEL);
    await setupPrice(FALLBACK_MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    let capturedUrl = "";
    stubUpstreamFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ ...CHAT_RESPONSE, model: FALLBACK_MODEL }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({ model: FALLBACK_MODEL, max_tokens: 100, messages: [{ role: "user", content: "hello" }] }),
    );
    expect(res.status).toBe(200);
    // 上游按 openai 方言 chat 面形态打（主端点 base_url + chat 路径）
    expect(capturedUrl).toBe(EXPECTED_CUSTOM_URL);
    const json = (await res.json()) as { type: string; usage: { input_tokens: number } };
    expect(json["type"]).toBe("message"); // 转换转发：出站恒 anthropic 形态
    expect(json["usage"]).toEqual({ input_tokens: 100, output_tokens: 50 });

    // 承重点 5：openai 方言端点 → openai 适配器 parseUsage（延迟计费消费者落账）
    await settleDelayedBilling([
      { userId, keyId, providerId, model: FALLBACK_MODEL, promptTokens: 100, completionTokens: 50 },
    ]);
    expect(await getBalance(userId)).toBeCloseTo(10 - EXPECTED_COST, 10);
    expect(await countTxByType(userId, "usage")).toBe(1);
    expect(await latestLogStatus(userId)).toBe("success");
  });

  it("流式：chat 面（openai 方言）在 messages 入站不得字节直通（门缺方言支会吐原始 openai 分帧）", async () => {
    const userId = await setupUser("custom-chat-gate@test.dev", 10);
    const { plaintext } = await setupKey(userId);
    await setupCustomChatProvider(GATE_MODEL);
    await setupPrice(GATE_MODEL, INPUT_PRICE, INPUT_PRICE, INPUT_PRICE / 4, OUTPUT_PRICE, OUTPUT_PRICE);

    const upstreamSse = [
      'data: {"id":"chatcmpl-custom","object":"chat.completion.chunk","created":1700000000,"model":"' + GATE_MODEL + '","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-custom","object":"chat.completion.chunk","created":1700000000,"model":"' + GATE_MODEL + '","choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl-custom","object":"chat.completion.chunk","created":1700000000,"model":"' + GATE_MODEL + '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"chatcmpl-custom","object":"chat.completion.chunk","created":1700000000,"model":"' + GATE_MODEL + '","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}',
      "data: [DONE]",
    ].join("\n\n") + "\n\n";
    stubUpstreamFetch(
      () => new Response(upstreamSse, { headers: { "Content-Type": "text/event-stream" } }),
    );

    const res = await postAnthropic(
      "/anthropic/v1/messages",
      plaintext,
      JSON.stringify({ model: GATE_MODEL, max_tokens: 100, messages: [{ role: "user", content: "hello" }], stream: true }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    // 直通门方言支的判别点：出站必须经过帧级转换（anthropic 事件形态），而非原样透传
    expect(text).toContain("event: message_start");
    expect(text).toContain('"type":"text_delta"');
    expect(text).toContain("event: message_stop");
    expect(text).not.toContain("[DONE]");
    expect(text).not.toContain('"object":"chat.completion.chunk"');
  });
});
