// Provider 适配器契约（design.md §4）。
// 适配器职责：OpenAI 形态内部请求 → 上游请求；上游响应 → OpenAI 形态（含流式 SSE）。
// 注册表：src/providers/index.ts；新增 Provider 类型只需实现本接口。
import type { SseFrameTransform } from "./sse-pipe";

/** 网关内部统一请求形态 = OpenAI 兼容格式。 */
export type EndpointKind = "chat" | "completions" | "embeddings";

export interface InternalRequest {
  kind: EndpointKind;
  /** OpenAI 形态请求体（已过 Zod 校验的 JSON object） */
  body: Record<string, unknown>;
  /** 内部模型名（路由映射的 key） */
  model: string;
  stream: boolean;
  /**
   * Anthropic 入站原始透传字段（R1，仅 anthropic 协议入口填充）：
   * Claude Code 逐请求携带的 thinking / output_config 顶层参数，经此专用通道
   * 绕开内部 OpenAI 形态，由 anthropic 适配器逐字写回上游（不校验形态——
   * 畸形值由上游 400 显式暴露）；openai 适配器不感知（零泄漏）。
   */
  anthropicExtras?: {
    thinking?: unknown;
    output_config?: unknown;
    /** Claude Code message threads（2026-11-02 beta）：convert 路径逐字写回 anthropic 上游。 */
    thread?: unknown;
    /** Claude Code auto mode 服务端评审请求字段：convert 路径逐字写回 anthropic 上游。 */
    safeguards?: unknown;
  };
  /**
   * 客户端 `anthropic-beta` 请求头（逐字，不解析；仅 anthropic 方言上游注入）。
   * 优先级：provider httpOptions.headers["anthropic-beta"] > 本字段（适配器先注入
   * defaults，buildUpstreamHeaders 再套 httpOptions 覆盖）。
   */
  anthropicBeta?: string;
}

/**
 * 高级 HTTP 选项（provider 级，PRD R2）：覆盖上游请求的 User-Agent、
 * 强制覆盖/新增 Header 与 body 字段（厂商适配与附加认证）。
 * headers 值可能含上游认证信息 → DB 中与 apiKey 同规范 AES-GCM 加密存储。
 */
export interface HttpOptions {
  /** 覆盖上游请求 User-Agent（未配置使用默认）。 */
  userAgent?: string;
  /** 新增/强制覆盖上游请求 Header（同名覆盖适配器默认值，含认证头）。 */
  headers?: Record<string, string>;
  /** 新增/强制覆盖上游请求 body 字段（任意 JSON 值，如 temperature）。 */
  body?: Record<string, unknown>;
}

export interface ProviderConfig {
  type: ProviderType;
  baseUrl: string;
  /** 解密后的上游密钥（仅请求构造内存中使用，不落日志） */
  apiKey: string;
  /** 内部模型名 -> 上游模型名 */
  models: Record<string, string>;
  /** 高级 HTTP 选项（未配置为空对象，行为与现状一致）。 */
  httpOptions?: HttpOptions;
  /**
   * 思考模式（R2，providers.thinking_mode 列）：缺省 undefined ≡ auto（自适应线优先）。
   * adaptive → reasoning_effort 映射 output_config:{effort}+thinking:{type:"adaptive"}；
   * budget → reasoning_effort 丢弃 + warn（budget 线仅服务 R1 逐字透传）；
   * off → 保持现状（丢弃）。
   */
  /** thinking_mode（R2 + H3/H6）："adaptive" | "budget" | "off" | null（DB NULL ≡ 不映射）；非法值 → AdapterError。 */
  thinkingMode?: string | null;
  /**
   * reasoning 输入项回传（Workstream B，providers.reasoning_roundtrip 列）：
   * true → 保留 assistant 消息的 reasoning_content（deepseek 思考模式上游要求回传）；
   * false/undefined（默认）→ openai 适配器剥离（上游零变化，现状语义）。
   * 仅 openai 适配器生效；anthropic 适配器白名单构造天然忽略该字段。
   */
  reasoningRoundtrip?: boolean;
  /**
   * 上游超时（毫秒，09-01-stg-glm-ccswitch-fix，providers.upstream_timeout_ms 列）：
   * undefined ≡ 默认 60s（DEFAULT_UPSTREAM_TIMEOUT_MS）。慢模型长生成按 provider 调大。
   */
  upstreamTimeoutMs?: number;
}

export interface UpstreamRequest {
  url: string;
  init: RequestInit;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** 缓存命中输入 tokens（OpenAI cached_tokens / Anthropic cache_read_input_tokens）；缺失按 0 计。 */
  cachedTokens?: number;
}

/** 适配器抛出的格式转换错误 → 网关映射为 400（OpenAI 风格错误体）。 */
export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

export interface ProviderAdapter {
  type: ProviderType;
  /** 是否支持该端点（Anthropic 仅 chat/completions）。 */
  supports(kind: EndpointKind): boolean;
  /** 构造上游请求（含模型名替换与鉴权头）。 */
  buildRequest(req: InternalRequest, cfg: ProviderConfig): UpstreamRequest;
  /**
   * 非流式上游响应 → 网关返回体（OpenAI 形态）。
   * OpenAI 适配器不实现（原样透传）；Anthropic 实现消息格式转换。
   */
  transformResponse?(body: unknown): unknown;
  /** 非流式响应中解析 usage（无法解析返回 null，M4 计费据此决定免计/估算）。 */
  parseUsage(body: unknown): TokenUsage | null;
  /**
   * 流式：从 SSE 尾部 chunk（OpenAI 形态，含 usage 字段）解析用量。
   * 两个适配器的流式变换都会在末尾合成携带 usage 的 chunk。
   */
  parseStreamUsage(tailChunk: unknown): TokenUsage | null;
  /** 上游流式响应体 → OpenAI SSE（OpenAI 透传；Anthropic 逐事件转换）。 */
  transformStreamToOpenAI(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  /**
   * 流式：帧级转换器（R2.4 统一 SsePipe 帧层）——上游 SSE 事件逐帧消费并 enqueue
   * OpenAI 出站字节。OpenAI 透传不实现；Anthropic 实现。代理管线在结算管线上
   * 消费同一批帧（消除重复 decode/parse）。每次调用创建独立状态机。
   */
  createStreamToOpenAI?(): SseFrameTransform;
}

export type ProviderType = "openai" | "anthropic";
