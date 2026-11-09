<p align="center">
  <img src="doc/icon-256.png" width="128" height="128" alt="TokiAPI" />
</p>

<h1 align="center">TokiAPI</h1>

<p align="center">
  <strong>一个 OpenAI 兼容 API，接入所有模型供应商 —— 自托管在 Cloudflare 上。</strong>
</p>

<p align="center">
  <a href="https://github.com/limccn/TokiAPI/actions/workflows/ci.yml"><img src="https://github.com/limccn/TokiAPI/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/limccn/TokiAPI/releases"><img src="https://img.shields.io/github/v/release/limccn/TokiAPI?sort=semver&amp;style=flat-square&amp;label=release" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/limccn/TokiAPI?style=flat-square" alt="License: MIT" /></a>
  <a href="https://github.com/limccn/TokiAPI/stargazers"><img src="https://img.shields.io/github/stars/limccn/TokiAPI?style=flat-square" alt="GitHub stars" /></a>
  <a href="https://github.com/limccn/TokiAPI/commits/develop"><img src="https://img.shields.io/github/last-commit/limccn/TokiAPI?style=flat-square" alt="Last commit" /></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&amp;logo=cloudflare&amp;logoColor=white" alt="Cloudflare Workers" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/TokiAPI"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" /></a>
  <a href="https://appflare.dev/install/?repo=limccn/TokiAPI"><img src="https://appflare.dev/badge.svg" alt="Install with Appflare" /></a>
</p>

---

TokiAPI 是一个自托管的 AI API 网关。它把**一个 OpenAI 兼容端点**放在多家模型供应商前面
（OpenAI 兼容与 Anthropic 原生协议都支持），让应用只用一个 base URL、一把 key，
同时在同一个管理台里查看用量、密钥、余额与价格。

核心完全运行在 Cloudflare 上（Workers、D1、KV、Queues）。邮箱验证与短信登录是
**可选**的 Resend / 阿里云集成；不配置时网关照常运行。

## 目录

