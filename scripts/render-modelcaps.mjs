// render-modelcaps：seed.sql（权威全量源）→ src/generated/modelcaps.ts（提交入库）。
// O3c（09-11-kv-ops-optimization）：modelcap 常量权威快路径（design.md §3.1）。
// 档位化（09-16 用户裁决）：生成物存**档位**（xlarge 式 1x/2x，null=不限），
// 运行时 cap = MODELCAP_BASE_TOKENS × MODELCAP_MULTIPLIER × 档位（env [vars] 烘焙，
// 默认链 process.env → .dev.vars → 8192/2）。档位按当前常数自 seed 字面值推导，
// 非半档（0.5 的正整数倍）→ fail-fast；改常数需重跑本脚本 + 部署（与改 seed.sql 同流程）。
// 幂等：同输入 → 同输出（键排序稳定）；解析失败 fail-fast（seed.sql 格式严格）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveTier } from "./lib/modelcap-grid.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = resolve(ROOT, "seed.sql");
const OUT_PATH = resolve(ROOT, "src", "generated", "modelcaps.ts");

const DEFAULT_BASE_TOKENS = 8192;
const DEFAULT_MULTIPLIER = 2;

// 解析 .dev.vars（KEY=VALUE + # 注释 + 引号剥离；与 .dev.vars.example 的模板规则一致）。
function parseDotVars(file) {
  const values = {};
  if (!existsSync(file)) return values;
  const text = readFileSync(file, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function positiveInt(name, raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!(Number.isInteger(parsed) && parsed > 0)) {
    console.error(`render-modelcaps: ${name}=${raw} 非法（需正整数）`);
    process.exit(1);
  }
  return parsed;
}

// 行模式：('model', p1, p2, p3, p4, p5, <int|NULL>, unixepoch(), unixepoch())[;]
// 首行表头 `(model, input_price_short, ...)` 跳过；注释 `--` 跳过。
const ROW_RE = /^\s*\('([^']+)',\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*(NULL|\d+)\s*,/;
const HEADER_RE = /^\s*\(model,/;

const caps = new Map();
const lines = readFileSync(SEED_PATH, "utf8").split("\n");

let modelRows = 0;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (line.trim() === "" || line.trim().startsWith("--")) {
    continue;
  }
  if (!line.trim().startsWith("(")) {
    continue;
  }
  if (HEADER_RE.test(line)) {
    continue;
  }
  const m = line.match(ROW_RE);
  if (!m) {
    console.error(`render-modelcaps: seed.sql:${i + 1} 无法解析的 models 行：${line.trim()}`);
    process.exit(1);
  }
  const model = m[1];
  const cap = m[2] === "NULL" ? null : Number.parseInt(m[2], 10);
  if (caps.has(model)) {
    console.error(`render-modelcaps: 模型重复：${model}`);
    process.exit(1);
  }
  if (cap !== null && !(Number.isInteger(cap) && cap > 0)) {
    console.error(`render-modelcaps: 非法 cap：${model} -> ${m[2]}`);
    process.exit(1);
  }
  caps.set(model, cap);
  modelRows += 1;
}

// 档位推导：tier = cap / (base × mult)，非半档 fail-fast（网格外字面值需先改常数或 seed）
const dotVars = parseDotVars(resolve(ROOT, ".dev.vars"));
const baseTokens = positiveInt(
  "MODELCAP_BASE_TOKENS",
  process.env.MODELCAP_BASE_TOKENS ?? dotVars.MODELCAP_BASE_TOKENS,
  DEFAULT_BASE_TOKENS,
);
const multiplier = positiveInt(
  "MODELCAP_MULTIPLIER",
  process.env.MODELCAP_MULTIPLIER ?? dotVars.MODELCAP_MULTIPLIER,
  DEFAULT_MULTIPLIER,
);
const gridSize = baseTokens * multiplier;

const tiers = new Map();
for (const [model, cap] of caps) {
  if (cap === null) {
    tiers.set(model, null);
    continue;
  }
  const tier = deriveTier(cap, gridSize);
  if (tier === null) {
    console.error(
      `render-modelcaps: ${model} cap=${cap} 不在档位网格上（${baseTokens} × ${multiplier} = ${gridSize}，` +
        `档位须为 0.5 的正整数倍，即 ${gridSize / 2} 的整数倍）；` +
        `改 seed.sql 字面值或调整 MODELCAP_BASE_TOKENS/MODELCAP_MULTIPLIER`,
    );
    process.exit(1);
  }
  tiers.set(model, tier);
}

if (modelRows === 0) {
  console.error("render-modelcaps: seed.sql 未解析出任何 models 行");
  process.exit(1);
}

const entries = [...tiers.entries()].sort(([a], [b]) => a.localeCompare(b));
const body = entries.map(([model, tier]) => `  "${model}": ${tier === null ? "null" : tier},`).join("\n");
const content = `// 生成物（勿手改）：scripts/render-modelcaps.mjs 解析 seed.sql 生成。
// 权威源 = seed.sql（全量替换语义）；cap/常数变更 → 重跑 npm run render:modelcaps + 部署。
// O3c（09-11-kv-ops-optimization）：modelcap 常量权威快路径（design.md §3.1）。
// 档位化（09-16 用户裁决）：值为**档位**（xlarge 式，null = 不限）——
//   运行时 cap = MODELCAP_BASE_TOKENS × MODELCAP_MULTIPLIER × 档位
//   （env [vars] 烘焙，缺省 8192 × 2 = 16384 基准；本文件按生成时常数推导档位）。
//   档位为 0.5 的正整数倍（管理台 Max output 下拉提供 0.5x/1x/2x/4x/8x）。
export const MODELCAPS: Record<string, number | null> = {
${body}
};
`;

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, content);
console.log(
  `render-modelcaps: ${modelRows} 个模型 → src/generated/modelcaps.ts（档位网格 ${baseTokens} × ${multiplier}）`,
);
