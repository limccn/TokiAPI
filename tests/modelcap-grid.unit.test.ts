// modelcap 档位网格谓词的单测（批次 Q，2026-09-23）。
//
// 被测对象是 scripts/lib/modelcap-grid.mjs —— 特意抽成零依赖纯函数：它同时被 Node 侧的
// scripts/render-modelcaps.mjs import，而 vitest 跑在 Workers pool（workerd）里没有 node:fs，
// 谓词留在那个脚本里就**测不到** —— 这正是把它抽成零依赖文件的原因。
//
// 为什么值得锁：这个谓词是**构建期的唯一闸门**。放宽成「任意正数」= 闸门消失，网格外的 cap
// 会静默进入生成物（管理台的下拉届时选不中任何一项）；收紧回「整数档」= 管理台下拉的 0.5x
// 会让 npm run render:modelcaps 直接 fail-fast（档位表再生不了，须先调常数再放宽谓词）。
// 两个方向都得有断言，否则「改成恒真」也能全绿。
import { describe, expect, it } from "vitest";
import { deriveTier, isGridTier } from "../scripts/lib/modelcap-grid.mjs";

/** 缺省网格：MODELCAP_BASE_TOKENS(8192) × MODELCAP_MULTIPLIER(2)。 */
const GRID = 16384;

describe("isGridTier — 0.5 的正整数倍", () => {
  it("管理台下拉提供的五档全合法：0.5 / 1 / 2 / 4 / 8", () => {
    for (const tier of [0.5, 1, 2, 4, 8]) {
      expect(isGridTier(tier), `档位 ${tier} 应合法`).toBe(true);
    }
  });

  it("半档的其它正整数倍也合法（1.5/3 可被 seed 使用，只是下拉不提供）", () => {
    // 构建侧只管「落不落在网格上」，不管「下拉有没有这一项」——后者是管理台的呈现问题，
    // 由 app/modules/models/display.ts 的档位表 + snapToTier 负责。
    expect(isGridTier(1.5)).toBe(true);
    expect(isGridTier(3)).toBe(true);
  });

  it("非半档一律拒绝：0.25 / 1.3 / 0 / 负数 / NaN / 非数字", () => {
    for (const bad of [0.25, 1.3, 0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(isGridTier(bad), `${String(bad)} 不该合法`).toBe(false);
    }
  });
});

describe("deriveTier — cap → 档位", () => {
  it("网格上：各档与半档都算得出", () => {
    expect(deriveTier(16384, GRID)).toBe(1);
    expect(deriveTier(8192, GRID)).toBe(0.5);
    expect(deriveTier(32768, GRID)).toBe(2);
    expect(deriveTier(65536, GRID)).toBe(4);
    expect(deriveTier(131072, GRID)).toBe(8);
    expect(deriveTier(24576, GRID)).toBe(1.5);
  });

  it("网格外 → null（render-modelcaps 据此 fail-fast）", () => {
    // 16000 是那个自由输入框占位符曾经写着的值：它正是本批次要消灭的形状
    expect(deriveTier(16000, GRID)).toBeNull();
    expect(deriveTier(4096, GRID)).toBeNull();
    expect(deriveTier(8191, GRID)).toBeNull();
    expect(deriveTier(0, GRID)).toBeNull();
    expect(deriveTier(-16384, GRID)).toBeNull();
    expect(deriveTier(Number.NaN, GRID)).toBeNull();
  });

  it("网格由传入常数推导，不写死 16384（grid=8192 时 8192 就是 1x）", () => {
    expect(deriveTier(8192, 8192)).toBe(1);
    expect(deriveTier(16384, 8192)).toBe(2);
    // 4,096 在上面那个用例里是**离网**的（16384 网格上的 0.25x），换 8192 的网格就成了合法的 0.5x
    // —— 同一个 cap 在两个常数下判定相反，正是本条要钉的「网格来自实参」。
    expect(deriveTier(4096, 8192)).toBe(0.5);
    expect(deriveTier(6144, 8192)).toBeNull(); // 0.75x：非半档，换什么常数都不合法
  });
});
