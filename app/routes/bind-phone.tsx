// /bind-phone — 强制绑定手机号（11-06-sms-alicloud-auth，PRD R19 / design §13.8）。
//
// 独立路由，**不套 AppLayout**：门禁开启时管理面 API 一律 403，套进管理台布局只会
// 渲染出一堆加载失败的空壳。本页只依赖 allowlist 内的 GET /api/me/profile 判状态。
//
// 三种重定向（design §13.8）：
//   - 未登录 → /login；
//   - 部署未开短信（或配置未到达）→ /dashboard；
//   - 已绑定 verified → /dashboard。
// 绑定成功后 → /dashboard（会话里的 phoneNumberVerified 由服务端在下次 getSession 时读到，
// 前端只需让 profile 缓存失效，AppLayout 的门禁判定即通过）。
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, useNavigate } from "react-router";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/hooks/use-session";
import { useMounted } from "@/hooks/use-mounted";
import { useApiConfig } from "@/hooks/use-api-config";
import { useSmsCodeSender } from "@/hooks/use-sms-code";
import { useProfile } from "@/modules/profile/hooks/use-profile";
import { smsErrorMessage, type SmsErrorLike } from "@/lib/sms-errors";
import {
  INVALID_CODE_MESSAGE,
  INVALID_PHONE_MESSAGE,
  composePhoneNumber,
  toSmsCode,
} from "@/lib/phone-input";
// type-only 导入（完全擦除、零运行时成本）：响应契约与服务端单一真源
import type { ProfileOutput } from "../../src/routes/profile/types";
import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneNumberInput } from "@/components/ui/phone-number-input";
import { SendCodeButton } from "@/components/ui/send-code-button";

export default function BindPhonePage() {
  const isMounted = useMounted();
  const { isPending: sessionPending, user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const config = useApiConfig();
  const profileQuery = useProfile({ enabled: !!user });

  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  // 字段错误内联（与注册/找回/登录同一形态），error 只承载绑定失败的整表错误
  const [fieldErrors, setFieldErrors] = useState<{ phone?: string; code?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const smsSender = useSmsCodeSender();

  if (!isMounted || sessionPending) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // 配置未到达时先等：开关关闭的部署上，这个页面没有任何可做的事（否则用户会填完表单
  // 才发现端点 404）。config 是公开端点，正常瞬间返回。
  if (config.isPending) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  if (config.data !== undefined && !config.data.smsAuthEnabled) {
    return <Navigate to="/dashboard" replace />;
  }

  if (profileQuery.isPending) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }

  if (profileQuery.isError || profileQuery.data === undefined) {
    return (
      <AuthCard title="Verify your phone" description="We couldn't load your account">
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Failed to load your profile. Please try again.
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full"
          onClick={() => void profileQuery.refetch()}
        >
          Try again
        </Button>
      </AuthCard>
    );
  }

  // 已经验证过（例如直接输 URL）：没有绑定语境，回控制台
  if (profileQuery.data.profile.phoneNumberVerified) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleSendCode = async () => {
    setError(null);
    const phoneNumber = composePhoneNumber(phone);
    if (phoneNumber === null) {
      setFieldErrors((prev) => ({ ...prev, phone: INVALID_PHONE_MESSAGE }));
      return;
    }
    setFieldErrors((prev) => ({ ...prev, phone: undefined }));
    await smsSender.send(phoneNumber);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const phoneNumber = composePhoneNumber(phone);
    const trimmedCode = code.trim();
    const errors: typeof fieldErrors = {
      phone: phoneNumber === null ? INVALID_PHONE_MESSAGE : undefined,
      code: /^\d{6}$/.test(trimmedCode) ? undefined : INVALID_CODE_MESSAGE,
    };
    setFieldErrors(errors);
    if (phoneNumber === null || errors.code !== undefined) {
      return;
    }
    setIsSaving(true);
    try {
      // updatePhoneNumber: true —— 本页也可能用于「换绑/重试绑定」，库据此覆盖旧号码
      const { error: verifyError } = await authClient.phoneNumber.verify({
        phoneNumber,
        code: trimmedCode,
        updatePhoneNumber: true,
      });
      if (verifyError) {
        setError(smsErrorMessage(verifyError as SmsErrorLike, "profile"));
        return;
      }
      // 先本地改写缓存再失效：AppLayout 的门禁判据读同一个 queryKey，
      // 若只 invalidate，跳转瞬间可能仍拿到「未验证」的旧快照而把用户弹回本页。
      queryClient.setQueryData<ProfileOutput>(["profile"], (old) =>
        old === undefined
          ? old
          : {
              ...old,
              profile: { ...old.profile, phoneNumber, phoneNumberVerified: true },
            },
      );
      // 让 AppLayout / 资料弹窗的下一次读拿到服务端最新值
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      navigate("/dashboard", { replace: true });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <AuthCard
      title="Verify your phone number"
      description="A phone number is required before you can use the dashboard"
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error !== null || smsSender.error !== null ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error ?? smsSender.error}
          </p>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="bind-phone-number">Phone number (China Only)</Label>
          <PhoneNumberInput
            id="bind-phone-number"
            value={phone}
            onValueChange={(digits) => {
              setPhone(digits);
              setFieldErrors((prev) => ({ ...prev, phone: undefined }));
            }}
            aria-invalid={fieldErrors.phone !== undefined}
          />
          {fieldErrors.phone !== undefined ? (
            <p className="text-xs text-destructive">{fieldErrors.phone}</p>
          ) : null}
        </div>

        {/* 发码按钮与验证码输入框同一行（与登录/注册一致）；提示行不再出现 ——
            按钮标签本身（Resend in Ns）已表达发送结果 */}
        <div className="space-y-2">
          <Label htmlFor="bind-phone-code">Verification code</Label>
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              <Input
                id="bind-phone-code"
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
                  setFieldErrors((prev) => ({ ...prev, code: undefined }));
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
        </div>

        <Button type="submit" className="w-full" disabled={isSaving}>
          {isSaving ? "Binding…" : "Bind phone"}
        </Button>
      </form>
    </AuthCard>
  );
}
