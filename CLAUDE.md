# CLAUDE.md — TokiAPI

> 本文件是仓库知识入口（2026-08-28 重建；2026-10-14 随「Deploy to Cloudflare 一键发布适配」重写环境/部署两章）：合并了原 `docs/` 下 6 份文档的要点。
> 原文档已移管至本地 Trellis spec（`.trellis/spec/governance/`，**不入 git、不随仓库分发**——本文各处 `.trellis/*` 路径均为本地内部 spec，开源仓库里不存在）；全量细节在那里，本文档是已提交的权威摘要与索引。
> 开发任务流程另见 `.trellis/workflow.md`（同为本地文件，不随仓库分发）。

## 项目概览

OpenAI 兼容的 **AI API 网关**：单入口代理多家模型供应商（OpenAI 兼容 + Anthropic 原生格式转换），提供团队 key 管理、预付费余额计费、限流、响应缓存、用量分析、Web 管理台。**100% Cloudflare**（Workers / D1 / KV / Queues），无外部服务。SDK 只换 base URL 即可接入。支持 **Deploy to Cloudflare 一键部署**（资源自动供给 + 回写）。

- 管理 API：`/api/*`（Better Auth 会话鉴权，角色 admin/member）；代理 API：`/v1/*`、`/anthropic/*`（网关 key 鉴权）。
技术栈（分层）：

| 层 | 技术 |
| --- | --- |
| Runtime | Cloudflare Workers（单 Worker，`nodejs_compat`；Wrangler v4+）、Hono |
| Data | D1（SQLite，Drizzle ORM）、KV（缓存 + 限流计数）、Queues（用量聚合） |
| Auth | Better Auth（邮箱密码 + GitHub OAuth，D1 adapter） |
| Validation | Zod（`zod` v4 + `@hono/zod-validator`） |
| Frontend | React 19、React Router v7、Vite、Tailwind CSS v4、shadcn-style UI、React Query |
| Quality | TypeScript strict、ESLint（flat config）、Vitest + Miniflare、drizzle-kit migrations |
- 线上实例：生产 `https://platform.lmlh.net`（公开 API `https://api.lmlh.net`）由维护者 fork（`wrangler.prod.jsonc`，gitignored）部署；**staging 环境已退役**（退役 runbook 见本地 `governance/stg-retirement.md`）。

## 部署配置（jsonc 双形态）

> 2026-10-14 起**旧渲染管线（toml 模板 + 段感知渲染脚本）整体拆除**，`wrangler.toml` 是历史名词。配置 = 两份 jsonc：

| 形态 | 文件 | 内容 | 谁在用 |
| --- | --- | --- | --- |
| 提交入库 | `wrangler.jsonc` | 占位资源 id（一键部署自动供给并回写真实 id）+ `[vars]` 15 键安全缺省 + **无 routes / 无 env / 无 placement** | 本地 dev / test / CI、一键部署（Workers Builds）、手动部署的缺省 |
| 维护者 fork | `wrangler.prod.jsonc`（gitignored） | 真实域名 routes（管理台域 + API 域，`custom_domain`）+ 真实 D1/KV id + 个性化 vars + placement | 仅 `npm run deploy` 自动选中 |

