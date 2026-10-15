// OpenAI Responses API 入站协议适配（D1-D8）：POST /v1/responses ↔ 网关内部 OpenAI Chat Completions 形态。
// 方向与正向适配器相反，不复用其内部函数（R2.4 起流式走统一 SsePipe 帧层）：
// - buildInternalFromResponses：入站 Responses 请求 → 内部 OpenAI chat 形态（OR §2.1 / design §3.2）
// - transformResponseToResponses：内部 chat 响应 → Responses response（OR §2.2 / design §3.3）
// - transformStreamToResponses：上游 OpenAI chat SSE → Responses SSE（OR §1.3/§2.2 / design §3.4）
// 合成 id 统一生成器：resp_（response）/ msg_（message item）/ call_（function_call item）（D8）。
// 拒绝（400）：previous_response_id / conversation（D7：无状态会话，客户端须每轮自带完整 input items）。
// additional_tools（Codex Responses Lite ≥0.149.0 / GPT-5.6 系）：工具 hoist 并入请求级 tools（Bifrost/headroom 同语义），
// carrier item 不产生消息。
// 降级（丢弃 + 告警日志）：store / include / metadata / 内置工具 / 非 function tool_choice 等（OR §4 风险 1）；
// 服务端执行类 input item（web_search_call 等 8 类白名单，DROPPED_INPUT_ITEM_TYPES）。
import type { Logger } from "../lib/logger";
import { logger as moduleLogger } from "../lib/logger";
import { AdapterError } from "./types";
import {
  pipeSseStream,
  type SseEvent,
  type SseFrameTransform,
} from "./sse-pipe";

type JsonObject = Record<string, unknown>;

