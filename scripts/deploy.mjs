// 部署 runner —— package.json "deploy" 的唯一入口（10-14-deploy-button-research design §4）。
//
// 流程：
//   1. npm run build（无条件执行 —— 防维护者旧 dist 被部署；Workers Builds 场景重复构建一次，
//      正确性优先）
//   2. 选配置：wrangler.prod.jsonc（维护者 fork，gitignored）存在 → 用之；否则 wrangler.jsonc
//      （按钮/开源形态）。**打印选中配置与目标环境**。
//   3. wrangler d1 migrations apply DB --remote --config <选中>（binding 名形态；幂等，只应用
//      未应用的迁移 —— 官方推荐把迁移放进 deploy script；D1 迁移只增不改，wrangler rollback 可回）
//   4. wrangler deploy --config <选中>
//
// --dry-run 旗标：只执行 1–2 并**打印将执行的远程命令清单**即退出，不迁移不部署 ——
// AC6 的无害验证路径（确认 runner 选中 prod fork），也是维护者部署前预览工具。
//
// **为什么 runner 自动优先 prod fork**（防呆语义）：维护者机器上肌肉记忆 `npm run deploy`
// 若裸用 wrangler.jsonc，占位资源 id 会以 `cf-ai-gateway` 名覆盖真实生产 worker 的绑定 ——
// 自动选择把「误用按钮配置覆盖生产」从纪律问题变成结构不可能。
//
// 跨平台（Windows）注意：子进程全部经 spawnSync + shell:true（PATH 解析 npm/npx），不依赖
// POSIX shell 特性。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY_RUN = process.argv.includes("--dry-run");

const prodForkPath = join(ROOT, "wrangler.prod.jsonc");
const hasProdFork = existsSync(prodForkPath);
const selected = hasProdFork ? "wrangler.prod.jsonc" : "wrangler.jsonc";

console.log(`\n[deploy] 选中配置：${selected}（${hasProdFork ? "生产 · 维护者 fork" : "开源 / Deploy-to-Cloudflare 按钮形态"}）`);
if (!hasProdFork) {
  console.log("[deploy] 未检测到 wrangler.prod.jsonc —— 按按钮形态部署（占位资源 id + 无 routes）。");
  console.log("[deploy] 真实 secrets 仍须先 `wrangler secret put`（BETTER_AUTH_SECRET / GITHUB_CLIENT_SECRET /");
  console.log("[deploy] GATEWAY_SECRET_KEY / RESEND_API_KEY）—— 配置文件从不承载 secrets。");
}

// 1. build（dry-run 也执行：验证构建链路本身；失败即暴露，不进入远程步骤）
console.log("\n[deploy] Step 1/3 npm run build");
const build = spawnSync("npm", ["run", "build"], { stdio: "inherit", shell: true, cwd: ROOT });
if ((build.status ?? 1) !== 0) {
  process.exit(build.status ?? 1);
}

if (DRY_RUN) {
  console.log("\n[deploy] --dry-run：build 完成，到此为止。远程步骤未执行，将执行的命令：");
  console.log(`[deploy]   wrangler d1 migrations apply DB --remote --config ${selected}`);
  console.log(`[deploy]   wrangler deploy --config ${selected}`);
  process.exit(0);
}

// 2. 远程迁移（幂等：只应用未应用的迁移；binding 名 DB 引用，官方推荐形态）
console.log(`\n[deploy] Step 2/3 wrangler d1 migrations apply DB --remote --config ${selected}`);
const migrate = spawnSync(
  "npx",
  ["wrangler", "d1", "migrations", "apply", "DB", "--remote", "--config", selected],
  { stdio: "inherit", shell: true, cwd: ROOT },
);
if ((migrate.status ?? 1) !== 0) {
  process.exit(migrate.status ?? 1);
}

// 3. 部署
console.log(`\n[deploy] Step 3/3 wrangler deploy --config ${selected}`);
const deploy = spawnSync("npx", ["wrangler", "deploy", "--config", selected], {
  stdio: "inherit",
  shell: true,
  cwd: ROOT,
});
if ((deploy.status ?? 1) !== 0) {
  process.exit(deploy.status ?? 1);
}

console.log("\n[deploy] 完成。部署后核对清单（README「部署后收尾清单」）：");
console.log("[deploy]   1. secrets 就位：wrangler secret list（四个 secret 键）");
console.log("[deploy]   2. 个性化 [vars]：BETTER_AUTH_URL 指向实际管理台 origin（jsonc 缺省是 localhost，");
console.log("[deploy]      管理面会被 301 到 https://localhost/...）、GITHUB_CLIENT_ID（占位 = GitHub 登录不可用）、");
console.log("[deploy]      GITHUB_ALLOWED_EMAILS 白名单（占位值同样须核对 —— 值来源详见 README 收尾清单 2/4 步）");
console.log("[deploy]   3. 探针：curl -sI https://<管理台>/ 与 https://<api 域>/api/health 均 200");
console.log("[deploy]   4. 认证面限流：/api/auth 同 IP 25 连发 → 401 为主 + 429 出现");
console.log("[deploy]   5. 首个 admin：GitHub 登录白名单内账号后 D1 UPDATE users SET role='admin'（禁止 SQL INSERT 造用户）");
process.exit(0);