- 选择逻辑在 `scripts/deploy.mjs`：fork 存在 → 用 fork；否则用 jsonc。**防呆语义**：维护者肌肉记忆 `npm run deploy` 误用占位 id 覆盖真实生产 worker 绑定，在结构上不可能。
- `--dry-run` 旗标：`npm run deploy -- --dry-run` 只 build + 打印选中配置与将执行的远程命令（AC6 验证路径）。
- **三条写配置陷阱**（详见 `wrangler.jsonc` 头注）：① 占位 id 是按钮期望的形态，本地 miniflare 不校验真实存在；② **`wrangler deploy --dry-run` 不校验 `[[queues.producers]]` 指向的队列是否存在**——dry-run 绿只证明配置结构合法，资源就绪以账号侧实查为准（`wrangler queues list` / `wrangler kv namespace list`）；③ **queue() 按队列名精确比对分流**——`BILLING_QUEUE_NAME` `[vars]` 必须与 producers 里 BILLING_QUEUE 的 `queue` 字面一致，漂移 = 计费批静默落进用量分支（不扣费且账上无痕），改队列名两处一起改（`tests/config-fork.test.ts` 钉此不变式）。
- 迁移形态：`drizzle/` 迁移用 **binding 名**引用（`wrangler d1 migrations apply DB --remote`）；`npm run deploy` 在 deploy 前自动执行。**D1 迁移只增不改**（保证 `wrangler rollback` 兼容旧版本）；回滚用 `wrangler rollback`，勿改已应用迁移。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite dev server（Worker + SPA，Miniflare 绑定；读 `wrangler.jsonc` + `.dev.vars`） |
| `npm run build` | 构建 React SPA 到 `dist/`（vite 插件按 jsonc 的 assets 配置产 `dist/client`） |
| `npm test` | Vitest 全量（Miniflare：D1/KV/Queues）；**全量须加 `--maxWorkers=2`**（并发 isolate OOM） |
| `npm run typecheck` / `npm run lint` | 3 个 tsconfig 类型检查 / ESLint |
| `npm run db:generate` / `db:migrate` / `db:seed` | Drizzle 迁移生成 / 本地应用（`--local --config wrangler.jsonc`）/ 本地种子价格表 |
| `npm run render:modelcaps` | 重算 modelcap 档位（改 `MODELCAP_*` 常数或档位后手动跑） |
| `npm run deploy` | `scripts/deploy.mjs`：build → 远程迁移 → `wrangler deploy`（自动选 jsonc/prod fork） |
| `npm run deploy -- --dry-run` | 预览：只 build，打印选中配置与远程命令，不触碰远端 |

## Git 运用规范（最高约束）

> 全量：`.trellis/spec/governance/git-workflow.md`；分支职责/保护/历史事件：`governance/branching.md`。

### 分支模型

| 分支 | 职责 |
| --- | --- |
| `develop` | 唯一 trunk，始终可部署；只接受特性 merge 提交与治理 docs，**禁止直接提交特性代码** |
| `feat/<name>` | 特性开发，合并进 develop 后即删（短生命周期） |
| `staging` / `production` | 发布指针分支，平常不开发，发布时推进 |
| `main` | 仅大版本（语义断代）；**一键部署按钮与 Workers Builds 从 main 构建发布** |

### 特性开发流程（强制 5 步）

```bash
git checkout develop && git pull origin develop    # ① 基于最新 trunk
git checkout -b feat/<kebab-case>                  # ② 开发（提交可多个）

git rebase develop && git reset --soft develop \
  && git commit -m "feat(scope): 一句话摘要 — 要点1、要点2"   # ③ squash 为单提交

git checkout develop && git merge --no-ff feat/<name> \
  -m "Merge feat/<name> into develop: <与 squash 摘要一致>"   # ④ --no-ff 合并

git branch -d feat/<name>                          # ⑤ 删除
```

每个特性在 develop 上 = **1 个 squash 提交 + 1 个 merge 节点**；merge 信息与 squash 摘要一致（`git log --first-parent develop` 可读）。

### 提交前缀

`feat` / `fix` / `test` / `docs` / `chore` / `release`；中文描述，` — ` 分隔要点，scope 可选（`fix(deploy)`）。大版本在 main 打 tag（`v2.0.0`）。

### 红线

1. 禁止直接向 develop 提交特性代码（治理 docs 除外）。
2. 禁止重写已共享历史（develop/staging/production 均已推送 origin）。
3. 历史重写前必须先建备份 tag `backup/<name>-<yyyymmdd>`，完成后更新 branching.md 历史事件记录。
4. stash 随用随清。
5. 删分支前核验已合并（`git diff develop <branch>` 为空或仅剩有意差异）。
6. 多会话协作：重写/删除/reset 前先 `git rev-parse` 校验分支状态，可能影响其他会话的操作先声明。

