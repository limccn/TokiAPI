// /forgot-password — 短信找回密码（11-06-sms-alicloud-auth，design §7.4）。
//
// 两步：
//   ① 号码 → `requestPasswordReset`（服务端对**不存在的号码也返回成功**，见 lib 的
//      request-password-reset 路由：先落一条 OTP 记录再查人，查不到直接 return {status:true}）；
//   ② 验证码 + 新密码 → `resetPassword`。
// 两步的差异是刻意的、也是本页唯一的文案纪律：
//   - 第 ① 步永远说「如果该号码已注册，验证码已发出」—— 说「已发送」就等于给了号码登记状态的
//     oracle，前端不能把服务端刚守住的克制还回去；
//   - 第 ② 步才可能出现真错误（验证码错/过期/号码其实没注册 ⇒ 库抛 UNEXPECTED_ERROR）。
//     那里的 5xx/兜底走 `reset-password` 上下文，不会被说成「短信没发出去」。
//
// 本页**不**校验部署开关以外的任何东西：开关关闭时 phone-number 端点整段 404，
// 直接给一句「本部署未开启」而不是让用户填完表单才失败。
import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/hooks/use-session";
import { useMounted } from "@/hooks/use-mounted";
import { useApiConfig } from "@/hooks/use-api-config";
import { useSmsCodeSender } from "@/hooks/use-sms-code";
import { smsErrorMessage, type SmsErrorLike } from "@/lib/sms-errors";
import {
  INVALID_CODE_MESSAGE,
  INVALID_PHONE_MESSAGE,
  composePhoneNumber,
  toSmsCode,
} from "@/lib/phone-input";
import { MIN_PASSWORD_LENGTH } from "../../src/lib/password";
import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneNumberInput } from "@/components/ui/phone-number-input";
import { SendCodeButton } from "@/components/ui/send-code-button";

const MIN_LENGTH_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

/**
 * 第 ① 步的发送结果 —— 「若已注册」是必要条件，不是客套：服务端对未注册号码同样返回成功，
 * 说「已发送」就把号码登记状态变成了 oracle（见文件头注）。冷却期与第二步共用这一句。
 */
const SENT_MESSAGE = "If this number is registered, a code is on its way.";

type Step = "request" | "reset" | "done";

