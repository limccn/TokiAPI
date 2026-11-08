// /login — 登录页（M6 6.2；11-06-sms-alicloud-auth 改版，11-08 R9 改分段控件）。
//
// 表单顶部是 Email / Phone 分段控件（`aria-pressed` 表达当前段，不引入 tab 语义）：
//   - Email 段：`type="email"` 输入 + 密码 → `authClient.signIn.email`（表单已 noValidate，
//     浏览器格式拦截不生效；格式不对由服务端返回文案）；
//   - Phone 段：`PhoneNumberInput`（`withCountrySelector`）+ 密码 →
//     `composePhoneNumber` 拼规范形（`+86` + 11 位）→ `authClient.signIn.phoneNumber`。
//     段内还有次级切换：密码登录 ⇄ 短信验证码登录（`smsMode`，发码/验证共用本段号码）。
// 切段只清错误（上一段的失败原因不再适用）并在切回 Email 时退出 smsMode；两段各自保留
// 已输入值，来回切换不丢。`/api/config` 确认 `smsAuthEnabled === false` 时不渲染 Phone 段
// —— 此时 phone-number 插件整段 404；配置未到达（unknown）时渲染，由 404 兜底文案接住。
//
// 登录成功后的去向（PRD R14 / R19，design §13.7；11-08 R8 加后门判据）：
//   - 短信开关关闭 ⇒ 原目的地（`from` 或 /dashboard）；
//   - 开关开启 ⇒ 读 `GET /api/me/profile`，`needsPhoneBinding`（手机未验证且未命中
//     ADMIN_EMAILS 后门）的账号先去 `/bind-phone`（服务端门禁是最终防线，前端重定向只为
//     避免落进 403 的空页面）。判据走 app/lib/phone-gate.ts 的单一函数，前端不解析名单。
//   `useProfile` 的 enabled 用 `!!user && smsStatus === "on"` —— 会话与开关都成立才请求，
//   不在匿名态白拿一次 401，也不伪造 SessionUser 里不存在的 phoneNumberVerified 字段。
//
// SMS 验证码面（仅开关开启时出现）：号码 → Send code（成功后 60s 冷却）→ 6 位码 → verify。
// 登录页**不传 inviteCode**：verify 对未注册号码会走到 signUpOnVerification，
// 而 validateUserInfo 要求注册必须带邀请码 ⇒ 403 INVITE_CODE_REQUIRED ⇒
// 映射为「该号码还没注册，请先注册」（design §8）。这正是登录页想要的语义。
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useLocation, useNavigate } from "react-router";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/hooks/use-session";
import { useMounted } from "@/hooks/use-mounted";
import { useApiConfig } from "@/hooks/use-api-config";
import { useSmsCodeSender } from "@/hooks/use-sms-code";
import { apiFetch } from "@/lib/api";
import { smsErrorMessage, type SmsErrorLike } from "@/lib/sms-errors";
import { useProfile } from "@/modules/profile/hooks/use-profile";
import { needsPhoneBinding } from "@/lib/phone-gate";
import {
  INVALID_CODE_MESSAGE,
  INVALID_PHONE_MESSAGE,
  composePhoneNumber,
  toSmsCode,
} from "@/lib/phone-input";
// type-only 导入（完全擦除、零运行时成本）：响应契约与服务端单一真源
import type { ProfileOutput } from "../../src/routes/profile/types";
import { cn } from "@/lib/utils";
import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneNumberInput } from "@/components/ui/phone-number-input";
import { SendCodeButton } from "@/components/ui/send-code-button";

type LoginMethod = "email" | "phone";

// 每个段只校验自己的标识字段 + 共用密码（不校验另一段的残留值）。
const emailFormSchema = z.object({
  email: z.string().min(1, "Email is required"),
  password: z.string().min(1, "Password is required"),
});

const phoneFormSchema = z.object({
  phoneDigits: z.string().min(1, "Phone number is required"),
  password: z.string().min(1, "Password is required"),
});

interface FieldErrors {
  email?: string;
  phone?: string;
  password?: string;
}

interface IssueLike {
  path: readonly PropertyKey[];
  message: string;
}

/** zod issue → 本页内联错误（phoneDigits 落在号码字段下；其余段以外的 issue 忽略）。 */
function collectFieldErrors(issues: readonly IssueLike[]): FieldErrors {
  const next: FieldErrors = {};
  for (const issue of issues) {
    const raw = issue.path[0];
    const field = raw === "phoneDigits" ? "phone" : raw;
    if (field === "email" || field === "phone" || field === "password") {
      next[field] ??= issue.message;
    }
  }
  return next;
}