> push / PR / 发布由仓库所有者（limccn）执行；自动化与助手不得擅自 push。
> 分支保护规则见 `governance/branching.md`。

## 环境与配置（三类）

> 全量键清单：本地 `.trellis/spec/governance/config-inventory.md`；各键权威注释在 `wrangler.jsonc` 与 `.dev.vars.example`（提交入库的模板）。

1. **真实 secrets**（`BETTER_AUTH_SECRET` / `GATEWAY_SECRET_KEY` / `GITHUB_CLIENT_SECRET` / `RESEND_API_KEY`）→ **绝不进任何 jsonc / 文档 / 代码**。生产走 `wrangler secret put`（每环境独立；`GATEWAY_SECRET_KEY` 与 `BETTER_AUTH_SECRET` 分别随机生成、不得相同）；本地 dev 走 `.dev.vars`（gitignored，复制自 `.dev.vars.example`）；一键部署在 setup 页输入。
2. **个性化 vars**（PII 与环境差异值 `BETTER_AUTH_URL` / `GITHUB_CLIENT_ID` / `GITHUB_ALLOWED_EMAILS`，加策略开关 `CACHE_ENABLED` / `EMAIL_VERIFICATION_ENABLED` / `EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` 等）→ `wrangler.jsonc` `[vars]` 承载**安全缺省**（开关缺省一律关闭，白名单空 = 拒绝，fail-closed）；部署后按收尾清单用 Dashboard vars 或维护者 fork 覆盖；本地覆盖走 `.dev.vars`（**只影响本地 dev**）。
3. **基础设施资源 ID**（D1 database_id、KV id、Queue 名、worker 名、自定义域名）→ jsonc 字面量。提交形态是**占位 id**（按钮自动供给后回写真实值）；维护者把真实 id 与域名 routes 放进 `wrangler.prod.jsonc`。资源命名式 **`<worker 名>-<purpose>`**。域名是安全敏感值：提交形态**刻意零域名**（`tests/config-fork.test.ts` 断言不含维护者域名）。

**关键坑（仍然成立）**：

- `BETTER_AUTH_URL` 同时是双域名分流的「平台域」真源（`new URL(BETTER_AUTH_URL).hostname`，见 `src/lib/domains.ts`）。缺省 localhost 是已知错误值特征：管理面（`/api/*` 与 SPA）会被 301 到 `https://localhost/...`，`/v1` 照常——**部分可用**，部署后必须改成实际 origin。
- GitHub OAuth 回调必须精确等于 `https://<origin>/api/auth/callback/github`（origin 与 `BETTER_AUTH_URL` 一致）；`GITHUB_ALLOWED_EMAILS` 为空 = 拒绝所有登录（fail-closed）。
- `[[ratelimits]]` 的 `namespace_id` 是**账号级**命名空间：同账号同值跨 Worker 共享计数。一键部署用户各自部署到各自账号，1001/1002 无碰撞；**同账号部署多个实例时须自行错开段位**。
- 本地 curl 验证线上可能需 `--ssl-no-revoke`（Windows schannel CRL）与自定义域名（workers.dev 域名在部分网络被 DNS 污染）。
- cron 每日 02:00 UTC 清理 `request_logs`（保留 `REQUEST_LOG_RETENTION_DAYS`，缺省 30）。
- vite 插件构建会在 `dist/` 产出生成的 `wrangler.json`（丢注释、丢 routes 细节）——部署一律走 `npm run deploy`（内部显式 `--config <选中>`）或显式 `--config`，勿依赖构建产物里的配置。

## 部署要点

> 全量从零手册：README「快速开始 + 部署后收尾清单」+ 本地 `governance/deployment.md`。

