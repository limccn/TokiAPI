// modelcap 档位乘算（09-16 kv-ops O3c 档位化，用户裁决）：
// MODELCAPS 存档位（xlarge 式 1x/2x，null=不限）；运行时
// cap = MODELCAP_BASE_TOKENS × MODELCAP_MULTIPLIER × 档位。
// 两常数为部署配置 [vars]（缺省 8192 × 2 = 16384 基准；render:modelcaps 读 .dev.vars 同名键 ——
// 档位表是全局的，不分环境）。
// 改常数需重跑 render:modelcaps + 部署（档位按生成时常数推导，design.md §3.1 契约）。
import { MODELCAPS } from "../generated/modelcaps";

export const DEFAULT_MODELCAP_BASE_TOKENS = 8192;
export const DEFAULT_MODELCAP_MULTIPLIER = 2;

/** 正整数解析（env 字符串）；缺失/非法回退默认（部署配置的缺省值已兜底，见 wrangler.jsonc）。 */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface ModelCapLookup {
  /** billingModel 是否在常量中（不在 → 慢路径 D1 权威）。 */
  known: boolean;
  /** 乘算后的 cap（null = 不限）。 */
  cap: number | null;
}

export function modelCapFor(model: string, baseTokens: number, multiplier: number): ModelCapLookup {
  if (!Object.prototype.hasOwnProperty.call(MODELCAPS, model)) {
    return { known: false, cap: null };
  }
  const tier = MODELCAPS[model] ?? null;
  return { known: true, cap: tier === null ? null : baseTokens * multiplier * tier };
}
