// 工具调用配对卫生（分支 1：OpenAI Chat 入站；design §1.2/§1.3b 的共享纯函数）。
// 修复被中断 agent 循环留下的孤儿 tool_calls / tool 消息：
// - 空 call_id 确定性重命名（call_<n>，避开已用 id；空 output 按出现顺序 FIFO 绑定）；
// - 孤儿 tool 消息（无对应 assistant tool_call）→ 丢弃 + 告警；
// - 孤儿 tool_call（无对应 tool 消息）→ 紧随 assistant 的连续 tool 消息块之后注入合成响应；
// - 同一 tool_call_id 的重复 tool 消息 → 首个保留，其余按孤儿丢弃。
// 全部配对完整时数组顺序与对象引用不变（零回归）。
// 另含 Responses 面 verbatim 路径的 input items 版本（sanitizeResponsesInput）——
// verbatim 不经过 buildInternalFromResponses，必须在原始 input 上执行同一套配对修复。
import type { Logger } from "./logger";
import { logger as moduleLogger } from "./logger";

type JsonObject = Record<string, unknown>;

/** 孤儿 tool_call 的合成 tool 响应文案（cc-switch #7504 上游已验证可接受；恒短）。 */
const SYNTHETIC_TOOL_RESULT = "[tool result unavailable: call interrupted]";

export function sanitizeToolCallPairs(
  messages: JsonObject[],
  logger: Logger = moduleLogger,
): void {
  normalizeEmptyToolCallIds(messages);

  // 期望集合 E：assistant tool_calls[].id（全局配对，不依赖顺序）
  const expected = new Set<string>();
  for (const message of messages) {
    if (message["role"] !== "assistant") continue;
    const toolCalls = message["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const callId = (rawCall as JsonObject)["id"];
      if (typeof callId === "string" && callId.length > 0) {
        expected.add(callId);
      }
    }
  }

  // 第一遍：保留配对的 tool 消息（重复 id 只留首个）；孤儿 output 丢弃
  const keptToolIds = new Set<string>();
  const kept: JsonObject[] = [];
  for (const message of messages) {
    if (message["role"] !== "tool") {
      kept.push(message);
      continue;
    }
    const toolCallId = message["tool_call_id"];
    if (
      typeof toolCallId !== "string" ||
      toolCallId.length === 0 ||
      !expected.has(toolCallId) ||
      keptToolIds.has(toolCallId)
    ) {
      logger.warn("orphan_tool_message_dropped", {
        tool_call_id: typeof toolCallId === "string" ? toolCallId : "",
      });
      continue;
    }
    keptToolIds.add(toolCallId);
    kept.push(message);
  }

  // 第二遍：缺失的 tool_call 在该 assistant 的连续 tool 消息块之后注入合成响应
  const syntheticByIndex = new Map<number, JsonObject[]>();
  const synthesized = new Set<string>();
  for (let i = 0; i < kept.length; i++) {
    const message = kept[i];
    if (message === undefined || message["role"] !== "assistant") continue;
    const toolCalls = message["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;
    let insertAt = i + 1;
    while (insertAt < kept.length && kept[insertAt]?.["role"] === "tool") {
      insertAt += 1;
    }
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const callId = (rawCall as JsonObject)["id"];
      if (typeof callId !== "string" || callId.length === 0) continue;
      if (keptToolIds.has(callId) || synthesized.has(callId)) continue;
      synthesized.add(callId);
      const additions = syntheticByIndex.get(insertAt) ?? [];
      additions.push({
        role: "tool",
        tool_call_id: callId,
        content: SYNTHETIC_TOOL_RESULT,
      });
      syntheticByIndex.set(insertAt, additions);
      logger.warn("orphan_tool_call_synthesized", { tool_call_id: callId });
    }
  }

  const sanitized: JsonObject[] = [];
  for (let i = 0; i <= kept.length; i++) {
    const additions = syntheticByIndex.get(i);
    if (additions !== undefined) {
      sanitized.push(...additions);
    }
    const message = kept[i];
    if (message !== undefined) {
      sanitized.push(message);
    }
  }
  messages.splice(0, messages.length, ...sanitized);
}

/**
 * 入站空 call_id 确定性重命名（design §1.3b）：空 call 按出现顺序取 call_<n>（避开已用 id），
 * 空 output 按出现顺序 FIFO 绑定到空 call；多并行空 call 场景属 best-effort
 * （该场景现网关下本已不可用，出站合成修复阻断新空 id 产生）。
 */
