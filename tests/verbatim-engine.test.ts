// verbatim 引擎·请求侧单测（09-28-upstream-custom-type-passthrough 批次 3 + 批次 9 前置）。
// 纯函数、无 Worker、无 DOM。钉 design §4.3 的 7 项注入中**请求侧 5 项**逐项落点 +
// 头方言默认值 + 「verbatim 打面端点而非主端点」的分流判据 +
// responses 面 verbatim 的无状态红线（previous_response_id / conversation → 400）。
//
// 夹具纪律（候选值两两不等，防恒真假绿）：resolved.endpointUrl 的 base 与 cfg.baseUrl
// **刻意不同**（unit-a.test / unit-b.test vs main-endpoint.test）——URL 断言若退化成
// 「contain 某个公共串」就失去判别力；模型名/标记值逐场景互异。
import { describe, expect, it } from "vitest";
import { verbatimRequest } from "../src/providers/verbatim";
import {
  parseResolvedEndpoints,
  type ProviderEndpointRow,
  type ResolvedEndpoint,
} from "../src/providers/endpoints";
import { AdapterError, type ProviderConfig } from "../src/providers/types";

const MAIN_BASE = "https://main-endpoint.test/v1";
const CHAT_FACE_BASE = "https://unit-a.test/v1";
const MSG_FACE_BASE = "https://unit-b.test/anthropic";
const RESP_FACE_BASE = "https://unit-r.test/v1";

/** custom 记录解析出的首个端点（单面声明 ⇒ 恰一个；取不到即夹具损坏，fail-fast）。 */
function firstEndpoint(row: ProviderEndpointRow): ResolvedEndpoint {
  const first = parseResolvedEndpoints(row)[0];
  if (first === undefined) {
    throw new Error("fixture must resolve at least one endpoint");
  }
  return first;
}

/** custom 记录解析出的 chat 面（声明面缺省 policy=verbatim ⇒ openai 方言面端点）。 */
const CHAT_VERBATIM: ResolvedEndpoint = firstEndpoint({
  type: "custom",
  baseUrl: CHAT_FACE_BASE,
  protocols: JSON.stringify({ chat: {} }),
});

/** custom 记录解析出的 messages 面（anthropic 方言，policy=verbatim）。 */
const MSG_VERBATIM: ResolvedEndpoint = firstEndpoint({
  type: "custom",
  baseUrl: MSG_FACE_BASE,
  protocols: JSON.stringify({ messages: {} }),
});

/** custom 记录解析出的 responses 面（policy=verbatim）。
 * 注：FACE_DEFAULT_POLICY.responses = "convert" ⇒ 必须**显式**声明 policy（chat/messages 面缺省即 verbatim，responses 面不缺省）。 */
const RESPONSES_VERBATIM: ResolvedEndpoint = firstEndpoint({
  type: "custom",
  baseUrl: RESP_FACE_BASE,
  protocols: JSON.stringify({ responses: { policy: "verbatim" } }),
});

function cfg(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    type: "openai",
    baseUrl: MAIN_BASE,
    apiKey: "sk-unit-verbatim",
    models: {},
    ...overrides,
  };
}

function upstreamBody(req: ReturnType<typeof verbatimRequest>): Record<string, unknown> {
  return JSON.parse(String(req.init.body)) as Record<string, unknown>;
}

function upstreamHeaders(req: ReturnType<typeof verbatimRequest>): Record<string, string> {
  return req.init.headers as Record<string, unknown> as Record<string, string>;
}

describe("verbatimRequest — URL 分流（verbatim 打面端点，不是主端点）", () => {
  it("URL 恰为 resolved.endpointUrl，与 cfg.baseUrl（convert 的主端点）无关", () => {
    const req = verbatimRequest(
      { model: "m-url", messages: [{ role: "user", content: "hi" }] },
      CHAT_VERBATIM,
      cfg(),
    );
    expect(req.url).toBe("https://unit-a.test/v1/chat/completions");
    expect(req.url).not.toContain("main-endpoint.test");
    expect(req.init.method).toBe("POST");
  });

  it("messages 面 URL 走 anthropicMessagesUrl 规则（/anthropic 基址 + /v1/messages）", () => {
    const req = verbatimRequest(
      { model: "m-url2", max_tokens: 64, messages: [{ role: "user", content: "hi" }] },
      MSG_VERBATIM,
      cfg(),
    );
    expect(req.url).toBe("https://unit-b.test/anthropic/v1/messages");
  });
});

