// verbatim 引擎·请求侧（09-28-upstream-custom-type-passthrough 批次 3，design §4.1/§4.2/§4.3）。
// 开集透传 + 7 项强制注入：不是零变换，也**不是白名单重建** —— rawBody（入站 zod
// passthrough 产物，开集可用）整体上抛，仅做 7 项注入（design §4.3 表逐项复用现函数，
// 迁移时不得丢）：
//   1. 模型名替换（含 `[1m]` 别名解析）      → lib/model-id.ts resolveModelId
//   2. `_gateway_` 保留键剥离               → openai.ts stripGatewayReserved
//   3. 流式 include_usage 注入（**仅 chat 面**：anthropic 面 message_delta、responses 面
//      response.completed 自带 usage）       → openai.ts ensureStreamIncludeUsage（🔴 漏 = 流式零计费）
//   4. reasoning 回传策略（flag off 默认剥离）→ openai.ts stripReasoningRoundtrip
//   5. httpOptions 覆盖（headers/body）      → http-options.ts buildUpstreamHeaders / applyHttpBody
//   6. 响应侧 model 反伪装                  → 调用方 proxy.ts（maskModelInStream / maskModelInData）
//   7. 用量提取                             → 调用方 proxy.ts（adapter.parseUsage ?? extractLooseUsage）
// 分派条件（D2 逐候选，design §4.2）在 proxy.ts 候选循环内：端点 policy === "verbatim" ∧
// 端点方言 === 入站面原生方言（dialectForFace）⇒ 走本函数；否则 adapter.buildRequest 现路径
// 逐字节不变。URL 取 resolved.endpointUrl（主端点规则：verbatim 打**该面端点**，面内 baseUrl
// 缺省继承 base_url，批次 1 解析层已算好），与 convert 打主端点（cand.baseUrl）分流。
// 头默认值与两个适配器逐字段一致（openai=bearer / anthropic=x-api-key + 固定 anthropic-version
// ——版本锁是 §5.3 的取舍，verbatim 请求侧同样固定，不透传客户端 pin）。
// 另有一条面级守卫（非注入项）：responses 面 verbatim 执行无状态红线（previous_response_id /
// conversation → 400，批次 9 前置），见函数内注释。
import type { ProviderConfig, UpstreamRequest } from "./types";
import type { ResolvedEndpoint } from "./endpoints";
import { assertStatelessResponsesBody } from "./responses";
import { resolveModelId } from "../lib/model-id";
import {
  sanitizeResponsesInput,
  sanitizeToolCallPairs,
} from "../lib/tool-call-hygiene";
import {
  ensureStreamIncludeUsage,
  stripGatewayReserved,
  stripReasoningRoundtrip,
} from "./openai";
import { applyHttpBody, buildUpstreamHeaders } from "./http-options";

/**
 * verbatim 上游请求构造：开集体 + 7 项注入（见文件头注释）。
 * 注入顺序与 openai 适配器 buildRequest 逐行同构（strip → model 替换 → reasoning 剥离 →
 * httpOptions body 覆盖 → include_usage），保证「同一请求在 verbatim / convert 两条路上
 * 除既有转换差异外行为一致」。
 */
