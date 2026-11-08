// 手机号与短信配置的纯函数层（11-06-sms-alicloud-auth；design §4.1）。
//
// 🔴 **本文件必须保持零依赖**：不 import 任何模块，连 `import type` 都不行。
// 原因不是洁癖 —— SPA 的登录页/注册页/绑定页/找回密码页都要直取这里的归一与常量
// （经 `app/lib/phone-input.ts` 的 `composePhoneNumber` 用到 `normalizePhone`、
// `SMS_CODE_TTL_SECONDS` 用于文案、`classifyLoginIdentifier` 是「邮箱还是手机号」的分流契约），
// 一旦这里出现运行时边，整条服务端依赖链会被并进首屏分块。同类事故有据可查：
// `src/lib/password.ts` 头注记录的「首屏 182 kB → 255 kB」（把 zod 拖进登录页）。
// 因此这里连错误类型都自己定义，不去复用 `src/lib/sms.ts` 的 SmsError。
//
// 号码的唯一规范形是 **E.164 中国区**：`+86` + 11 位（`^\+861[3-9]\d{9}$`）。
// 为什么死守一个形态：同一个号可能从 UI（带 +86）、从阿里云回调（不带）、从白名单配置
// （裸 11 位）三个方向进来，宽松比对会让「同一号码被当成两个账号」这类问题无处追。

/** 规范形判据：`+86` + 1[3-9] + 9 位。**唯一**合法的存储/比对形态。 */
const CANONICAL_RE = /^\+861[3-9]\d{9}$/;

/** 国内手机号主体（不含国家码）。 */
const NATIONAL_RE = /^1[3-9]\d{9}$/;

/** 模板占位符字面量：`SMS_TEMPLATE_PARAM` 里出现这个串的位置会被替换成真实验证码。 */
export const SMS_CODE_PLACEHOLDER = "##code##";

/**
 * 验证码有效期（秒）= 5 分钟。
 * 消费方：`src/lib/auth.ts` 的 `phoneNumber({ expiresIn })`（库内过期判据）与前端文案
 * （「码 5 分钟内有效」）—— 两处写死必然漂：库改了有效期，文案还在说旧时长。
 */
export const SMS_CODE_TTL_SECONDS = 300;

/**
 * `SMS_TEMPLATE_PARAM` 配置错误。**刻意不复用 sms.ts 的 SmsError**（见文件头零依赖约束）——
 * 调用点（sms.ts）负责把它翻译成自己的错误类型。
 */
export class SmsTemplateError extends Error {
  readonly code = "SMS_TEMPLATE_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "SmsTemplateError";
  }
}

/**
 * 归一成规范形；无法归一返回 `null`。
 *
 * 容错范围（刻意的窄）：去空白与 `-`/`(`/`)`，去 `+86` 或前导 `86`，余下必须 `^1[3-9]\d{9}$`。
 * 不做的事：不补零、不猜被截断的号码、不接受 `+852` 等非中国区号码
 * —— 阿里云「短信认证」当前只支持中国内地号码（research R10-2）。
 */
export function normalizePhone(raw: string): string | null {
  let value = raw.trim().replaceAll(/[\s\-()]/g, "");
  if (value.startsWith("+86")) {
    value = value.slice(3);
  } else if (value.startsWith("86") && value.length > 11) {
    // 裸 11 位号码永远以 1 开头，故「前导 86」只可能是国家码，不会误伤
    value = value.slice(2);
  }
  return NATIONAL_RE.test(value) ? `+86${value}` : null;
}

/** 是否已经是规范形（不做任何容错）。 */
export function isCanonicalPhone(value: string): boolean {
  return CANONICAL_RE.test(value);
}

/**
 * 取阿里云 `PhoneNumber` 要的国内号形态（`+8613800138000` → `13800138000`）。
 * 非规范形输入原样返回 —— 调用方必须先用 `isCanonicalPhone` 挡住，本函数不做二次校验。
 */
export function toNationalNumber(canonical: string): string {
  return canonical.slice(3);
}

