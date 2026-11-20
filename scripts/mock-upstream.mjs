// 本地 mock 上游（M3 验证用，无第三方依赖）：OpenAI 兼容 + Anthropic Messages API 双端点。
// 用法：node scripts/mock-upstream.mjs  （默认端口 8788，可用 MOCK_PORT 覆盖）
// 用途：
//   - OpenAI 兼容面：/openai/v1/{chat/completions,completions,embeddings,models}
//   - Anthropic 面：/anthropic/v1/messages（非流式 + 流式 SSE，含 text 与 tool_use 两种样例）
// 鉴权校验（验证网关正确解密并注入上游密钥）：
//   - OpenAI 面要求 `Authorization: Bearer sk-mock-openai`
//   - Anthropic 面要求 `x-api-key: sk-mock-anthropic`
// 特殊模型：model=error-500 → 恒返回 500（验证网关错误映射）。
// 落点指纹：非流式响应携带 system_fingerprint="mock:<model>"（disguise 层只重写 model/error.message，
// 不触碰该字段）——多上游 E2E 用它在 disguise 生效时区分落点 provider。
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const OPENAI_KEY = "sk-mock-openai";
const ANTHROPIC_KEY = "sk-mock-anthropic";

// 严格 tool 配对校验（E2E 用；MOCK_STRICT_TOOL_PAIRS=1 时复刻真实上游的反向 400）
const STRICT_TOOL_PAIRS = process.env.MOCK_STRICT_TOOL_PAIRS === "1";

// 安全头快照：只记录协议相关头；认证头打码，绝不落明文。
function safeHeaders(req) {
  const out = {};
  for (const key of ["anthropic-beta", "anthropic-version", "content-type", "accept"]) {
    if (typeof req.headers[key] === "string") out[key] = req.headers[key];
  }
  for (const key of ["authorization", "x-api-key"]) {
    if (typeof req.headers[key] === "string") out[key] = "<redacted>";
  }
  return out;
}

// 未识别路径也记录（body=null, unknown=true）：E2E 诊断 404 落点，不影响 lastUpstream 的 body 断言。
function recordUnknown(req, path) {
  recentRequests.push({
    at: Date.now(),
    path,
    method: req.method,
    headers: safeHeaders(req),
    body: null,
    unknown: true,
  });
  if (recentRequests.length > 30) recentRequests.shift();
}

// 最近收到的请求记录（E2E 断言上游 body/headers 用；GET /__requests 可查询，cap 30 条）
const recentRequests = [];
function record(req, body) {
  recentRequests.push({
    at: Date.now(),
    path: req.url,
    method: req.method,
    headers: safeHeaders(req),
    body,
  });
  if (recentRequests.length > 30) recentRequests.shift();
}

/** 严格配对校验：assistant tool_calls 后必须紧跟覆盖全部 id 的 tool 消息。 */
function validateToolPairs(messages) {
  if (!Array.isArray(messages)) return null;
  let pending = new Set();
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
      if (pending.size > 0) return "assistant tool_calls not followed by tool messages";
      pending = new Set(
        message.tool_calls
          .map((call) => call?.id)
          .filter((id) => typeof id === "string" && id.length > 0),
      );
      continue;
    }
    if (message.role === "tool") {
      const id = message.tool_call_id;
      if (typeof id !== "string" || !pending.has(id)) {
        return "tool message without matching tool_calls";
      }
      pending.delete(id);
      continue;
    }
    if (pending.size > 0) return "assistant tool_calls not followed by tool messages";
  }
  return pending.size > 0 ? "assistant tool_calls not followed by tool messages" : null;
}

