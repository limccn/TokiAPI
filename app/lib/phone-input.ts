// 手机号输入框的清洗与拼接（11-06-sms-alicloud-auth，PRD R20）。
//
// 本部署只服务中国内地号码：输入框**默认 +86**（界面上的 `+86` 是静态前缀，不是可选项），
// 用户只输 11 位本地号。粘贴可能带来完整号码（`+86 138 0013 8000` / `8613800138000`），
// 故输入框统一经 `toNationalDigits` 清洗：只留数字、剥掉可能被一并粘贴进来的 `86`、截到 11 位。
//
// 拼接与校验复用零依赖的 `src/lib/phone.ts`（与服务端同一份判据）：
// 不在前端另写一套号码正则 —— 那会与白名单/登录比对所用的规范形各自漂移。
import { SMS_CODE_TTL_SECONDS, normalizePhone } from "../../src/lib/phone";

/** 本地号码位数（不含国家码）。 */
export const NATIONAL_PHONE_LENGTH = 11;

/** 验证码位数（与后端 OTP 长度一致）。 */
export const SMS_CODE_LENGTH = 6;

/** 本部署唯一支持的国家码（PRD R20：不提供选择器，默认中国内地）。 */
export const PHONE_COUNTRY_CODE = "+86";

/** 手机号字段的内联错误（注册/登录/找回/绑定共用一份，避免标点与措辞漂移）。 */
export const INVALID_PHONE_MESSAGE = "Enter a valid mainland China mobile number.";

/** 验证码字段的内联错误（同上）。 */
export const INVALID_CODE_MESSAGE = "Enter the 6-digit code from the SMS.";

/** 验证码有效期文案：发送按钮的常驻提示与找回密码状态行共用。 */
export function smsCodeValidityMessage(): string {
  return `Codes are valid for ${Math.round(SMS_CODE_TTL_SECONDS / 60)} minutes.`;
}

/**
 * 把输入框里的任意文本清洗成「本地 11 位号码」的输入态字符串。
 *
 * 只做输入态清洗（不判断合法前缀）：用户可能只输了一半，此时不应报错或吞字符。
 * 合法性由 `composePhoneNumber` 在提交时判定。
 *
 * ⚠ 受控组件纪律：调用方必须把 `event.target.value` 改回返回值（见 `toSmsCode`）——
 * 否则「第 12 位数字 / 字母」在清洗结果等于当前 state 时不会触发重渲染，会残留在 DOM。
 */
export function toNationalDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // 粘贴完整号码时去掉国家码：国内号码必以 1 开头，故「86 开头且超长」只可能是国家码
  const national =
    digits.length > NATIONAL_PHONE_LENGTH && digits.startsWith("86")
      ? digits.slice(2)
      : digits;
  return national.slice(0, NATIONAL_PHONE_LENGTH);
}

/**
 * 把验证码输入框里的任意文本清洗成「最多 6 位数字」。
 *
 * 与 `toNationalDigits` 同一个受控组件纪律：**调用方必须把 `event.target.value`
 * 改回本函数的返回值**再去 setState —— 清洗结果与当前 state 相同时 React 不会重渲染，
 * 非法字符（字母/空格）或第 7 位会留在 DOM 里，看起来像校验没生效。
 */
export function toSmsCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, SMS_CODE_LENGTH);
}

/**
 * 拼接并校验为规范形（`+86` + 11 位）；不合法返回 `null`。
 * 调用方在返回 `null` 时展示内联错误，且**不发请求**。
 */
export function composePhoneNumber(nationalDigits: string): string | null {
  return normalizePhone(`${PHONE_COUNTRY_CODE}${nationalDigits}`);
}
