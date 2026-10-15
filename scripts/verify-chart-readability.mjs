// 图表可读性回归锁（随 task 09-14-admin-ui-adjustments-2 批次 B 入库）：
//
//   锁四条**渲染契约**（都是「不报错、只是看起来不对」的一类缺陷，纯函数单测覆盖不到，
//   页面也没有 DOM 测试环境，只能用真实浏览器量测）：
//     ① x 轴刻度密度（AC15）：刻度数恒落 [4,6] 且**首尾桶必有标签**。
//        旧实现 `labelEvery = barWidth < 20 ? 2 : 1` 是**按柱宽**定密度 —— 24 桶 @1440 时
//        barWidth ≈ 29 会算出「不抽稀」，24 个标签全挤在一起（用户报的「x 轴过于密集」即此）。
//     ② 环形图图例**恒并排**且可用（AC17）：图例换到环图下方是缺陷而非降级。
//        **构造性验证推翻了原假设**：规划时以为承重的是「去掉 flex-wrap」，实测不是 ——
//        把 flex-wrap 加回去，本脚本的并排断言**照样全 PASS**，因为真正承重的是
//        DonutChart 的**宽度预算自适应收缩**（按容器宽反算，先给图例留够 LEGEND_MIN_WIDTH，
//        余量才是环图能占的宽度）。图例既然总有位置，flex-wrap 就永不触发，成了死代码。
//        故本组的强锁是「**数值未跑出卡片右边界**」：去掉宽度预算后它在 375 下转 FAIL
//        （实测：图例被压到 46px，label 压成 0 宽、数值 64px 溢出）。
//        而「svg 与 ul 的 y 区间重叠」是一条**负向锁** —— 它只在「有人加回 flex-wrap
//        **且** 同时去掉宽度预算」时才可能失败，判别力弱；留着的用途是「加回去必须有人知道」
//        （与 scripts/verify-responsive.mjs 的 AC5 `position !== sticky` 同类）。
//        宽度预算有**适用前提**：容器 ≥ MIN_SIZE + 图例保底 + 间距。补这条不变量时抓到一个
//        真缺陷：三分栏断点原本是 lg（1024），而那恰好也是**侧栏出现**的断点，两者叠加把
//        1/3 卡内容盒压到 **174px** → 图例 70px、序列名 0 宽（名字完全不可见），与 375 那个
//        缺陷同源。修法是把 usage 页三分栏推到 xl（1280，内容盒实测 259.7px），1024~1279
//        退回单列。故本组新增「图例实得 ≥ 118 且序列名未压成 0 宽」断言，并把 1024 与 1280
//        都纳入视口清单 —— 断点被改回 lg 时它会立刻红。
//     ③ 数值格式（AC16）：Spend 柱顶标签小数位 ≤ 3；tokens 柱顶走紧凑格式；
//        图例数值**永不截断**（可以截名字，不能截数字）。
//        **批次 H 订正**：柱顶标签的**有无**改锁「严格由柱宽阈值 14 决定」这条不变量。
//        原先只在标签**存在**时校验格式、不存在时打一行「既有降级规则，非本批改动」放行 ——
//        二分栏后柱宽从 ~30 掉到 10~17，降级成了**常态**，那行日志随之变成**假话**
//        （标签消失正是本批改动导致的）。同时补上「标签降级后数值仍在 `<title>` 里且格式不变」，
//        这是用户接受「对半分 + 标签消失」的前提：数据可无损取回（见 usage.tsx 的批次 H 注）。
//     ④ 柱图与同排环图等高（AC18，2026-09-18 追加；批次 H 扩到**全视口**）：三张柱状图由 240
//        降到 152，与环形图的 `size` 同值。锁法是「= 152」+「= 环图实际渲染高度」两条互补。
//        原先只在 1440 断言（三分栏时代 1280~1439 环图被图例挤小、本就不同高，是使用方接受的
//        权衡）；批次 H 改成二分栏后环图列宽翻倍，**该坏带消失**（实测 1280 环图 117.7 → 152），
//        故断言放开到全视口，唯一例外是**手机 375 单列**（内容盒 214 < 环图宽度预算 222）——
//        那里环图落到 `MIN_SIZE` 下限 80、图例保住 118，是「图例可读优先于两者等高」的既有取舍；
//        该档不跳过，而是**显式断言它停在 80**，否则「某天它变成 120」会无人知道。
//     ⑤ 柱图文字**不被裁切**（AC19，2026-09-18 追加；批次 K 修的既有缺陷）：svg 内
//        每个 `<text>`（x 轴刻度 + 柱顶数值）的渲染矩形必须完整落在 svg 矩形内。
//        首末桶的柱心距 svg 左右边缘仅 `barWidth/2`，标签以柱心居中时约半个标签宽落到
//        视口外，被 svg 自身的 `overflow: hidden`（UA 样式表）裁成**残字** —— 375 实测最左
//        渲染成 `-19`（应 `08-19`）、`00:00` 成 `0:00`；1440 下 `08-22` 左越 10px。
//        **这条是既有断言集的盲区**：裁切与溢出是**相反**的失败模式，裁切时
//        `scrollWidth === clientWidth` 恰恰成立 ⇒ 任何基于 scrollWidth 的溢出断言**全盲**
//        （同一批 stg 画面测试里 33 条零溢出断言全绿，而残字就在屏幕上）。
//        修法是首桶 `textAnchor="start"`、末桶 `"end"`（`x` 仍取柱心，故上面「首/末桶有标签」
//        两条读 x 的断言不受影响）；构造性验证把锚点改回 `middle` ⇒ 五档视口齐 FAIL。
//
//   **刻度文字的 y 不写死**：它是各图自身 `height − 8`（usage 与 dashboard 传的高度不同），
//   故在 readCharts 里按图从 DOM 现算。写死会静默把 tickY 指空 → 一个刻度都取不到、
//   断言全红却全是假红（2026-09-18 改高度时正是靠这条避免的）。
//
//   刻度期望值与容器宽联动：`tickCount = clamp(floor(usedWidth / 80), 4, 6)`，故脚本先读
//   实测容器宽再算期望下标，而不是写死——写死会在换视口/改卡片内边距时变成假红。
//   唯一写死的是用户给的那一例：24 桶窄端应为 00:00 / 08:00 / 15:00 / 23:00。
//
//   刻度断言的判别力经**构造性验证**：把采样逻辑改回旧的 `labelEvery = barWidth < 20 ? 2 : 1`
//   （「index % every + 强制末位」），三视口齐 FAIL —— 1440 实测 **24 个标签全显示**
//   （barWidth ≈ 29 > 20 → labelEvery = 1，等于不抽稀），正是用户报的「x 轴过于密集」；
//   768/375 实测 13 个（`00 02 04 … 22 23`，末位 22 与强制的 23 相邻 1 格，疏密不均）。还原后 230/0。
//
//   数据一致性（AC13/AC14）：从**网络响应**取桶聚合（无损），再与 DOM 上的数字逐项对账 ——
//   tokens 柱顶是紧凑格式（1.2M）无法反解，故改用「在 Node 里用同一 Intl 选项重算期望字符串」
//   做**逐桶精确比对**；环形图图例与中心总数都是精确格式，直接字符串相等。
//
// 本机专用脚本：依赖 playwright（未声明为 devDeps，需 `npm i -D playwright && npx playwright install chromium`）
// 前置：①`npm run dev` 已启动；②本地 D1 已有测试用户（历史夹具或走注册页建号）；
//       ③本机 D1 的 request_logs 在 **today 本地窗口**内有秒精度的行——本机既有行写的是**毫秒**，
//         对应用呈现为远未来、窗口一律不命中（Drizzle integer timestamp 按秒读写）。
//         脚本会先自查前置，缺数据时明确报「前置未满足」而不是伪装成断言失败。
// 用法：node scripts/verify-chart-readability.mjs
import { createRequire } from "node:module";

