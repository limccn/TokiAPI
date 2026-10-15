// Usage 页「筛选变更 vs 桶窗口快照」回归锁（随 task 09-14-admin-ui-adjustments-2 批次 A 入库）：
//
//   锁定缺陷（批次 A 复核发现的 P1）：改「状态筛选」**不得**刷新桶窗口快照（nowMs，见 usage.tsx 的 updateFilters）。
//   判据：status 不在图表三路（buckets / byModel / byStatus）的查询键里 → 图表不重取；
//   若此刻仍刷新快照，`buildRangeSeries` 会按新快照推导桶键，与后端**已取**窗口错位 ——
//   平时看不出来（同一本地日内桶键相同），**跨本地午夜**时整体偏移一天 → 图表整片归零。
//
// 为什么是脚本而不是单测：缺陷在「客户端快照 state 与已取数据的耦合」上，纯函数单测覆盖不到，
// 页面也没有 DOM 测试环境。故用真实浏览器构造「跨午夜」这一唯一能暴露它的状态。
//
// 构造法：把页面内 Date.now 整体前推 24h（模拟页面开着跨过本地午夜），
// 再改状态筛选，断言柱状图逐桶与改前**完全一致**。
// 末段做**反方向灵敏度校验**：改 range 会合法刷新快照 → 同样推后下柱图应整片归零；
// 若这一段不归零，说明探针根本没生效（假的 PASS）。
//
// 窗口不写死为 today/yesterday：本机数据会随日期滚动换窗口（实测踩过 —— 前一天还成立的
// 「today 有数据、yesterday 空」在次日整体反号）。故先**发现**哪个逐桶窗口有数据再用它。
// 只认逐桶窗口（today / yesterday）：date 桶窗口（last14 / last30）前推一天仍有 13/14 天命中，
// 不构成灵敏度信号，用了会得到「看起来通过」的假绿。
//
// 本机专用脚本：依赖 playwright（未声明为 devDeps，需 `npm i -D playwright && npx playwright install chromium`）
// 前置：npm run dev 已启动；本地 D1 已有测试用户（历史夹具或走注册页建号）；本机 D1 的 request_logs
//       在 today 或 yesterday 窗口内有数据（页面直读 request_logs，无数据时前置断言会明确报出，
//       不是脚本坏了）。注意 Drizzle integer timestamp 按**秒**存储，写入毫秒值则行对应用不可见。
// 用法：node scripts/verify-usage-filter-snapshot.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
/** 逐桶（hour）窗口 —— 只有这两档在「快照前推一天」下会整体落空。 */
const HOURLY_RANGES = ["today", "yesterday"];