/** 严格校验 Responses input 的 function_call/output 全局配对（MOCK_STRICT_TOOL_PAIRS=1）。 */
function validateResponsesInput(input) {
  if (!Array.isArray(input)) return null;
  const calls = new Set();
  const outputs = new Set();
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      item.call_id.length > 0
    ) {
      calls.add(item.call_id);
    }
    if (
      item.type === "function_call_output" &&
      typeof item.call_id === "string" &&
      item.call_id.length > 0
    ) {
      outputs.add(item.call_id);
    }
  }
  for (const id of calls) {
    if (!outputs.has(id)) return "function_call without matching function_call_output";
  }
  for (const id of outputs) {
    if (!calls.has(id)) return "function_call_output without matching function_call";
  }
  return null;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendSse(res, events, delayMs = 30) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let i = 0;
  const timer = setInterval(() => {
    if (i >= events.length) {
      clearInterval(timer);
      res.end();
      return;
    }
    const [event, data] = events[i++];
    if (data === null) {
      // 约定：data 为 null 表示发送裸 [DONE] 终止符（OpenAI SSE 结尾）
      res.write("data: [DONE]\n\n");
      return;
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }, delayMs);
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ============ OpenAI 兼容面样例 ============

function openaiChatResponse(body, model) {
  return {
    id: "chatcmpl-mock-openai",
    object: "chat.completion",
    created: nowSeconds(),
    model,
    system_fingerprint: `mock:${model}`,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: `Hello from OpenAI mock (model=${model})`,
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const path = url.pathname;

  try {
    // ---------- 请求记录查询（E2E 断言上游收到体，无鉴权，仅本地 mock） ----------
    if (method === "GET" && path === "/__requests") {
      return sendJson(res, 200, { requests: recentRequests });
    }

    // ---------- OpenAI 兼容面 ----------
    if (path.startsWith("/openai/v1/")) {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${OPENAI_KEY}`) {
        return sendJson(res, 401, { error: { message: "Mock upstream: invalid API key" } });
      }
      // Responses 面 verbatim E2E：记录原始 input items；严格模式校验配对卫生。
      if (method === "POST" && path === "/openai/v1/responses") {
        const body = await readJson(req);
        record(req, body);
        if (STRICT_TOOL_PAIRS) {
          const violation = validateResponsesInput(body?.input);
          if (violation !== null) {
            return sendJson(res, 400, {
              error: { message: `Mock upstream: ${violation}` },
            });
          }
        }
        return sendJson(res, 200, {
          id: "resp_mock_openai",
          object: "response",
          created_at: nowSeconds(),
          status: "completed",
          model: body?.model ?? "gpt-4o-mini",
          output: [
            {
              type: "message",
              id: "msg_mock_openai",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: "Hello from Responses mock",
                  annotations: [],
                },
              ],
            },
          ],
          output_text: "Hello from Responses mock",
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      }
      if (method === "POST" && path === "/openai/v1/chat/completions") {
        const body = await readJson(req);
        record(req, body);
        const model = body?.model ?? "gpt-4o-mini";
        if (STRICT_TOOL_PAIRS) {
          const violation = validateToolPairs(body?.messages);
          if (violation !== null) {
            return sendJson(res, 400, {
              error: {
                message:
                  "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.",
              },
            });
          }
        }
        if (model === "error-500") {
          return sendJson(res, 500, { error: { message: "Mock upstream simulated failure" } });
        }
        // 出站空 call_id 合成测试：返回一个 id="" 的 tool_call（网关必须合成 call_ id）
        if (model === "empty-tool-id") {
          return sendJson(res, 200, {
            id: "chatcmpl-empty-tool-id",
            object: "chat.completion",
            created: nowSeconds(),
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "", type: "function", function: { name: "get_time", arguments: "{}" } },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          });
        }
        if (body?.stream === true) {
          const chunk = (choices, extra) => ({
            id: "chatcmpl-mock-openai",
            object: "chat.completion.chunk",
            created: nowSeconds(),
            model,
            choices,
            ...extra,
          });
          // 思考流样例（09-01 R4 E2E）：模型名含 "reasoning"（openai 入站 + openai 上游，
          // 验证 Responses include 后 reasoning 事件合成）→ 发 reasoning_content 段
          const withReasoning =
            model.includes("reasoning") || body?.reasoning_effort !== undefined;
          const frames = [
            ["message", chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }], {})],
          ];
          if (withReasoning) {
            frames.push(
              ["message", chunk([{ index: 0, delta: { reasoning_content: "Let me reason" }, finish_reason: null }], {})],
              ["message", chunk([{ index: 0, delta: { reasoning_content: " about the plan" }, finish_reason: null }], {})],
            );
          }
          frames.push(
            ["message", chunk([{ index: 0, delta: { content: "Hello from OpenAI mock" }, finish_reason: null }], {})],
            ["message", chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {})],
            ["message", chunk([], { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })],
            ["message", null], // data: [DONE]
          );
          return sendSse(res, frames, 20);
        }
        return sendJson(res, 200, openaiChatResponse(body, model));
      }
      if (method === "POST" && path === "/openai/v1/completions") {
        const body = await readJson(req);
        return sendJson(res, 200, {
          id: "cmpl-mock-openai",
          object: "text_completion",
          created: nowSeconds(),
          model: body?.model ?? "gpt-4o-mini",
          choices: [
            {
              text: `Hello from OpenAI completions mock (prompt=${String(body?.prompt ?? "").slice(0, 20)})`,
              index: 0,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        });
      }
      if (method === "POST" && path === "/openai/v1/embeddings") {
        const body = await readJson(req);
        return sendJson(res, 200, {
          object: "list",
          data: [
            {
              object: "embedding",
              index: 0,
              embedding: [0.1, 0.2, 0.3, 0.4, 0.5],
            },
          ],
          model: body?.model ?? "text-embedding-3-small",
          usage: { prompt_tokens: 3, total_tokens: 3 },
        });
      }
      if (method === "GET" && path === "/openai/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: [
            { id: "gpt-4o-mini", object: "model", created: nowSeconds(), owned_by: "mock" },
            { id: "text-embedding-3-small", object: "model", created: nowSeconds(), owned_by: "mock" },
          ],
        });
      }
      recordUnknown(req, path);
      return sendJson(res, 404, { error: { message: `Mock upstream: not found ${method} ${path}` } });
    }

    // ---------- Anthropic 面 ----------
    if (path.startsWith("/anthropic/v1/")) {
      if (req.headers["x-api-key"] !== ANTHROPIC_KEY) {
        return sendJson(res, 401, { error: { message: "Mock upstream: invalid x-api-key" } });
      }
      if (method === "POST" && path === "/anthropic/v1/messages") {
        const body = await readJson(req);
        record(req, body);
        const model = body?.model ?? "claude-sonnet-4-20250514";
        const stream = body?.stream === true;
        const system = typeof body?.system === "string" ? body.system : "";
        const maxTokens = body?.max_tokens ?? 0;
        const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;

        if (!stream) {
          const response = {
            id: "msg_mock_anthropic",
            type: "message",
            role: "assistant",
            model,
            content: [
              {
                type: "text",
                text: `Hello from Anthropic mock (system=${system}, max_tokens=${maxTokens})`,
              },
            ],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 15 },
          };
          // 请求带 safeguards（Claude Code auto mode）→ 回带哨兵 safeguard_results，
          // 供网关 convert 路径逐字回写断言。
          if (body?.safeguards !== undefined) {
            response.safeguard_results = [
              { type: "safeguard_result", safeguard: "mock", result: "allow" },
            ];
          }
          return sendJson(res, 200, response);
        }

        // 流式样例：有 tools 时走 tool_use 事件序列，否则走纯文本事件序列
        const startEvent = {
          type: "message_start",
          message: {
            id: "msg_mock_anthropic",
            type: "message",
            role: "assistant",
            model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 25, output_tokens: 1 },
          },
        };
        // 思考流样例（09-01 R1/R3a E2E）：请求带 thinking 参数（anthropic 入站，验证 P2a
        // 字节透传）或模型名含 "thinking"（openai 入站 + anthropic 上游，验证 thinking_delta
        // → reasoning_content 转换）→ 发 thinking 事件序列（thinking 块 + signature + text 块）
        if (body?.thinking !== undefined || model.includes("thinking")) {
          return sendSse(
            res,
            [
              ["message_start", startEvent],
              ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me reason" } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about the plan" } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_mock_01" } }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
              ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Hello with thinking" } }],
              ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: " (streamed)" } }],
              ["content_block_stop", { type: "content_block_stop", index: 1 }],
              ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }],
              ["message_stop", { type: "message_stop" }],
            ],
            25,
          );
        }
        if (hasTools) {
          return sendSse(
            res,
            [
              ["message_start", startEvent],
              ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_mock1", name: "get_weather", input: {} } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"city": "Bei' } }],
              ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'jing"}' } }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
              ["message_stop", { type: "message_stop" }],
            ],
            25,
          );
        }
        return sendSse(
          res,
          [
            ["message_start", startEvent],
            ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
            ["ping", { type: "ping" }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello from Anthropic mock" } }],
            ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " (streamed)" } }],
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 15 } }],
            ["message_stop", { type: "message_stop" }],
          ],
          25,
        );
      }
      return sendJson(res, 404, { error: { message: `Mock upstream: not found ${method} ${path}` } });
    }

    recordUnknown(req, path);
    return sendJson(res, 404, { error: { message: `Mock upstream: not found ${method} ${path}` } });
  } catch (error) {
    return sendJson(res, 500, { error: { message: `Mock upstream internal error: ${String(error)}` } });
  }
});

server.listen(PORT, () => {
  console.log(`[mock-upstream] listening on http://127.0.0.1:${PORT}`);
  console.log(`[mock-upstream] openai:  /openai/v1  (Bearer ${OPENAI_KEY})`);
  console.log(`[mock-upstream] anthropic: /anthropic/v1 (x-api-key ${ANTHROPIC_KEY})`);
});