// playwright 刻意不入 devDeps（它带着几十 MB 的浏览器下载，与「100% Cloudflare、无外部服务」
// 的依赖面不符）。故按候选顺序解析：环境变量 → 本地 node_modules → 本机已知安装位置。
// 解析失败时给出可执行的补救命令，而不是抛一个 ERR_MODULE_NOT_FOUND 栈。
const require = createRequire(import.meta.url);
const PW_CANDIDATES = [
  process.env.PLAYWRIGHT_MODULE,
  "playwright",
  "C:/Users/limc/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright",
].filter(Boolean);
let chromium;
for (const spec of PW_CANDIDATES) {
  try {
    ({ chromium } = require(spec));
    break;
  } catch {
    /* 试下一个候选 */
  }
}
if (!chromium) {
  console.error(
    "找不到 playwright。任选其一：\n" +
      "  npm i -D playwright && npx playwright install chromium\n" +
      "  set PLAYWRIGHT_MODULE=<已安装 playwright 的绝对路径>",
  );
  process.exit(2);
}

// 默认端口与仓库其余 15 个 scripts/*.mjs 一致（2026-09-18 订正：本文件曾是唯一写 5174 的，
// 而 `npm run dev` 与 `.dev.vars` 的 BETTER_AUTH_URL 都是 5173 —— 那是条**跑不通**的默认值）。
const BASE = process.env.BASE_URL ?? "http://localhost:5173";

/** 与 bar-chart.tsx 保持一致（契约值，改了要同步）。 */
const MIN_TICKS = 4;
const MAX_TICKS = 6;
const MIN_TICK_SPACING = 80;
/** usage 页柱状图高度（= 同排环形图的 size，见 usage.tsx 的 CHART_ROW_SIZE）。
 *  刻度文字的 y **不**由它推：那是各图自身 height − 8，在 readCharts 里从 DOM 读（见下），
 *  否则改高度会静默把 tickY 指空 —— 一个刻度都取不到，断言全红却全是假红。 */
const EXPECTED_BAR_HEIGHT = 152;

