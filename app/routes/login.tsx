// /login — 登录页（M6 6.2；11-06-sms-alicloud-auth 第二轮改版 + 第三轮微调）。
//
// 全页**只有一个**标识输入框（Email or phone number，PRD R21）：含 `@` ⇒ signIn.email；
// 否则按中国内地手机号处理，值 = `+86` + 11 位本地号拼成的规范形（PRD R20：不再提供国家码下拉）。
// 密码登录与验证码登录共用这一个输入框 —— 切换模式只换密码/验证码字段，不换标识。
// 客户端**先拦**三种确定失败：
//   - 号码不合法 ⇒ 内联错误，不发请求；
//   - 是手机号但部署没开短信认证 ⇒ 明确说「本部署未开启」，而不是让用户拿到一个 404。
//     ⚠ 只有**确定**关闭（/api/config 已到达且为 false）才拦；配置还在路上时放行，
//     真关闭的话服务端 404 会由下面的 404 兜底文案接住。
//
// 登录成功后的去向（PRD R14 / R19，design §13.7）：
//   - 短信开关关闭 ⇒ 原目的地（`from` 或 /dashboard）；
//   - 开关开启 ⇒ 读 `GET /api/me/profile`，`phoneNumberVerified !== true` 的账号先去
//     `/bind-phone`（服务端门禁是最终防线，前端重定向只为避免落进 403 的空页面）。
//   `useProfile` 的 enabled 用 `!!user && smsAuthEnabled` —— 会话与开关都成立才请求，
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
import {
  INVALID_CODE_MESSAGE,
  INVALID_PHONE_MESSAGE,
  composePhoneNumber,
  toNationalDigits,
  toSmsCode,
} from "@/lib/phone-input";
// type-only 导入（完全擦除、零运行时成本）：响应契约与服务端单一真源
import type { ProfileOutput } from "../../src/routes/profile/types";
import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SendCodeButton } from "@/components/ui/send-code-button";