export default function ForgotPasswordPage() {
  const isMounted = useMounted();
  const { user } = useSession();
  const navigate = useNavigate();
  const config = useApiConfig();

  const [step, setStep] = useState<Step>("request");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{
    phone?: string;
    code?: string;
    password?: string;
    confirm?: string;
  }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // purpose: "reset" 必须显式传 —— 库的找回密码验证码存在 `${号码}-request-password-reset`
  // 命名空间，第 ② 步的 resetPassword 只认那一行；用缺省的 sendOtp 会让码永远对不上。
  const smsSender = useSmsCodeSender({ purpose: "reset" });

  if (!isMounted) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  // 已登录用户没有「找回密码」的语境（改密码在账户菜单），直接回控制台
  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  if (config.data !== undefined && !config.data.smsAuthEnabled) {
    return (
      <AuthCard
        title="Reset password"
        description="Password reset by SMS is not enabled on this deployment"
        footer={
          <>
            Back to{" "}
            <Link to="/login" className="font-medium text-primary hover:underline">
              sign in
            </Link>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">
          This deployment has SMS sign-in turned off, so there is no self-service password reset.
          Ask an administrator for help.
        </p>
      </AuthCard>
    );
  }

  /** 规范形号码；非法时写内联错误并返回 null（不发请求）。 */
  const canonicalPhone = (): string | null => {
    const target = composePhoneNumber(phone);
    if (target === null) {
      setFieldErrors((prev) => ({ ...prev, phone: INVALID_PHONE_MESSAGE }));
      return null;
    }
    return target;
  };

  const handleSendCode = async () => {
    setFormError(null);
    const phoneNumber = canonicalPhone();
    if (phoneNumber === null) {
      return;
    }
    setFieldErrors((prev) => ({ ...prev, phone: undefined }));
    const ok = await smsSender.send(phoneNumber);
    if (ok) {
      // 发送成功才进入第二步：未注册号码服务端同样「成功」，故这一步不泄露登记状态
      setStep("reset");
    }
  };

  const handleReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    // 第一步还没开始（单输入框 + 回车）：回车应当等同于「发送验证码」，
    // 而不是拿空验证码/空密码把两个字段的错误一起报出来。
    if (step === "request") {
      await handleSendCode();
      return;
    }
    const phoneNumber = canonicalPhone();
    const trimmedCode = code.trim();
    const errors: typeof fieldErrors = {
      phone: phoneNumber === null ? INVALID_PHONE_MESSAGE : undefined,
      code: /^\d{6}$/.test(trimmedCode) ? undefined : INVALID_CODE_MESSAGE,
      password: newPassword.length < MIN_PASSWORD_LENGTH ? MIN_LENGTH_MESSAGE : undefined,
      // 确认框只比对，不重复长度规则（空密码时长度规则已先报）
      confirm: confirmPassword !== newPassword ? "Passwords do not match" : undefined,
    };
    setFieldErrors(errors);
    if (phoneNumber === null || Object.values(errors).some((value) => value !== undefined)) {
      return;
    }
    setIsSubmitting(true);
    try {
      const { error } = await authClient.phoneNumber.resetPassword({
        phoneNumber,
        otp: trimmedCode,
        newPassword,
      });
      if (error) {
        setFormError(smsErrorMessage(error as SmsErrorLike, "reset-password"));
        return;
      }
      setStep("done");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (step === "done") {
    return (
      <AuthCard
        title="Password reset"
        description="You can now sign in with your new password"
        footer={
          <>
            Back to{" "}
            <Link to="/login" className="font-medium text-primary hover:underline">
              sign in
            </Link>
          </>
        }
      >
        <p role="status" className="text-sm text-muted-foreground">
          Your password has been changed. Sign in with your phone number and the new password.
        </p>
        <Button type="button" className="mt-4 w-full" onClick={() => navigate("/login", { replace: true })}>
          Go to sign in
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset password"
      description="We'll text you a verification code"
      footer={
        <>
          Remembered it?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleReset} className="space-y-4" noValidate>
        {formError !== null || smsSender.error !== null ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {formError ?? smsSender.error}
          </p>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="forgot-phone">Phone number (China Only)</Label>
          <PhoneNumberInput
            id="forgot-phone"
            value={phone}
            // 换号码即作废第二步（验证码是发给上一个号码的，留着只会送出必然失败的请求）
            onValueChange={(digits) => {
              setPhone(digits);
              setStep("request");
              setCode("");
            }}
            aria-invalid={fieldErrors.phone !== undefined}
          />
          {fieldErrors.phone !== undefined ? (
            <p className="text-xs text-destructive">{fieldErrors.phone}</p>
          ) : null}
        </div>

        {/* 第一步还没有验证码输入框可配对：整宽按钮独自成立，hint={null} 不渲染提示行
            （发送结果由按钮标签表达；第二步的那句「若已注册」见下方验证码行） */}
        {step === "request" ? (
          <SendCodeButton
            layout="stacked"
            hint={null}
            isSending={smsSender.isSending}
            cooldownSeconds={smsSender.cooldownSeconds}
            onSend={() => void handleSendCode()}
          />
        ) : null}

        {step === "reset" ? (
          <>
            {/* 发码按钮与验证码输入框同一行（与登录/注册/绑定一致） */}
            <div className="space-y-2">
              <Label htmlFor="forgot-code">Verification code</Label>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    id="forgot-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    // 不加 maxLength：浏览器先截原始文本会在清洗前丢掉粘贴里的位数，截断交给 toSmsCode
                    placeholder="6-digit code"
                    value={code}
                    onChange={(event) => {
                      const next = toSmsCode(event.target.value);
                      if (event.target.value !== next) {
                        event.target.value = next;
                      }
                      setCode(next);
                    }}
                    aria-invalid={fieldErrors.code !== undefined}
                  />
                  {fieldErrors.code !== undefined ? (
                    <p className="text-xs text-destructive">{fieldErrors.code}</p>
                  ) : null}
                </div>
                <SendCodeButton
                  layout="button"
                  isSending={smsSender.isSending}
                  cooldownSeconds={smsSender.cooldownSeconds}
                  onSend={() => void handleSendCode()}
                />
              </div>
              {/* 第二步存在 = 本号码的码已请求过：常驻这一句（冷却结束后依然成立）。
                  绝不能说「已发送」—— 服务端对未注册号码同样返回成功（文件头注） */}
              <p role="status" className="text-xs text-muted-foreground">
                {SENT_MESSAGE}
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="forgot-new-password">New password</Label>
              <Input
                id="forgot-new-password"
                type="password"
                autoComplete="new-password"
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                aria-invalid={fieldErrors.password !== undefined}
              />
              {fieldErrors.password !== undefined ? (
                <p className="text-xs text-destructive">{fieldErrors.password}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="forgot-confirm-password">Confirm new password</Label>
              <Input
                id="forgot-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                aria-invalid={fieldErrors.confirm !== undefined}
              />
              {fieldErrors.confirm !== undefined ? (
                <p className="text-xs text-destructive">{fieldErrors.confirm}</p>
              ) : null}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Resetting…" : "Reset password"}
            </Button>
          </>
        ) : null}
      </form>
    </AuthCard>
  );
}