/** 与 app/lib/format.ts 的 formatNumberCompact 保持同一 Intl 选项（逐桶精确比对的基准）。 */
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const numberFmt = new Intl.NumberFormat("en-US");
const usdShortFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/** 与 donut-chart.tsx 保持一致（契约值，改了要同步）。 */
const DONUT_LEGEND_MIN_WIDTH = 118;
/** 与 donut-chart.tsx 的 MIN_SIZE 保持一致：环图被图例预算挤到不能再挤时的下限。 */
const DONUT_MIN_SIZE = 80;
/** 与 bar-chart.tsx 的 `showValues = barWidth >= 14` 保持一致（契约值，改了要同步）。 */
const COST_LABEL_MIN_BAR_WIDTH = 14;

const VIEWPORTS = [
  { name: "PC 1440", width: 1440, height: 900 },
  // 二分栏断点（xl=1280）的两端：1279 走单列、1280 起走 1/2 栏。1024 是**曾经的**三分栏断点（lg）——
  // 它与侧栏出现的断点重合，1/3 卡内容盒只剩 174px，图例被压到 70px、序列名 0 宽。
  // 这两档锁的不是「好看」，而是「图例拿到了保底宽度」（见下方 118 断言）。
  { name: "PC 1024（旧 lg 断点）", width: 1024, height: 900 },
  { name: "PC 1280（现 xl 断点）", width: 1280, height: 900 },
  { name: "平板 768", width: 768, height: 1024 },
  // 375 是唯一「环图到不了 152」的档（单列内容盒 214 < 222 预算）—— AC18 在此档改断言下限值。
  { name: "手机 375", width: 375, height: 812 },
];

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

/** 页面上取三行卡片的量测快照（全部用结构查询，不靠 class —— class 会随样式重构漂移）。 */
const readCharts = () =>
  page.evaluate(
    () => {
      const out = [];
      for (const heading of document.querySelectorAll("h3")) {
        const card = heading.closest("div.rounded-lg");
        if (!card) continue;
        const barsSvg = card.querySelector('svg[aria-label="Usage bar chart"]');
        const donutSvg = card.querySelector('svg[aria-label="Usage distribution donut chart"]');
        const entry = { title: heading.textContent.trim(), kind: "empty" };
        if (barsSvg) {
          entry.kind = "bar";
          const wrapper = barsSvg.parentElement;
          const rects = [...barsSvg.querySelectorAll("g > rect")];
          const texts = [...barsSvg.querySelectorAll("text")];
          // 刻度文字画在 `y = 该图自身 height − 8`（bar-chart.tsx）。按图现算而非写死常量：
          // usage 页与 dashboard 传的高度不同，将来再调也不会把刻度判空（写死即假红）。
          const tickY = Number(barsSvg.getAttribute("height")) - 8;
          const tickTexts = texts.filter((t) => Number(t.getAttribute("y")) === tickY);
          const valueTexts = texts.filter((t) => Number(t.getAttribute("y")) !== tickY);
          const gs = [...barsSvg.querySelectorAll("g")];
          entry.height = Number(barsSvg.getAttribute("height"));
          entry.barCount = rects.length;
          entry.barWidth = rects.length ? Number(rects[0].getAttribute("width")) : 0;
          entry.firstBarCenter = rects.length ? Number(rects[0].getAttribute("x")) + entry.barWidth / 2 : 0;
          entry.lastBarCenter = rects.length
            ? Number(rects[rects.length - 1].getAttribute("x")) + entry.barWidth / 2
            : 0;
          entry.wrapperWidth = wrapper.clientWidth;
          entry.scrollWidth = wrapper.scrollWidth;
          entry.ticks = tickTexts.map((t) => ({
            x: Number(t.getAttribute("x")),
            label: t.textContent,
          }));
          entry.values = valueTexts.map((t) => t.textContent);
          // AC19 的量测源：**每个**文字的渲染矩形 vs svg 自身的矩形。
          // 不用 scrollWidth 那套 —— svg 是 `overflow: hidden`（UA 样式表），被裁的部分
          // 不产生滚动条，`scrollWidth === clientWidth` 恰恰**成立**，溢出断言全盲
          // （本批缺陷正是这么溜过既有 266 条断言的）。越界量取**带符号的浮点数**，
          // 不做四舍五入 —— 阈值判在 0.5px 上，取整会把 0.4px 的越界抹成 0。
          // 四个方向一律「越界为正」：左/上是 svg 减文字，右/下是文字减 svg。
          const svgRect = barsSvg.getBoundingClientRect();
          entry.textBoxes = texts.map((t) => {
            const r = t.getBoundingClientRect();
            return {
              label: t.textContent,
              isTick: Number(t.getAttribute("y")) === tickY,
              overLeft: svgRect.left - r.left,
              overRight: r.right - svgRect.right,
              overTop: svgRect.top - r.top,
              overBottom: r.bottom - svgRect.bottom,
            };
          });
          // <title> 恒存在（数值标签在柱宽过窄时会降级为 tooltip），故它是**无损读数**的来源
          entry.titles = gs.map((g) => g.querySelector("title")?.textContent ?? "");
        } else if (donutSvg) {
          entry.kind = "donut";
          // 环图 svg 的 height = **实际渲染尺寸**（`size` 是上限，窄端会被图例挤小）
          entry.donutSize = Number(donutSvg.getAttribute("height"));
          entry.wrapWidth = donutSvg.parentElement.clientWidth;
          const ul = card.querySelector("ul");
          entry.ulWidth = ul.clientWidth;
          entry.ulScrollWidth = ul.scrollWidth;
          const svgRect = donutSvg.getBoundingClientRect();
          const ulRect = ul.getBoundingClientRect();
          entry.svgRect = { top: svgRect.top, bottom: svgRect.bottom, left: svgRect.left, right: svgRect.right };
          entry.ulRect = { top: ulRect.top, bottom: ulRect.bottom, left: ulRect.left, right: ulRect.right };
          entry.centerTexts = [...donutSvg.querySelectorAll(":scope > text")].map((t) => t.textContent);
          entry.legend = [...ul.querySelectorAll("li")].map((li) => {
            const spans = li.querySelectorAll("span");
            const label = spans[1];
            const value = spans[2];
            const style = getComputedStyle(label);
            return {
              label: label.textContent,
              title: label.getAttribute("title"),
              overflowX: style.overflowX,
              labelWidth: label.getBoundingClientRect().width,
              labelTruncated: label.scrollWidth > label.clientWidth + 1,
              value: value.textContent,
              valueTruncated: value.scrollWidth > value.clientWidth + 1,
              valueRight: value.getBoundingClientRect().right,
            };
          });
          entry.containerRight = card.getBoundingClientRect().right;
        }
        out.push(entry);
      }
      return out;
    },
  );