describe("verbatimRequest — 注入逐项（design §4.3 请求侧 5 项）", () => {
  it("注入 1：模型名替换走 resolveModelId（映射命中 / [1m] 别名回退 / 未命中原样）", () => {
    const mapped = cfg({ models: { "alias-in": "alias-up" } });
    // 命中：上游名替换
    expect(
      upstreamBody(
        verbatimRequest(
          { model: "alias-in", messages: [] },
          CHAT_VERBATIM,
          mapped,
        ),
      )["model"],
    ).toBe("alias-up");
    // [1m] 别名回退：剥后缀命中映射，默认不向上游拼回后缀
    expect(
      upstreamBody(
        verbatimRequest(
          { model: "alias-in[1m]", messages: [] },
          CHAT_VERBATIM,
          mapped,
        ),
      )["model"],
    ).toBe("alias-up");
    // 未命中：原样透传（open-set 语义）
    expect(
      upstreamBody(
        verbatimRequest(
          { model: "never-mapped-x", messages: [] },
          CHAT_VERBATIM,
          mapped,
        ),
      )["model"],
    ).toBe("never-mapped-x");
  });

  it("注入 2：`_gateway_` 保留键剥离（其余键一律保留——开集）", () => {
    const body = upstreamBody(
      verbatimRequest(
        {
          model: "m-strip",
          messages: [{ role: "user", content: "hi" }],
          _gateway_reasoning: { effort: "high" },
          _other_vendor_field: "keep-me",
        },
        CHAT_VERBATIM,
        cfg(),
      ),
    );
    expect(body["_gateway_reasoning"]).toBeUndefined();
    expect(body["_other_vendor_field"]).toBe("keep-me");
    expect(body["messages"]).toEqual([{ role: "user", content: "hi" }]);
  });

  it("注入 3：chat 面 + 流式 ⇒ stream_options.include_usage=true 强制注入（已有字段保留）", () => {
    // 未带 stream_options：注入
    const injected = upstreamBody(
      verbatimRequest({ model: "m-inc1", messages: [], stream: true }, CHAT_VERBATIM, cfg()),
    );
    expect((injected["stream_options"] as Record<string, unknown>)["include_usage"]).toBe(true);
    // 已有 stream_options 其他字段：保留（浅拷贝不污染）
    const merged = upstreamBody(
      verbatimRequest(
        { model: "m-inc2", messages: [], stream: true, stream_options: { seq: 7 } },
        CHAT_VERBATIM,
        cfg(),
      ),
    );
    expect(merged["stream_options"]).toEqual({ seq: 7, include_usage: true });
    // 非流式：零变化
    const nonStream = upstreamBody(
      verbatimRequest({ model: "m-inc3", messages: [] }, CHAT_VERBATIM, cfg()),
    );
    expect(nonStream["stream_options"]).toBeUndefined();
  });

  it("注入 3 作用域：messages 面（anthropic 方言）流式**不**注入（message_delta 自带 usage）", () => {
    const body = upstreamBody(
      verbatimRequest(
        { model: "m-inc4", max_tokens: 64, messages: [], stream: true },
        MSG_VERBATIM,
        cfg(),
      ),
    );
    expect(body["stream_options"]).toBeUndefined();
  });

  it("注入 4：reasoning_roundtrip flag off（默认）剥离 assistant 的 reasoning_content；flag on 保留", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok", reasoning_content: "secret-thought" },
    ];
    const stripped = upstreamBody(
      verbatimRequest(
        { model: "m-rr1", messages },
        CHAT_VERBATIM,
        cfg(),
      ),
    );
    expect(stripped["messages"]).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ]);
    const kept = upstreamBody(
      verbatimRequest(
        { model: "m-rr2", messages },
        CHAT_VERBATIM,
        cfg({ reasoningRoundtrip: true }),
      ),
    );
    expect((kept["messages"] as Array<Record<string, unknown>>)[1]?.["reasoning_content"]).toBe(
      "secret-thought",
    );
  });

  it("注入 5：httpOptions 覆盖 headers（含认证头）与 body 字段（同名字段覆盖请求值）", () => {
    const req = verbatimRequest(
      { model: "m-opt1", messages: [], temperature: 0.9 },
      CHAT_VERBATIM,
      cfg({
        httpOptions: {
          userAgent: "unit-agent/1.0",
          headers: { "x-vendor-auth": "vendor-secret", Authorization: "Bearer override-key" },
          body: { temperature: 0.4 },
        },
      }),
    );
    const headers = upstreamHeaders(req);
    expect(headers["x-vendor-auth"]).toBe("vendor-secret");
    // headers 强制覆盖适配器默认认证头
    expect(headers["Authorization"]).toBe("Bearer override-key");
    expect(headers["User-Agent"]).toBe("unit-agent/1.0");
    const body = upstreamBody(req);
    expect(body["temperature"]).toBe(0.4);
  });

  it("开集体：未知顶层字段（随机标记值）逐字到达上游 body", () => {
    const marker = `rnd-${crypto.randomUUID()}`;
    const body = upstreamBody(
      verbatimRequest(
        {
          model: "m-open",
          messages: [{ role: "user", content: "hi" }],
          vendor_marker: { nonce: marker, level: 3 },
          vendor_list: [1, "two", null],
        },
        CHAT_VERBATIM,
        cfg(),
      ),
    );
    expect(body["vendor_marker"]).toEqual({ nonce: marker, level: 3 });
    expect(body["vendor_list"]).toEqual([1, "two", null]);
  });
});