function normalizeEmptyToolCallIds(messages: JsonObject[]): void {
  const used = new Set<string>();
  for (const message of messages) {
    if (message["role"] === "tool") {
      const id = message["tool_call_id"];
      if (typeof id === "string" && id.length > 0) {
        used.add(id);
      }
      continue;
    }
    if (message["role"] !== "assistant") continue;
    const toolCalls = message["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const callId = (rawCall as JsonObject)["id"];
      if (typeof callId === "string" && callId.length > 0) {
        used.add(callId);
      }
    }
  }

  let counter = 0;
  const nextId = (): string => {
    let id: string;
    do {
      counter += 1;
      id = `call_${counter}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };

  const emptyCallIds: string[] = [];
  for (const message of messages) {
    if (message["role"] !== "assistant") continue;
    const toolCalls = message["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;
    for (const rawCall of toolCalls) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as JsonObject;
      const callId = call["id"];
      if (typeof callId === "string" && callId.length > 0) continue;
      const assigned = nextId();
      call["id"] = assigned;
      emptyCallIds.push(assigned);
    }
  }

  let fifo = 0;
  for (const message of messages) {
    if (message["role"] !== "tool") continue;
    const callId = message["tool_call_id"];
    if (typeof callId === "string" && callId.length > 0) continue;
    message["tool_call_id"] =
      fifo < emptyCallIds.length ? emptyCallIds[fifo] : nextId();
    fifo += 1;
  }
}

/**
 * Responses 面 verbatim 路径的 input items 配对卫生（design §1.2 的 Responses 形态）。
 * verbatimRequest 开集透传 rawBody，不经过 buildInternalFromResponses；此函数在发送前
 * 对原始 input items 做同一套修复（不依赖顺序，只按 call_id 全局配对）：
 * - 空 call_id 确定性重命名（call_<n>，避开已用 id；空 output FIFO 绑定）；
 * - 孤儿 function_call_output → 丢弃 + 告警；
 * - 孤儿 function_call → 紧随其后注入合成 function_call_output + 告警；
 * - 重复 output call_id → 首个保留。
 * 全部配对完整时数组顺序与对象引用不变（零回归）。
 */
export function sanitizeResponsesInput(
  input: unknown[],
  logger: Logger = moduleLogger,
): unknown[] {
  const items = input.map((item) =>
    item && typeof item === "object" ? { ...(item as JsonObject) } : item,
  );

  // 空 call_id：先收集已用 id，再按出现顺序分配 call_<n>
  const used = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    if (
      record["type"] !== "function_call" &&
      record["type"] !== "function_call_output"
    ) {
      continue;
    }
    const callId = record["call_id"];
    if (typeof callId === "string" && callId.length > 0) {
      used.add(callId);
    }
  }
  let counter = 0;
  const nextId = (): string => {
    let id: string;
    do {
      counter += 1;
      id = `call_${counter}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };
  const emptyCallIds: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    if (record["type"] !== "function_call") continue;
    const callId = record["call_id"];
    if (typeof callId === "string" && callId.length > 0) continue;
    const assigned = nextId();
    record["call_id"] = assigned;
    emptyCallIds.push(assigned);
  }
  let fifo = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    if (record["type"] !== "function_call_output") continue;
    const callId = record["call_id"];
    if (typeof callId === "string" && callId.length > 0) continue;
    record["call_id"] =
      fifo < emptyCallIds.length ? emptyCallIds[fifo] : nextId();
    fifo += 1;
  }

  // 期望集合 E：function_call call_id
  const expected = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    if (record["type"] !== "function_call") continue;
    const callId = record["call_id"];
    if (typeof callId === "string" && callId.length > 0) {
      expected.add(callId);
    }
  }

  // 保留配对 output（重复 id 只留首个）；孤儿 output 丢弃
  const keptOutputIds = new Set<string>();
  const kept: unknown[] = [];
  for (const item of items) {
    if (
      !item ||
      typeof item !== "object" ||
      (item as JsonObject)["type"] !== "function_call_output"
    ) {
      kept.push(item);
      continue;
    }
    const record = item as JsonObject;
    const callId = record["call_id"];
    if (
      typeof callId !== "string" ||
      callId.length === 0 ||
      !expected.has(callId) ||
      keptOutputIds.has(callId)
    ) {
      logger.warn("orphan_responses_output_dropped", {
        call_id: typeof callId === "string" ? callId : "",
      });
      continue;
    }
    keptOutputIds.add(callId);
    kept.push(item);
  }

  // 缺失 output 的 function_call → 紧随其后注入合成 output
  const result: unknown[] = [];
  const synthesized = new Set<string>();
  for (const item of kept) {
    result.push(item);
    if (!item || typeof item !== "object") continue;
    const record = item as JsonObject;
    if (record["type"] !== "function_call") continue;
    const callId = record["call_id"];
    if (typeof callId !== "string" || callId.length === 0) continue;
    if (keptOutputIds.has(callId) || synthesized.has(callId)) continue;
    synthesized.add(callId);
    result.push({
      type: "function_call_output",
      call_id: callId,
      output: SYNTHETIC_TOOL_RESULT,
    });
    logger.warn("orphan_responses_call_synthesized", { call_id: callId });
  }
  return result;
}