let passed = 0;
let failed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` <- ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  executablePath: "C:/Users/limc/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
});

const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// 聚合三路一律带 limit=1（use-usage-report.ts），明细带 limit=20 ——
// 故 `limit=1` 是「图表重取」的判别式，`status=` 是「明细重取」的判别式。
const usageReqs = [];
page.on("request", (req) => {
  const url = req.url();
  if (/\/api\/(me|admin)\/usage/.test(url)) usageReqs.push(url);
});
const aggregateRefetches = () => usageReqs.filter((u) => /[?&]limit=1(&|$)/.test(u));

/**
 * 「Requests XXXX」卡里那根柱状图的逐桶读数（`<title>` 文本，按桶序）。
 * 从 h3 沿祖先上溯到第一个含柱状图的容器，而非匹配 class —— class 会随样式重构漂移。
 * 返回 null 表示该卡没渲染柱状图（空态）。
 */
const readBars = () =>
  page.evaluate(() => {
    const heading = [...document.querySelectorAll("h3")].find((el) =>
      /^Requests/.test(el.textContent.trim()),
    );
    let card = heading?.parentElement ?? null;
    while (card && !card.querySelector('svg[aria-label="Usage bar chart"]')) card = card.parentElement;
    if (!card) return null;
    return [...card.querySelectorAll('svg[aria-label="Usage bar chart"] g > title')].map((t) =>
      t.textContent.trim(),
    );
  });

/** 选 range 并等到卡片渲染完（冷启动时 1.5s 可能只等到加载态，读数为 null）。 */
const selectRange = async (value) => {
  await page.selectOption("#usage-range", value);
  await page.waitForFunction(() =>
    [...document.querySelectorAll("h3")].some((el) => /^Requests/.test(el.textContent.trim())),
  );
  await page.waitForTimeout(900);
};

const hasNonZero = (bars) =>
  Array.isArray(bars) && bars.length > 0 && bars.some((t) => !/: 0$/.test(t));

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill("#login-email", "admin@local.dev");
await page.fill("#login-password", "local-dev-pass-123");
await page.click('button[type="submit"]');
await page.waitForFunction(() => !location.pathname.startsWith("/login"));
await page.goto(`${BASE}/usage`, { waitUntil: "networkidle" });
await page.waitForSelector("#usage-range");
await page.waitForTimeout(1200);

// ---- 前置：发现一个「服务端有数据」的逐桶窗口 ----
let target = null;
const observed = {};
for (const range of HOURLY_RANGES) {
  await selectRange(range);
  const bars = await readBars();
  observed[range] = bars;
  if (hasNonZero(bars)) {
    target = range;
    break;
  }
}
const describe = (bars) => (Array.isArray(bars) ? `${bars.length} 桶` : "无柱状图（空态）");
check(
  "前置：存在有数据的逐桶窗口",
  target !== null,
  Object.entries(observed)
    .map(([k, v]) => `${k}=${describe(v)}`)
    .join(" "),
);
if (target === null) {
  await browser.close();
  console.log("\n前置不满足：本机 D1 的 request_logs 在 today / yesterday 两个逐桶窗口内都没有数据。");
  console.log("本脚本需要一个「服务端有数据」的窗口才能构造灵敏度信号（空窗口只渲染空态，无从判别）。");
  console.log("请先向本机 D1 写入当前或昨日的用量行后重跑；注意 Drizzle integer timestamp 按**秒**存储。");
  process.exit(1);
}
const before = observed[target];
const otherRange = HOURLY_RANGES.find((r) => r !== target);

// 把页面内 Date.now 前推 24h：此后任何「刷新快照」都会与后端已取窗口错位
await page.evaluate(() => {
  const real = Date.now;
  Date.now = () => real() + 24 * 3600 * 1000;
});

// ① 锁定缺陷：改状态筛选（合法行为 = 只重取明细 + 回第一页，**不动快照**）
usageReqs.length = 0;
await page.selectOption("#usage-status", "error");
await page.waitForTimeout(1200);
const afterStatus = await readBars();
check(
  "P1a 改状态筛选后柱状图逐桶不变（快照未被刷新）",
  JSON.stringify(afterStatus) === JSON.stringify(before),
  `target=${target} before/after=${JSON.stringify(before.slice(0, 2))} / ${JSON.stringify(afterStatus?.slice(0, 2))}`,
);
// P1b 是**伴随**判据不是判别式：把缺陷改回去它照样通过（缺陷在快照，不在请求编排），
// 实测已证。留着是为了把「为什么 P1a 该不动」的机制钉在输出里。
check(
  "P1b 改状态筛选只发明细查询，未重取图表三路",
  aggregateRefetches().length === 0 && usageReqs.some((u) => /[?&]status=error(&|$)/.test(u)),
  `总请求=${usageReqs.length} 聚合重取=${aggregateRefetches().length}`,
);

// ② 灵敏度校验：改 range 会**合法**刷新快照 → 与后端（真实时刻）窗口错位 → 柱图应整片归零。
// 先切走再切回，使「切回」这一步必定触发 onChange（选同一个值不触发），从而必定刷新快照。
await selectRange(otherRange);
await selectRange(target);
const afterShift = await readBars();
const allZero =
  Array.isArray(afterShift) && afterShift.length > 0 && afterShift.every((t) => /: 0$/.test(t));
check(
  "灵敏度：快照被推后后（该窗口服务端有数据）柱图整片归零 —— 证明本探针能识别该失效模式",
  allZero,
  `after=${JSON.stringify(afterShift)}`,
);

await browser.close();

console.log(`\n筛选快照回归锁: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log("失败明细:");
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