const loginFormSchema = z.object({
  // 字段名从 email 改成 identifier：格式判别交给页面里的 `@` 分流，
  // 这里只做「非空」—— 两处各写一套邮箱/号码正则必然漂移。
  identifier: z.string().min(1, "Email or phone number is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginForm = z.infer<typeof loginFormSchema>;

const INVALID_IDENTIFIER = "Enter a valid email or mainland China mobile number.";
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
  // 前者放行（由服务端 404 兜底），后者客户端直接拦（design §7.2）。
  const smsStatus: "unknown" | "on" | "off" =
    config.data === undefined ? "unknown" : config.data.smsAuthEnabled ? "on" : "off";

  // 已登录访客的去向判据（design §13.7）：开关开启时以服务端 profile 为准。
  const profileQuery = useProfile({ enabled: !!user && smsStatus === "on" });

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Partial<Record<keyof LoginForm, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [phoneSignInFailed, setPhoneSignInFailed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ---- SMS 验证码面 ----
  // 与密码面共用同一个 identifier 输入框（PRD R21）：本组状态只承载「模式」与验证码。
  const [smsMode, setSmsMode] = useState(false);
  const [smsCode, setSmsCode] = useState("");
  // 字段错误走内联（与 identifier/password 及注册/绑定/找回三页同一形态），
  // smsError 只留认证失败的整表错误
  const [smsCodeError, setSmsCodeError] = useState<string | null>(null);
  const [smsError, setSmsError] = useState<string | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const smsSender = useSmsCodeSender();

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
        const target = profileQuery.data.profile.phoneNumberVerified
          ? (from ?? "/dashboard")
          : "/bind-phone";
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
   * 顺带填好上面守卫用的缓存），未验手机 → /bind-phone；读取失败则放行 ——
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
      if (result.profile.phoneNumberVerified !== true) {
        navigate("/bind-phone", { replace: true });
        return;
      }
    } catch {
      // fail-open：去向由 AppLayout / 服务端门禁兜底
    }
    navigate(from ?? "/dashboard", { replace: true });
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setPhoneSignInFailed(false);
    const parsed = loginFormSchema.safeParse({ identifier, password });
    if (!parsed.success) {
      const next: Partial<Record<keyof LoginForm, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof LoginForm;
        if (key !== undefined && next[key] === undefined) {
          next[key] = issue.message;
        }
      }
      setErrors(next);
      return;
    }
    const value = parsed.data.identifier.trim();
    const isEmail = value.includes("@");
    if (!isEmail && smsStatus === "off") {
      setErrors({ identifier: PHONE_DISABLED });
      return;
    }
    // 手机号 = 静态 `+86` + 本地 11 位（PRD R20：用户不手输国家码，也没有下拉）。
    // 仍经 toNationalDigits 清洗：允许用户把完整号码粘贴进同一个输入框。
    const phoneNumber = isEmail ? null : composePhoneNumber(toNationalDigits(value));
    if (!isEmail && phoneNumber === null) {
      // 客户端拦截，不发请求（design §7.2）
      setErrors({ identifier: INVALID_IDENTIFIER });
      return;
    }
    setErrors({});
    setIsSubmitting(true);
    try {
      if (isEmail) {
        const { error } = await authClient.signIn.email({
          email: value,
          password: parsed.data.password,
        });
        if (error) {
          // 邮箱面沿用服务端文案：不走 smsErrorMessage（那张表把 5xx 解释成「短信没发出去」）
          setFormError(error.message ?? "Sign in failed");
          return;
        }
      } else {
        if (phoneNumber === null) {
          setErrors({ identifier: INVALID_IDENTIFIER });
          return;
        }
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

  /** 从共用标识框解析出规范形号码；不是手机号形态则返回 null（不再有第二个号码框）。 */
  const identifierPhoneNumber = (): string | null => {
    if (identifier.includes("@")) {
      return null;
    }
    return composePhoneNumber(toNationalDigits(identifier));
  };

  const handleSendCode = async () => {
    setSmsError(null);
    const phoneNumber = identifierPhoneNumber();
    if (phoneNumber === null) {
      setErrors({ identifier: INVALID_PHONE_MESSAGE });
      return;
    }
    setErrors({});
    await smsSender.send(phoneNumber);
  };

  const handleVerify = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSmsError(null);
    const phoneNumber = identifierPhoneNumber();
    if (phoneNumber === null) {
      setErrors({ identifier: INVALID_PHONE_MESSAGE });
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

  // 两种模式的表单级错误落在同一个位置。模式切换时各自清空（openSmsMode / closeSmsMode），
  // 因此这里同一时刻只会有一个来源。
  const pageError = smsMode ? (smsError ?? smsSender.error) : formError;

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
      {phoneSignInFailed && smsStatus === "on" && !smsMode ? (
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

      <form onSubmit={smsMode ? handleVerify : handleSubmit} className="space-y-4" noValidate>
        {/* 全页唯一的标识输入框（PRD R21）：密码登录与验证码登录共用，切换模式不换字段 */}
        <div className="space-y-2">
          {/* 验证码视图里标识只能是手机号（邮箱分支不存在），标签随之收窄；
              密码视图两态并存，保留 Email or phone number */}
          <Label htmlFor="login-identifier">
            {smsMode ? "Phone number (China Only)" : "Email or phone number"}
          </Label>
          <Input
            id="login-identifier"
            // 刻意不是 type="email"：浏览器会拦掉手机号（design §7.2）
            type="text"
            autoComplete="username"
            // 邮箱地址上限（RFC 5321 的 254）；手机号在验证码视图另有 11 位清洗
            maxLength={254}
            value={identifier}
            onChange={(e) => {
              // 验证码视图只收手机号（邮箱分支不存在）：就地清洗成 ≤11 位数字，
              // 字母/超长不再留到提交才报错；密码视图同一个框收邮箱，不能清洗。
              const next = smsMode ? toNationalDigits(e.target.value) : e.target.value;
              if (e.target.value !== next) {
                e.target.value = next;
              }
              setIdentifier(next);
              // 改标识即清掉它的内联错误；验证码属于上一个标识，一并作废（码是发给旧号码的）
              setErrors((prev) => ({ ...prev, identifier: undefined }));
              setSmsCodeError(null);
              if (smsMode) {
                setSmsCode("");
              }
            }}
            aria-invalid={errors.identifier !== undefined}
          />
          {errors.identifier ? <p className="text-xs text-destructive">{errors.identifier}</p> : null}
        </div>

        {smsMode ? (
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

        {/* 模式切换与找回入口固定在提交按钮下方：两种模式同一位置、同一文字链接样式 */}
        {smsStatus === "on" ? (
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={smsMode ? closeSmsMode : openSmsMode}
            >
              {smsMode ? "Sign in with password" : "Sign in with SMS code"}
            </button>
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
