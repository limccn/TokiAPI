// 短信认证错误码 → 英文文案（11-06-sms-alicloud-auth，design §8）。
//
// **纯函数、零依赖**（只取 MIN_PASSWORD_LENGTH 这一个常量）：登录/注册/找回密码/资料四个页面
// 共用同一张表 —— 文案若各页各写一份，同一个 OTP_EXPIRED 会在三个地方说出三句话。
//
// 两条纪律：
//   1. **不把服务端 message 直接展示**（未知码时才回落），也不展示 code 本身 ——
//      阿里云/库的原文里有内部术语（如 "User already has a password set"），对用户是噪音。
//   2. 手机号 + 密码登录的失败**不区分原因**（未注册 / 无密码 / 密码错一律一句话）——
//      服务端本来就不区分（避免号码枚举），前端不能靠文案把服务端的克制还回去。
import { MIN_PASSWORD_LENGTH } from "../../src/lib/password";
// 与输入框内联错误共用同一句文案：同一个号码格式问题不该在两条路径上说出两种话
import { INVALID_PHONE_MESSAGE } from "./phone-input";

/**
 * 出错所在的表单 —— 同一错误码在不同页面要不同的说法。
 *
 * - `INVITE_CODE_REQUIRED` 分叉：登录页意味着「该号码还没注册」，注册页意味着「你得填邀请码」。
 * - `send` 是**步骤**而非页面：只有「点了发送验证码」这一步的 5xx 才等于「短信没发出去」。
 *   此前用 `forgot-password` 表达这件事，于是登录页的「验证码登录」与「手机号+密码登录」
 *   也会把库的 500（如停用账号的 `FAILED_TO_CREATE_SESSION`）说成发短信失败 —— 用户会一直
 *   重发验证码，而问题根本不在发送。发送步骤已收敛到 useSmsCodeSender，故只需一个 `send`。
 * - `reset-password` 分叉：`resetPassword` 的 5xx 与发送无关（号码不存在时库就抛
 *   `UNEXPECTED_ERROR` = 500），必须中性兜底，否则同样误导。
 */
export type SmsErrorContext =
  | "login"
  | "register"
  | "forgot-password"
  | "reset-password"
  | "profile"
  | "send";

/** 前端拿到的错误对象（@better-fetch 的 BetterFetchError 会把响应体字段铺在自身上）。 */
export interface SmsErrorLike {
  code?: string | undefined;
  message?: string | undefined;
  status?: number | undefined;
}

const MIN_LENGTH_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

/** 兜底文案。刻意中性：说不清原因时不要编一个具体理由。 */
const FALLBACK = "Something went wrong. Please try again.";

/**
 * 映射为可展示文案。优先级：**code 表** → **HTTP 状态**（429 / 5xx）→ 服务端 message → 兜底。
 *
 * 为什么状态码要参与：`sendSmsCode` 抛的 `SmsError` 不是 Better Auth 的 APIError，
 * 库的 router 会把它变成 **500 且无响应体的响应**（client 侧 code/message 都是空）——
 * 只按 code 映射的话，用户看到的会是兜底文案，而真实语义「短信没发出去」就丢了。
 */
export function smsErrorMessage(
  error: SmsErrorLike | null | undefined,
  context: SmsErrorContext = "login",
): string {
  const code = typeof error?.code === "string" ? error.code : undefined;
  switch (code) {
    case "INVALID_PHONE_NUMBER":
      return INVALID_PHONE_MESSAGE;
    case "OTP_NOT_FOUND":
    case "OTP_EXPIRED":
      return "That code has expired. Request a new one.";
    case "INVALID_OTP":
      return "Incorrect code. Please try again.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Request a new code.";
    case "INVITE_CODE_REQUIRED":
      return context === "register"
        ? "Invite code is required."
        : "This phone number isn't registered yet — create an account first.";
    case "INVITE_CODE_INVALID":
      return "Invalid, used or expired invite code.";
    case "PHONE_NUMBER_EXIST":
      return "This phone number is already linked to another account.";
    case "INVALID_PHONE_NUMBER_OR_PASSWORD":
      return "Incorrect phone number or password.";
    case "UNEXPECTED_ERROR":
      // 库在两个地方抛它：① 手机号+密码登录时 credential 行存在但 password 为 null
      // （对用户而言仍是「这个组合登不进去」，不能泄露「你没设密码」以外的实现细节）；
      // ② 重置密码时号码不存在（400）—— 那里绝不能说出「号码不存在」（枚举），
      // 且既然第一步已恒返回成功，用户看到的只能是中性兜底。
      return context === "reset-password"
        ? FALLBACK
        : "Incorrect phone number or password.";
    case "PHONE_NUMBER_NOT_VERIFIED":
      return "This phone number isn't verified yet. Sign in with an SMS code first.";
    case "PASSWORD_ALREADY_SET":
      return 'This account already has a password — use "Change password" instead.';
    case "PASSWORD_TOO_SHORT":
    case "PASSWORD_TOO_LONG":
      return MIN_LENGTH_MESSAGE;
    case "SESSION_EXPIRED":
      return "Your session has expired. Please sign in again.";
    case "SMS_CONFIG_INVALID":
    case "SMS_TEMPLATE_INVALID":
    case "SMS_SEND_FAILED":
    case "SMS_SIGN_FAILED":
      // 配置类错误（签名/模板/AK）对用户无意义，统一按「发不出去」呈现；
      // 真正的原因在服务端 sms_config_invalid / sms_send_failed 日志里
      return "We couldn't send the SMS. Please try again in a minute.";
    default:
      break;
  }

  const status = error?.status;
  if (status === 429) {
    return "Too many requests. Please try again later.";
  }
  if (typeof status === "number" && status >= 500) {
    // 只有**发送步骤**的 5xx 才等于「短信没发出去」（SmsError 被库转成 500 空体）。
    // 其余步骤的 5xx（会话建不起来、库内部错误）一律中性兜底：说成发短信失败会让用户
    // 一直重发验证码，而问题不在发送。停用账号走验证码登录就是这一支（库回
    // FAILED_TO_CREATE_SESSION = 500）。
    return context === "send"
      ? "We couldn't send the SMS. Please try again in a minute."
      : FALLBACK;
  }

  // 未知码：回落服务端 message（它通常是给开发者看的英文短句，比兜底更有信息量）；
  // 两者都没有才用兜底
  const message = error?.message?.trim() ?? "";
  return message === "" ? FALLBACK : message;
}
