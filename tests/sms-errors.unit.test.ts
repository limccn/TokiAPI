// smsErrorMessage 纯函数单测（11-06-sms-alicloud-auth，design §8）。
//
// 判别性纪律（spec shared/assertion-discipline）：**成对断言**「映射命中」与「近邻不混淆」。
// 若只断言「每个码都返回非空字符串」，把实现改成 `return "Something went wrong"` 也能全绿。
import { describe, expect, it } from "vitest";
import { smsErrorMessage } from "../app/lib/sms-errors";
import { MIN_PASSWORD_LENGTH } from "../src/lib/password";

describe("smsErrorMessage — code 映射", () => {
  it("插件错误码逐条映射（不是同一句话）", () => {
    expect(smsErrorMessage({ code: "INVALID_PHONE_NUMBER" })).toBe(
      "Enter a valid mainland China mobile number.",
    );
    expect(smsErrorMessage({ code: "OTP_EXPIRED" })).toBe("That code has expired. Request a new one.");
    expect(smsErrorMessage({ code: "OTP_NOT_FOUND" })).toBe("That code has expired. Request a new one.");
    expect(smsErrorMessage({ code: "INVALID_OTP" })).toBe("Incorrect code. Please try again.");
    expect(smsErrorMessage({ code: "TOO_MANY_ATTEMPTS" })).toBe("Too many attempts. Request a new code.");
    expect(smsErrorMessage({ code: "INVITE_CODE_INVALID" })).toBe(
      "Invalid, used or expired invite code.",
    );
    expect(smsErrorMessage({ code: "PHONE_NUMBER_EXIST" })).toBe(
      "This phone number is already linked to another account.",
    );
    expect(smsErrorMessage({ code: "INVALID_PHONE_NUMBER_OR_PASSWORD" })).toBe(
      "Incorrect phone number or password.",
    );
    expect(smsErrorMessage({ code: "PASSWORD_ALREADY_SET" })).toBe(
      'This account already has a password — use "Change password" instead.',
    );
    expect(smsErrorMessage({ code: "SESSION_EXPIRED" })).toBe(
      "Your session has expired. Please sign in again.",
    );

    // 判别点：OTP 三种错必须分成两类说法（过期 vs 输错），混成一句会让用户做错下一步
    expect(smsErrorMessage({ code: "OTP_EXPIRED" })).not.toBe(smsErrorMessage({ code: "INVALID_OTP" }));
  });

  it("UNEXPECTED_ERROR 按页面分叉：登录 = 登不进去，重置 = 中性兜底（不暴露号码不存在）", () => {
    expect(smsErrorMessage({ code: "UNEXPECTED_ERROR" }, "login")).toBe(
      "Incorrect phone number or password.",
    );
    expect(smsErrorMessage({ code: "UNEXPECTED_ERROR" }, "reset-password")).toBe(
      "Something went wrong. Please try again.",
    );
    // 反例：兜底里不得出现「号码不存在」这类可枚举措辞
    expect(smsErrorMessage({ code: "UNEXPECTED_ERROR" }, "reset-password")).not.toMatch(
      /not found|doesn't exist|isn't registered/i,
    );
  });

  it("PHONE_NUMBER_NOT_VERIFIED → 指向「先用验证码登录」这一步", () => {
    expect(smsErrorMessage({ code: "PHONE_NUMBER_NOT_VERIFIED" })).toBe(
      "This phone number isn't verified yet. Sign in with an SMS code first.",
    );
  });

  it("INVITE_CODE_REQUIRED 按页面分叉（登录 = 未注册，注册 = 要邀请码）", () => {
    expect(smsErrorMessage({ code: "INVITE_CODE_REQUIRED" }, "login")).toBe(
      "This phone number isn't registered yet — create an account first.",
    );
    expect(smsErrorMessage({ code: "INVITE_CODE_REQUIRED" }, "register")).toBe(
      "Invite code is required.",
    );
    // 缺省上下文是登录页
    expect(smsErrorMessage({ code: "INVITE_CODE_REQUIRED" })).toBe(
      "This phone number isn't registered yet — create an account first.",
    );
  });

  it("密码长度文案插值常量（不写死 8）", () => {
    const expected = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
    expect(smsErrorMessage({ code: "PASSWORD_TOO_SHORT" })).toBe(expected);
    expect(smsErrorMessage({ code: "PASSWORD_TOO_LONG" })).toBe(expected);
  });

  it("发送类 4xx/未知码：配置错误统一成「发不出去」，不泄露内部术语", () => {
    for (const code of ["SMS_CONFIG_INVALID", "SMS_TEMPLATE_INVALID", "SMS_SEND_FAILED", "SMS_SIGN_FAILED"]) {
      const text = smsErrorMessage({ code });
      expect(text).toBe("We couldn't send the SMS. Please try again in a minute.");
      // 内部术语不得出现在文案里
      expect(text).not.toContain("SMS_");
      expect(text).not.toContain(code);
    }
  });
});

describe("smsErrorMessage — 状态码与兜底", () => {
  it("429（中间件限流）优先于兜底；无 code 也能认出", () => {
    expect(smsErrorMessage({ status: 429 })).toBe("Too many requests. Please try again later.");
    // 传了 code 但表里没有时，429 仍然生效（顺序：code 表 → 状态 → message）
    expect(smsErrorMessage({ status: 429, code: "UNKNOWN", message: "oops" })).toBe(
      "Too many requests. Please try again later.",
    );
  });

  it("send 步骤的 5xx（发送失败 → 库返回 500 空体）→ 短信失败文案", () => {
    expect(smsErrorMessage({ status: 500 }, "send")).toBe(
      "We couldn't send the SMS. Please try again in a minute.",
    );
    expect(smsErrorMessage({ status: 503 }, "send")).toBe(
      "We couldn't send the SMS. Please try again in a minute.",
    );
  });

  it("非发送步骤的 5xx 不冒充「短信发送失败」（同状态码按步骤分叉）", () => {
    // 判别点：同一输入 { status: 500 } 在发送步骤与其他步骤的输出必须不同 ——
    // 停用账号走验证码登录时库回 FAILED_TO_CREATE_SESSION(500)，说成「短信没发出去」
    // 会让用户一直重发验证码，而问题不在发送。
    const smsFailure = "We couldn't send the SMS. Please try again in a minute.";
    const fallback = "Something went wrong. Please try again.";
    expect(smsErrorMessage({ status: 500 }, "send")).toBe(smsFailure);
    for (const context of ["login", "register", "forgot-password", "reset-password", "profile"] as const) {
      expect(smsErrorMessage({ status: 500 }, context)).toBe(fallback);
    }
    expect(smsErrorMessage({ status: 500 })).toBe(fallback); // 缺省上下文同其他步骤
  });

  it("未知 code 回落服务端 message；两者皆空才用兜底", () => {
    expect(smsErrorMessage({ code: "SOMETHING_NEW", message: "Server said this" })).toBe(
      "Server said this",
    );
    expect(smsErrorMessage({ code: "SOMETHING_NEW" })).toBe(
      "Something went wrong. Please try again.",
    );
    expect(smsErrorMessage(null)).toBe("Something went wrong. Please try again.");
    expect(smsErrorMessage(undefined)).toBe("Something went wrong. Please try again.");
    // 空白 message 不当作有效回落值
    expect(smsErrorMessage({ message: "   " })).toBe("Something went wrong. Please try again.");
  });

  it("4xx 但不认识的码：落在 message/兜底，**不**误报成短信失败", () => {
    expect(smsErrorMessage({ status: 400, code: "WHATEVER" })).toBe(
      "Something went wrong. Please try again.",
    );
  });
});
