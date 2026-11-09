// 字符串环境变量类型补充（与 worker-configuration.d.ts 生成的 Env 接口合并）。
// 这些变量通过部署配置 [vars]（wrangler.jsonc / 维护者 wrangler.prod.jsonc）、.dev.vars（本地 dev）
// 或 wrangler secret（生产）注入，wrangler types 不会为它们生成类型。
// 静态资源绑定（M6）：wrangler.jsonc `assets = { binding: "ASSETS" }`。
// `wrangler types` 不会为 assets binding 生成类型（虚拟绑定），这里合并进 __BaseEnv_Env，
// 使全局 Env（worker 代码）与 Cloudflare.Env（cloudflare:test 测试环境）都包含 ASSETS。
interface __BaseEnv_Env {
  ASSETS: Fetcher;
}

interface Env {
  // 上游 Provider 密钥的 AES-GCM 加密密钥（生产：wrangler secret put GATEWAY_SECRET_KEY，
  // 任意长度字符串，建议 >=32 字符随机值；本地由 .dev.vars 提供）
  GATEWAY_SECRET_KEY: string;
  // Better Auth 会话签名密钥（生产：wrangler secret put BETTER_AUTH_SECRET）
  BETTER_AUTH_SECRET: string;
  // 前端 origin（本地 http://localhost:5173；生产为部署域名），用于 baseURL/cookie/回调地址
  // **同时是分流的"平台域"真源**：`new URL(BETTER_AUTH_URL).hostname`（见 src/lib/domains.ts，
  // 刻意不新增 PLATFORM_DOMAIN token —— 那会是第三个真源）。故生产必须把它设成管理台域
  // （wrangler.jsonc 缺省是 localhost —— 本地 dev 形态；生产部署在 wrangler.prod.jsonc 覆盖）。
  BETTER_AUTH_URL: string;
  // 公开 API 域名（双域名分流，09-21-dual-domain-split；部署配置 [vars]）：/v1、/anthropic 只在
  // 该域服务，管理台域上的这两个前缀会被 308/301 跳到它。**未配置（或为空）= 分流整体关闭**
  // —— wrangler.jsonc 缺省为空，即一键发布开箱的「单一 workers.dev 域」形态，本地 dev 也处于
  // "未配置"形态；要本地演练双域名时可在 .dev.vars 设同名键（保护本地的是中间件的**环回例外**
  // isLoopbackHost，见 src/middleware/domain-split.ts 与 src/lib/domains.ts —— 删掉环回例外
  // 会让本地 /v1 被 301 到线上；断言"未配置即关闭"的用例只覆盖另一条路径，见 tests/domain-split.test.ts）。
  API_DOMAIN?: string;
  // GitHub OAuth App 凭据（生产：wrangler secret put）
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // 管理员邮箱名单（11-06-sms-alicloud-auth）：逗号分隔。
  // 语义 = **自动提权名单**（不再是登录准入门，GitHub 已开放注册）：列表内邮箱的账号在
  // 注册与每次登录时被提升为 admin，且只升不降（见 src/lib/auth.ts 的 promoteAdminIfListed）。
  // **空 = 无人自动提权**（不锁死：D1 手工 UPDATE 仍是合法 bootstrap）。
  // 声明为**必填 string**：与 wrangler types 生成的 __BaseEnv_Env 一致（wrangler.jsonc 常驻该键）；
  // 写成可选会与生成声明的必填冲突（接口合并类型不兼容）。解析函数仍接受 undefined 兜底。
  ADMIN_EMAILS: string;
  // request_logs 明细保留天数（M5 5.4；scheduled cron 清理用，缺省 30）
  REQUEST_LOG_RETENTION_DAYS?: string;
  // 延迟计费队列名（部署配置 [vars]；queue() handler 按 batch.queue 分流用；缺失时回退 usage 聚合）
  BILLING_QUEUE_NAME?: string;
  // 网关 API Key 明文前缀（缺省 "sk-"；空白视为未设置，回退默认。仅影响新生成 Key）
  API_KEY_PREFIX?: string;
  // 全局响应缓存总开关（09-03-stg-cache-investigation；部署配置 [vars]，缺省 false = 关闭）：
  // 即使 key.cacheEnabled=true 也不缓存；true/1/yes/on = 开启。本地覆盖写在 .dev.vars 同名键。
  CACHE_ENABLED?: string;
  // modelcap 档位乘算常数（09-16 kv-ops 档位化；部署配置 [vars]，缺省 8192 × 2 = 16384 基准）：
  // cap = BASE × MULT × 档位（src/generated/modelcaps.ts 存档位）。改后重跑 render:modelcaps +
  // 部署；该脚本读 .dev.vars 同名键（档位表是全局的，不分环境）。
  MODELCAP_BASE_TOKENS?: string;
  MODELCAP_MULTIPLIER?: string;
  // 三档赠金金额（USD；部署配置 [vars]）：
  // - SIGNUP_BONUS_AMOUNT：11-08 起语义 = **手机验证赠金**（注册赠金，phone-number 插件触发）
  // - EMAIL_VERIFY_BONUS_AMOUNT：语义 = **邮箱绑定赠金**（afterEmailVerification 触发）
  // - GITHUB_BIND_BONUS_AMOUNT：**GitHub 绑定赠金**（注册后绑定 GitHub 触发，11-08 新增）
  // 三者缺省 5（开箱即送）；显式设 0（或非法值）即不赠（涉及钱，fail-safe 到少发）。
  SIGNUP_BONUS_AMOUNT?: string;
  EMAIL_VERIFY_BONUS_AMOUNT?: string;
  GITHUB_BIND_BONUS_AMOUNT?: string;
  // 邮箱验证功能总开关（09-16-signup-bonus-grant；部署配置 [vars]）：缺省 false = 整个
  // emailVerification 段不配置（不发验证信、不发验证赠金）；true/1/yes/on 才开启。
  EMAIL_VERIFICATION_ENABLED?: string;
  // 账户安全总开关（09-21-email-admin-promotion-switch；部署配置 [vars]）：缺省 false =
  // 邮件注册的账户（有 accounts.providerId='credential' 行）**永远不能**提升为 admin ——
  // PATCH /api/users/:id 对该形态显式 403，管理画面的提升操作置灰；true/1/yes/on 才允许。
  // 只拦「新提升」：降级、停用、以及已是 admin 的幂等重写不受影响（不倒查存量）。
  EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED?: string;
  // Resend 事务邮件 API key（08-27-email-notification；**真实 secret**：本地 .dev.vars，
  // 生产 `wrangler secret put RESEND_API_KEY`）。空/缺失 = **通道未配置**：
  // 不发信、不抛错，只记 email_not_configured（fail-safe，见 src/lib/email.ts）。
  // 可选（`?`）：该键不进部署配置 [vars]（真实 secret 不入库），未被 secret put 的环境里
  // binding 真的缺席 —— 类型如实反映，且必须与 tests/test-env.d.ts 的声明一致（否则 Cloudflare.Env 不能传给 Env）
  RESEND_API_KEY?: string;
  // 事务邮件收件人白名单（同上；部署配置 [vars]）：逗号分隔、大小写不敏感；**空 = 全放行**
  // （仅在 EMAIL_VERIFICATION_ENABLED=true 时相关 —— 缺省开关关闭，整个通道休眠）。
  EMAIL_ALLOWED_RECIPIENTS?: string;
  // 事务邮件发件地址（部署配置 [vars]，11-09 新增）：空/缺失 = 内置 notify@tokiapi.app
  // （仅托管实例拥有该域）。自部署者须填自己 Resend 已验证域名下的地址，否则 Resend 拒发。
  EMAIL_FROM?: string;
  // ---- 短信认证（11-06-sms-alicloud-auth）----
  // 总开关（部署配置 [vars]，缺省 false）：false 时 phone-number 插件**不注册** ⇒
  // /api/auth/phone-number/* 与 /api/auth/sign-in/phone-number 全部 404，SPA 入口同时消失。
  // 刻意做成结构性的（而非配置了但内部 no-op）：开关关闭期间短信代码路径不可达。
  SMS_AUTH_ENABLED?: string;
  // 短信测试号码白名单（部署配置 [vars]）：逗号分隔，`+86` 规范形或裸 11 位；
  // **空 = 全放行**（对齐 EMAIL_ALLOWED_RECIPIENTS）；非空但全项非法 = **全拒**（fail-closed）。
  SMS_ALLOWED_PHONES?: string;
  // 短信签名名 / 模板 CODE（部署配置 [vars]）：由部署方从阿里云「短信认证」控制台补齐。
  // 空 = **配置错误** ⇒ sendSmsCode 抛 SMS_CONFIG_INVALID（**不**静默跳过；静默只有
  // 「开关关 / AK 缺失 / 白名单外」三态）。*非空但模板变量错* 同样抛错。
  SMS_SIGN_NAME?: string;
  // 模板 CODE。阿里云「短信认证」的**五个系统赠送模板**（2026-11-06 调研）：
  //   100001 登录/注册/通用 · 100002 修改绑定号码 · 100003 重置密码
  //   100004 绑定新号码 · 100005 验证已绑定号码
  // 五者只差**文案**，变量同为 `${code}` / `${min}`，频控一致。
  SMS_TEMPLATE_CODE?: string;
  // 找回密码专用模板 CODE（可选，建议 100003）：**空 = 回落 SMS_TEMPLATE_CODE**。
  // 之所以只分这一条岔路：库的 sendOTP 把登录/注册/绑定合并成一个回调，服务端分不清
  // 「这次是绑定」；而 sendPasswordResetOTP 是独立回调，可以分。
  SMS_TEMPLATE_CODE_RESET?: string;
  // 模板变量映射（JSON 文本，部署配置 [vars]）：值里的 ##code## 被替换为验证码。
  // 变量名以控制台实际模板为准 —— 不符时改本 vars，不改代码。
  SMS_TEMPLATE_PARAM?: string;
  // 阿里云 AccessKey（**真实 secret**：本地 .dev.vars，生产 `wrangler secret put`）。
  // 可选（`?`）且空 = **通道未配置**：sendSmsCode 记 sms_not_configured 后返回，不抛错。
  // 与 RESEND_API_KEY 同理 —— 未被 secret put 的环境里 binding 真的缺席，类型如实反映；
  // 且必须与 tests/test-env.d.ts 的声明一致（否则 Cloudflare.Env 不能传给 Env）。
  SMS_ACCESS_KEY_ID?: string;
  SMS_ACCESS_KEY_SECRET?: string;
  // 认证面限流绑定（09-28-auth-rate-limit-fix / security-audit F1；部署配置 `[[ratelimits]]`）。
  // 两个绑定的**档位（limit/period）只在配置里** —— workerd 的 `RateLimitOptions` 只有 `key` 字段，
  // 代码侧无法逐调用覆写，故策略不同的类别必须各占一个绑定（namespace_id 即计数命名空间）。
  // ⚠ **声明为可选（`?`）是如实的**：中间件有一条 fail-open 分支专门处理 binding 缺席
  //   （`[[ratelimits]]` 是 wrangler 的 notInheritable key —— 自建部署配置漏写不报错，
  //   只是让该环境静默不限流）。声明为必填会把这条真实运行时形态挡在类型之外。
  // 与 tests/test-env.d.ts 的 Cloudflare.Env 声明必须一致（那是 cloudflare:test 侧的平行声明）。
  AUTH_CREDENTIAL_LIMIT?: RateLimit;
  AUTH_EMAIL_LIMIT?: RateLimit;
}