- **一键部署（按钮）**：克隆仓库 → 按 `wrangler.jsonc` 自动供给 D1/KV/Queues（Free 计划即可——Queues 在 Free/Paid 均可用，Free 含 10,000 ops/天额度；2026-10-15 实证修订，此前「需 Paid」为过时断言）→ 回写资源 id → Workers Builds 从 `main` 构建发布。**迁移不自动执行**——收尾清单第 1 步手动 `npx wrangler d1 migrations apply DB --remote`。
- **维护者生产部署**：本地生成 `wrangler.prod.jsonc`（真实 routes/id/vars；生成流程与字段表在本地 governance spec，**先加 .gitignore 再落盘**）→ `npm run deploy` 自动选中 → 探针验收。secrets 不进 fork，仍走 `wrangler secret put`。
- **🔴 fork `[vars]` 部署前须人工核对**：实施期 fork 从本地 `.dev.vars` 生成，其中 `GITHUB_CLIENT_ID="placeholder-github-client-id"` / `GITHUB_ALLOWED_EMAILS`（本地测试邮箱）/ `EMAIL_VERIFICATION_ENABLED="true"` 是 **dev 遗留值**（真实生产值历来自部署 shell export，从未落 `.dev.vars`）。每次用 fork 部署前核对这五键（加 `BETTER_AUTH_URL` / `EMAIL_ALLOWED_RECIPIENTS`）为真实生产值；`wrangler deploy` banner 会打印解析值（`env.X ("...")` 行），据此最终确认。
- **首个 admin 无自提升端点**：GitHub OAuth 登录（白名单内）→ 直接 D1 `UPDATE users SET role='admin' WHERE email=...`（唯一合法 bootstrap；**禁止 SQL INSERT 造用户**——Better Auth 哈希/绑定会被绕过）。无用户状态不能发邀请码，故 GitHub OAuth 是 bootstrap 唯一入口（README 收尾清单）。
- **删队列前先删消费者**：`wrangler deploy` 不删旧 consumer（实测孤儿消费者会常驻）；删旧队列先 `consumer remove`，归零用 `purge`。**队列表不可改名**，改名 = 新建 + 改绑定 + 删旧，切换后旧队列在途消息永不被消费。
- 资源命名式 `<worker 名>-<purpose>`；KV 是本栈唯一可原地改名的资源（`wrangler kv namespace rename`，按 id 寻址数据不动；**别用 key 计数前后对比验证数据还在**——活流量下计数是读数时刻的函数）。全表见本地 `config-inventory.md`。
- 本地验证 `wrangler deploy --dry-run` 只证明配置结构合法（含队列存在性在内的资源就绪要账号侧实查，见上文陷阱②）。

## 验收状态

> 全量证据与复跑命令：本地 `.trellis/spec/governance/verification.md`。