- [为什么选择 TokiAPI？](#为什么选择-tokiapi)
- [试用托管实例](#试用托管实例)
- [快速开始](#快速开始)
- [部署后：收尾清单](#部署后收尾清单)
- [必须设置正确的关键变量](#必须设置正确的关键变量)
- [配置参考](#配置参考)
- [外部依赖](#外部依赖)
- [短信门禁](#短信门禁)
- [接入你的应用](#接入你的应用)
- [工作原理](#工作原理)
- [管理台](#管理台)
- [仓库结构](#仓库结构)
- [常见问题与故障排查](#常见问题与故障排查)
- [贡献与安全](#贡献与安全)
- [许可证](#许可证)

## 为什么选择 TokiAPI？

- **一个端点，多家供应商。** 注册任意数量的上游供应商，切换模型时只改 `model` 参数。
- **官方 SDK 直接可用。** 把 OpenAI 或 Anthropic SDK 指向网关即可，应用代码不需要做协议转换。
- **适配编码 Agent。** Claude Code、Codex CLI、CC Switch 等 OpenAI/Anthropic 兼容工具可直接接入。
- **团队密钥。** 按人或按应用签发 key，设置限流，随时吊销。
- **预付费计费。** 按 token 计价，余额可见；失败的请求不计费。
- **限流与响应缓存。** 超额请求自动拒绝；重复的非流式请求可由边缘缓存直接返回。
- **管理台。** 用量报表、密钥、成员、供应商、模型价格与账户设置集中在一处。
- **数据留在自己的账号。** 用户、密钥、价格、余额与请求日志都在你自己的 Cloudflare D1/KV 资源里。

## 试用托管实例

托管实例运行在 **<https://tokiapi.app>**，API 地址为
**<https://api.tokiapi.app/v1>**（OpenAI 兼容）与 **<https://api.tokiapi.app/anthropic>**
（Anthropic 原生）。

邮箱密码与手机号注册需要邀请码；GitHub 登录开放。该实例面向评估用途：不提供 SLA，容量有限，
请勿通过共享实例提交敏感数据。

如需邀请码，请使用专门的 issue 表单：

**[申请邀请码](https://github.com/limccn/TokiAPI/issues/new?template=invite-request.yml)**

表单会询问：

- 你打算用它做什么
- 计划使用哪些模型或供应商
- 预计的月用量
- 确认会合理使用、不转售

也可以把下面的模板复制到新 issue 中：

```text
用途：
计划使用的模型 / 供应商：
预计月用量：
其他说明：
```

请**不要**在 issue 中填写手机号、密码、API key 或其他敏感信息。

## 快速开始

| 我想…… | 从这里开始 |
| --- | --- |
| 不部署，先试用 | [试用托管实例](#试用托管实例) |
| 部署自己的实例 | [一键部署](#方式-a一键部署推荐) |
| 本地运行或参与开发 | [本地开发](#方式-c本地开发) |

### 方式 A：一键部署（推荐）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/limccn/TokiAPI)

Cloudflare 会把仓库克隆到你的账号，并按 `wrangler.jsonc` 的声明自动供给 D1、KV 与 Queues
资源（真实资源 id 会回写到你账号里的这份配置）。构建与发布由 Workers Builds 负责。
Secrets 与个性化配置在 setup 页面填写。

**前置条件**

- 一个 Cloudflare 账号。**免费计划即可**：Queues 在 Free 与 Paid 计划都可用，但有每日操作额度。
  如果预计流量较大，请以 Cloudflare 当前的额度说明为准。
- *（可选）* 一个 GitHub OAuth App —— GitHub 登录需要它，而 GitHub 登录也是首个管理员的引导路径。
- *（可选）* Resend 和/或阿里云账号，用于邮箱验证或短信登录。

**步骤**

1. 点击 Deploy 按钮，完成 Cloudflare 的部署流程。
2. 在 setup 页面填入需要的 secrets。至少生成两个相互独立的随机值：
   `BETTER_AUTH_SECRET` 与 `GATEWAY_SECRET_KEY`。
3. 把 `BETTER_AUTH_URL` 设置为部署的真实 origin（例如
   `https://<worker-name>.<your-subdomain>.workers.dev`），不要保留 localhost 缺省值。
4. 等待 Workers Builds 完成首次部署。
5. **手动执行一次**数据库迁移（一键部署**不会**自动执行）。请在 Cloudflare 创建到你账号里的那份
   仓库副本的本地克隆中执行 —— 上游原仓库里的资源 id 仍是占位符：

   ```bash
   npx wrangler d1 migrations apply DB --remote
   ```

6. 继续阅读[部署后：收尾清单](#部署后收尾清单)。

> **替代方案：** [Appflare](https://appflare.dev) 是第三方平台，会在你的 Cloudflare 账号里安装一个
> 管理 Worker。它的安装流程会自动供给资源、执行迁移并填写站点 URL。其“从仓库构建”的形态可能要求
> 付费 Workers 计划，具体以 Appflare 文档为准。

### 方式 B：手动部署

如果你希望自己创建资源或从本机部署，使用这条路径。

```bash
git clone https://github.com/limccn/TokiAPI.git tokiapi
cd tokiapi
npm install
```

创建资源，并把真实 id 回填到 `wrangler.jsonc`（仓库里的 id 是给本地开发与 Deploy 按钮用的占位符）。
资源名必须与 `wrangler.jsonc` 中声明的 `name` / `database_name` / `queue` 一致；若要改名，两处一起改：

```bash
# 把每个 <...> 替换为 wrangler.jsonc 中对应的资源名
npx wrangler d1 create <database-name>          # database_id → wrangler.jsonc
npx wrangler kv namespace create CACHE_KV        # id → wrangler.jsonc
npx wrangler queues create <usage-queue>
npx wrangler queues create <billing-queue>
```

如果修改计费队列名，还要同步更新 `BILLING_QUEUE_NAME` —— 队列分派按名称精确比对。

从提交入库的模板创建本地变量文件：

```bash
cp .dev.vars.example .dev.vars
```

然后一条命令完成构建、迁移与部署：

```bash
npm run deploy               # 构建 → 远程 D1 迁移 → wrangler deploy
npm run deploy -- --dry-run  # 预览：只构建，打印选中的配置与将执行的远程命令
```

`scripts/deploy.mjs` 会优先使用 `wrangler.prod.jsonc`（gitignored 的维护者 fork），否则使用
`wrangler.jsonc`。普通部署不需要创建 fork。

### 方式 C：本地开发

**环境要求：** Node.js 20 或更高版本，以及 npm。不需要 Cloudflare 账号。

```bash
git clone https://github.com/limccn/TokiAPI.git tokiapi
cd tokiapi
npm install

cp .dev.vars.example .dev.vars   # 至少填写 BETTER_AUTH_SECRET 与 GATEWAY_SECRET_KEY
npm run db:migrate               # 把迁移应用到本地 D1
npm run db:seed                  # 导入默认模型价格表
npm run dev                      # http://localhost:5173
```

本地开发从 `wrangler.jsonc` 读取绑定与安全缺省值，从 `.dev.vars` 读取本地覆盖。
GitHub OAuth 在本地是可选的。

**首个管理员从哪里来（本地与生产同理）：** 邮箱密码注册需要邀请码，而首个管理员还没有邀请码可用。
请使用 GitHub OAuth：把自己的邮箱写进 `ADMIN_EMAILS`，配置 `GITHUB_CLIENT_ID` /
`GITHUB_CLIENT_SECRET`，然后登录 —— 账号会自动提权。如果邮箱不在名单里，登录后手动提升：

```bash
npx wrangler d1 execute DB --local --config wrangler.jsonc \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

永远不要用 `INSERT` SQL 创建用户；那会绕过 Better Auth 的密码哈希与账号绑定。

## 部署后：收尾清单

系统以安全状态启动：零用户、所有策略开关关闭。请按顺序完成以下步骤。

### 1. 应用数据库迁移

一键部署不会自动执行；手动 `npm run deploy` 已经包含这一步。一键部署请在账号内仓库副本的本地克隆中执行（上游原仓库是占位 id）。

```bash
npx wrangler d1 migrations apply DB --remote
```

**验证：** 命令报告迁移已应用且无错误。

### 2. 设置站点 URL

在 Dashboard → Workers & Pages → 你的 Worker → Settings → Variables and Secrets 中，把
`BETTER_AUTH_URL` 设为真实 origin（例如 `https://<worker-name>.<your-subdomain>.workers.dev`）。
如果使用维护者 fork，则改 `wrangler.prod.jsonc`。

**原因：** 缺省值 `http://localhost:5173` 会让管理面请求 301 到 `https://localhost/...`。
API 流量可能仍然正常，因此这个问题很容易被忽略。

**验证：** 打开管理台并登录，确认浏览器停留在真实 origin。

### 3. 写入必需的 secrets

```bash
npx wrangler secret put BETTER_AUTH_SECRET     # 会话签名密钥，随机，≥ 32 字符
npx wrangler secret put GATEWAY_SECRET_KEY     # 上游密钥加密密钥，随机，≥ 32 字符
```

两个值分别随机生成。`GATEWAY_SECRET_KEY` 用于加密上游供应商密钥，绝不能与
`BETTER_AUTH_SECRET` 相同。

只在启用对应功能时再添加可选 secrets：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET   # GitHub 登录
npx wrangler secret put RESEND_API_KEY         # 邮箱验证（Resend）
npx wrangler secret put SMS_ACCESS_KEY_ID      # 短信登录（阿里云）
npx wrangler secret put SMS_ACCESS_KEY_SECRET
```

### 4. 创建 GitHub OAuth App 并引导首个管理员

1. GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**。
2. 回调地址必须精确等于 `https://<your-origin>/api/auth/callback/github`。
3. 把 Client ID 填入 `GITHUB_CLIENT_ID`（Dashboard 变量或 `wrangler.jsonc`），
   Client Secret 写入 `GITHUB_CLIENT_SECRET` secret。
4. 把自己的邮箱写进 `ADMIN_EMAILS`（逗号分隔；Dashboard 变量或 `wrangler.jsonc`）。
5. 使用 GitHub 登录。账号会自动提升为 admin。

如果邮箱不在 `ADMIN_EMAILS` 中，登录后手动提升：

```bash
npx wrangler d1 execute DB --remote \
  --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
```

`ADMIN_EMAILS` 在注册与登录时提权，且只升不降。**管理员建立完成后请清空该名单** ——
空名单表示不再自动提权。如果你使用短信登录，清空前请先阅读
[必须设置正确的关键变量](#必须设置正确的关键变量)。

### 5. 创建邀请码

登录管理台，打开 Invites 页面，生成邀请链接发给成员。
开启短信时，注册是三屏流程：邀请码 + 手机验证码 → 用户名与密码 → 可选绑定邮箱。
关闭短信时，注册使用邮箱与密码（该流程仍需邀请码）；GitHub 注册开放，不需要邀请码。

### 6. 添加上游供应商与模型价格

管理台 → **Providers**：添加上游供应商及其 API key。密钥使用 AES-GCM 加密，响应中打码。
管理台 → **Models**：添加应用将要发送的模型名，或导入默认价格表：

```bash
npx wrangler d1 execute DB --remote --file=./seed.sql
```

`seed.sql` 是**全量替换**语义；只在你还没有配置自己的价格时使用。

### 7. 冒烟测试

```bash
curl https://<your-origin>/api/health
curl https://<your-origin>/v1/models -H "Authorization: Bearer sk-..."
```

健康检查返回 `200`，带鉴权的模型列表能正常返回，即表示实例可用。

### 8. 可选：启用邮箱验证（Resend）

见[使用 Resend 发送邮件](#使用-resend-发送邮件)。在 Resend 域名验证完成、
`EMAIL_FROM` 指向该域名之前，请保持关闭。

### 9. 可选：启用短信登录（阿里云）

见[使用阿里云短信](#使用阿里云短信)。在设置 `SMS_AUTH_ENABLED=true` **之前**，
先配置好凭据、签名、模板与测试白名单，因为该开关同时会启用[短信门禁](#短信门禁)。

## 必须设置正确的关键变量

### `BETTER_AUTH_URL`

平台（管理台）域的完整 origin，例如 `https://tokiapi.example.com`。

- 生产环境必须设为真实 origin。localhost 缺省值会让管理页面 301 到 `https://localhost/...`。
- GitHub OAuth 回调必须使用同一 origin：
  `https://<origin>/api/auth/callback/github`。
- 如果使用独立的 API 域名，还需设置 `API_DOMAIN`（见配置表）。

### `ADMIN_EMAILS`

逗号分隔的邮箱名单，名单内账号在注册或登录时自动成为管理员。

- **空 = 无人自动提权。** 登录本身不受该名单限制。
- 提权是单向的：已被提升的账号即使从名单移除，仍是 admin。
- 该名单是**引导工具**，不是永久的角色存储。管理员建立完成后请清空。
- 如果 `SMS_AUTH_ENABLED=true`，该名单还会授予短信门禁豁免 —— 但仅当账号邮箱已验证时。
  清空名单也会移除该豁免。清空前请确保每位管理员都已验证手机号，否则保留名单直到他们完成绑定。
  清空名单后，未验证手机的管理员仍可访问 `/bind-phone`，但其他 `/api/*` 调用会返回 `403`。

### `SMS_ALLOWED_PHONES`

逗号分隔的手机号白名单，只有名单内的号码可以接收短信验证码。

- 支持格式：`+8613800138000` 或 `13800138000`。空格与连字符会被清洗。
- **空 = 全放行。** 任何能访问发送验证码端点的人，都可以向任意合法号码触发付费短信。
- **非空但全部非法 = 全拒**（fail-closed），不会静默退化为“全放行”。
- 名单外的号码会被**静默跳过**：端点可能仍返回成功，但不会发出短信。
  测试前先把测试号码加入名单。
- 推荐上线节奏：先用测试白名单 → 验证送达 → 再决定保留团队白名单或有意清空。

### `EMAIL_ALLOWED_RECIPIENTS`

逗号分隔的事务邮件收件人白名单。

- **空 = 全放行**（与短信白名单语义相同，不是相反）。
- 非空 = 只有名单内地址能收到邮件。
- 仅在 `EMAIL_VERIFICATION_ENABLED=true` 时相关。测试期间建议设为自己的地址。

## 配置参考

### Secrets

绝不写入配置文件、README 或源码。使用 `wrangler secret put`（或一键部署 setup 页面）。

| Secret | 是否必需 | 用途 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | 是 | 会话签名。随机，≥ 32 字符。 |
| `GATEWAY_SECRET_KEY` | 是 | 加密上游供应商密钥。随机，≥ 32 字符，且与 auth secret 不同。 |
| `GITHUB_CLIENT_SECRET` | 仅 GitHub 登录 | GitHub OAuth App 的 client secret。 |
| `RESEND_API_KEY` | 仅邮件 | Resend API key；建议使用 send-only key。 |
| `SMS_ACCESS_KEY_ID` | 仅短信 | 阿里云 RAM AccessKey ID。 |
| `SMS_ACCESS_KEY_SECRET` | 仅短信 | 阿里云 RAM AccessKey secret。 |

### 运行时变量

提交入库的 `wrangler.jsonc` 带有安全缺省值。个性化值请在 Dashboard、
`wrangler.prod.jsonc`（维护者 fork）或 `.dev.vars`（仅本地）中修改。

| 变量 | 缺省值 | 作用 |
| --- | --- | --- |
| `BETTER_AUTH_URL` | `http://localhost:5173` | 平台 origin。**生产必须修改。** |
| `GITHUB_CLIENT_ID` | 占位符 | GitHub OAuth App client id。 |
| `ADMIN_EMAILS` | 空 | 自动提权邮箱名单。空 = 不自动提权。引导完成后清空。 |
| `API_DOMAIN` | 空 | 双域名分流用的独立 API 域名。空 = 单域名。 |
| `API_KEY_PREFIX` | `sk-` | 新生成网关 key 的前缀。 |
| `REQUEST_LOG_RETENTION_DAYS` | `30` | 请求日志保留天数；每日 cron 清理。 |
| `CACHE_ENABLED` | `false` | 全局响应缓存开关。 |
| `BILLING_QUEUE_NAME` | `<billing-queue>` | 必须与 `wrangler.jsonc` 中的计费队列名一致（改队列名时两处一起改）；高级项。 |
| `SIGNUP_BONUS_AMOUNT` | `5` | 验证手机号时发放的赠金（USD）。`0` = 不赠。 |
| `EMAIL_VERIFY_BONUS_AMOUNT` | `5` | 验证/绑定邮箱时发放的赠金。`0` = 不赠。 |
| `GITHUB_BIND_BONUS_AMOUNT` | `5` | 注册后绑定 GitHub 时发放的赠金。`0` = 不赠。 |
| `EMAIL_VERIFICATION_ENABLED` | `false` | 启用邮箱验证与邮箱绑定赠金。不阻断登录。 |
| `EMAIL_ALLOWED_RECIPIENTS` | 空 | 邮件收件人白名单。**空 = 全放行。** |
| `EMAIL_FROM` | 空 | 事务邮件发件地址。空 = 内置 `notify@tokiapi.app`（仅托管实例拥有该域）。自部署请设置。 |
| `EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` | `false` | 允许通过用户 API 把邮箱注册账号提升为 admin。不影响 `ADMIN_EMAILS`。 |
| `SMS_AUTH_ENABLED` | `false` | 启用手机号登录/注册与短信门禁。关闭时端点返回 404、手机 UI 隐藏。 |
| `SMS_ALLOWED_PHONES` | 空 | 短信白名单。**空 = 全放行**；全部非法 = 全拒。 |
| `SMS_SIGN_NAME` | 空 | 阿里云短信签名名称。 |
| `SMS_TEMPLATE_CODE` | 空 | 登录/注册/绑定用的模板 CODE。赠送模板为 `100001`–`100005`。 |
| `SMS_TEMPLATE_CODE_RESET` | 空 | 找回密码模板 CODE。空 = 复用 `SMS_TEMPLATE_CODE`；建议 `100003`。 |
| `SMS_TEMPLATE_PARAM` | `{"code":"##code##","min":"5"}` | 模板变量映射。`##code##` 会替换为真实验证码。 |
| `MODELCAP_BASE_TOKENS` | `8192` | 高级：modelcap 档位基准。 |
| `MODELCAP_MULTIPLIER` | `2` | 高级：modelcap 档位乘数。 |

每个键的权威注释也写在 `wrangler.jsonc` 与 `.dev.vars.example` 中。

## 外部依赖

两个集成都是可选的。不配置时网关照常工作，只是不发邮件或短信。失败模式刻意保持安静，
以免可选集成缺失阻断核心代理 —— 但这也意味着配置完成后必须自行测试。

### 使用 Resend 发送邮件

用于邮箱验证与邮箱绑定赠金。它**不会**阻断登录。

1. 注册 [Resend](https://resend.com) 账号。
2. 添加要用于发件的域名，并按 Resend 的提示添加 DNS 记录。等待域名验证通过。
3. 创建一个只有**发送**权限的 API key。
4. 写入 key：

   ```bash
   npx wrangler secret put RESEND_API_KEY
   ```

5. 把 `EMAIL_FROM` 设为已验证域名下的地址，例如 `notify@mail.example.com`。
   留空会使用内置的 `notify@tokiapi.app`，该地址只在托管实例可用。
6. 设置 `EMAIL_VERIFICATION_ENABLED=true`。
7. *（测试期推荐）* 把 `EMAIL_ALLOWED_RECIPIENTS` 设为自己的地址。空表示允许所有收件人。

**如何验证：** 在管理台绑定邮箱，或使用重发验证邮件操作，确认邮件到达。在 Worker 日志中查看：

| 日志事件 | 含义 |
| --- | --- |
| `email_not_configured` | `RESEND_API_KEY` 为空，通道休眠。 |
| `email_skipped_allowlist` | 收件人不在 `EMAIL_ALLOWED_RECIPIENTS` 中。 |
| `email_sent` | Resend 已接受邮件。 |
| `email_send_failed` | Resend 拒绝（域名、key 或请求体问题）。 |

**常见问题**

- **完全收不到邮件：** key 缺失、域名未验证，或收件人不在白名单。
- **Resend 拒绝发件人：** `EMAIL_FROM` 仍是内置的 `notify@tokiapi.app`，而你的 Resend 账号并不拥有该域。
- **Resend 沙箱：** `onboarding@resend.dev` 只能发往 Resend 账号所有者自己的地址。
  面向真实用户时，请验证自己的域名。

### 使用阿里云短信

用于手机号登录、手机号注册、绑定手机号与找回密码。网关使用**阿里云「短信认证」**
（`dypnsapi`），而不是旧的「短信服务」（`dysmsapi`）。

**前置条件**

- 已完成实名认证的阿里云账号。
- 已在控制台开通**短信认证**服务。
- 一个只授予 `dypns:SendSmsVerifyCode` 权限的 RAM 子账号（最小权限），以及该账号的 AccessKey。
- 一个签名名称与一个模板 CODE。控制台提供五个赠送模板；可用性取决于账号与地域。
  如果不可用，请申请使用相同变量的模板。

1. 创建 RAM 子账号与 AccessKey。不要使用主账号 AccessKey。
2. 写入凭据：

   ```bash
   npx wrangler secret put SMS_ACCESS_KEY_ID
   npx wrangler secret put SMS_ACCESS_KEY_SECRET
   ```

3. 把控制台的**签名名称**抄写到 `SMS_SIGN_NAME`。
4. 把 `SMS_TEMPLATE_CODE` 设为赠送模板之一：

   | CODE | 适用场景 |
   | --- | --- |
   | `100001` | 登录 / 注册 / 通用 |
   | `100002` | 修改绑定号码 |
   | `100003` | 重置密码 |
   | `100004` | 绑定新号码 |
   | `100005` | 验证已绑定号码 |

   五个模板只有文案不同，变量都是 `${code}` 与 `${min}`。找回密码可设
   `SMS_TEMPLATE_CODE_RESET=100003`（空 = 复用主模板）。
5. 如果模板使用不同的变量名，修改 `SMS_TEMPLATE_PARAM` 的键。
   缺省为 `{"code":"##code##","min":"5"}`；`##code##` 会替换为真实验证码。
6. 把一个测试号码加入 `SMS_ALLOWED_PHONES`，例如 `+8613800138000`。
   除非确实想允许所有号码，测试期间不要留空。
7. **最后**再设置 `SMS_AUTH_ENABLED=true`。该开关同时启用[短信门禁](#短信门禁)。
8. 从登录页请求验证码，确认短信到达。

**限制**

- 仅支持中国内地 `+86` 号码；模板为中文。
- 同一号码 60 秒内只能发一条。
- 验证码 5 分钟内有效，允许 3 次尝试。
- 阿里云按条计费；赠送模板与额度以其控制台为准。

**验证 / 排错**

| 日志或错误 | 含义 |
| --- | --- |
| `sms_not_configured` | `SMS_ACCESS_KEY_ID` 或 `SMS_ACCESS_KEY_SECRET` 为空，发送被跳过。 |
| `sms_skipped_allowlist` | 号码不在 `SMS_ALLOWED_PHONES` 中，不会发送。 |
| `SMS_CONFIG_INVALID` | `SMS_SIGN_NAME`、`SMS_TEMPLATE_CODE` 或 `SMS_TEMPLATE_PARAM` 缺失/非法。 |
| `ILLEGAL_MOBILE` | 不是合法的中国内地手机号。 |
| `biz.FREQUENCY` | 同一号码 60 秒内重复请求。 |
| `SMS_SEND_FAILED` | 网络或签名失败；检查 AccessKey 与系统时间。 |

> **先配置，再开开关。** 如果 `SMS_AUTH_ENABLED=true` 但 AccessKey 缺失，端点会处于启用状态，
> 而每次发送都被静默跳过。如果号码不在白名单，界面可能提示已发送，但实际上收不到。
> 请先用名单内号码测试。

## 短信门禁

当 `SMS_AUTH_ENABLED=true` 时，未验证手机的账号会受到限制：

- 可以访问 `/bind-phone` 页面、`GET /api/me/profile` 与 `POST /api/me/password`。
- 其余受门禁的 `/api/*` 调用返回 `403`，错误体带 `code: "PHONE_BINDING_REQUIRED"`；
  门禁之前挂载的公开路由（`/api/auth/*`、`/api/health`、`/api/config`、`/api/invites/*`）不受影响。
- `/v1/*` 与 `/anthropic/*` 代理**不受影响**。
- 在 `ADMIN_EMAILS` 名单内**且邮箱已验证**的账号可豁免。邮箱未验证不算；
  清空 `ADMIN_EMAILS` 会移除该豁免。
- 把 `SMS_AUTH_ENABLED` 改回 `false` 会移除门禁，手机相关端点重新返回 `404`；这是回滚路径。

如果要在既有部署上开启短信，请为现有成员做好准备：他们下次访问时会被要求绑定手机号。
确保手机白名单包含他们的号码（或留空），并确保管理员在清空 `ADMIN_EMAILS` 前已完成绑定。

## 接入你的应用

在管理台创建网关 key（Keys → Create key）。完整 key 只显示一次。

### OpenAI SDK

```ts
import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "sk-…",                          // 网关 API key
  baseURL: "https://<gateway>/v1",         // 只改这一行
});

const completion = await openai.chat.completions.create({
  model: "gpt-…",                          // 网关中已配置的模型
  messages: [{ role: "user", content: "hi" }],
});
```

### Anthropic SDK

```ts
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: "sk-…",                          // 网关 API key
  baseURL: "https://<gateway>/anthropic",  // 只改这一行
});

const message = await anthropic.messages.create({
  model: "claude-…",                       // 网关中已配置的模型
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
});
```

`Authorization: Bearer` 与 Anthropic 原生的 `x-api-key` 两种头都被接受。

### 端点

| 端点 | 协议 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat Completions | 流式与非流式。 |
| `POST /v1/completions` | OpenAI | 文本补全。 |
| `POST /v1/embeddings` | OpenAI | 向量嵌入。 |
| `POST /v1/responses` | OpenAI Responses | 流式 SSE，无 `[DONE]` 终止符。 |
| `POST /v1/messages` | 自动探测 | Anthropic Messages 或 OpenAI Chat Completions，逐请求探测。 |
| `GET /v1/models` | OpenAI | 网关中已配置的模型。 |
| `POST /anthropic/v1/messages` | Anthropic Messages | 官方 Anthropic SDK 的目标路径。 |
| `POST /anthropic/messages` | Anthropic Messages | 供 baseURL 不带路径后缀的 SDK 使用的别名。 |

错误格式跟随入口协议：`/v1/*` 使用 OpenAI 风格 `{ "error": { "message": … } }`，
`/anthropic/*` 使用 Anthropic 风格 `{ "type": "error", "error": { … } }`；
`/v1/messages` 按该请求探测出的协议返回错误。

请求中的模型名必须与管理台配置的模型完全一致。Claude Code、Codex CLI 与 CC Switch
的配置片段可在部署实例的 `/docs` 页面查看。

## 工作原理

```text
客户端（OpenAI / Anthropic SDK、编码 Agent）
        │
        ▼
Cloudflare Worker（Hono）
  ├── 网关 key 鉴权 ──► D1（用户、密钥、余额、价格、用量）
  ├── 限流 ───────────► KV 计数器
  ├── 响应缓存 ───────► KV
  ├── 供应商路由 ─────► OpenAI 兼容 / Anthropic 上游
  └── 用量结算 ───────► Queues（用量 + 计费聚合）
```

- **D1** 存储用户、网关密钥、供应商、模型价格、余额、交易与请求日志。
- **KV** 保存限流计数与可选的响应缓存。
- **Queues** 异步聚合用量与计费；队列消费者追上后，管理台才会反映最新用量。
- 每日 cron 清理超过 `REQUEST_LOG_RETENTION_DAYS` 的请求日志。

**数据边界：** 提示词与响应会发送给你配置的上游供应商。其余内容 —— 账号、密钥、价格、余额与日志 ——
都留在你的 Cloudflare 账号中。Resend 会收到收件邮箱与验证内容；阿里云会收到手机号与验证码。
网关本身不向任何地方发送分析或遥测数据。

## 管理台

托管实例 <https://tokiapi.app> 展示了当前的管理台。

- **Dashboard** —— 余额、消费、请求数与 token 用量。
- **API Keys** —— 创建、查看与吊销网关密钥。
- **Billing** —— 余额与交易记录。
- **Usage** —— 按密钥、模型与时间范围查看用量。
- **Providers** —— 上游供应商与加密保存的 API key。
- **Models** —— 模型名、价格、免费/可见标志。
- **Users** —— 成员、角色、邀请、赠金与已绑定的登录方式。
- **Settings** —— 当前生效的运行时缺省值与策略开关（只读；修改请到 Cloudflare）。

## 仓库结构

```text
src/                 Worker 后端（Hono）：路由、中间件、计费、供应商适配
app/                 React SPA：管理台、公开页面、文档页
drizzle/             D1 迁移（只增不改）
tests/               Vitest + Miniflare 测试套件
scripts/             部署执行器、E2E 探针与夹具
seed.sql             默认模型价格表（全量替换；见第 6 步）
doc/                 README 图形资源与管理台截图
wrangler.jsonc       提交入库的部署配置：占位 id + 安全缺省值
README.md            英文 README
README.zh-CN.md      中文 README（本文件）
CLAUDE.md            面向维护者的更深入工程笔记（中文）
```

## 常见问题与故障排查

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| 管理台重定向到 `https://localhost/...` | `BETTER_AUTH_URL` 仍是缺省值 | 设为真实 origin 并重新部署。 |
| `403 PHONE_BINDING_REQUIRED` | 已开启短信，账号未验证手机 | 打开 `/bind-phone`；`ADMIN_EMAILS` 中邮箱已验证的管理员可豁免。 |
| `/v1/*` 返回 `401` | 网关 key 缺失、错误或已吊销 | 检查 `Authorization: Bearer sk-…`，或新建 key。 |
| 手机相关端点返回 `404` | `SMS_AUTH_ENABLED` 不是 `true` | 在凭据与模板配置完成后再开启。 |
| 收不到邮件 | Resend key 缺失、域名未验证，或收件人不在白名单 | 查看日志与 Resend 控制台。 |
| 收不到短信 | AccessKey 缺失、号码不在 `SMS_ALLOWED_PHONES`、签名/模板非法，或 60 秒频控 | 查看日志；先把测试号码加入白名单。 |
| “邀请码无效、已使用或已过期” | 邀请码已被消耗或过期 | 请管理员重新生成。 |
| 用量或计费没有立即更新 | 队列消费者尚未追上，或队列名配置错误 | 检查 Queues 控制台与 `BILLING_QUEUE_NAME`。 |
| `npm run deploy` 选错了配置 | 存在 `wrangler.prod.jsonc` fork | 运行 `npm run deploy -- --dry-run` 查看选中的配置。 |
| `wrangler deploy --dry-run` 通过但部署失败 | dry-run 不校验队列/资源是否存在 | 先在账号中创建资源。 |
| 如何更新？ | — | 手动部署：`git pull`，然后 `npm run deploy`。Workers Builds：向它跟踪的分支推送或合并。 |
| 如何回滚？ | — | `npx wrangler rollback`；迁移只增不改，永远不要修改已应用的迁移。 |
| 需要自定义域名吗？ | — | 不需要；`*.workers.dev` 可用。把 `BETTER_AUTH_URL` 设为该 origin。 |
| 免费计划够用吗？ | — | 小团队通常够用；流量较大时请核对 Cloudflare Queues 当前额度。 |

## 贡献与安全

欢迎提交 issue 与 pull request。提交改动前请先运行：

```bash
npm run lint
npm run typecheck
npm test -- --maxWorkers=2
npm run build
```

全量测试必须加 `--maxWorkers=2`，因为并行的 Miniflare isolate 可能耗尽内存。

请勿在 issue 中粘贴 API key、手机号、邮箱或其他个人数据。安全问题请使用 GitHub 的私密安全公告，
不要开公开 issue：<https://github.com/limccn/TokiAPI/security/advisories/new>。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
