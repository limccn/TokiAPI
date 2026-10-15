// modelcap 档位网格的纯函数（零依赖 —— 无 node:fs / 无外部模块，可被 Workers pool 单测直连 import）。
//
// 为什么单独成文件：scripts/render-modelcaps.mjs 顶层就 readFileSync + process.exit，而 vitest 跑在
// Workers pool（workerd）里没有 node:fs —— 谓词留在那个脚本里就**测不到**。抽到这里才能被
// tests/modelcap-grid.unit.test.ts 直接 import（靠 tsconfig.test.json 的 allowJs 读 .mjs）。

/**
 * 档位是否落在网格上：**0.5 的正整数倍**（0.5x / 1x / 2x / 4x / 8x / 1.5x …）。
 *
 * 为什么是半档而不是整数档（批次 Q，2026-09-23）：管理台的 Max output 下拉提供 0.5x 一档，它是
 * 网格允许的最小步长；仍按「整数档」校验会让 0.5x 的 seed 字面值把 predev/pretest/predeploy
 * 全部 fail-fast。反向也不能放宽成「任意正数」——那等于取消这道闸门，网格外的 cap 会静默进入
 * 生成物，而管理台的下拉届时选不中任何一项。
 */
export function isGridTier(tier) {
  // typeof 先卡一道：`"1" * 2 === 2` 会被 Number.isInteger 放行，而 seed 里解析出的「数字字符串」
  // 一旦漏过 parseInt 就会以字符串身份通过闸门（本谓词的调用方现在都先 parseInt，这是兜底）。
  return typeof tier === "number" && Number.isInteger(tier * 2) && tier > 0;
}

/** cap → 档位；不在网格上返回 `null`（调用方据此 fail-fast）。 */
export function deriveTier(cap, gridSize) {
  const tier = cap / gridSize;
  return isGridTier(tier) ? tier : null;
}