export function verbatimRequest(
  rawBody: Record<string, unknown>,
  resolved: ResolvedEndpoint,
  cfg: ProviderConfig,
  anthropicBeta?: string,
): UpstreamRequest {
  // 无状态红线（批次 9 前置 / 批次 3 边界 C）：responses 面的 verbatim 路径**显式**执行
  // previous_response_id / conversation 拒绝（与 buildInternalFromResponses 同一函数、同一文案
  // ——「verbatim 400」与「convert 400」不可能漂移成两套措辞）。为什么在这里：
  // ① **去伴随化** —— 今天红线对 verbatim 请求经 proxy.ts「toInternal 无条件先于候选分派」
  //    （:421）伴随生效，若将来 verbatim 候选跳过 toInternal（潜在优化），红线在 verbatim
  //    路径静默消失；本调用让红线不再依赖该结构事实。
  // ② **face ⇔ 入站面等价性** —— D2 分派四要素合取（proxy.ts useVerbatim）含
  //    `endpoint.face === inboundFace`，故进入本函数且 face === "responses" ⇔
  //    inboundFace === "responses"：按 face 条件执行即等价于「responses 入站的 verbatim 路径」。
  // ③ **异常映射 = 400 非 500** —— 本函数由 proxy.ts 在 adapter.buildRequest 同一 try/catch
  //    内调用（:830-846），该 catch 把 AdapterError 归一为 400 `{error:{message}}`，与
  //    toInternalSafe 的 HTTPException(400) 同语义（tests/verbatim-engine.test.ts 直接打
  //    本函数 pin 抛出效果；tests/responses-api.test.ts pin 路由级 400）。
  if (resolved.face === "responses") {
    assertStatelessResponsesBody(rawBody);
  }
  // 注入 1：模型名替换（`[1m]` 别名解析与适配器同源 resolveModelId；缺 model 时按空串
  // 解析不命中映射——入站 schema 均要求 model，此为防御分支）
  const rawModel = typeof rawBody["model"] === "string" ? rawBody["model"] : "";
  const upstreamModel = resolveModelId(cfg.models, rawModel).upstream;
  let body = stripReasoningRoundtrip(
    stripGatewayReserved({ ...rawBody, model: upstreamModel }),
    cfg.reasoningRoundtrip === true,
  );
  // Responses 面 verbatim 不经过 buildInternalFromResponses：在原始 input items 上执行
  // 同一套配对卫生（孤儿 function_call → 合成 output；孤儿 output 丢弃），再交给
  // httpOptions.body 覆盖。非 responses 面零改动。
  if (resolved.face === "responses" && Array.isArray(body["input"])) {
    body = { ...body, input: sanitizeResponsesInput(body["input"]) };
  } else if (resolved.face === "chat" && Array.isArray(body["messages"])) {
    // Chat 面 verbatim（生产 custom providers 的 chat face 为 verbatim）不经过 proxy 的
    // chatToInternal；在原始 messages 上执行同一套配对修复（浅克隆，不污染 rawBody）。
    const messages = (body["messages"] as unknown[]).map((message) => {
      if (!message || typeof message !== "object") return message;
      const copy = { ...(message as Record<string, unknown>) };
      if (Array.isArray(copy["tool_calls"])) {
        copy["tool_calls"] = copy["tool_calls"].map((call) =>
          call && typeof call === "object"
            ? { ...(call as Record<string, unknown>) }
            : call,
        );
      }
      return copy;
    });
    sanitizeToolCallPairs(messages as Record<string, unknown>[]);
    body = { ...body, messages };
  }
  body = applyHttpBody(body, cfg);
  // 注入 3：流式 include_usage（计费兜底，🔴 客户端无权关闭）——仅 chat 面
  if (resolved.face === "chat") {
    body = ensureStreamIncludeUsage(body).body;
  }
  const defaults: Record<string, string> =
    resolved.dialect === "anthropic"
      ? {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          "anthropic-version": "2023-06-01",
          // 分支 3：客户端 beta 头逐字转发（仅 anthropic 方言）；httpOptions.headers
          // 覆盖优先级由 buildUpstreamHeaders 保证。
          ...(anthropicBeta !== undefined ? { "anthropic-beta": anthropicBeta } : {}),
        }
      : {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        };
  return {
    // verbatim 打该面端点（解析层 resolved.endpointUrl；convert 打主端点的行为在
    // adapter.buildRequest 内，未动）
    url: resolved.endpointUrl,
    init: {
      method: "POST",
      // 注入 5：httpOptions 覆盖（headers 同名覆盖默认头含认证头；body 字段覆盖）
      headers: buildUpstreamHeaders(defaults, cfg),
      body: JSON.stringify(body),
    },
  };
}