- 功能验收 AC1–AC9 全部 PASSED（本地 2026-08-25 `npm test` + lint + typecheck + dry-run 全绿；E2E `scripts/mock-upstream.mjs` + `verify-m3.mjs` / `verify-m4.mjs` 走 auth → keys → providers → /v1/* → 计费/限流/缓存）。AC6/AC9 已线上验证（2026-08-25，真实 GitHub OAuth 登录、双 admin 经 D1 提升）；认证面限流 AC11 已线上验证（2026-09-28，25 连发 22×401→3×429）。均为当时线上（含已退役的 staging）证据。
- **2026-10-14 一键部署适配后**：删除 `tests/render-config.unit.test.ts`（渲染管线拆除）与 `tests/seed-users.test.ts`（种子用户机制拆除），新增 `tests/config-fork.test.ts`（配置 fork 护栏）；全量测试/lint/typecheck/dry-run 复跑结果以该适配的交付报告与 CI 为准。
- **单测清单（10-08 现状，10-14 适配后按上条增删）**：`tests/` 按域归组（省略 `.test.ts`）：代理管线与协议 26 个（anthropic-inbound、config-enhance、disguise、endpoint-face-gate、error-adapt、error-format、forward-headers.unit、http-options.unit、max-tokens-clamp、model-id.unit、model-mask.unit、protocol-detect、protocol-detect-integration、proxy-pipeline、reasoning-effort-mapping、responses-api、responses-reasoning-visibility、sdk-integration、stream-include-usage、stream-settle、stream-thinking-interop、thinking-passthrough、verbatim-engine、verbatim-fidelity、verbatim-passthrough、verbatim-response-side）；计费/余额/用量 9（billing、billing-queue、bonus.unit、model-price-display.unit、settings、signup-bonus、transactions、usage、usage-series.unit）；限流/缓存 4（auth-rate-limit、cache、rate-counter、rate-limit）；供应商与模型配置 15（modelcap-fastpath、modelcap-grid.unit、modelcaps.unit、models-api、multi-upstream、provider-declare-endpoint、provider-endpoints.unit、provider-form.unit、provider-key-mask.unit、provider-ping、provider-presets-route、provider-presets.unit、provider-router、provider-test-probe、provider-test-state.unit）；认证/账户/邀请 13（admin-promotion-policy.unit、admin-users-delete、admin-users-promotion-switch、api-keys、change-password、email、email-verification-send、invite-check.unit、invite-link.unit、invite-register、invite-validate、onboarding、profile）；管理台 UI 3（format、menu-position.unit、popover-position.unit）；基础设施/配置 5→4（domain-split、migration-rebuild、queue-dispatch、**config-fork**；render-config.unit 与 seed-users 已随拆除删除，modelcap-grid.unit 计入模型配置组）。
- 已知偏差：`PATCH /api/admin/settings` 未实现（只读设计）；`recharge` 账目类型无端点写入（管理端充值记为 `adjust`）；`scripts/verify-codex-lite.mjs` 的 E2E_STG=1 模式随 staging 退役成为遗留死路（显式 fail-fast 并指向退役 runbook，未删除以保留参数对照）；线上环境需用户自带凭据（GitHub OAuth App client secret 经 `wrangler secret put`、上游供应商真实密钥部署后在管理台配置）。

## API 参考

**管理 API**（`/api/*`，会话鉴权）：

| 端点 | 访问权限 | 说明 |
| --- | --- | --- |
| `/api/auth/*` | public | Better Auth（邮箱密码、GitHub OAuth） |
| `/api/invites/validate` | public | 注册前预检邀请码（`valid: true/false`，只读不消耗，带限流） |
| `/api/me/usage` | member | 本人用量聚合 + 明细（分页） |
| `/api/me/transactions` | member | 本人余额账本（分页，类型/时间过滤） |
| `/api/keys` | member/admin | 本人网关密钥 CRUD（admin 可见全部） |
| `/api/users` | admin | 用户列表/角色/状态、邀请、余额调整 |
| `/api/providers` | admin | 上游供应商 CRUD（密钥 AES-GCM 加密，响应中打码） |
| `/api/models` | member/admin | 模型价格表（member 只读；admin CRUD + 每行免费/隐藏标志） |
| `/api/admin/usage` | admin | 全局用量，按用户/密钥/模型/时间过滤 |
| `/api/admin/transactions` | admin | 全局账本，可选 `userId` 过滤 |
| `/api/admin/settings` | admin | 运行时默认值（只读） |
| `/api/health` | public | 存活探针 |

`/api/users` 的角色变更受部署侧账户安全开关 `EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` 约束：开关关闭（缺省）时，把邮箱注册账号提升为 `admin` 会被 `403` 拒绝，管理台对相应行禁用该操作。降级、状态变更、既有 admin 与首个 admin bootstrap（直接 D1 `UPDATE`）不受影响。

**代理 API**（`/v1/*`、`/anthropic/*`，网关 key 鉴权，三个协议入口）：

| 端点 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | 聊天补全（流式 + 非流式） |
| `POST /v1/completions` | OpenAI | 文本补全 |
| `POST /v1/embeddings` | OpenAI | 向量嵌入 |
| `GET /v1/models` | OpenAI | 已配置模型列表 |
| `POST /v1/messages` | 双协议自动探测 | Anthropic Messages **或** OpenAI Chat Completions——逐请求探测（硬信号，否则 `claude-*` → Anthropic / 其余 → OpenAI） |
| `POST /v1/responses` | OpenAI Responses | Responses API（流式 SSE 无 `[DONE]` 终止符，遵循官方协议） |
| `POST /anthropic/v1/messages` | Anthropic Messages | Anthropic Messages API——官方 Anthropic SDK 的 baseURL 目标 |
| `POST /anthropic/messages` | Anthropic Messages | 上者的别名（无路径后缀的 SDK baseURL） |

错误格式跟随入口协议：`/v1/*` 各面用 OpenAI 风格 `{ "error": { "message": "..." } }`（含 Zod 校验失败），`/anthropic/*` 用 Anthropic 风格 `{ "type": "error", "error": { "type": ..., "message": ... } }`。`/v1/messages` 的错误跟随**探测结果**协议：探测为 Anthropic 的请求回 Anthropic 错误形态，探测为 OpenAI 的回 OpenAI 形态；混合两种协议的请求以 `400` 拒绝。

### SDK baseURL 约定

官方 SDK 指向网关时用网关 API key（`Authorization: Bearer sk-…` 或 Anthropic SDK 的 `x-api-key`）：

```ts
// Anthropic TS SDK
const anthropic = new Anthropic({ apiKey: "sk-…", baseURL: "https://<gateway>/anthropic" });
await anthropic.messages.create({ model, max_tokens: 1024, messages: [{ role: "user", content: "hi" }] });

// OpenAI TS SDK (Responses API)
const openai = new OpenAI({ apiKey: "sk-…", baseURL: "https://<gateway>/v1" });
await openai.responses.create({ model, input: "hi" });
```

Anthropic SDK 请求原生携带 `x-api-key` + `anthropic-version` 头；两者在所有代理入口均被接受（缺 `Authorization: Bearer` 时 `x-api-key` 兜底）。

## 安全

> 全量：本地 `.trellis/spec/governance/security-audit.md`（基线 2026-09-23：0 HIGH/2 MED/4 LOW；P2–P6 暂缓）。

- 2026-08-26 gitleaks 全历史 **0 命中**；历史 PII 已全量 squash 清除，远程零 PII；仓库已于 2026-10-08 转公开（checklist 见 security-audit.md §0–§7；**永不推 `backup/*` tags**）。
- 零-secrets 轻量 CI（`.github/workflows/ci.yml`：build / test / lint / typecheck，`permissions: contents: read`，不引用任何 secrets；**CI 无 `.dev.vars`**——测试环境由 vitest.config.ts 全量 pin + `TEST_MIGRATIONS` 提供，`wrangler.jsonc` 常驻仓库提供绑定）。

## 项目结构

```
src/                 Worker backend (Hono)
  routes/            API modules (usage, billing, settings, keys, providers, models, users, v1)
  middleware/        requestContext, requireSession/adminOnly, gateway auth, domain-split
  lib/               billing, rate limiting, cache, cleanup, security, adapters helpers
  providers/         openai / anthropic adapters + SSE conversion
  db/                Drizzle schema + D1 access
app/                 React SPA (React Router v7, React Query, Tailwind)
tests/               Vitest + Miniflare suite
scripts/             mock upstream + E2E verification + deploy runner (deploy.mjs)
wrangler.jsonc       常驻部署配置（按钮形态：占位 id + 安全缺省 vars，无 routes）
CLAUDE.md            knowledge entry (deploy config / git workflow / env config / deploy / AC summary; extended specs live in a local, gitignored store — not shipped)
drizzle/             SQL migrations
```

## Spec 索引与工作流

> 以下 `.trellis/*` 路径均为**本地内部 spec / 工作流文件**（gitignored，不随开源仓库分发）；链接仅供参考，仓库读者不可达。

- Spec 主索引：`.trellis/spec/README.md`（backend / frontend / shared / guides / big-question / **governance**）。
- Governance 类目（本仓库治理/运维全量）：`.trellis/spec/governance/index.md`（含 **stg-retirement.md**：staging 环境退役 runbook）。
- 开发任务工作流（任务创建需用户同意）：`.trellis/workflow.md`。
- 原 `docs/` 目录已于 2026-08-28 删除（内容移管至此 + 本文件）。