/** 期望刻度下标（与 bar-chart.tsx 的 pickTickIndices 同式；n / k 由实测推导）。 */
function expectedTicks(n, containerWidth) {
  const k = Math.min(n, Math.max(MIN_TICKS, Math.min(MAX_TICKS, Math.floor(containerWidth / MIN_TICK_SPACING))));
  if (k <= 1) return [0];
  return Array.from({ length: k }, (_, i) => Math.round((i * (n - 1)) / (k - 1)));
}

const browser = await chromium.launch({
  executablePath: "C:/Users/limc/AppData/Local/ms-playwright/chromium-1224/chrome-win64/chrome.exe",
});
const ctx = await browser.newContext({ viewport: VIEWPORTS[0] });
const page = await ctx.newPage();

// 桶聚合那一路的判别式：limit=1（聚合三路一律 limit:1）且**无 groupBy**（byModel / byStatus 带 groupBy）
const bucketsResponses = [];
page.on("response", async (res) => {
  const url = res.url();
  if (!/\/api\/(admin|me)\/usage\?/.test(url)) return;
  if (!/[?&]limit=1(&|$)/.test(url) || /[?&]groupBy=/.test(url)) return;
  try {
    const body = await res.json();
    if (Array.isArray(body?.aggregates)) bucketsResponses.push({ url, aggregates: body.aggregates });
  } catch {
    /* 非 JSON 响应忽略 */
  }
});

try {
  // goto 也放进 try：端口没人监听时它会先抛 ERR_CONNECTION_REFUSED，若留在外面，
  // 下面「诊断探测本身失败」那条分支就永远走不到（写了却不可达的分支 = 死代码）。
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#login-email", "admin@local.dev");
  await page.fill("#login-password", "local-dev-pass-123");
  await page.click('button[type="submit"]');
  // 注意签名是 (pageFunction, arg, options) —— **arg 在第二位**。写成 waitForFunction(fn, { timeout })
  // 会把 options 当 arg 传进去，超时静默保持默认 30s（2026-09-18 实测踩到：日志里报 30000ms）。
  await page.waitForFunction(() => !location.pathname.startsWith("/login"), undefined, {
    timeout: 15000,
  });
} catch (err) {
  // 失败必须说人话。BASE 与 `.dev.vars` 的 BETTER_AUTH_URL **端口**不一致时，服务端回 403
  // INVALID_ORIGIN —— 两个 `http://localhost:<port>` 只有端口不同，Better Auth 也视为不同 origin。
  // 原实现只表现为 30s 超时，**看起来像「测试用户不存在」**，与真实原因毫无关系（2026-09-18 踩到，
  // 当时真去库里确认了 admin@local.dev 存在，方向完全错）。
  // 诊断用无凭据的假账号打一次：真原因是 origin 时它**同样**回 403 INVALID_ORIGIN，
  // 而「用户不存在」类问题在它这里只会是 4xx 凭据错 —— 两者可据此区分，不必再猜。
  const diag = await page
    .evaluate(async () => {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "diagnostic@invalid", password: "diagnostic" }),
      });
      return { status: res.status, body: (await res.text()).slice(0, 200) };
    })
    .catch(() => null);
  let hint;
  if (diag?.body.includes("INVALID_ORIGIN")) {
    hint =
      "  服务端回 403 INVALID_ORIGIN —— **origin 校验拒绝**，不是「用户不存在」。\n" +
      "  服务端只接受 `.dev.vars` 里 BETTER_AUTH_URL 指定的那个 origin；端口不同即不同 origin。\n" +
      "  跑法：BASE_URL=<与 BETTER_AUTH_URL 一致的值> node scripts/verify-chart-readability.mjs\n";
  } else if (diag) {
    hint =
      `  诊断探测回 ${diag.status} ${diag.body}（非 origin 问题）—— 检查 dev server 是否在跑、` +
      "测试用户是否存在（本地 D1 需已有测试用户）。\n";
  } else {
    hint = `  诊断探测本身失败 —— dev server 大概没在 ${BASE} 上跑。\n`;
  }
  console.error(`登录失败（BASE=${BASE}）—— 未能进入已登录态。\n${hint}  原始错误：${String(err).split("\n")[0]}\n`);
  await browser.close();
  process.exit(1);
}
await page.goto(`${BASE}/usage`, { waitUntil: "networkidle" });
await page.waitForSelector('svg[aria-label="Usage bar chart"]', { timeout: 15000 });