const PHONE_DISABLED = "Phone sign-in is not enabled on this deployment.";

/** 服务端未注册 phoneNumber 插件时是 404（插件整段不注册）—— 别把 "Not found" 端给用户。 */
function phoneAuthErrorMessage(error: SmsErrorLike): string {
  return error.status === 404 ? PHONE_DISABLED : smsErrorMessage(error, "login");
}

export default function LoginPage() {
  const isMounted = useMounted();
  const { user } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const config = useApiConfig();
  const queryClient = useQueryClient();

  // 三态而非布尔：配置未到达（unknown）与确定关闭（off）不能同等对待 ——
  // 前者放行（由服务端 404 兜底），后者不渲染 Phone 段（design §7.2 / §13.1）。
  const smsStatus: "unknown" | "on" | "off" =
    config.data === undefined ? "unknown" : config.data.smsAuthEnabled ? "on" : "off";

  // 已登录访客的去向判据（design §13.7）：开关开启时以服务端 profile 为准。
  const profileQuery = useProfile({ enabled: !!user && smsStatus === "on" });

  const [method, setMethod] = useState<LoginMethod>("email");
  // 配置异步到达时可能把用户已选的 Phone 段「抽走」：off 时一律按 Email 段渲染与提交，
  // 避免停在一个没有插件支撑的表单里（Phone 按钮同时不渲染）。
  const activeMethod: LoginMethod = smsStatus === "off" ? "email" : method;

  const [email, setEmail] = useState("");
  const [phoneDigits, setPhoneDigits] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [phoneSignInFailed, setPhoneSignInFailed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ---- SMS 验证码面（仅 Phone 段）----
  // 与密码方式共用 Phone 段的号码输入框：本组状态只承载「方式」与验证码。
  const [smsMode, setSmsMode] = useState(false);
  const [smsCode, setSmsCode] = useState("");
  // 字段错误走内联（与号码/密码及注册/绑定/找回三页同一形态），
  // smsError 只留认证失败的整表错误
  const [smsCodeError, setSmsCodeError] = useState<string | null>(null);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const smsSender = useSmsCodeSender();

  // 验证码视图要求 Phone 段仍可见（smsMode 单独为 true 不构成视图）
  const smsView = activeMethod === "phone" && smsMode;

  const from = (location.state as { from?: string } | null)?.from;

  // SSR-safe
  if (!isMounted) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  // 已登录：开关开启时先确认手机绑定状态再决定去向；查询在途时保持空白页，
  // 避免「先闪一下登录表单 / 先跳 dashboard 再被 AppLayout 弹回」。
  if (user) {
    if (smsStatus === "on") {
      if (profileQuery.data !== undefined) {
        const target = needsPhoneBinding(profileQuery.data.profile)
          ? "/bind-phone"
          : (from ?? "/dashboard");
        return <Navigate to={target} replace />;
      }
      if (profileQuery.isPending) {
        return <div className="min-h-screen" aria-hidden="true" />;
      }
    }
    // 开关关闭或 profile 读取失败：原目的地。服务端门禁仍是最终防线。
    return <Navigate to={from ?? "/dashboard"} replace />;
  }

  /**
   * 登录成功后的统一去向。短信开启时**立即**取一次服务端 profile（同一 queryKey 会
   * 顺带填好上面守卫用的缓存），`needsPhoneBinding` 为真 → /bind-phone；读取失败则放行 ——
   * 把用户卡在登录页比多一次 403 更糟，AppLayout 与服务端门禁会接住。
   */
  const goAfterSignIn = async () => {
    if (smsStatus !== "on") {
      navigate(from ?? "/dashboard", { replace: true });
      return;
    }
    try {
      const result = await queryClient.fetchQuery({
        queryKey: ["profile"],
        queryFn: () => apiFetch<ProfileOutput>("/api/me/profile"),
        staleTime: 0,
      });
      if (needsPhoneBinding(result.profile)) {
        navigate("/bind-phone", { replace: true });
        return;
      }
    } catch {
      // fail-open：去向由 AppLayout / 服务端门禁兜底
    }
    navigate(from ?? "/dashboard", { replace: true });
  };

  /**
   * 切段：清所有错误（上一段的失败原因不再适用于新段），切到 Email 时强制退出 smsMode。
   * 两段各自的已输入值保留 —— 用户来回对照不该丢输入。
   */
  const switchMethod = (next: LoginMethod) => {
    if (next === activeMethod) {
      return;
    }
    setMethod(next);
    setErrors({});
    setFormError(null);
    setPhoneSignInFailed(false);
    setSmsError(null);
    setSmsCodeError(null);
    if (next === "email") {
      setSmsMode(false);
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setPhoneSignInFailed(false);

    if (activeMethod === "email") {
      const parsed = emailFormSchema.safeParse({ email, password });
      if (!parsed.success) {
        setErrors(collectFieldErrors(parsed.error.issues));
        return;
      }
      setErrors({});
      setIsSubmitting(true);
      try {
        const { error } = await authClient.signIn.email({
          email: parsed.data.email.trim(),
          password: parsed.data.password,
        });
        if (error) {
          // 邮箱面沿用服务端文案：不走 smsErrorMessage（那张表把 5xx 解释成「短信没发出去」）
          setFormError(error.message ?? "Sign in failed");
          return;
        }
        await goAfterSignIn();
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    const parsed = phoneFormSchema.safeParse({ phoneDigits, password });
    if (!parsed.success) {
      setErrors(collectFieldErrors(parsed.error.issues));
      return;
    }
    // 手机号 = 静态 `+86` + 本地 11 位（PRD R20：用户不手输国家码，也没有真正的下拉）
    const phoneNumber = composePhoneNumber(parsed.data.phoneDigits);
    if (phoneNumber === null) {
      // 客户端拦截，不发请求（design §7.2）
      setErrors({ phone: INVALID_PHONE_MESSAGE });
      return;
    }
    setErrors({});
    setIsSubmitting(true);
    try {
      const { error } = await authClient.signIn.phoneNumber({
        phoneNumber,
        password: parsed.data.password,
      });
      if (error) {
        // 号码/密码登录失败**不区分原因**（未注册 / 无密码 / 密码错）—— 服务端本就不区分，
        // 前端不能靠文案把这份克制还回去（design §8）
        setFormError(phoneAuthErrorMessage(error as SmsErrorLike));
        setPhoneSignInFailed(true);
        return;
      }
      await goAfterSignIn();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGithubSignIn = async () => {
    await authClient.signIn.social({
      provider: "github",
      callbackURL: "/dashboard",
    });
  };

  const openSmsMode = () => {
    setSmsMode(true);
    setFormError(null);
    setPhoneSignInFailed(false);
    setSmsError(null);
    setSmsCodeError(null);
  };

  const closeSmsMode = () => {
    setSmsMode(false);
    setSmsError(null);
    setSmsCodeError(null);
  };

  const handleSendCode = async () => {
    setSmsError(null);
    const phoneNumber = composePhoneNumber(phoneDigits);
    if (phoneNumber === null) {
      setErrors({ phone: INVALID_PHONE_MESSAGE });
      return;
    }
    setErrors({});
    await smsSender.send(phoneNumber);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSmsError(null);
    const phoneNumber = composePhoneNumber(phoneDigits);
    if (phoneNumber === null) {
      setErrors({ phone: INVALID_PHONE_MESSAGE });
      return;
    }
    const code = smsCode.trim();
    if (!/^\d{6}$/.test(code)) {
      setSmsCodeError(INVALID_CODE_MESSAGE);
      return;
    }
    setErrors({});
    setSmsCodeError(null);
    setIsVerifying(true);
    try {
      const { error } = await authClient.phoneNumber.verify({
        phoneNumber,
        code,
      });
      if (error) {
        setSmsError(phoneAuthErrorMessage(error as SmsErrorLike));
        return;
      }
      await goAfterSignIn();
    } finally {
      setIsVerifying(false);
    }
  };

  // 密码（两段共用）与验证码两种模式的表单级错误落在同一个位置。
  // 模式/段切换时各自清空（openSmsMode / closeSmsMode / switchMethod），同一时刻只会有一个来源。
  const pageError = smsView ? (smsError ?? smsSender.error) : formError;

  return (
    <AuthCard
      title="Sign in"
      description="Access your gateway dashboard"
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link to="/register" className="font-medium text-primary hover:underline">
            Register
          </Link>
        </>
      }
    >
      {/* 表单级错误统一放在卡片内容顶部：密码与验证码两种模式同一位置、同一形态 */}
      {pageError ? (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {pageError}
        </p>
      ) : null}
      {/* 失败原因的替代路径：不解释「为什么失败」，只指出下一步（design §8） */}
      {phoneSignInFailed && smsStatus === "on" && !smsView ? (
        <p className="mb-4 text-xs text-muted-foreground">
          Haven&apos;t set a password?{" "}
          <button
            type="button"
            className="font-medium text-primary hover:underline"
            onClick={openSmsMode}
          >
            Sign in with an SMS code
          </button>
          .
        </p>
      ) : null}

      <form onSubmit={smsView ? handleVerify : handleSubmit} className="space-y-4" noValidate>
        {/* Email / Phone 分段控件（design §13.2）：aria-pressed 表达当前段；
            smsStatus === "off" 时不渲染 Phone（插件整段 404）。 */}
        <div role="group" aria-label="Sign-in method" className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            aria-pressed={activeMethod === "email"}
            onClick={() => switchMethod("email")}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
              activeMethod === "email"
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Email
          </button>
          {smsStatus !== "off" ? (
            <button
              type="button"
              aria-pressed={activeMethod === "phone"}
              onClick={() => switchMethod("phone")}
              className={cn(
                "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors",
                activeMethod === "phone"
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Phone
            </button>
          ) : null}
        </div>

        {activeMethod === "email" ? (
          <div className="space-y-2">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              type="email"
              autoComplete="email"
              // 邮箱地址上限（RFC 5321 的 254）
              maxLength={254}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                // 改标识即清掉它的内联错误
                setErrors((prev) => ({ ...prev, email: undefined }));
              }}
              aria-invalid={errors.email !== undefined}
            />
            {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="login-phone">Phone number (China Only)</Label>
            <PhoneNumberInput
              id="login-phone"
              withCountrySelector
              autoComplete="tel-national"
              value={phoneDigits}
              onValueChange={(next) => {
                setPhoneDigits(next);
                setErrors((prev) => ({ ...prev, phone: undefined }));
                // 验证码属于上一个号码，改号即作废（码是发给旧号码的）
                setSmsCodeError(null);
                setSmsCode("");
              }}
              aria-invalid={errors.phone !== undefined}
            />
            {errors.phone ? <p className="text-xs text-destructive">{errors.phone}</p> : null}
          </div>
        )}

        {smsView ? (
          <>
            {/* 发码按钮与验证码输入框同一行（输入框占满剩余宽度）；提示行不再出现 ——
                按钮标签本身（Resend in Ns）已表达发送结果 */}
            <div className="space-y-2">
              <Label htmlFor="login-sms-code">Verification code</Label>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-2">
                  <Input
                    id="login-sms-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    // 不加 maxLength：浏览器会先截断原始文本，粘进来的「123 456」会在清洗前
                    // 丢位数。截断交给 toSmsCode（清洗 6 位 + 写回 DOM）。
                    placeholder="6-digit code"
                    value={smsCode}
                    onChange={(event) => {
                      const next = toSmsCode(event.target.value);
                      if (event.target.value !== next) {
                        event.target.value = next;
                      }
                      setSmsCode(next);
                      setSmsCodeError(null);
                    }}
                    aria-invalid={smsCodeError !== null}
                  />
                  {smsCodeError !== null ? (
                    <p className="text-xs text-destructive">{smsCodeError}</p>
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
            <Button type="submit" className="w-full" disabled={isVerifying}>
              {isVerifying ? "Signing in…" : "Sign in with code"}
            </Button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={errors.password !== undefined}
              />
              {errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}
            </div>
            <Button type="submit" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </>
        )}

        {/* 模式切换（仅 Phone 段有第二种方式）与找回入口固定在提交按钮下方：
            同一位置、同一文字链接样式。Forgot password 走短信验证码，故仍受开关门控。 */}
        {smsStatus === "on" ? (
          <div
            className={cn(
              "flex items-center text-sm",
              activeMethod === "phone" ? "justify-between" : "justify-end",
            )}
          >
            {activeMethod === "phone" ? (
              <button
                type="button"
                className="font-medium text-primary hover:underline"
                onClick={smsView ? closeSmsMode : openSmsMode}
              >
                {smsView ? "Sign in with password" : "Sign in with SMS code"}
              </button>
            ) : null}
            <Link to="/forgot-password" className="text-muted-foreground hover:text-foreground hover:underline">
              Forgot password?
            </Link>
          </div>
        ) : null}

        <div className="relative py-1 text-center">
          <span className="text-xs text-muted-foreground">or</span>
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={handleGithubSignIn}>
          Continue with GitHub
        </Button>
      </form>
    </AuthCard>
  );
}
