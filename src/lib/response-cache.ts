// 响应缓存（M4 4.5）：规范化请求体 hash → KV 缓存（仅非流式）。
// 缓存键 = keyId + model + 规范化 body hash（R7.2：键含 Key 隔离，避免不同 Key 路由到
// 不同 Provider 时串缓存）；命中直接返回（不转发、不扣费），TTL 由 key.cacheTtl 控制。
// R2（08-31-perf-v2）：触发条件收窄 —— 只缓存「小上下文窗口（请求体 ≤ MAX_CACHE_BODY_BYTES）
// ∧ 高频重传（同键 10min 窗口内出现 ≥ CACHE_HIT_THRESHOLD 次）」的响应；一次性大请求不写 KV。
import { hashToken } from "./security";

const CACHE_PREFIX = "resp:";

/** 缓存评估前置过滤：请求体序列化长度超过该阈值 → 跳过整个缓存评估（不 hash、不读 KV、不计数、不写）。 */
export const MAX_CACHE_BODY_BYTES = 32 * 1024;

/** 高频重传阈值：同缓存键（keyId+model+bodyHash）在窗口内出现次数 ≥ 该值才写缓存。 */
export const CACHE_HIT_THRESHOLD = 2;

/** 计数窗口（秒）：热度计数的时间分桶（O2 起为 isolate 内分桶，非 KV TTL）；翻转清零，重传热度需重新累积。 */
export const CACHE_HIT_WINDOW_SECONDS = 600;

/**
 * 全局响应缓存总开关（09-03-stg-cache-investigation）：CACHE_ENABLED env（部署配置 [vars]，缺省 false）为
 * true/1/yes/on（大小写不敏感）才允许缓存参与；缺省/其他值 = 关闭 —— 即使 key.cacheEnabled=true
 * 也不命中/不写入。默认关闭：缓存是新机制，按环境显式开启（wrangler.jsonc 缺省 false，本地 .dev.vars 可覆盖）。
 */
export function isGlobalCacheEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/** 递归规范化 JSON：object key 排序、array 逐项、原始值原样，保证等价请求体哈希一致。 */
export function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeJson(item));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, normalizeJson(item)] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

/** 规范化请求体 → sha256 hex（缓存键主体）。 */
export async function hashRequestBody(body: Record<string, unknown>): Promise<string> {
  return hashToken(JSON.stringify(normalizeJson(body)));
}

/**
 * 缓存键 = 协议前缀（默认空，协议间隔离如 "anthropic:"）+ keyId + model + body hash。
 * prefix 参数为末尾可选，向后兼容既有 3 参调用（现有端点键逐字节不变）。
 */
export function buildCacheKey(
  keyId: number,
  model: string,
  bodyHash: string,
  prefix = "",
): string {
  return `${CACHE_PREFIX}${prefix}${keyId}:${model}:${bodyHash}`;
}

/**
 * 高频重传计数键（未命中路径）：keyId + model + bodyHash（与缓存键同粒度的热度指纹）。
 * H11：prefix 参数与 buildCacheKey 同语义（协议分支隔离计数——不同协议的同一请求体
 * 热度不得共享，否则一种协议的重传会触发另一种协议的缓存写）。prefix 为末尾可选，
 * 向后兼容既有 3 参调用（现有端点键逐字节不变）。
 */
export function buildCountKey(
  keyId: number,
  model: string,
  bodyHash: string,
  prefix = "",
): string {
  return `cachecnt:${prefix}${keyId}:${model}:${bodyHash}`;
}

/**
 * 未命中路径计数（R2；O2 改造 09-11-kv-ops-optimization）：本次出现次数 +1 并与阈值比较。
 * isolate 模块级 Map（0 KV 操作）——advisory 信号，isolate 回收计数丢失可接受
 * （缓存填充略延迟；现状 KV 版本也有传播延迟）。
 * - 未达阈值 → 仅计数，返回 false；
 * - 达到阈值 → 清零计数，返回 true（调用方在响应成功后写缓存）。
 * 窗口 = CACHE_HIT_WINDOW_SECONDS，按 600s 时间分桶；翻转后计数清零（重传热度需重新累积，
 * 与旧 KV TTL 版本同量级近似）。
 */
const missCounts = new Map<string, { windowStart: number; count: number }>();

export function bumpCacheMissCount(countKey: string): boolean {
  const windowStart =
    Math.floor(Date.now() / (CACHE_HIT_WINDOW_SECONDS * 1000)) * CACHE_HIT_WINDOW_SECONDS;
  const existing = missCounts.get(countKey);
  // 缺失或窗口翻转 → 重置计数（陈旧条目惰性清理）
  const next = existing && existing.windowStart === windowStart ? existing.count + 1 : 1;
  if (next >= CACHE_HIT_THRESHOLD) {
    missCounts.delete(countKey);
    return true;
  }
  missCounts.set(countKey, { windowStart, count: next });
  return false;
}

/** 测试隔离：清空模块级计数状态。 */
export function resetMissCountsForTest(): void {
  missCounts.clear();
}

export async function getCachedResponse(
  kv: KVNamespace,
  cacheKey: string,
): Promise<unknown | null> {
  const raw = await kv.get(cacheKey);
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 非流式响应缓存体积阈值（R3）：超过则跳过 KV 缓存（照常返回）。远低于 KV 25MB 上限，
 * 避免 waitUntil 内 JSON.stringify 大响应的内存/CPU 峰值。
 */
export const MAX_CACHE_RESPONSE_BYTES = 5 * 1024 * 1024;

export async function setCachedResponse(
  kv: KVNamespace,
  cacheKey: string,
  data: unknown,
  ttlSeconds: number,
): Promise<void> {
  // R3：data 为已序列化字符串时直接写入（避免双重 stringify 的瞬时峰值）
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  await kv.put(cacheKey, payload, { expirationTtl: ttlSeconds });
}