// ── 前置自查：today 窗口必须有秒精度数据，否则整套断言都无意义 ──
const buckets = bucketsResponses.at(-1)?.aggregates ?? [];
if (buckets.length === 0) {
  console.error(
    "前置未满足：today 本地窗口内 buckets 为空（页面走 EmptyState，无从量测）。\n" +
      "  本机既有 request_logs 的 created_at 是**毫秒**，Drizzle integer timestamp 按秒读 → 对应用不可见。\n" +
      "  用 `node scripts/gen-usage-fixture.mjs` 造秒精度的夹具行。",
  );
  await browser.close();
  process.exit(2);
}
const sumIn = buckets.reduce((s, a) => s + a.tokensIn, 0);
const sumOut = buckets.reduce((s, a) => s + a.tokensOut, 0);
const sumBoth = sumIn + sumOut;
console.log(`前置 OK：today 窗口 ${buckets.length} 个桶，tokens ${numberFmt.format(sumBoth)}（in ${numberFmt.format(sumIn)} / out ${numberFmt.format(sumOut)}）\n`);

for (const vp of VIEWPORTS) {
  console.log(`\n───── ${vp.name} (${vp.width}×${vp.height}) ─────`);
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.waitForTimeout(400); // ResizeObserver 重算柱宽 / 刻度
  const charts = await readCharts();
  const byTitle = (t) => charts.find((c) => c.title === t);
  const tag = `[${vp.name}]`;

  // ── AC12：三行卡片齐备（成本 / 请求 / tokens） ──
  const costBar = byTitle("Spend today");
  const reqBar = byTitle("Requests today");
  const tokBar = byTitle("Tokens today");
  const modelDonut = byTitle("Spend by model");
  const statusDonut = byTitle("Requests by status");
  const tokDonut = byTitle("Tokens by direction");
  check(`${tag} 三张柱状图齐备（Spend/Requests/Tokens today）`, [costBar, reqBar, tokBar].every((c) => c?.kind === "bar"),
    [costBar, reqBar, tokBar].map((c) => c?.kind ?? "missing").join("/"));
  check(`${tag} 三张环形图齐备（模型/状态/tokens）`, [modelDonut, statusDonut, tokDonut].every((c) => c?.kind === "donut"),
    [modelDonut, statusDonut, tokDonut].map((c) => c?.kind ?? "missing").join("/"));

  for (const [label, chart] of [["Spend", costBar], ["Requests", reqBar], ["Tokens", tokBar]]) {
    if (chart?.kind !== "bar") continue;

    // ── AC15：刻度数落 [4,6]，首尾桶必有标签 ──
    const n = chart.barCount;
    const exp = expectedTicks(n, chart.wrapperWidth);
    const expLabels = exp.map((i) => chart.titles[i]?.split(": ")[0] ?? "?");
    check(
      `${tag} ${label} 柱状图刻度数落 [4,6]`,
      chart.ticks.length >= MIN_TICKS && chart.ticks.length <= MAX_TICKS,
      `实测 ${chart.ticks.length} 个（${chart.ticks.map((t) => t.label).join(" ")}）`,
    );
    check(
      `${tag} ${label} 刻度数 = 容器宽推导值（n=${n}, w=${chart.wrapperWidth}）`,
      chart.ticks.length === Math.min(n, exp.length),
      `实测 ${chart.ticks.length} vs 期望 ${exp.length}`,
    );
    const tickLabels = chart.ticks.map((t) => t.label).join(",");
    check(`${tag} ${label} 刻度标签 = 期望下标（含首尾）`, tickLabels === expLabels.join(","),
      `实测 ${tickLabels} vs 期望 ${expLabels.join(",")}`);
    check(
      `${tag} ${label} 首桶有标签`,
      chart.ticks.some((t) => Math.abs(t.x - chart.firstBarCenter) < 0.75),
      `首桶中心 x=${chart.firstBarCenter.toFixed(1)}，刻度 x=${chart.ticks.map((t) => t.x.toFixed(1)).join("/")}`,
    );
    check(
      `${tag} ${label} 末桶有标签`,
      chart.ticks.some((t) => Math.abs(t.x - chart.lastBarCenter) < 0.75),
      `末桶中心 x=${chart.lastBarCenter.toFixed(1)}`,
    );

    // ── AC19（2026-09-18 追加，批次 K）：svg 内所有文字完整可见（无裁切） ──
    // 与上面两条「首/末桶有标签」互补：那两条只问标签**在不在**（读的是 `x` 对齐），
    // 这条问它**看不看得全**。首末桶的柱心分别距 svg 左右边缘仅 `barWidth/2`，
    // 标签以柱心居中（middle）时约半个标签宽落到视口外，被 svg 自身的
    // `overflow: hidden`（UA 样式表，computed 实测确认）裁掉 —— 不报错、不溢出、
    // 不换行，只是文字**少了一截**：375 下最左渲染成 `-19`（应 `08-19`）、
    // `00:00` 渲染成 `0:00`；1440 下同样存在（`08-22` 左越 10px）。
    //
    // **为什么既有断言全绿而缺陷仍在**：裁切与溢出是**相反的失败模式** ——
    // 溢出时 `scrollWidth > clientWidth`，裁切时二者恰恰**相等**（多余部分被吃掉了，
    // 不产生滚动条）。故这条必须**逐元素量矩形**，任何基于 scrollWidth 的写法都对它全盲。
    // 柱顶数值标签与刻度同画在柱心（同一处 `x + barWidth/2`），同源同风险，一并纳入 ——
    // 当前数据恰好让首个非零桶落在中间才没暴露，换一天的数据就会露出来。
    //
    // 阈值 0.5px 是给亚像素渲染留的余量（实测越界量在 1~11px，判别力不受影响）。
    const CLIP_TOL = 0.5;
    const clippedTexts = chart.textBoxes.filter(
      (b) =>
        b.overLeft > CLIP_TOL || b.overRight > CLIP_TOL || b.overTop > CLIP_TOL || b.overBottom > CLIP_TOL,
    );
    check(
      `${tag} ${label} svg 内 ${chart.textBoxes.length} 个文字（刻度+柱顶）完整可见，无被裁残字`,
      clippedTexts.length === 0,
      clippedTexts.length
        ? clippedTexts
            .map(
              (b) =>
                `"${b.label}"${b.isTick ? "(刻度)" : "(柱顶)"} 左越${b.overLeft.toFixed(1)} 右越${b.overRight.toFixed(1)} 上越${b.overTop.toFixed(1)} 下越${b.overBottom.toFixed(1)}`,
            )
            .join("; ")
        : `柱宽 ${chart.barWidth}，全在界内`,
    );
  }

  // ── AC18（2026-09-18 追加，批次 H 扩到全视口）：柱状图高度 = 同排环形图高度 ──
  // 用户裁决把三张柱状图从 240 降到与环图同高，这两条是该裁决的锁。**两条互补**：
  //   ① 「= 152」把具体高度钉住；
  //   ② 「= 环形图渲染高度」锁的是用户要的**效果**（两侧都从 DOM 量）。
  // 只留②不够：将来两边一起漂移（例如又被一起改回 240）它照样 PASS，裁决本身就锁不住了。
  // 只留①也不够：环图若单方面缩小，柱图仍会脱离契约而①不响。
  //
  // 断言范围（批次 H 订正）：原先只在 1440 断言 —— 三分栏时代环图的 `size` 是**上限**，
  // 1280~1439 会被图例挤小（实测 1366 → 146.3、1280 → 117.7），该段「同高」本就不成立。
  // 批次 H 把三行卡改成二分栏（bar/环图对半分）后环图列宽翻倍，**这段坏带消失**
  // （实测 1280 环图 117.7 → 152），故断言放开到全视口。
  // 唯一例外是手机 375 单列：内容盒 214px < 环图宽度预算 (80+118+24)=222px，`max(MIN_SIZE, …)`
  // 的下限获胜 → 环图落 80、图例保住 118（AC17 已锁）。这是「图例可读优先」的既有取舍，
  // 但**不跳过**——改为显式断言它停在 80：跳过会让「某天它变成 120（下限被改）」无人知道。
  {
    const pairs = [["Spend", costBar, modelDonut], ["Requests", reqBar, statusDonut], ["Tokens", tokBar, tokDonut]];
    for (const [label, bar, donut] of pairs) {
      if (bar?.kind !== "bar") continue;
      check(`${tag} ${label} 柱状图高度 = ${EXPECTED_BAR_HEIGHT}（降高裁决值）`,
        bar.height === EXPECTED_BAR_HEIGHT, `实测 ${bar.height}`);
      if (vp.width === 375) {
        check(`${tag} ${label} 手机单列：环图停在 MIN_SIZE 下限（图例保底优先，非回归）`,
          donut?.kind === "donut" && donut.donutSize === DONUT_MIN_SIZE,
          `环图 ${donut?.kind === "donut" ? donut.donutSize : "缺失"} vs 下限 ${DONUT_MIN_SIZE}`);
      } else {
        check(`${tag} ${label} 柱状图高度 = 环形图渲染高度`,
          donut?.kind === "donut" && bar.height === donut.donutSize,
          `柱图 ${bar.height} vs 环图 ${donut?.kind === "donut" ? donut.donutSize : "缺失"}`);
      }
    }
  }

  // ── 用户原话的那一例：24 桶窄端 = 4 个 = 00:00 / 08:00 / 15:00 / 23:00 ──
  if (vp.width === 375 && reqBar?.kind === "bar" && reqBar.ticks.length === 4) {
    check(`${tag} 24 桶窄端刻度 = 00:00/08:00/15:00/23:00`,
      reqBar.ticks.map((t) => t.label).join(",") === "00:00,08:00,15:00,23:00",
      reqBar.ticks.map((t) => t.label).join(","));
  }

  // ── AC17：环形图与图例并排（y 区间重叠 + 环图在左） ──
  for (const [label, donut] of [["Spend by model", modelDonut], ["Requests by status", statusDonut], ["Tokens by direction", tokDonut]]) {
    if (donut?.kind !== "donut") continue;
    // 这条是**布局不变量**，不是外观偏好：容器一旦窄于「环图下限 + 图例保底 + 间距」，
    // `max(MIN_SIZE, …)` 的下限就会推翻「先给图例留够」的预算，图例被压破
    // （1024/旧 lg 断点实测 ul 70px、序列名 0 宽 —— 名字完全不可见）。
    // 断言落在**效果**（图例实得宽度）而非容器宽上：CSS 间距按视口取 `gap-4 sm:gap-6`，
    // 用保守间距反推的容器阈值在 375 下会比真实要求严 8px，反而变成假红。
    check(`${tag} ${label}：图例保底宽度 ${DONUT_LEGEND_MIN_WIDTH} 成立、序列名未被压成 0 宽`,
      donut.ulWidth >= DONUT_LEGEND_MIN_WIDTH && donut.legend.every((d) => d.labelWidth > 0),
      `ul ${donut.ulWidth}px/内容 ${donut.ulScrollWidth}px｜序列名宽 ${donut.legend.map((d) => d.labelWidth.toFixed(1)).join("/")}`);
    const overlap = Math.max(donut.svgRect.top, donut.ulRect.top) < Math.min(donut.svgRect.bottom, donut.ulRect.bottom);
    check(`${tag} ${label}：图例与环图 y 区间重叠（并排未换行）`, overlap,
      `svg y[${donut.svgRect.top.toFixed(0)},${donut.svgRect.bottom.toFixed(0)}] ul y[${donut.ulRect.top.toFixed(0)},${donut.ulRect.bottom.toFixed(0)}]`);
    check(`${tag} ${label}：环图在图例左侧`, donut.svgRect.right <= donut.ulRect.left + 2,
      `svg.right=${donut.svgRect.right.toFixed(1)} ul.left=${donut.ulRect.left.toFixed(1)}`);
    check(`${tag} ${label}：图例数值未被截断`, donut.legend.every((d) => !d.valueTruncated),
      donut.legend.filter((d) => d.valueTruncated).map((d) => d.value).join(",") || "全部完整");
    check(`${tag} ${label}：图例数值未跑出卡片右边界`, donut.legend.every((d) => d.valueRight <= donut.containerRight + 1),
      `max right=${Math.max(...donut.legend.map((d) => d.valueRight)).toFixed(1)} vs 卡片 ${donut.containerRight.toFixed(1)}`);
    check(`${tag} ${label}：图例全名可经 title 取回`, donut.legend.every((d) => d.title === d.label),
      donut.legend.filter((d) => d.title !== d.label).map((d) => d.label).join(",") || "全部一致");
    check(`${tag} ${label}：长名走截断而非撑破（overflow-x: hidden）`, donut.legend.every((d) => d.overflowX === "hidden"),
      donut.legend.map((d) => d.overflowX).join(","));
    if (vp.width === 1440 && label === "Spend by model") {
      console.log(`      · 图例截断情况：${donut.legend.map((d) => `${d.label}${d.labelTruncated ? "(截断)" : ""}`).join(", ")}`);
    }
  }

  // ── AC16（批次 H 订正）：柱顶标签的有无严格由柱宽阈值决定，且数值不因降级而丢失 ──
  // 原实现只在标签**存在**时校验格式；标签不存在时打一行「barWidth < 14，既有降级规则，
  // 非本批改动」就放行。批次 H 改二分栏后柱宽从 ~30 掉到 10~12（≥1280），这条降级路径
  // **成了常态**，那行日志也随之变成**假话**——标签消失正是本批改动造成的（用户已知情并接受）。
  // 故改为断言不变量：`柱宽 ≥ 14` ⇔ `柱顶有标签`。两个方向都能抓：该出没出（回归）、
  // 不够宽却硬出（标签互相重叠）。
  // 标签缺席时改为断言**数值仍在 `<title>`（悬停 tooltip）里且格式不变** —— 这正是
  // 「标签消失」被接受的前提：数据可无损取回，而不是看不见了。
  if (costBar?.kind === "bar") {
    const titleValues = costBar.titles.map((t) => t.slice(t.indexOf(": ") + 2));
    // 全 0 时无论多宽都不渲染标签（bar-chart 的 `datum.value > 0` 条件），此时阈值不变量不适用。
    const hasPositive = titleValues.some((v) => Number(v.replace(/[$,]/g, "")) > 0);
    if (!hasPositive) {
      console.log(`      · Spend 全桶为 0，柱顶标签本就不渲染（与柱宽无关），跳过 AC16`);
    } else {
      const hasLabels = costBar.values.length > 0;
      const wideEnough = costBar.barWidth >= COST_LABEL_MIN_BAR_WIDTH;
      check(`${tag} Spend 柱顶标签有无 = 柱宽阈值 ${COST_LABEL_MIN_BAR_WIDTH}（柱宽 ${costBar.barWidth}）`,
        hasLabels === wideEnough, `标签${hasLabels ? "有" : "无"} vs 阈值判定${wideEnough ? "该有" : "该降级"}`);
      const source = hasLabels ? costBar.values : titleValues;
      const bad = source.filter((v) => !/^\$[\d,]+\.\d{1,3}$/.test(v));
      check(`${tag} Spend 数值（${hasLabels ? "柱顶" : "tooltip"}）全为 $x.yz(≤3 位)`, bad.length === 0,
        bad.length ? `不合式：${bad.join(",")}` : `共 ${source.length} 个：${source.slice(0, 4).join(" ")}…`);
    }
  }

  // ── AC13/AC14：DOM 数字与网络响应逐项对账 ──
  if (tokDonut?.kind === "donut") {
    const [total, caption] = tokDonut.centerTexts;
    check(`${tag} tokens 环形图中心 = 输入+输出总量`, total === numberFmt.format(sumBoth),
      `实测 ${total} vs 期望 ${numberFmt.format(sumBoth)}`);
    check(`${tag} tokens 环形图中心副标题为 total`, caption === "total", String(caption));
    const legendText = tokDonut.legend.map((d) => `${d.label}=${d.value}`).join(" ");
    check(`${tag} tokens 环形图恰两段且为 input/output`, tokDonut.legend.length === 2 &&
      tokDonut.legend[0].label === "Input" && tokDonut.legend[1].label === "Output", legendText);
    check(`${tag} tokens 环形图两段和 = 总量（无 cached 第三段）`,
      tokDonut.legend[0].value === numberFmt.format(sumIn) && tokDonut.legend[1].value === numberFmt.format(sumOut),
      `实测 ${legendText} vs 期望 Input=${numberFmt.format(sumIn)} Output=${numberFmt.format(sumOut)}`);
  }
  if (tokBar?.kind === "bar") {
    // 逐桶精确比对：柱顶是紧凑格式（无法反解），故在 Node 里用同一 Intl 选项重算期望字符串。
    //
    // **按键对齐，不按数组下标**：响应里的 aggregates 只含**有数据**的桶且按 group 升序，
    // 而 DOM 是固定 24 槽的窗口（缺数据补 0）—— 两者下标不同源，按下标比会得到
    // 「整体错位」的假红（实测踩过：0≠167K / 167K≠80.5K）。
    // 键 → label 的换算与 range.ts 的 bucketLabel 同式：hour 桶取 key 的 HH 拼 ":00"。
    const labelOf = (group) => `${String(group).slice(11, 13)}:00`;
    const actualByLabel = new Map(
      tokBar.titles.map((t) => {
        const sep = t.indexOf(": ");
        return [t.slice(0, sep), t.slice(sep + 2)];
      }),
    );
    const expectedByLabel = new Map(
      buckets.map((a) => [labelOf(a.group), compactFmt.format(a.tokensIn + a.tokensOut)]),
    );
    const mismatch = [];
    for (const [label, want] of expectedByLabel) {
      const got = actualByLabel.get(label);
      if (got !== want) mismatch.push(`${label}: ${got}≠${want}`);
    }
    // 反向：响应里没有的桶必须渲染为 0（防「把某桶的值复制到相邻空桶」这类错位）
    for (const [label, got] of actualByLabel) {
      if (!expectedByLabel.has(label) && got !== "0") mismatch.push(`${label}: ${got}≠0(响应无此桶)`);
    }
    check(`${tag} tokens 柱状图逐桶 = 响应聚合（紧凑格式精确比对）`, mismatch.length === 0,
      mismatch.slice(0, 4).join(" ") || `${expectedByLabel.size} 个非空桶 + ${actualByLabel.size - expectedByLabel.size} 个空桶全等`);
  }

  // ── 三图共用同一套桶窗口（AC13 的可观测判据） ──
  if ([costBar, reqBar, tokBar].every((c) => c?.kind === "bar")) {
    const tickSets = [costBar, reqBar, tokBar].map((c) => c.ticks.map((t) => t.label).join(","));
    check(`${tag} 三张柱状图刻度集一致（同一桶窗口）`, new Set(tickSets).size === 1, tickSets.join(" | "));
    const counts = [costBar.barCount, reqBar.barCount, tokBar.barCount];
    check(`${tag} 三张柱状图桶数一致`, new Set(counts).size === 1, counts.join("/"));
  }
}

console.log(`\n${"─".repeat(60)}\n${passed} passed / ${failed} failed`);
if (failures.length) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  - ${f}`);
}
await browser.close();
process.exit(failed === 0 ? 0 : 1);
