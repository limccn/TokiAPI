// 事务邮件通道（08-27-email-notification R0/R1）：Resend HTTP API，无 SDK 依赖。
//
// 为什么是裸 fetch 而不是 resend npm 包：Workers 里它只是一个 POST，加依赖纯增面；
// 测试也能直接 vi.stubGlobal("fetch") 拦出站请求（与 tests/proxy-pipeline.test.ts 同法）。
//
// **失败统一抛出**，后果由调用点决定 —— 这不是省事，而是 better-auth 的调用结构决定的
// （design §2，读 node_modules/better-auth/dist 实证）：
//   - 注册（sendOnSignUp）走 runInBackgroundOrAwait，其实现是 try{…}catch{logger.error}
//     → 错误被吞，注册天然 fail-open（邮件绝不阻断注册）；
//   - 交互式 POST /api/auth/send-verification-email 是 `await sendVerificationEmailFn(…)`
//     且无 catch → 错误上抛到端点 → UI 可见。
// 本层若自己 catch 掉，交互式路径会返回 {status:true} 而用户永远收不到信 —— 正是本轮要消灭的
// 「不诚实」形态。故此处**刻意不做 fail-open**。
//
// 两条短路分支（都**不抛错**，只记日志）：
//   1) RESEND_API_KEY 空/缺失 = 通道未配置（回滚杠杆，design §8）→ email_not_configured；
//   2) 收件人不在白名单（白名单非空时）→ email_skipped_allowlist。**必须静默**：抛错会让
//      /send-verification-email 未登录分支的 500ms 恒定耗时防枚举失效（「邮箱存在但不在名单」
//      成为可探测信号，见 better-auth email-verification.mjs:100-108）。
import type { Logger } from "./logger";

/** 发件人（lmlh.net 域已配 Resend 的 DKIM/SPF，见 PRD R0.2）。 */
export const EMAIL_FROM = "notify@lmlh.net";
export const EMAIL_FROM_NAME = "AI Gateway";
/** 出站超时上界（毫秒）：信号同时约束响应体读取，防上游挂起拖死认证请求。 */
export const EMAIL_TIMEOUT_MS = 10_000;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
/** 失败正文入日志的上界（字符）：正文可能很大，只留排障需要的那一段。 */
const ERROR_BODY_LIMIT = 200;

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * sendMail 只读这两个键，故 env 收窄为结构类型（同 grantSignupBonus 的形态）：
 * 单元测试可直接传 `{ RESEND_API_KEY: "re_test" }` 覆盖分支，无需造整个 Env。
 * RESEND_API_KEY 是**真实 secret**（env 三分类第 1 类）：只经 wrangler secret put / .dev.vars 注入。
 */
export interface MailEnv {
  RESEND_API_KEY?: string;
  EMAIL_ALLOWED_RECIPIENTS?: string;
}

/**
 * 收件人白名单解析：逗号分隔 → trim + 小写归一 → 去空项。
 * 空/缺失 → 空数组 = **全放行**（仅在 EMAIL_VERIFICATION_ENABLED=true 时相关；缺省关闭即通道休眠）。
 */
export function parseEmailAllowlist(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== "");
}

/**
 * 发送一封事务邮件。四条分支的日志名与顺序是契约（design §3）：
 * 未配置 → email_not_configured；白名单外 → email_skipped_allowlist；成功 → email_sent；
 * 失败 → email_send_failed 后**抛出**（见文件头）。
 */