describe("verbatimRequest — 头默认值按端点方言（与两适配器逐字段一致）", () => {
  it("openai 方言：Bearer 认证，无 x-api-key", () => {
    const headers = upstreamHeaders(
      verbatimRequest({ model: "m-h1", messages: [] }, CHAT_VERBATIM, cfg()),
    );
    expect(headers["Authorization"]).toBe("Bearer sk-unit-verbatim");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("anthropic 方言：x-api-key + 固定 anthropic-version 2023-06-01（§5.3 版本锁的请求侧形态）", () => {
    const headers = upstreamHeaders(
      verbatimRequest(
        { model: "m-h2", max_tokens: 64, messages: [] },
        MSG_VERBATIM,
        cfg({ type: "anthropic" }),
      ),
    );
    expect(headers["x-api-key"]).toBe("sk-unit-verbatim");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("分支 3：anthropic 方言 + anthropicBeta → anthropic-beta 逐字注入；openai 方言不注入", () => {
    const beta = "message-threads-2026-08-12, interleaved-thinking-2025-05-14";
    const anthropicHeaders = upstreamHeaders(
      verbatimRequest(
        { model: "m-h3", max_tokens: 64, messages: [] },
        MSG_VERBATIM,
        cfg({ type: "anthropic" }),
        beta,
      ),
    );
    expect(anthropicHeaders["anthropic-beta"]).toBe(beta);

    const openaiHeaders = upstreamHeaders(
      verbatimRequest(
        { model: "m-h3", messages: [] },
        CHAT_VERBATIM,
        cfg(),
        beta,
      ),
    );
    expect(openaiHeaders["anthropic-beta"]).toBeUndefined();
  });

  it("分支 3：httpOptions.headers.anthropic-beta 覆盖客户端值（逃生通道）", () => {
    const headers = upstreamHeaders(
      verbatimRequest(
        { model: "m-h4", max_tokens: 64, messages: [] },
        MSG_VERBATIM,
        cfg({
          type: "anthropic",
          httpOptions: { headers: { "anthropic-beta": "pinned-beta" } },
        }),
        "client-beta",
      ),
    );
    expect(headers["anthropic-beta"]).toBe("pinned-beta");
  });
});

describe("verbatimRequest — Responses 面配对卫生（verbatim 路径）", () => {
  it("孤儿 function_call → 合成 function_call_output；孤儿 output 丢弃", () => {
    const body = upstreamBody(
      verbatimRequest(
        {
          model: "m-resp-hyg",
          input: [
            { type: "function_call", call_id: "call_x", name: "request_permissions", arguments: "{}" },
            { type: "function_call_output", call_id: "call_orphan", output: "stale" },
            { role: "user", content: "continue" },
          ],
        },
        RESPONSES_VERBATIM,
        cfg(),
      ),
    );
    expect(body["input"]).toEqual([
      { type: "function_call", call_id: "call_x", name: "request_permissions", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_x",
        output: "[tool result unavailable: call interrupted]",
      },
      { role: "user", content: "continue" },
    ]);
  });

  it("完整配对 → responses input 逐字节/结构不变（零回归）", () => {
    const input = [
      { type: "function_call", call_id: "call_full", name: "get_time", arguments: "{}" },
      { type: "function_call_output", call_id: "call_full", output: "12:00" },
      { role: "user", content: "hi" },
    ];
    const body = upstreamBody(
      verbatimRequest({ model: "m-resp-hyg2", input }, RESPONSES_VERBATIM, cfg()),
    );
    expect(body["input"]).toEqual(input);
  });
});

describe("verbatimRequest — Chat 面配对卫生（verbatim 路径）", () => {
  it("孤儿 tool_calls 注入合成 tool 响应；孤儿 tool 消息丢弃", () => {
    const body = upstreamBody(
      verbatimRequest(
        {
          model: "m-chat-hyg",
          messages: [
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_chat",
                  type: "function",
                  function: { name: "get_time", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_orphan", content: "stale" },
            { role: "user", content: "hi" },
          ],
        },
        CHAT_VERBATIM,
        cfg(),
      ),
    );
    expect(body["messages"]).toEqual([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_chat",
            type: "function",
            function: { name: "get_time", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_chat",
        content: "[tool result unavailable: call interrupted]",
      },
      { role: "user", content: "hi" },
    ]);
  });

  it("完整配对零改动", () => {
    const messages = [
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
      { role: "user", content: "hi" },
    ];
    const body = upstreamBody(
      verbatimRequest({ model: "m-chat-hyg2", messages }, CHAT_VERBATIM, cfg()),
    );
    expect(body["messages"]).toEqual(messages);
  });
});

describe("verbatimRequest — 无状态红线（批次 9 前置，批次 3 边界 C）", () => {
  // 判别力说明：直接打 verbatimRequest（不经路由）。路由级 400 今天由 proxy.ts「toInternal
  // 无条件先于候选分派」的**伴随路径**先行产生——路由级测试判别不了本守卫是否存在（必要条件
  // 当充分条件的恒真假绿）；本 describe 是「verbatim 路径显式执行红线」的直接判据。
  // 守卫在注入**之前**执行（见 verbatimRequest 内注释），故与注入顺序无耦合。

  it("responses 面 verbatim 带 previous_response_id → AdapterError，文案与 convert 路径逐字节同源", () => {
    const body = { model: "m-rr1", input: "hi", previous_response_id: "resp_prev_unit" };
    // 类钉：proxy 候选循环 catch 靠 instanceof AdapterError 归一 400（类丢 = 500）
    expect(() => verbatimRequest(body, RESPONSES_VERBATIM, cfg())).toThrow(AdapterError);
    // 文案钉：toThrow(error 实例) 断言 message **相等**——两路径共用同一函数同一文案
    expect(() => verbatimRequest(body, RESPONSES_VERBATIM, cfg())).toThrow(
      new AdapterError(
        "previous_response_id is not supported by this gateway; include the full input items in each request (stateless mode)",
      ),
    );
  });

  it("responses 面 verbatim 带 conversation → AdapterError，同函数同文案", () => {
    const body = { model: "m-rr2", input: "hi", conversation: "conv_unit_r" };
    expect(() => verbatimRequest(body, RESPONSES_VERBATIM, cfg())).toThrow(AdapterError);
    expect(() => verbatimRequest(body, RESPONSES_VERBATIM, cfg())).toThrow(
      new AdapterError(
        "conversation is not supported by this gateway; include the full input items in each request (stateless mode)",
      ),
    );
  });

  it("干净体（未知字段 + 随机标记值）→ 不抛且开集体原样保留；URL 恰为该面端点", () => {
    const marker = `rnd-${crypto.randomUUID()}`;
    const req = verbatimRequest(
      { model: "m-rr3", input: "hi", vendor_stateless_probe: marker },
      RESPONSES_VERBATIM,
      cfg(),
    );
    // 红线只看两字段：开集未知字段不拦（responses 面 verbatim 的开集语义同 chat 面）
    expect(upstreamBody(req)["vendor_stateless_probe"]).toBe(marker);
    // responses 面 URL 规则 {base}/responses（endpoints.ts 与探测同款），host 与 convert 主端点两两不等
    expect(req.url).toBe("https://unit-r.test/v1/responses");
    expect(req.url).not.toContain("main-endpoint.test");
  });

  it("红线按面作用域：chat 面 verbatim 带 previous_response_id 不拦（守卫只在 responses 面）", () => {
    const req = verbatimRequest(
      { model: "m-rr4", messages: [], previous_response_id: "resp_chat_scope" },
      CHAT_VERBATIM,
      cfg(),
    );
    // chat 面无状态红线管辖（其入站面是 /v1/chat/completions，红线本就不拦）——face 条件错误会导致本用例变红
    expect(upstreamBody(req)["previous_response_id"]).toBe("resp_chat_scope");
    expect(req.url).toBe("https://unit-a.test/v1/chat/completions");
  });
});
