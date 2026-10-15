// 测试环境类型补充（M4）：cloudflare:test 的 `env` 类型为 `Cloudflare.Env`
// （worker-configuration.d.ts 生成，仅含 D1/KV/Queues 绑定）；字符串环境变量与
// TEST_MIGRATIONS 由 vitest.config.ts 以 miniflare bindings 注入，此处合并声明。
// Vite `?raw` 资源导入：vitest 的 Workers pool 走 Vite 转换管线，`?raw` 在**构建期**内联为字符串
// 常量，因此 workerd 里也读得到仓库文件（测试没有 node:fs）。
// 用于 tests/config-fork.test.ts 直接断言 wrangler.jsonc（一键发布形态配置）的结构契约。
declare module "*?raw" {
  const content: string;
  export default content;
}

declare namespace Cloudflare {
  interface Env {
    GATEWAY_SECRET_KEY: string;
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    /**
     * 公开 API 域名（双域名分流，09-21-dual-domain-split）。vitest.config.ts pin ""（**空 =
     * 未配置 = 分流整体关闭**，既有用例零影响）；tests/domain-split.test.ts 用 helpers.withSwitch
     * 逐用例翻成真实域名来覆盖分流规则 —— 故这里必须声明（本文件是 Cloudflare.Env 的平行声明，
     * 漏一处会「运行时能跑、typecheck 报错」，src/env.d.ts 管不到 cloudflare:test 的 env）。
     */
    API_DOMAIN?: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_ALLOWED_EMAILS: string;
    /** request_logs 保留天数（M5 5.4；缺省 30，未注入时按默认处理）。 */
    REQUEST_LOG_RETENTION_DAYS?: string;
    /** 网关 API Key 明文前缀（缺省 "sk-"；空白视为未设置，回退默认）。 */
    API_KEY_PREFIX?: string;
    /**
     * 账户安全总开关（09-21-email-admin-promotion-switch）。vitest.config.ts pin "false"（部署缺省）；
     * helpers.withSwitch 运行时改写它来覆盖开启态，故这里**必须**声明 —— 本文件是 Cloudflare.Env 的
     * 平行声明，漏一处会让「运行时能跑、类型检查报错」（src/env.d.ts 管不到 cloudflare:test 的 env）。
     */
    EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED?: string;
    /**
     * 邮箱验证总开关（09-16-signup-bonus-grant）。vitest.config.ts pin "true"（否则 emailVerification
     * 段整段不配置，验证链路不可测）；email-verification-send.test.ts 的 AC5 用 withSwitch 翻到
     * "false" 做对照 —— 故这里必须声明（漏一处会「运行时能跑、typecheck 报错」）。
     */
    EMAIL_VERIFICATION_ENABLED?: string;
    /**
     * Resend 事务邮件 API key（08-27-email-notification）。vitest.config.ts pin ""（**空 = 通道未配置**）
     * → 既有注册/验证用例零网络、行为不变；需要真发送的用例自己 stub fetch 并用 withSwitch 注入 key。
     */
    RESEND_API_KEY?: string;
    /** 事务邮件收件人白名单（同上）。pin "" = 全放行，与 prod 缺省形态一致。 */
    EMAIL_ALLOWED_RECIPIENTS?: string;
    /**
     * 延迟计费队列名（09-21-prod-resource-naming）。**双重身份** token：既是 queues 绑定的队列名
     * （绑定本身由 worker-configuration.d.ts 生成 BILLING_QUEUE），又是 queue() 的运行期分流谓词。
     * vitest.config.ts 显式 pin；tests/queue-dispatch.test.ts 的 A/A′/B 三例从 cloudflare:test 侧读它
     * —— 该文件是**首个**这样做的用例，故这里必须声明（本文件是 Cloudflare.Env 的平行声明，
     * src/env.d.ts 管不到 cloudflare:test 的 env；漏声明的症状是「运行时能跑、typecheck 报错」）。
     */
    BILLING_QUEUE_NAME?: string;
    /**
     * 认证面限流绑定（09-28-auth-rate-limit-fix / security-audit F1）。**不是** vitest.config.ts 的
     * miniflare bindings 注入 —— 它由 `vitest.config.ts` 的 `wrangler.configPath` 读部署配置
     * wrangler.jsonc 自动获得（`cloudflareTest` 读 wrangler 配置里的绑定），故本文件只需声明类型。
     * 声明为可选与 src/env.d.ts 一致：中间件的 fail-open 分支要能处理 binding 缺席
     * （AC6 就在验这条），必填声明会让该用例在类型上无法表达。
     */
    AUTH_CREDENTIAL_LIMIT?: RateLimit;
    AUTH_EMAIL_LIMIT?: RateLimit;
    /**
     * 维护者生产 fork（wrangler.prod.jsonc，gitignored）的**原文**，vitest.config.ts 在 Node 侧读取
     * 后注入；空串 = fork 不存在（裸仓库 clone），tests/config-fork.test.ts 的 prod-fork 组据此跳过。
     */
    TEST_PROD_FORK_JSON?: string;
    /** vitest.config.ts 注入的 drizzle 迁移 SQL（applyD1Migrations 用）。 */
    TEST_MIGRATIONS: D1Migration[];
  }
}