export async function sendMail(
  env: MailEnv,
  logger: Logger,
  input: SendMailInput,
): Promise<void> {
  const apiKey = env.RESEND_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    logger.info("email_not_configured", { to: input.to, subject: input.subject });
    return;
  }

  if (!isRecipientAllowed(parseEmailAllowlist(env.EMAIL_ALLOWED_RECIPIENTS), input.to)) {
    logger.info("email_skipped_allowlist", { to: input.to, subject: input.subject });
    return;
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${EMAIL_FROM_NAME} <${EMAIL_FROM}>`,
        // Resend 规范形态：单收件人也用数组
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
  } catch (error) {
    // 网络异常 / 超时（TimeoutError）：记录后原样抛出（保留原始堆栈）
    logger.error("email_send_failed", {
      to: input.to,
      subject: input.subject,
      error: String(error),
    });
    throw error;
  }

  if (!response.ok) {
    const detail = await readErrorBody(response);
    logger.error("email_send_failed", {
      to: input.to,
      subject: input.subject,
      status: response.status,
      error: detail,
    });
    throw new Error(`resend rejected the email (${response.status}): ${detail}`);
  }

  logger.info("email_sent", {
    to: input.to,
    subject: input.subject,
    id: await readMessageId(response),
  });
}

/** 白名单判据：空名单 = 全放行；比对大小写不敏感（名单在解析时已归一为小写）。 */
function isRecipientAllowed(allowlist: string[], to: string): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  return allowlist.includes(to.trim().toLowerCase());
}

/**
 * 读取失败正文用于日志：**有界**（防大正文拖死认证请求）+ **读失败不吞状态码**
 * （09-21 批次 N 的教训：正文读失败把状态码一起吞掉，排障时什么都看不到）。
 */
async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_LIMIT);
  } catch {
    return "<body unreadable>";
  }
}

/** 成功响应体的 id（Resend 200 `{id}`）：读失败只丢 id —— 邮件**已被受理**，不得因此抛错。 */
async function readMessageId(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const id = (body as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  } catch {
    return null;
  }
}

/**
 * HTML 片段的最小转义：只处理能改变标签/属性结构的字符（引号与尖括号）。
 * **刻意不转义 `&`**：验证链接的查询串分隔符就是 `&`，转义后邮件里肉眼可见的链接与
 * `html.includes(url)` 都不再成立；而 `&` 在 HTML 中只能构成字符引用，逃不出属性。
 */
function escapeHtml(raw: string): string {
  return raw.replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * 验证邮件模板（本轮唯一模板）。url 同时出现在 html 的按钮与纯文本链接、以及 text 版里。
 * **有效期文案与 src/lib/auth.ts 的 `expiresIn: 60 * 60` 同一口径 —— 改一处必须同步另一处。**
 * url 不进 subject：主题行带长链接既伤投递又会把 token 泄进通知预览。
 * html 用内联样式：邮件客户端普遍过滤外部 CSS。
 */
export function verificationEmail(url: string): {
  subject: string;
  html: string;
  text: string;
} {
  const link = escapeHtml(url);
  const subject = "Verify your email address — AI Gateway";
  const html = [
    '<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#fafaf9;color:#1c1917;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif">',
    '<div style="max-width:520px;margin:0 auto;padding:24px;background:#ffffff;border:1px solid #e7e5e4;border-radius:8px">',
    '<h1 style="margin:0 0 12px;font-size:18px;line-height:1.4">Verify your email address</h1>',
    '<p style="margin:0 0 16px;font-size:14px;line-height:1.6">Confirm this address to finish setting up your AI Gateway account. The link expires in 1 hour.</p>',
    `<p style="margin:0 0 16px"><a href="${link}" style="display:inline-block;padding:10px 18px;border-radius:6px;background:#1c1917;color:#ffffff;font-size:14px;text-decoration:none">Verify email</a></p>`,
    `<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#57534e">If the button does not work, paste this link into your browser:<br><span style="word-break:break-all">${link}</span></p>`,
    '<p style="margin:0;font-size:13px;line-height:1.6;color:#57534e">If you did not create an account, you can ignore this email — nothing will be changed.</p>',
    "</div></body></html>",
  ].join("");

  const text = [
    "Verify your email address",
    "",
    "Confirm this address to finish setting up your AI Gateway account. The link expires in 1 hour.",
    "",
    url,
    "",
    "If you did not create an account, you can ignore this email — nothing will be changed.",
  ].join("\n");

  return { subject, html, text };
}