/** 合成 Responses response id（D8）：resp_ 前缀 + UUID 去连字符（Worker 环境 crypto 可用）。 */
function newResponseId(): string {
  return `resp_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** 合成 message item id（D8）：msg_ 前缀。 */
function newMessageItemId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** 合成 function_call item id（D8）：call_ 前缀。 */
function newFunctionCallId(): string {
  return `call_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** 合成 reasoning item id（R4）：rs_ 前缀（贴近 OpenAI Responses 官方 rs_ 惯例）。 */
function newReasoningItemId(): string {
  return `rs_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** 丢弃字段告警（structured logger，snake_case；不落任何 token 值）。 */
function logDropped(logger: Logger, field: string): void {
  logger.warn("responses_field_dropped", { field });
}

/**
 * reasoning item 回传状态（Codex Responses Lite / GPT-5.6 系多轮历史重放）：
 * 提取的推理文本只挂给下一个 assistant 消息（OpenAI Responses 序列
 * [reasoning, message/function_call] 语义对齐）；下一条非 assistant → 丢弃 + 告警。
 */
interface PendingReasoning {
  /** 待挂载的推理文本（null = 无 pending）。 */
  text: string | null;
}

/**
 * include 白名单（R4）：仅放行 reasoning 可见性项，其余逐项丢弃 + 告警。
 * 白名单命中 → 返回 true（调用方据此设内部保留键 / 出站合成 reasoning 事件）。
 */
export const INCLUDE_REASONING_ALLOWED = new Set([
  "reasoning.summary_text",
  "reasoning.raw",
]);

/**
 * 服务端执行类 input item 白名单（10-14-web-search-call-unsupported）：识别 + 丢弃 + 告警
 * （不再 400，与 tool_search_call 先例同款分支）。这些 item 由上游服务端执行（web search /
 * file search / code interpreter / 图像生成 / MCP），无 Chat 对应物且**无 call_id 配对**
 * （mcp approval 对按 item id 关联、成对丢弃），丢弃不产生孤儿 tool 消息、不损失模型可见语义。
 * item 只经历史重放可达（verbatim 上游服务端执行过 / 历史来自外部后端如 ChatGPT），而 D7
 * 无状态重放 + `toInternal` 先于供应商候选循环（proxy.ts:421）⇒ 400 不可被故障转移自救、
 * 会永久毒化线程，故降级 drop+warn。
 * 配对类型（`computer_call`/`computer_call_output`、`custom_tool_call`/`custom_tool_call_output`）
 * 不入此名单：call_id 成对结构，成对降级需专门设计（孤儿 tool 消息风险），保持 400。
 */
const DROPPED_INPUT_ITEM_TYPES = new Set([
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "image_generation_call",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
]);

export function parseIncludeReasoning(body: JsonObject, logger: Logger): boolean {
  const includes = Array.isArray(body["include"])
    ? body["include"].filter((x): x is string => typeof x === "string")
    : [];
  let includeReasoning = false;
  for (const item of includes) {
    if (INCLUDE_REASONING_ALLOWED.has(item)) {
      includeReasoning = true;
    } else {
      logDropped(logger, `include.${item}`);
    }
  }
  return includeReasoning;
}

/** chat 侧消息 role（developer 归并为 system；OR：Responses developer 即 system 级指令）。 */
function toChatRole(role: unknown): string {
  return role === "developer" ? "system" : String(role);
}

/**
 * 无状态红线（D7）：Responses 服务端会话状态字段（previous_response_id / conversation）任一
 * 存在 → AdapterError（路由层归一 400，提示无状态 input items 用法）。
 *
 * 导出给两处调用（批次 9 前置 / 批次 3 边界 C）：
 * ① `buildInternalFromResponses` 原位（convert 路径，行为逐字节不变）；
 * ② `verbatim.ts verbatimRequest`（verbatim 路径**显式**执行）。
 * 去伴随化的动机：今天红线对 verbatim 请求经 proxy.ts「toInternal 无条件先于候选分派」
 * （:420）伴随生效——若将来 verbatim 候选跳过 toInternal（潜在优化），红线在 verbatim
 * 路径**静默消失**。显式执行让红线不再依赖该结构事实；两处共用同一函数与同一文案，
 * 「verbatim 抛 400」与「convert 抛 400」不可能漂移成两套措辞。
 */
export function assertStatelessResponsesBody(body: JsonObject): void {
  // 拒绝：Responses 服务端会话状态（D7）——Chat 是无状态协议，无法表达 → 400，提示无状态用法
  if (body["previous_response_id"] !== undefined) {
    throw new AdapterError(
      "previous_response_id is not supported by this gateway; include the full input items in each request (stateless mode)",
    );
  }
  if (body["conversation"] !== undefined) {
    throw new AdapterError(
      "conversation is not supported by this gateway; include the full input items in each request (stateless mode)",
    );
  }
}

// ============ 入站转换（Responses 请求 → 内部 OpenAI Chat 形态） ============

/**
 * 入站 Responses 请求 → 内部 OpenAI Chat Completions body（OR §2.1 / design §3.2）。
 * 字段级转换失败抛 AdapterError（路由 toInternalSafe 包装为 400）。
 * logger 可选（默认模块级 logger）：toInternal 注入点无请求上下文，仅用于丢弃告警。
 */
export function buildInternalFromResponses(
  body: JsonObject,
  logger: Logger = moduleLogger,
): JsonObject {
  // 拒绝：Responses 服务端会话状态（D7）——提取为 assertStatelessResponsesBody（verbatim
  // 路径同函数显式执行，见该函数注释）；convert 路径行为逐字节不变
  assertStatelessResponsesBody(body);

  const messages: JsonObject[] = [];
  // additional_tools items（Codex Responses Lite）携带的工具原始定义（hoist 到请求级 tools）
  const extraTools: unknown[] = [];
  // reasoning item 回传（Codex Responses Lite 多轮历史重放）：pendingReasoning 只挂给
  // 下一个 assistant 消息；跨 instructions/input 两次 pushItems 共享同一状态
  const pendingReasoning: PendingReasoning = { text: null };
  // instructions（string | items 数组）→ 顶部 system 消息（OR §2.1：与 input 组合为上下文）
  const instructions = body["instructions"];
  if (typeof instructions === "string") {
    if (instructions.length > 0) {
      messages.push({ role: "system", content: instructions });
    }
  } else if (Array.isArray(instructions)) {
    pushItems(messages, instructions, extraTools, pendingReasoning, logger);
  }

  // input（string 简写 | items 数组）→ messages
  const input = body["input"];
  if (typeof input === "string") {
    if (input.length > 0) {
      messages.push({ role: "user", content: input });
    }
  } else if (Array.isArray(input)) {
    pushItems(messages, input, extraTools, pendingReasoning, logger);
  } else {
    throw new AdapterError("input must be a string or an array of input items");
  }
  // 序列结束仍挂着的 pending（input 尾部 reasoning 后无 assistant 消息）→ 丢弃 + 告警
  dropPendingReasoning(pendingReasoning, logger);

  const internal: JsonObject = { model: body["model"], messages };
  // max_output_tokens → max_completion_tokens（1:1；两者口径一致，都含 reasoning tokens，OR §2.1）
  if (typeof body["max_output_tokens"] === "number") {
    internal["max_completion_tokens"] = body["max_output_tokens"];
  }
  if (typeof body["temperature"] === "number") {
    internal["temperature"] = body["temperature"];
  }
  if (typeof body["top_p"] === "number") {
    internal["top_p"] = body["top_p"];
  }
  // top_logprobs → Chat 需同时置 logprobs:true（OR §2.1；anthropic 上游白名单构造天然丢弃）
  if (typeof body["top_logprobs"] === "number") {
    internal["logprobs"] = true;
    internal["top_logprobs"] = body["top_logprobs"];
  }
  if (body["parallel_tool_calls"] === true || body["parallel_tool_calls"] === false) {
    internal["parallel_tool_calls"] = body["parallel_tool_calls"];
  }
  const tools = buildTools(mergeTools(body["tools"], extraTools), logger);
  if (tools.length > 0) {
    internal["tools"] = tools;
  }
  const toolChoice = buildToolChoice(body["tool_choice"], tools, logger);
  if (toolChoice !== null) {
    internal["tool_choice"] = toolChoice;
  }
  // text.format → response_format（json_schema / json_object；anthropic 上游白名单丢弃，OR §2.1）
  const responseFormat = buildResponseFormat(body["text"], logger);
  if (responseFormat !== null) {
    internal["response_format"] = responseFormat;
  }
  // reasoning.effort → reasoning_effort（summary/context/mode 丢弃，OR §2.1）
  const reasoningEffort = extractReasoningEffort(body["reasoning"], logger);
  if (reasoningEffort !== null) {
    internal["reasoning_effort"] = reasoningEffort;
  }
  if (body["stream"] === true) {
    internal["stream"] = true;
  }
  // R4：include 白名单（reasoning.summary_text / reasoning.raw）→ 内部保留键信号
  // （仅本地消费；openai 适配器剥离 `_gateway_` 前缀字段，不进上游）
  if (parseIncludeReasoning(body, logger)) {
    internal["_gateway_resp_include_reasoning"] = true;
  }

  // 丢弃 + 告警日志（OR §4 风险 1：OpenAI 平台专属参数，网关不承担服务端能力）
  for (const field of [
    "store",
    "metadata",
    "prompt_cache_key",
    "prompt_cache_options",
    "prompt_cache_retention",
    "moderation",
    "service_tier",
    "background",
    "prompt",
    "context_management",
    "truncation",
    "safety_identifier",
    "user",
    "stream_options",
    // client_metadata（Codex 恒发 x-codex-turn-metadata 对应的顶层字段）：纯 telemetry，
    // 无功能语义 → 丢弃 + 告警（Codex Responses Lite 全量适配）
    "client_metadata",
  ]) {
    if (body[field] !== undefined) {
      logDropped(logger, field);
    }
  }

  return internal;
}

/** input items 数组 → messages（逐条防御性转换；服务端执行类白名单 DROPPED_INPUT_ITEM_TYPES
 *  → drop+warn；其余不识别 item 类型 → 400）。
 *  extraTools：additional_tools items（Codex Responses Lite）携带的工具原始定义收集处。
 *  pendingReasoning：reasoning item 提取文本的挂载状态（只挂给下一个 assistant 消息）。 */
function pushItems(
  messages: JsonObject[],
  items: unknown[],
  extraTools: unknown[],
  pendingReasoning: PendingReasoning,
  logger: Logger,
): void {
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") {
      continue;
    }
    const item = rawItem as JsonObject;
    const type = item["type"];
    if (type === undefined || type === "message") {
      pushMessageItem(messages, item, pendingReasoning, logger);
    } else if (type === "function_call") {
      pushFunctionCallItem(messages, item, pendingReasoning);
    } else if (type === "function_call_output") {
      // 非 assistant item → 未消费的 pending 丢弃（reasoning 只挂 assistant 消息）
      dropPendingReasoning(pendingReasoning, logger);
      pushFunctionCallOutputItem(messages, item);
    } else if (type === "reasoning") {
      // 推理项（Codex 多轮历史全量重放）：提取文本挂 pendingReasoning，由下一条
      // assistant 消息回传为 reasoning_content（thinking round-trip，Workstream B）；
      // summary/raw 皆缺 → 丢弃 + 告警（降级，语义与现一致）
      collectReasoningText(pendingReasoning, item, logger);
    } else if (type === "additional_tools") {
      // Codex Responses Lite（Codex ≥0.149.0 / GPT-5.6 系）：工具随 input[0] 承载、
      // 顶层 tools 置 null → hoist 到请求级工具列表（同 Bifrost/headroom），carrier 不产生消息
      dropPendingReasoning(pendingReasoning, logger);
      collectAdditionalTools(extraTools, item, logger);
    } else if (type === "tool_search_call" || type === "tool_search_output") {
      // tool_search 工具被网关丢弃 → 上游不产 call → 正常无回放；防御性降级（不再 400）：
      // 历史重放若带此类项，识别 + 丢弃 + 告警（理由记录：丢弃后发现工具丢失可接受，路径不可达）
      dropPendingReasoning(pendingReasoning, logger);
      logDropped(logger, `${type}_item`);
    } else if (typeof type === "string" && DROPPED_INPUT_ITEM_TYPES.has(type)) {
      // 服务端执行类 item（web_search_call 等 8 类白名单）：无 Chat 对应物且无 call_id 配对 →
      // 识别 + 丢弃 + 告警（不再 400）；与 tool_search 先例同款：pending reasoning 一并丢弃
      // （reasoning 只挂 assistant 消息）。与 tool_search 分支理由不同：白名单是真实可达路径的降级
      dropPendingReasoning(pendingReasoning, logger);
      logDropped(logger, `${type}_item`);
    } else {
      // computer_call / custom_tool_call 等配对类型与真正未识别类型：无法映射 → 400
      // （配对类型成对降级需专门设计——孤儿 tool 消息风险比显式 400 更糟，fail-closed 保留）
      throw new AdapterError(
        `Unsupported input item type '${String(type)}'`,
      );
    }
  }
}

/**
 * additional_tools item → 提取 tools 原始定义供请求级 hoist（Codex Responses Lite）。
 * 无 tools 数组 → 丢弃 + 告警（无工具可提升）。
 *
 * Functions 命名空间平面化：lite 契约把全部 function/freeform 工具包装进
 * `{type:"namespace", name:"functions", tools:[...]}`（子工具保持真实平名，
 * responses_lite.rs 断言 `{type:"function", name:"exec"}`）——不平面化则 hoist 后
 * 上游 tools 为空（= Codex #31894 症状在网关复现）。仅 functions 命名空间提取；
 * web / tool_search / collaboration 等命名空间保持原样 → buildTools 白名单丢弃 + 告警
 * （Codex 客户端执行语义 / 加密多智能体，chat 上游无对应物，Azure 剥离实践）。
 */
function collectAdditionalTools(
  extraTools: unknown[],
  item: JsonObject,
  logger: Logger,
): void {
  const rawTools = item["tools"];
  if (Array.isArray(rawTools)) {
    for (const tool of rawTools) {
      if (isFunctionsNamespace(tool)) {
        flattenFunctionsNamespace(extraTools, tool as JsonObject, logger);
      } else {
        extraTools.push(tool);
      }
    }
  } else {
    logDropped(logger, "additional_tools.tools");
  }
}

/** `{type:"namespace", name:"functions"}` 判定（lite 契约的可调工具包装容器）。 */
function isFunctionsNamespace(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") {
    return false;
  }
  const t = raw as JsonObject;
  return t["type"] === "namespace" && t["name"] === "functions";
}

/**
 * functions 命名空间 → 递归提取 `type:"function"` 叶子进 extraTools（平名直用，
 * 不包装不回填；重名由 mergeTools 既有按名去重处理）。子 namespace 递归（防御性，
 * lite 契约实际扁平）；其余类型（web/tool_search 等）→ 丢弃 + 告警。
 */
function flattenFunctionsNamespace(
  extraTools: unknown[],
  ns: JsonObject,
  logger: Logger,
): void {
  const sub = ns["tools"];
  if (!Array.isArray(sub)) {
    logDropped(logger, "additional_tools.namespace.tools");
    return;
  }
  let extracted = 0;
  for (const leaf of sub) {
    if (!leaf || typeof leaf !== "object") {
      continue;
    }
    const l = leaf as JsonObject;
    if (l["type"] === "function") {
      extraTools.push(leaf);
      extracted += 1;
    } else if (l["type"] === "namespace") {
      flattenFunctionsNamespace(extraTools, l, logger);
    } else {
      logDropped(
        logger,
        `additional_tools.namespace.${String(l["type"] ?? "unknown")}`,
      );
    }
  }
  if (extracted === 0) {
    logDropped(logger, "additional_tools.namespace.functions_empty");
  }
}

/**
 * reasoning item → 提取推理文本挂 pending（summary 数组取首个非空 summary_text.text——
 * 网关 R4 出站生成形态，Codex 原样回放；raw string 兜底）。皆缺 → 丢弃 + 告警。
 */
function collectReasoningText(
  pending: PendingReasoning,
  item: JsonObject,
  logger: Logger,
): void {
  const summary = item["summary"];
  if (Array.isArray(summary)) {
    for (const s of summary) {
      if (s && typeof s === "object") {
        const block = s as JsonObject;
        if (
          block["type"] === "summary_text" &&
          typeof block["text"] === "string" &&
          block["text"].length > 0
        ) {
          pending.text = block["text"];
          return;
        }
      }
    }
  }
  const raw = item["raw"];
  if (typeof raw === "string" && raw.length > 0) {
    pending.text = raw;
    return;
  }
  logDropped(logger, "reasoning_item (no summary/raw text)");
}

/** 未消费的 pending（下一条非 assistant 消息 / 序列结束）→ 丢弃 + 告警。 */
function dropPendingReasoning(pending: PendingReasoning, logger: Logger): void {
  if (pending.text !== null) {
    logDropped(logger, "reasoning_item (no following assistant message)");
    pending.text = null;
  }
}

/** assistant 消息挂载点：pending 非空 → 附 reasoning_content 并清空（只挂一次）。 */
function attachReasoningText(
  msg: JsonObject,
  pending: PendingReasoning,
): void {
  if (pending.text === null) {
    return;
  }
  msg["reasoning_content"] = pending.text;
  pending.text = null;
}

/**
 * 顶层 tools 与 additional_tools items 携带的工具合并（按函数名去重，顶层优先）。
 * Codex #31894 修复后存在顶层 + additional_tools 双写场景；去重防上游重复工具定义。
 */
function mergeTools(toolsRaw: unknown, extraTools: unknown[]): unknown[] {
  const result: unknown[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const tool = raw as JsonObject;
    if (tool["type"] === "function" && typeof tool["name"] === "string") {
      if (seen.has(tool["name"])) {
        return;
      }
      seen.add(tool["name"]);
    }
    result.push(raw);
  };
  if (Array.isArray(toolsRaw)) {
    for (const tool of toolsRaw) {
      push(tool);
    }
  }
  for (const tool of extraTools) {
    push(tool);
  }
  return result;
}

/** message item（role user/assistant/system/developer + content）→ 对应 role 消息。 */
function pushMessageItem(
  messages: JsonObject[],
  item: JsonObject,
  pendingReasoning: PendingReasoning,
  logger: Logger,
): void {
  const role = item["role"];
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "system" &&
    role !== "developer"
  ) {
    throw new AdapterError(`Unsupported message role '${String(role)}'`);
  }
  const chatRole = toChatRole(role);
  const content = item["content"];
  if (typeof content === "string") {
    const msg: JsonObject = { role: chatRole, content };
    finalizeMessage(msg, chatRole, pendingReasoning, logger);
    messages.push(msg);
    return;
  }
  if (Array.isArray(content)) {
    const textParts: string[] = [];
    const parts: unknown[] = [];
    let hasImage = false;
    for (const block of content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as JsonObject;
      const type = b["type"];
      if (type === "input_text") {
        if (typeof b["text"] === "string") {
          textParts.push(b["text"]);
        }
      } else if (type === "input_image") {
        const image = inputImageToImageUrl(b, logger);
        if (image !== null) {
          parts.push(image);
          hasImage = true;
        }
      } else if (type === "input_file") {
        // input_file → Chat 无直接对应物（file_id 需服务端文件存储）→ 丢弃 + 告警
        logDropped(logger, "input_file");
      } else {
        // 其他内容块（output_text/reasoning_text 等回放形态）：非输入语义，丢弃 + 告警
        logDropped(logger, `content_block_${String(type)}`);
      }
    }
    if (textParts.length === 0 && parts.length === 0) {
      return; // 全丢弃 → 不产生消息（pending 保留：未消费，语义无漂移）
    }
    if (hasImage) {
      // 含图片 → parts 数组（text 块前置；与 anthropic 正向适配器内容块语义一致）
      if (textParts.length > 0) {
        parts.unshift(...textParts.map((text) => ({ type: "text", text })));
      }
      const msg: JsonObject = { role: chatRole, content: parts };
      finalizeMessage(msg, chatRole, pendingReasoning, logger);
      messages.push(msg);
    } else {
      // 纯文本：input_text 多块拼接为单条字符串（OR §2.1：Chat choices 无法表达多块）
      const msg: JsonObject = { role: chatRole, content: textParts.join("") };
      finalizeMessage(msg, chatRole, pendingReasoning, logger);
      messages.push(msg);
    }
    return;
  }
  if (content !== undefined && content !== null) {
    throw new AdapterError(
      "Message item content must be a string or an array of content blocks",
    );
  }
}

/**
 * 消息入队前的 reasoning 挂载/清理：assistant → 附 pending（只挂一次）；非 assistant
 * （user/system/developer）→ pending 丢弃 + 告警（reasoning 序列后跟非 assistant 消息）。
 */
function finalizeMessage(
  msg: JsonObject,
  chatRole: string,
  pendingReasoning: PendingReasoning,
  logger: Logger,
): void {
  if (chatRole === "assistant") {
    attachReasoningText(msg, pendingReasoning);
  } else {
    dropPendingReasoning(pendingReasoning, logger);
  }
}

/**
 * input_image 块 → image_url part（url 直透上游，网关不代拉取 → 无 SSRF 面）；
 * file_id（需服务端文件存储）→ 丢弃 + 告警。
 */
function inputImageToImageUrl(block: JsonObject, logger: Logger): unknown | null {
  const imageUrl = block["image_url"];
  if (typeof imageUrl === "string" && imageUrl.length > 0) {
    return { type: "image_url", image_url: { url: imageUrl } };
  }
  if (block["file_id"] !== undefined) {
    logDropped(logger, "input_image.file_id");
  }
  return null;
}

/** function_call item → assistant 消息 tool_calls（连续多个合并为一条 assistant 消息，避免交错）。 */
function pushFunctionCallItem(
  messages: JsonObject[],
  item: JsonObject,
  pendingReasoning: PendingReasoning,
): void {
  const name = item["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new AdapterError("function_call item requires a 'name'");
  }
  const callId = typeof item["call_id"] === "string" ? item["call_id"] : "";
  const args = item["arguments"];
  const argumentsRaw = typeof args === "string" ? args : JSON.stringify(args ?? {});
  const toolCall: JsonObject = {
    id: callId,
    type: "function",
    function: { name, arguments: argumentsRaw },
  };
  const last = messages[messages.length - 1];
  if (
    last !== undefined &&
    last["role"] === "assistant" &&
    last["content"] === null &&
    Array.isArray(last["tool_calls"])
  ) {
    // 合并进既有 assistant 消息：首个 function_call 已消费 pending（幂等 no-op）
    attachReasoningText(last, pendingReasoning);
    (last["tool_calls"] as unknown[]).push(toolCall);
    return;
  }
  const msg: JsonObject = { role: "assistant", content: null, tool_calls: [toolCall] };
  attachReasoningText(msg, pendingReasoning);
  messages.push(msg);
}

/** function_call_output item → tool 消息（output 数组 → JSON.stringify，OR §2.1）。 */
function pushFunctionCallOutputItem(
  messages: JsonObject[],
  item: JsonObject,
): void {
  const callId = typeof item["call_id"] === "string" ? item["call_id"] : "";
  const output = item["output"];
  messages.push({
    role: "tool",
    tool_call_id: callId,
    content:
      typeof output === "string" ? output : JSON.stringify(output ?? ""),
  });
}

/**
 * tools（扁平 FunctionTool）→ Chat 嵌套形态（{type:"function", function:{...}}）。
 * strict 从顶层挪入 function.strict（OR §2.1）；非 function 工具（内置工具）丢弃 + 告警（D7）。
 */
function buildTools(toolsRaw: unknown, logger: Logger): JsonObject[] {
  if (!Array.isArray(toolsRaw)) {
    return [];
  }
  const tools: JsonObject[] = [];
  for (const raw of toolsRaw) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const tool = raw as JsonObject;
    if (tool["type"] !== "function") {
      logDropped(logger, `tool_${String(tool["type"] ?? "unknown")}`);
      continue;
    }
    const name = tool["name"];
    if (typeof name !== "string" || name.length === 0) {
      continue;
    }
    const parametersRaw = tool["parameters"];
    const parameters =
      parametersRaw && typeof parametersRaw === "object" && !Array.isArray(parametersRaw)
        ? parametersRaw
        : { type: "object", properties: {} };
    const fn: JsonObject = { name, parameters };
    if (typeof tool["description"] === "string") {
      fn["description"] = tool["description"];
    }
    if (tool["strict"] === true || tool["strict"] === false) {
      fn["strict"] = tool["strict"];
    }
    // output_schema / allowed_callers / defer_loading：Chat 无对应物，丢弃（不进白名单 body）
    tools.push({ type: "function", function: fn });
  }
  return tools;
}

/**
 * tool_choice 映射（OR §2.1 / D7）：
 *   "auto" / "none" → 直通；"required" → 直通（无工具时降级 auto 防上游 400）；
 *   {type:"function",name} → {type:"function",function:{name}}（函数不在工具列表时降级 auto）；
 *   其他形态（custom/mcp/allowed_tools 等）→ 降级 auto + 告警。未提供 → null（不输出）。
 */
function buildToolChoice(
  toolChoice: unknown,
  tools: JsonObject[],
  logger: Logger,
): unknown {
  if (toolChoice === undefined || toolChoice === null) {
    return null;
  }
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto" || toolChoice === "none") {
      return toolChoice;
    }
    if (toolChoice === "required") {
      if (tools.length === 0) {
        logger.warn("responses_tool_choice_downgraded", { from: "required", to: "auto" });
        return "auto";
      }
      return "required";
    }
    logger.warn("responses_tool_choice_downgraded", { from: toolChoice, to: "auto" });
    return "auto";
  }
  if (typeof toolChoice === "object" && !Array.isArray(toolChoice)) {
    const tc = toolChoice as JsonObject;
    if (tc["type"] === "function") {
      const name = tc["name"];
      if (typeof name !== "string" || name.length === 0) {
        throw new AdapterError("tool_choice {type:'function'} requires a 'name'");
      }
      const names = new Set(
        tools.map((t) => {
          const f = t["function"];
          return f && typeof f === "object"
            ? String((f as JsonObject)["name"] ?? "")
            : "";
        }),
      );
      if (!names.has(name)) {
        // 指定函数不在最终工具列表（或工具全被丢弃）→ 降级 auto（避免上游 400）
        logger.warn("responses_tool_choice_downgraded", { from: `function:${name}`, to: "auto" });
        return "auto";
      }
      return { type: "function", function: { name } };
    }
    // 其他形态（custom / mcp / shell / apply_patch / allowed_tools）：降级 auto + 告警（D7）
    logger.warn("responses_tool_choice_downgraded", {
      from: `type:${String(tc["type"] ?? "unknown")}`,
      to: "auto",
    });
    return "auto";
  }
  return null;
}

/** text.format → response_format（json_schema / json_object；其余格式丢弃 + 告警）。 */
function buildResponseFormat(text: unknown, logger: Logger): unknown {
  if (!text || typeof text !== "object") {
    return null;
  }
  const format = (text as JsonObject)["format"];
  if (!format || typeof format !== "object") {
    return null;
  }
  const f = format as JsonObject;
  const type = f["type"];
  if (type === "json_schema") {
    const schema = f["schema"];
    if (!schema || typeof schema !== "object") {
      throw new AdapterError("text.format json_schema requires a 'schema' object");
    }
    const jsonSchema: JsonObject = {
      name: typeof f["name"] === "string" ? f["name"] : "response_schema",
      schema,
    };
    if (f["strict"] === true || f["strict"] === false) {
      jsonSchema["strict"] = f["strict"];
    }
    if (typeof f["description"] === "string") {
      jsonSchema["description"] = f["description"];
    }
    return { type: "json_schema", json_schema: jsonSchema };
  }
  if (type === "json_object") {
    return { type: "json_object" };
  }
  if (type !== "text") {
    logDropped(logger, `text.format_${String(type)}`);
  }
  return null; // "text" 为默认格式，无映射
}

/** reasoning.effort → reasoning_effort；summary/context/mode 丢弃 + 告警（OR §2.1）。 */
function extractReasoningEffort(reasoning: unknown, logger: Logger): string | null {
  if (!reasoning || typeof reasoning !== "object") {
    return null;
  }
  const r = reasoning as JsonObject;
  const effort = r["effort"];
  for (const field of ["summary", "context", "mode"]) {
    if (r[field] !== undefined) {
      logDropped(logger, `reasoning.${field}`);
    }
  }
  return typeof effort === "string" && effort.length > 0 ? effort : null;
}

// ============ 非流式出站转换（内部 chat 响应 → Responses response） ============

/** OpenAI finish_reason → Responses status（OR §2.2 映射表；refusal → completed + refusal 块）。 */
function mapToResponsesStatus(finishReason: unknown): "completed" | "incomplete" {
  switch (finishReason) {
    case "length":
    case "content_filter":
      return "incomplete";
    default:
      return "completed"; // stop / tool_calls / refusal / null
  }
}

function mapToIncompleteDetails(finishReason: unknown): JsonObject {
  return finishReason === "length"
    ? { reason: "max_output_tokens" }
    : { reason: "content_filter" };
}

/**
 * OpenAI 形态 usage → Responses 形态（OR §1.2 对照）：
 * input_tokens ← prompt_tokens；output_tokens ← completion_tokens（已含 reasoning，不重复加）；
 * details 按上游实际值透传（cached_tokens / cache_write_tokens / reasoning_tokens）。
 * 缺 prompt/completion → null（免计路径，不伪造 usage）。
 */
export function toResponsesUsage(usage: JsonObject): JsonObject | null {
  const prompt = usage["prompt_tokens"];
  const completion = usage["completion_tokens"];
  if (typeof prompt !== "number" || typeof completion !== "number") {
    return null;
  }
  const total = usage["total_tokens"];
  const result: JsonObject = {
    input_tokens: prompt,
    output_tokens: completion,
    total_tokens: typeof total === "number" ? total : prompt + completion,
  };
  const promptDetails = usage["prompt_tokens_details"];
  if (promptDetails && typeof promptDetails === "object") {
    const d = promptDetails as JsonObject;
    const inputDetails: JsonObject = {};
    if (typeof d["cached_tokens"] === "number") {
      inputDetails["cached_tokens"] = d["cached_tokens"];
    }
    if (typeof d["cache_write_tokens"] === "number") {
      inputDetails["cache_write_tokens"] = d["cache_write_tokens"];
    }
    if (Object.keys(inputDetails).length > 0) {
      result["input_tokens_details"] = inputDetails;
    }
  }
  const completionDetails = usage["completion_tokens_details"];
  if (completionDetails && typeof completionDetails === "object") {
    const d = completionDetails as JsonObject;
    if (typeof d["reasoning_tokens"] === "number") {
      result["output_tokens_details"] = { reasoning_tokens: d["reasoning_tokens"] };
    }
  }
  return result;
}

/**
 * 内部/上游 OpenAI chat.completion 响应 → Responses response（OR §2.2 / design §3.3）。
 * 仅取首 choice；model 优先用入站内部模型名（D2；路由层从原始 body 提取后传入，缺失时回退上游 model）。
 * includeReasoning（R4）：入站 include 命中白名单时，上游 message.reasoning_content →
 * reasoning item（放 message 之前——上游 reasoning 先于 content 生成，贴近真实顺序）。
 */
export function transformResponseToResponses(
  data: unknown,
  model = "",
  includeReasoning = false,
): unknown {
  if (!data || typeof data !== "object") {
    return data;
  }
  const response = data as JsonObject;
  const choices = response["choices"];
  const choice =
    Array.isArray(choices) && choices.length > 0 && typeof choices[0] === "object"
      ? (choices[0] as JsonObject)
      : null;
  const message = choice?.["message"];
  const m = message && typeof message === "object" ? (message as JsonObject) : null;
  const finishReason = choice?.["finish_reason"];
  const status = mapToResponsesStatus(finishReason);

  const output: JsonObject[] = [];
  // R4：reasoning item（仅 include 请求 + 上游带 reasoning_content；summary_text 取原文，
  // raw 与 summary_text 同内容——网关上游无 summary/raw 区分，取同一文本）
  const reasoningText = m?.["reasoning_content"];
  if (
    includeReasoning &&
    typeof reasoningText === "string" &&
    reasoningText.length > 0
  ) {
    output.push({
      type: "reasoning",
      id: newReasoningItemId(),
      summary: [{ type: "summary_text", text: reasoningText }],
      status: "completed",
    });
  }

  // message item（恒定存在，content 数组恒定非空语义 —— D8：SDK 断言 content 数组结构）
  const content: JsonObject[] = [];
  const text = m?.["content"];
  if (typeof text === "string" && text.length > 0) {
    content.push({ type: "output_text", text, annotations: [] });
  }
  const refusal = m?.["refusal"];
  if (typeof refusal === "string" && refusal.length > 0) {
    content.push({ type: "refusal", refusal });
  }
  // item 级 status 与 response 级同步（OR §1.2：message item 可为 completed/incomplete）：
  // 截断（length/content_filter）→ incomplete，其余 → completed
  const itemStatus = status === "completed" ? "completed" : "incomplete";
  output.push({
    type: "message",
    id: newMessageItemId(),
    status: itemStatus,
    role: "assistant",
    content,
  });

  // tool_calls → function_call items（每条 tool_call 一个 item；id/call_id 同源，OR §1.2 两字段都收）
  const toolCalls = m?.["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") {
        continue;
      }
      const call = rawCall as JsonObject;
      const fn = call["function"];
      if (!fn || typeof fn !== "object") {
        continue;
      }
      const f = fn as JsonObject;
      if (typeof f["name"] !== "string") {
        continue;
      }
      const callId = typeof call["id"] === "string" ? call["id"] : "";
      const args = f["arguments"];
      output.push({
        type: "function_call",
        id: callId,
        call_id: callId,
        name: f["name"],
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        status: "completed",
      });
    }
  }

  const outputText = content
    .filter((block) => block["type"] === "output_text")
    .map((block) => String(block["text"] ?? ""))
    .join("");

  const result: JsonObject = {
    id: newResponseId(),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model:
      model.length > 0
        ? model
        : typeof response["model"] === "string"
          ? response["model"]
          : "",
    output,
    output_text: outputText,
  };
  if (status === "completed") {
    result["completed_at"] = Math.floor(Date.now() / 1000);
  } else {
    result["incomplete_details"] = mapToIncompleteDetails(finishReason);
  }
  const usage = response["usage"];
  if (usage && typeof usage === "object") {
    const converted = toResponsesUsage(usage as JsonObject);
    if (converted !== null) {
      result["usage"] = converted;
    }
  }
  return result;
}

// ============ 流式出站转换（上游 OpenAI chat SSE → Responses SSE） ============

interface MessageItemState {
  id: string;
  outputIndex: number;
  contentIndex: number;
  text: string;
}

interface ToolItemState {
  id: string;
  outputIndex: number;
  callId: string;
  name: string;
  arguments: string;
}

interface ReasoningItemState {
  id: string;
  outputIndex: number;
  text: string;
}

/**
 * 上游 OpenAI chat.completion.chunk SSE 事件 → Responses SSE 帧转换（OR §1.3/§2.2 /
 * design §3.4 状态机；R2.4 统一 SsePipe 帧层，消除转换器自有 decode/parse）。
 * 事件序列：response.created → response.in_progress → output_item.added → content_part.added →
 * output_text.delta×N →（finish）output_text.done → content_part.done → output_item.done →
 * response.completed（usage 换算并入）→ 流终止（无 [DONE]、无 event: 行，纯 data: JSON 帧）。
 * 工具流：output_item.added（function_call）→ function_call_arguments.delta×N →
 * function_call_arguments.done → output_item.done。
 * D8：所有事件携带 sequence_number（单调递增）；item_id/output_index/content_index 齐全；
 * message item 恒含 content 数组；status 显式（completed/incomplete/failed）。
 * 异常兜底（OR §4 风险 3）：流在未收到 finish_reason 时结束 → 尽力合成 response.failed；
 * 上游 error data 块 → error 事件（SDK 收到即抛，流终止）。
 * 每次调用创建独立状态机；consume 返回 false 后 pump 继续排空上游（结算由 pump 拥有，
 * 响应不早于结算关闭——旧实现用注释规避的 settle 竞态由此从构造上消除）。
 * includeReasoning（R4）：true 时上游 delta.reasoning_content → reasoning 输出项事件序列
 * （output_item.added → reasoning_summary_text.delta×N → done → output_item.done）；
 * false（缺省）→ 零回归，reasoning_content 不产生任何事件。
 */
export function createStreamToResponsesTransform(
  includeReasoning = false,
): SseFrameTransform {
  const encoder = new TextEncoder();
  const responseId = newResponseId();
  const createdAt = Math.floor(Date.now() / 1000);
  let model = "";
  let sequenceNumber = 0;
  let started = false;
  let terminated = false;
  let finishReason: string | null = null;
  let usageData: JsonObject | null = null;
  let messageItem: MessageItemState | null = null;
  const toolItems = new Map<number, ToolItemState>();
  let reasoningItem: ReasoningItemState | null = null;
  let nextOutputIndex = 0;
  const output: JsonObject[] = [];
  let itemsClosed = false;

  function enqueue(
    controller: ReadableStreamDefaultController<Uint8Array>,
    type: string,
    payload: JsonObject,
  ): void {
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type, sequence_number: sequenceNumber++, ...payload })}\n\n`,
      ),
    );
  }

  /** response 快照（D8：status 显式；in_progress 阶段 output 为空数组，终态带完整 output）。 */
  function responseSnapshot(status: string): JsonObject {
    return {
      id: responseId,
      object: "response",
      created_at: createdAt,
      status,
      model,
      output: status === "in_progress" ? [] : [...output],
    };
  }

  function sendStart(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (started) {
      return;
    }
    started = true;
    enqueue(controller, "response.created", { response: responseSnapshot("in_progress") });
    enqueue(controller, "response.in_progress", { response: responseSnapshot("in_progress") });
  }

  /** 关闭所有未完成 item（幂等）：done 系列事件 + 累积终态 output。 */
  function closeItems(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (itemsClosed) {
      return;
    }
    itemsClosed = true;
    // R4：reasoning item 最先关闭（outputIndex 最先分配——上游 reasoning 先于 content）
    if (reasoningItem !== null) {
      const { id, outputIndex, text } = reasoningItem;
      enqueue(controller, "response.reasoning_summary_text.done", {
        item_id: id,
        output_index: outputIndex,
        text,
      });
      const reasoningDone: JsonObject = {
        type: "reasoning",
        id,
        summary: text.length > 0 ? [{ type: "summary_text", text }] : [],
        status: "completed",
      };
      enqueue(controller, "response.output_item.done", {
        item: reasoningDone,
        output_index: outputIndex,
      });
      output.push(reasoningDone);
    }
    if (messageItem !== null) {
      const { id, outputIndex, contentIndex, text } = messageItem;
      enqueue(controller, "response.output_text.done", {
        item_id: id,
        output_index: outputIndex,
        content_index: contentIndex,
        text,
      });
      enqueue(controller, "response.content_part.done", {
        item_id: id,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: "output_text", text, annotations: [] },
      });
      // item 级 status 与 response 级同步（OR §1.2）：finish_reason length/content_filter →
      // response incomplete，message item 亦为 incomplete；null（无 finish）按 completed（内容已完整输出）
      const itemStatus =
        mapToResponsesStatus(finishReason) === "completed" ? "completed" : "incomplete";
      const doneItem: JsonObject = {
        type: "message",
        id,
        status: itemStatus,
        role: "assistant",
        content:
          text.length > 0
            ? [{ type: "output_text", text, annotations: [] }]
            : [],
      };
      enqueue(controller, "response.output_item.done", {
        item: doneItem,
        output_index: outputIndex,
      });
      output.push(doneItem);
    }
    for (const tool of toolItems.values()) {
      enqueue(controller, "response.function_call_arguments.done", {
        item_id: tool.id,
        output_index: tool.outputIndex,
        name: tool.name,
        arguments: tool.arguments,
      });
      const doneItem: JsonObject = {
        type: "function_call",
        id: tool.id,
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
        status: "completed",
      };
      enqueue(controller, "response.output_item.done", {
        item: doneItem,
        output_index: tool.outputIndex,
      });
      output.push(doneItem);
    }
  }

  /** 终态事件（completed / incomplete）：usage 换算并入；流终止（无 [DONE]，D3）。 */
  function sendTerminal(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (terminated) {
      return;
    }
    terminated = true;
    const status = mapToResponsesStatus(finishReason);
    const snapshot = responseSnapshot(status);
    if (usageData !== null) {
      snapshot["usage"] = usageData;
    }
    if (status === "completed") {
      snapshot["completed_at"] = Math.floor(Date.now() / 1000);
      enqueue(controller, "response.completed", { response: snapshot });
    } else {
      snapshot["incomplete_details"] = mapToIncompleteDetails(finishReason);
      enqueue(controller, "response.incomplete", { response: snapshot });
    }
  }

  /** 上游异常中段兜底：尽力合成 response.failed（SDK 对缺终态事件的流报错，OR §4 风险 3）。 */
  function sendFailed(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: string,
  ): void {
    if (terminated) {
      return;
    }
    terminated = true;
    const snapshot = responseSnapshot("failed");
    snapshot["error"] = { code: "server_error", message };
    enqueue(controller, "response.failed", { response: snapshot });
  }

  function sendErrorEvent(
    controller: ReadableStreamDefaultController<Uint8Array>,
    message: unknown,
  ): void {
    if (terminated) {
      return;
    }
    terminated = true;
    enqueue(controller, "error", {
      code: null,
      message: typeof message === "string" ? message : "Upstream stream error",
      param: null,
    });
  }

  function pushText(
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): void {
    if (messageItem === null) {
      messageItem = {
        id: newMessageItemId(),
        outputIndex: nextOutputIndex++,
        contentIndex: 0,
        text: "",
      };
      enqueue(controller, "response.output_item.added", {
        item: {
          type: "message",
          id: messageItem.id,
          status: "in_progress",
          role: "assistant",
          content: [],
        },
        output_index: messageItem.outputIndex,
      });
      enqueue(controller, "response.content_part.added", {
        item_id: messageItem.id,
        output_index: messageItem.outputIndex,
        content_index: messageItem.contentIndex,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    messageItem.text += text;
    enqueue(controller, "response.output_text.delta", {
      item_id: messageItem.id,
      output_index: messageItem.outputIndex,
      content_index: messageItem.contentIndex,
      delta: text,
    });
  }

  /** R4：reasoning_content 段 → reasoning 输出项事件（首次建项 + added，逐段 delta）。 */
  function pushReasoning(
    controller: ReadableStreamDefaultController<Uint8Array>,
    text: string,
  ): void {
    if (reasoningItem === null) {
      reasoningItem = {
        id: newReasoningItemId(),
        outputIndex: nextOutputIndex++,
        text: "",
      };
      enqueue(controller, "response.output_item.added", {
        item: {
          type: "reasoning",
          id: reasoningItem.id,
          summary: [],
          status: "in_progress",
        },
        output_index: reasoningItem.outputIndex,
      });
    }
    reasoningItem.text += text;
    enqueue(controller, "response.reasoning_summary_text.delta", {
      item_id: reasoningItem.id,
      output_index: reasoningItem.outputIndex,
      delta: text,
    });
  }

  function pushToolCall(
    controller: ReadableStreamDefaultController<Uint8Array>,
    rawCall: JsonObject,
  ): void {
    const toolIndex = typeof rawCall["index"] === "number" ? rawCall["index"] : 0;
    const fn = rawCall["function"];
    const fnObj = fn && typeof fn === "object" ? (fn as JsonObject) : null;
    const fnName = fnObj !== null && typeof fnObj["name"] === "string" ? fnObj["name"] : "";
    const fnArgs = fnObj !== null ? fnObj["arguments"] : undefined;
    const callId = typeof rawCall["id"] === "string" ? rawCall["id"] : "";

    let tool = toolItems.get(toolIndex);
    if (tool === undefined) {
      tool = {
        id: newFunctionCallId(),
        outputIndex: nextOutputIndex++,
        callId,
        name: fnName.length > 0 ? fnName : `tool_${toolIndex}`,
        arguments: "",
      };
      toolItems.set(toolIndex, tool);
      enqueue(controller, "response.output_item.added", {
        item: {
          type: "function_call",
          id: tool.id,
          call_id: tool.callId,
          name: tool.name,
          arguments: "",
          status: "in_progress",
        },
        output_index: tool.outputIndex,
      });
    }
    if (typeof fnArgs === "string" && fnArgs.length > 0) {
      tool.arguments += fnArgs;
      enqueue(controller, "response.function_call_arguments.delta", {
        item_id: tool.id,
        output_index: tool.outputIndex,
        delta: fnArgs,
      });
    }
  }

  function handleEvent(
    event: SseEvent,
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    const data = event.data;
    if (data === null) {
      // [DONE] / 空事件：上游已终止 → 关闭 item 并发送终态（无 [DONE] 输出，D3）
      closeItems(controller);
      sendTerminal(controller);
      return;
    }
    if (typeof data !== "object" || Array.isArray(data)) {
      return; // ping / 未知事件 / 非 JSON 帧（容错跳过，不打断流）
    }
    const obj = data as JsonObject;
    // 模型名取自首 chunk（上游模型名；response 快照使用）
    const chunkModel = obj["model"];
    if (typeof chunkModel === "string" && chunkModel.length > 0 && model.length === 0) {
      model = chunkModel;
    }
    // 流内错误通知（OpenAI 形态 {error:{message}}）
    const err = obj["error"];
    if (err && typeof err === "object") {
      sendErrorEvent(controller, (err as JsonObject)["message"]);
      return;
    }
    // usage 尾包（choices 空数组或并入 finish chunk）：记录换算结果；finish 后立即终态
    const usage = obj["usage"];
    if (usage && typeof usage === "object") {
      const converted = toResponsesUsage(usage as JsonObject);
      if (converted !== null) {
        usageData = converted;
      }
      if (finishReason !== null) {
        sendTerminal(controller);
      }
    }

    const choices = obj["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      return; // usage 尾包已处理
    }
    const choice = choices[0];
    if (!choice || typeof choice !== "object") {
      return;
    }
    if (finishReason !== null) {
      return; // finish 之后的 chunk（不应出现）防御性忽略
    }
    sendStart(controller);

    const delta = (choice as JsonObject)["delta"];
    if (delta && typeof delta === "object") {
      const d = delta as JsonObject;
      const content = d["content"];
      if (typeof content === "string" && content.length > 0) {
        pushText(controller, content);
      }
      // R4：上游 delta.reasoning_content → reasoning 事件（仅 include 请求）
      const reasoning = d["reasoning_content"];
      if (includeReasoning && typeof reasoning === "string" && reasoning.length > 0) {
        pushReasoning(controller, reasoning);
      }
      const toolCallsRaw = d["tool_calls"];
      if (Array.isArray(toolCallsRaw)) {
        for (const rawCall of toolCallsRaw) {
          if (!rawCall || typeof rawCall !== "object") {
            continue;
          }
          pushToolCall(controller, rawCall as JsonObject);
        }
      }
    }

    const chunkFinish = (choice as JsonObject)["finish_reason"];
    if (typeof chunkFinish === "string") {
      finishReason = chunkFinish;
      closeItems(controller);
      // 终态延后：usage 尾包（下一 chunk）携带精确 usage；无尾包时 [DONE]/流结束兜底
    }
  }

  return {
    consume(event, controller) {
      handleEvent(event, controller);
      // 终态后 pump 继续排空上游（不投喂）；结算由 pump 拥有，响应不早于结算关闭
      return !terminated;
    },
    onError(error, controller) {
      const message = error instanceof Error ? error.message : "Upstream stream error";
      sendErrorEvent(controller, message); // 输出 error 事件后由 pipe 正常关闭（旧语义）
    },
    onEnd(controller) {
      // 上游流结束（无论是否收到 [DONE]）：若尚未终态，尽力合成（OR §4 风险 3）
      if (!terminated) {
        closeItems(controller);
        if (finishReason !== null) {
          sendTerminal(controller);
        } else {
          sendFailed(controller, "Upstream stream ended without a finish_reason");
        }
      }
    },
  };
}

/**
 * 上游 OpenAI chat SSE 字节流 → Responses SSE（字节级包装，供 corner 路径
 * （anthropic 上游）使用；主路径由代理管线直接消费 createStreamToResponsesTransform 的帧）。
 */
export function transformStreamToResponses(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return pipeSseStream(body, { transform: createStreamToResponsesTransform() });
}