/**
 * 手机号账号的占位邮箱（users.email NOT NULL UNIQUE，11-08 R10 / design §14.3）。
 *
 * 格式与手机号注册同一形态：`u<5hex>.+86<11位>@phone.invalid`。随机段**不可省**：
 * 同一号码反复注册/解绑时，固定格式会撞 UNIQUE，而这里没有任何可换的落点。
 *
 * 单一真源：`src/lib/auth.ts` 的 `signUpOnVerification.getTempEmail` 与
 * `DELETE /api/users/:id/email`（解绑邮箱后的重置地址）都调用本函数 —— 两处各拼一次
 * 格式必然漂，而漂移的后果是 `isPlaceholderEmail` 判据或前端「未绑定邮箱」显示失效。
 *
 * 前置条件：`canonicalPhone` 已通过 `isCanonicalPhone`（调用方保证；本函数不重复校验，
 * 非法输入会原样落到号码段 —— 那也只影响这一条占位地址的形态）。
 */
export function buildPhonePlaceholderEmail(canonicalPhone: string): string {
  const randomHex = crypto.randomUUID().replaceAll("-", "").slice(0, 5);
  return `u${randomHex}.+86${toNationalNumber(canonicalPhone)}@phone.invalid`;
}

/**
 * 是否为本系统生成的**占位邮箱**（手机号注册账号；PRD R18 / AC37）。
 *
 * 判据是**后缀**而不是完整格式（design §13.2）：新旧两种形态都必须命中 ——
 * `phone-<uuid>@phone.invalid`（旧）与 `u<5hex>.+86<号码>@phone.invalid`（新）。
 * 否则格式升级那一刻，存量账号会突然被当作「已绑定真实邮箱的普通账号」，
 * 绑定入口消失且没有任何报错。`.invalid` 是 RFC 2606 保留域，永不投递。
 *
 * 前端同口径（`app/components/layout/profile-dialog.tsx` 与 `user-button.tsx` 直接
 * import 本函数）—— 判据若在两处各写一个正则，下一次改格式就会只改一边。
 */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  if (typeof email !== "string") {
    return false;
  }
  return email.trim().toLowerCase().endsWith("@phone.invalid");
}

/**
 * 日志/UI 用的打码形态：`+86 138****8000`（保留前 3 后 4）。
 * 非规范形返回 `***`：打码函数绝不能因为输入非法就把原值漏出去。
 */
export function maskPhone(canonical: string): string {
  if (!CANONICAL_RE.test(canonical)) {
    return "***";
  }
  const national = canonical.slice(3);
  return `+86 ${national.slice(0, 3)}****${national.slice(7)}`;
}

/** 白名单解析结果：`allowAll` 为真时忽略 `phones`（空名单 = 全放行，对齐邮件白名单语义）。 */
export interface SmsAllowlist {
  readonly allowAll: boolean;
  readonly phones: ReadonlySet<string>;
}

/**
 * 解析 `SMS_ALLOWED_PHONES`（逗号分隔）。
 *
 * 三种形态，语义必须分清（design §2.2）：
 *   1. 空/缺失（`raw.trim() === ""`）⇒ **全放行**；
 *   2. 有条目且至少一条合法 ⇒ 只放行集合内号码；
 *   3. 有条目但**全部非法** ⇒ `allowAll=false` + 空集 ⇒ **全拒**（fail-closed）。
 * 第 3 条是刻意的：把白名单写成一堆乱码时，静默退化成「全放行」等于把测试白名单变成
 * 生产敞口 —— 宁可谁都发不出去（部署方会立刻发现），也不要悄悄放开。
 *
 * 判据是**原始串**而不是「过滤后条目数」：`","` / `" , , "` 这类手滑配置是非空串，
 * 必须走第 3 条（全拒），不能因为过滤掉空项后没剩下什么就退化成「没配」（design §2.2
 * 明写 allowAll 只在 `raw.trim() === ""` 时为真）。
 */
