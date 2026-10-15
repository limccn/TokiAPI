// 生成本机 usage 页的图表夹具 SQL（09-14 批次 B 验证用）。
//
// 为什么需要它：本机既有 request_logs 行的 created_at 是**毫秒**，而 Drizzle 的
// integer({mode:"timestamp"}) 按**秒**读写 → 那些行对应用呈现为「远未来」，窗口查询一律不命中。
// range 模式的桶聚合直读 request_logs（src/routes/usage/lib/queries.ts），故必须有秒精度的行。
//
// 只增不删：memory `local-d1-fixture-cleanup-toll` 记过 —— 删测试行会连带删掉
// verify-responsive 的数据夹具（AC3 会静默退化成 SKIP）。
//
// 归属可参数化（2026-09-18）：dashboard 走 `/api/me/usage`（**只看当前用户**），故它是否有图表
// 取决于**登录者本人**有没有行 —— 本机 admin@local.dev 是 user 22、原本 0 行，dashboard 恒空态
// （verify-responsive 的 AC3 那 3 条 SKIP 即此）。给它造行用 `FIXTURE_USER_ID=22 FIXTURE_KEY_ID=29`
// （key 29 = local-dev-key，属于 user 22，是真实配对）。usage 页 admin 视角是全站聚合，两者都能看到。
//
// 用法：node scripts/gen-usage-fixture.mjs > fixture.sql
//       npx wrangler d1 execute cf-ai-gateway-db --local --config wrangler.jsonc --file fixture.sql
// 注意：/tmp 在 Git Bash 下会被 node 解析成 d:\tmp，文件请落在工作区内（用完 rm）。

const TZ_OFFSET_MIN = -new Date().getTimezoneOffset(); // 本机为 +480（UTC+8）
const USER_ID = Number(process.env.FIXTURE_USER_ID ?? 29);
const KEY_ID = Number(process.env.FIXTURE_KEY_ID ?? 29);

/** 本地 (daysAgo, 本地小时) → UTC 毫秒（与前端 range.ts 的 dayStartUtcDaysAgo 同公式）。 */
function localSlotMs(daysAgo, hour, minute = 0) {
  const now = new Date();
  const offsetMs = TZ_OFFSET_MIN * 60_000;
  const local = new Date(now.getTime() + offsetMs);
  const dayStartUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate() - daysAgo,
  ) - offsetMs;
  return dayStartUtc + hour * 3_600_000 + minute * 60_000;
}

// [daysAgo, 本地小时, 模型, prompt, completion, cost, status]
// token 量级刻意做大：tokens 柱顶标签走紧凑格式（1.2M），夹具若不达千位就测不出紧凑格式生效。
const ROWS = [
  // 今天（本地）：4 个不同小时 → 柱状图有 4 根可见柱
  [0, 2, "gpt-4o-mini", 125_000, 42_000, 0.1875, "success"],
  [0, 5, "claude-sonnet-4-5", 480_000, 96_000, 1.584, "success"],
  [0, 8, "gpt-4o-mini", 62_000, 18_500, 0.0742, "cached"],
  [0, 11, "claude-opus-4-1", 1_240_000, 310_000, 12.4325, "success"],
  // 昨天
  [1, 3, "gpt-4o-mini", 88_000, 24_000, 0.1206, "success"],
  [1, 9, "deepseek-v3", 210_000, 130_000, 0.3614, "error"],
  [1, 14, "claude-sonnet-4-5", 350_000, 72_000, 1.152, "success"],
  // 更早（覆盖 last14 / last30 的日桶）
  [2, 6, "gpt-4o-mini", 44_000, 12_000, 0.0582, "rejected"],
  [2, 16, "claude-sonnet-4-5", 260_000, 58_000, 0.864, "success"],
  [5, 10, "deepseek-v3", 150_000, 90_000, 0.2685, "success"],
  [12, 7, "gpt-4o-mini", 33_000, 9_000, 0.0431, "success"],
  [20, 13, "claude-opus-4-1", 720_000, 180_000, 7.215, "success"],
];

const nowSec = Math.floor(Date.now() / 1000);
const values = ROWS.map(([daysAgo, hour, model, tin, tout, cost, status], i) => {
  const sec = Math.floor(localSlotMs(daysAgo, hour, 0) / 1000);
  const requestId = `fixture-b-${nowSec}-${i}`;
  return `(${USER_ID}, ${KEY_ID}, '${model}', ${tin}, ${tout}, ${cost}, '${status}', ${sec}, '${requestId}')`;
});

// 不包 BEGIN/COMMIT：Miniflare 的 D1 明确拒绝显式事务（state.storage.transaction() 才是对的），
// 单条 INSERT ... VALUES (...),(...) 本身即原子。
console.log(
  "INSERT INTO request_logs (user_id, key_id, model, prompt_tokens, completion_tokens, cost, status, created_at, request_id) VALUES\n" +
    values.join(",\n") +
    ";",
);
