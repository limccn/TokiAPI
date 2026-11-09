// 短信验证码「发送 + 冷却」的共享 hook（11-06-sms-alicloud-auth，design §7.6）。
//
// 四个地方都要「点发送 → 成功后 60s 倒计时 → 失败不冷却」：登录页、注册页、
// 找回密码页、资料弹窗的绑定手机号。四处各写一份 setInterval，最先漂的一定是
// 「失败要不要冷却」这条语义（design §7.6 明确要求失败**不**冷却 —— 失败可能是网络/配置，
// 禁用 60s 等于把用户锁在外面）。故收敛到一处。
//
// 冷却口径与平台同号频控对齐（阿里云 `biz.FREQUENCY`，60s 内重发必失败，research R14）：
// 本地先挡住，免得用户白等一次失败。
import { useCallback, useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { smsErrorMessage, type SmsErrorLike } from "@/lib/sms-errors";

/** 与阿里云同号频控对齐的本地冷却秒数（design §7.6）。 */
export const SMS_RESEND_COOLDOWN_SECONDS = 60;

export interface SmsCodeSender {
  /** 请求在途（按钮显示 Sending… 并禁用）。 */
  readonly isSending: boolean;
  /** 剩余冷却秒数；0 = 可再次发送。 */
  readonly cooldownSeconds: number;
  /** 上一次发送的可展示错误（成功即清空）。 */
  readonly error: string | null;
  /** 发送验证码。返回是否成功（失败不启动冷却）。 */
  readonly send: (phoneNumber: string) => Promise<boolean>;
}

/**
 * 发码用途。**不是可选装饰**：库对两类场景用不同的 verification identifier ——
 * 登录/注册/绑定写**裸号码**（`send-otp`），找回密码写 `${号码}-request-password-reset`
 * （`request-password-reset`），而 `reset-password` 只认后者。用错端点 ⇒ 短信照发、
 * 验证码永远对不上（OTP_NOT_FOUND）。默认 `login` 覆盖前三个页面，
 * `/forgot-password` 必须显式传 `reset`。
 */
export type SmsCodePurpose = "login" | "reset";

/**
 * 无需页面上下文：本 hook 只服务**发送步骤**，故错误一律按 `send` 解释
 * （5xx = 短信没发出去）。校验/重置步骤的错误由各页面自己映射 ——
 * 那里同一个 500 是「会话建不起来 / 库内部错误」，说成发送失败会误导。
 */
export function useSmsCodeSender(options?: { purpose?: SmsCodePurpose }): SmsCodeSender {
  const purpose = options?.purpose ?? "login";
  const [isSending, setIsSending] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  // 卸载即停表：倒计时跨页面存活会在 setState 已卸载组件上留下噪声
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const startCooldown = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
    }
    setCooldownSeconds(SMS_RESEND_COOLDOWN_SECONDS);
    timerRef.current = window.setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          if (timerRef.current !== null) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  const send = useCallback(
    async (phoneNumber: string) => {
      setError(null);
      setIsSending(true);
      try {
        // 端点必须与「验码端点」成对（见 SmsCodePurpose）：reset 页面用 sendOtp 会让
        // resetPassword 永远查不到记录。
        const { error: sendError } =
          purpose === "reset"
            ? await authClient.phoneNumber.requestPasswordReset({ phoneNumber })
            : await authClient.phoneNumber.sendOtp({ phoneNumber });
        if (sendError) {
          setError(smsErrorMessage(sendError as SmsErrorLike, "send"));
          return false;
        }
        startCooldown();
        return true;
      } catch (cause) {
        // 网络层异常（fetch 直接 reject）：按同一张表兜底，不吞掉
        setError(smsErrorMessage(cause as SmsErrorLike, "send"));
        return false;
      } finally {
        setIsSending(false);
      }
    },
    [startCooldown, purpose],
  );

  return { isSending, cooldownSeconds, error, send };
}