export function parseSmsAllowlist(raw: string | undefined): SmsAllowlist {
  if (raw === undefined || raw.trim() === "") {
    return { allowAll: true, phones: new Set() };
  }
  const phones = new Set<string>();
  for (const item of raw.split(",")) {
    const normalized = normalizePhone(item);
    if (normalized !== null) {
      phones.add(normalized);
    }
  }
  return { allowAll: false, phones };
}

/** 号码是否通过白名单（与 `sendMail` 的收件人判据同构）。 */
export function isPhoneAllowed(allowlist: SmsAllowlist, canonical: string): boolean {
  return allowlist.allowAll || allowlist.phones.has(canonical);
}

/**
 * 开关解析：`true`/`1`/`yes`/`on`（大小写与空白不敏感）为开，其余（含空/缺失）为关。
 * 与 `isEmailVerificationEnabled` 同一口径 —— 部署侧两种开关不该有两套布尔语法。
 */
export function isSmsAuthEnabled(raw: string | undefined): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  return value === "true" || value === "1" || value === "yes" || value === "on";
}

/**
 * 把验证码填进模板变量映射（`SMS_TEMPLATE_PARAM` 是 JSON 文本，如
 * `{"code":"##code##","min":"5"}`）。
 *
 * 两条**配置错误**必须抛（不能静默降级成空串，否则短信照发、正文缺码，用户拿到一条
 * 无法使用的短信，而服务端一切「成功」）：
 *   1. JSON 非法，或顶层不是对象；
 *   2. 没有任何字符串值包含 `##code##`。
 *
 * 变量名本身**不写死**：控制台模板可能用 `${code}` 之外的参数名，改 vars 即可适配（design §2.1）。
 * 非字符串值原样保留 —— 模板里出现数字类参数（如分钟数不带引号）不该被判成配置错误。
 */
export function renderTemplateParam(template: string, code: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch {
    throw new SmsTemplateError("SMS_TEMPLATE_PARAM is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new SmsTemplateError("SMS_TEMPLATE_PARAM must be a JSON object");
  }

  let replaced = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value.includes(SMS_CODE_PLACEHOLDER)) {
      replaced = true;
      out[key] = value.replaceAll(SMS_CODE_PLACEHOLDER, code);
      continue;
    }
    out[key] = value;
  }
  if (!replaced) {
    throw new SmsTemplateError("SMS_TEMPLATE_PARAM has no ##code## placeholder");
  }
  return JSON.stringify(out);
}

/**
 * 登录标识判别器（纯函数，**保留的协议契约**，11-08 R9 起登录页不再调用它）。
 *
 * 历史与现状：登录页最初只有**一个**「Email or phone number」输入框，由这里决定往哪个
 * 端点送（design §7.2 / PRD D16）。11-08 R9 改为 Email / Phone 分段控件后，登录页各自
 * 走明确的端点，不再需要猜；本函数保留为「按输入形态归类」的单一契约（单测锁定，
 * 其他调用方可继续用），删除它只会让同类判别在别处被重新复制一份。
 *
 *   - 含 `@` ⇒ 当邮箱（不在这里做格式校验：交给 Better Auth，免得两处校验漂移）；
 *   - 否则能归一成 `+86` 手机号 ⇒ 当手机号；
 *   - 否则 `invalid`（客户端直接拦下，不发请求）。
 *
 * **只接受中国内地号码**：`+852…` 之类的输入会落到 `invalid`，这是 PRD 明确的范围限制。
 */
export type LoginIdentifier =
  | { readonly kind: "email"; readonly email: string }
  | { readonly kind: "phone"; readonly phoneNumber: string }
  | { readonly kind: "invalid" };

export function classifyLoginIdentifier(raw: string): LoginIdentifier {
  const value = raw.trim();
  if (value === "") {
    return { kind: "invalid" };
  }
  if (value.includes("@")) {
    return { kind: "email", email: value };
  }
  const phoneNumber = normalizePhone(value);
  return phoneNumber === null ? { kind: "invalid" } : { kind: "phone", phoneNumber };
}
