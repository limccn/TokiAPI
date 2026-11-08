// /register — 注册页（M6 6.2；11-06-sms-alicloud-auth 第二轮改为手机优先三屏）。
//
// 两种形态由部署开关决定（PRD R15 / R18 / design §13.6）：
//   - SMS_AUTH_ENABLED=true ⇒ 三屏状态机 `step ∈ {phone, account, email}`：
//       ① 邀请码 + 手机（静态 +86 前缀 + 11 位）+ 短信验证码 —— verify 建号并建立会话；
//       ② 用户名 + 密码 + 确认 —— updateUser({name}) → POST /api/me/password；
//       ③ 绑定邮箱（可跳过）—— changeEmail；开关关闭时本屏只剩「继续」。
//   - 开关关闭（含 /api/config 未到达，开源缺省形态）⇒ 保留原邮箱注册表单，零行为变化。
//
// 邀请码准入门：后端 validateUserInfo 对 email-password 与 phone-number 两条注册路径
// 使用**同一套**邀请码语义；客户端预校验（GET /api/invites/validate）也两条路径共用同一份
// 状态机（批次 U，D28–D30）：
//   - 邀请链接 `?invite=CODE` → trim+大写归一后预填；
//   - URL 带码、以及输入框 blur（改码后）→ 预校验；
//   - 服务端 valid:false → `role="alert"` 失效警示 + 禁用提交；重新校验通过即恢复；
//   - 校验请求**本身失败**（429/5xx/网络错）→ fail-open：不警示、不禁用，只给中性提示；
//   - 三态判据**唯一**来源是 inviteCheckGate（app/lib/invite-check.ts），JSX 不另写条件。
//
// 步 1 成功即建号并建立会话 ⇒ 必须避免被「已登录 → /dashboard」重定向截胡：
// 沿用既有 `phoneFlow !== "idle"` 手法（design §13.6 明写改为 `step !== "phone"`，
// 这里额外保留 running 态 —— verify 在途时会话已经可能就绪，只用 step 会在一次 render 里
// 先把用户送走）。流程结束后 step 已是 account/email，重定向自然不再命中。
//
// 各屏失败语义（design §13.6 表格）：
//   - 步 1 失败留在本屏；邀请码错误不得前进；
//   - 步 2 用户名失败留在本屏；**密码失败可跳过**（账号已建、会话已立，资料页可补密码）；
//   - 步 3 发送失败提示重试；Skip 直达 /dashboard。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";
import { authClient } from "@/lib/auth-client";
import { useSession } from "@/hooks/use-session";
import { useMounted } from "@/hooks/use-mounted";
import { useApiConfig } from "@/hooks/use-api-config";
import { useSmsCodeSender } from "@/hooks/use-sms-code";
import { useProfile } from "@/modules/profile/hooks/use-profile";
import { ApiError, apiFetch } from "@/lib/api";
import { inviteCheckGate, type InviteCheckStatus } from "@/lib/invite-check";
import { normalizeInviteCode, toInviteCode } from "@/lib/invite-link";
import { smsErrorMessage, type SmsErrorLike } from "@/lib/sms-errors";
import {
  INVALID_CODE_MESSAGE,
  INVALID_PHONE_MESSAGE,
  composePhoneNumber,
  toSmsCode,
} from "@/lib/phone-input";
import { MIN_PASSWORD_LENGTH } from "../../src/lib/password";
// type-only 导入（完全擦除、零运行时成本）：响应契约与服务端单一真源（spec type-safety.md）
import type { ValidateInviteOutput } from "../../src/routes/invites/types";
import { AuthCard } from "@/components/layout/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneNumberInput } from "@/components/ui/phone-number-input";
import { SendCodeButton } from "@/components/ui/send-code-button";

const registerFormSchema = z.object({
  name: z.string().min(1, "Name is required").max(64, "Name must be 64 characters or fewer"),
  email: z.string().email("Enter a valid email address"),
  // 下限取自唯一真源 src/lib/password.ts（直接导入属主模块 —— 注册页与 profile 契约无关，
  // 经 @/modules/profile/types 取会是一次语义错配的耦合；同 providers.tsx 直取 src/ 的既有模式）。
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
  inviteCode: z.string().min(1, "An invite code is required"),
});

type RegisterForm = z.infer<typeof registerFormSchema>;

/** 三屏注册的当前屏（design §13.6）。 */
type Step = "phone" | "account" | "email";

const phoneStepSchema = z.object({
  inviteCode: z.string().min(1, "An invite code is required"),
  // 输入框只收 11 位本地号码；规范形拼接与最终校验由 composePhoneNumber 完成
  phoneNumber: z.string().regex(/^1[3-9]\d{9}$/, INVALID_PHONE_MESSAGE),
  code: z.string().regex(/^\d{6}$/, INVALID_CODE_MESSAGE),
});

const accountStepSchema = z
  .object({
    name: z.string().min(1, "Name is required").max(64, "Name must be 64 characters or fewer"),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
    confirmPassword: z.string().min(1, "Confirm your password"),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

const bindEmailSchema = z.string().email("Enter a valid email address");

const PASSWORD_FAILURE_NOTICE =
  "Your account was created, but the password couldn't be set. You can skip this step and set a password later from the account menu.";

/** 步 1 的提交状态：`running` 期间不许「已登录 → /dashboard」重定向截胡。 */
type PhoneFlow = "idle" | "running";

const STEP_ITEMS: ReadonlyArray<{ key: Step; label: string }> = [
  { key: "phone", label: "Phone" },
  { key: "account", label: "Account" },
  { key: "email", label: "Email" },
];

function StepIndicator({ current }: { current: Step }) {
  const currentIndex = STEP_ITEMS.findIndex((item) => item.key === current);
  return (
    <ol className="mb-4 flex items-center gap-2" aria-label="Registration steps">
      {STEP_ITEMS.map((item, index) => {
        const active = index === currentIndex;
        const done = index < currentIndex;
        return (
          <li
            key={item.key}
            aria-current={active ? "step" : undefined}
            className="flex flex-1 items-center gap-2"
          >
            <span
              className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
                active
                  ? "bg-primary text-primary-foreground"
                  : done
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground"
              }`}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span
              className={`text-xs ${active ? "font-medium text-foreground" : "text-muted-foreground"}`}
            >
              {item.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function RegisterPage() {
  const isMounted = useMounted();
  const { user } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const config = useApiConfig();
  // 配置未到达时按「关闭」处理 —— 与开源缺省一致的邮箱表单，不会闪出用不了的短信入口
  const smsEnabled = config.data?.smsAuthEnabled === true;

  const [step, setStep] = useState<Step>("phone");
  const [formError, setFormError] = useState<string | null>(null);

  // ---- Email 表单（SMS_AUTH_ENABLED=false 的回落形态，批次 U 起未改动）----
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // 预填：?invite= 归一（trim+大写）后作初值；无该参数时 normalize("") = "" ⇒ 表单现状零回归（AC49）
  const [inviteCode, setInviteCode] = useState(() =>
    normalizeInviteCode(searchParams.get("invite") ?? ""),
  );
  const [errors, setErrors] = useState<Partial<Record<keyof RegisterForm, string>>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  // ---- 步 1：邀请码 + 手机 + 验证码（邀请码与邮箱面共用同一个 state）----
  const [phoneNumber, setPhoneNumber] = useState("");
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneErrors, setPhoneErrors] = useState<{
    inviteCode?: string;
    phoneNumber?: string;
    code?: string;
  }>({});
  const [phoneFlow, setPhoneFlow] = useState<PhoneFlow>("idle");
  const smsSender = useSmsCodeSender();

  // ---- 步 2：用户名 + 密码 ----
  const [accountName, setAccountName] = useState("");
  const [accountPassword, setAccountPassword] = useState("");
  const [accountConfirmPassword, setAccountConfirmPassword] = useState("");
  const [accountErrors, setAccountErrors] = useState<{
    name?: string;
    password?: string;
    confirmPassword?: string;
  }>({});
  const [accountError, setAccountError] = useState<string | null>(null);
  const [passwordFailed, setPasswordFailed] = useState<string | null>(null);
  const [isSavingAccount, setIsSavingAccount] = useState(false);

  // ---- 步 3：绑定邮箱 ----
  const profileQuery = useProfile({ enabled: smsEnabled && step === "email" });
  const [bindEmail, setBindEmail] = useState("");
  const [bindEmailError, setBindEmailError] = useState<string | null>(null);
  const [bindEmailFormError, setBindEmailFormError] = useState<string | null>(null);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailSentTo, setEmailSentTo] = useState<string | null>(null);

  // ---- 邀请码预校验状态机（批次 U，D29；两条注册路径共用）----
  const [inviteCheck, setInviteCheck] = useState<InviteCheckStatus>("unchecked");
  /** 校验序号：改码 / 新一轮校验即递增 —— 乱序回包（旧请求后到）据此作废，不得覆盖新状态。 */
  const checkSeqRef = useRef(0);
  /** 上次拿到**确定结论**（valid/invalid）的码：同码重复 blur 不重发，免得白烧限流额度
   *  （D30：10 次/60s/IP，与登录共享桶）。error 不写入 ⇒ 下次 blur 可重试。 */
  const checkedCodeRef = useRef<string | null>(null);

  const runInviteCheck = useCallback(async (raw: string) => {
    const code = normalizeInviteCode(raw);
    if (code.length === 0) {
      checkSeqRef.current += 1; // 作废在途请求
      checkedCodeRef.current = null;
      setInviteCheck("unchecked");
      return;
    }
    if (code === checkedCodeRef.current) {
      return; // 值未变的重复 blur（已有确定结论）—— 不重发
    }
    const seq = ++checkSeqRef.current;
    setInviteCheck("checking");
    try {
      const result = await apiFetch<ValidateInviteOutput>(
        `/api/invites/validate?code=${encodeURIComponent(code)}`,
      );
      if (seq !== checkSeqRef.current) return; // 已有新一轮校验，丢弃旧回包
      checkedCodeRef.current = code;
      setInviteCheck(result.valid ? "valid" : "invalid");
    } catch {
      if (seq !== checkSeqRef.current) return;
      // fail-open（AC50 第三分支）：429/5xx/网络错 ≠ 码失效 —— 不写 checkedCodeRef，
      // 下次 blur 可重试；中性提示由 gate.showRetryHint 承担。
      setInviteCheck("error");
    }
  }, []);

  // URL 带码 → 打开即校验（AC50 第一分支）。searchParams 由 react-router 按 location.search
  // 记忆化、恒定时不重跑；无 ?invite= 或归一后为空则不发请求（AC49 后半零回归）。
  useEffect(() => {
    const initial = normalizeInviteCode(searchParams.get("invite") ?? "");
    if (initial.length > 0) {
      void runInviteCheck(initial);
    }
  }, [searchParams, runInviteCheck]);

  if (!isMounted) {
    return <div className="min-h-screen" aria-hidden="true" />;
  }
  // 已登录访客（或步 1 verify 在途）不在这里被送走：只有「还在步 1 且流程空闲」才重定向。
  if (user && step === "phone" && phoneFlow === "idle") {
    return <Navigate to="/dashboard" replace />;
  }

  // 三态（警示/禁用/中性提示）的唯一判据 —— JSX 不得另写条件（见文件头）
  const gate = inviteCheckGate(inviteCheck);

  const handleInviteChange = (value: string) => {
    setInviteCode(value);
    // 改码即清理警示态（D29），并作废在途校验与旧结论
    checkSeqRef.current += 1;
    checkedCodeRef.current = null;
    setInviteCheck("unchecked");
  };

  /** 邀请码输入（两条注册路径共用）：先清洗成 ≤10 位字母数字，再走状态机。 */
  const handleInviteInput = (event: ChangeEvent<HTMLInputElement>) => {
    const next = toInviteCode(event.target.value);
    // 受控组件纪律（见 app/lib/invite-link.ts toInviteCode）：清洗无变化时 React 不重渲染，
    // 空格/连字符/第 11 位会留在 DOM，故把输入框值改回清洗结果。
    if (event.target.value !== next) {
      event.target.value = next;
    }
    handleInviteChange(next);
  };

  // ---- 邮箱注册（sms 开关关闭时）----
  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const parsed = registerFormSchema.safeParse({ name, email, password, inviteCode });
    if (!parsed.success) {
      const next: Partial<Record<keyof RegisterForm, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof RegisterForm;
        if (key !== undefined && next[key] === undefined) {
          next[key] = issue.message;
        }
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setIsSubmitting(true);
    try {
      const { error } = await authClient.signUp.email({
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.name,
        ...(parsed.data.inviteCode.length > 0 ? { inviteCode: parsed.data.inviteCode } : {}),
      });
      if (error) {
        setFormError(error.message ?? "Registration failed");
        return;
      }
      navigate("/dashboard", { replace: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  // ---- 步 1 ----
  const handleSendCode = async () => {
    // 发送前清掉上一轮的表单级错误（邀请码/验证码失败）—— 否则两条 alert 并排，
    // 上面那条描述的动作已经过去
    setFormError(null);
    const phone = composePhoneNumber(phoneNumber);
    if (phone === null) {
      setPhoneErrors((prev) => ({ ...prev, phoneNumber: INVALID_PHONE_MESSAGE }));
      return;
    }
    setPhoneErrors((prev) => ({ ...prev, phoneNumber: undefined }));
    await smsSender.send(phone);
  };

  const handlePhoneSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const parsed = phoneStepSchema.safeParse({
      inviteCode,
      phoneNumber,
      code: phoneCode,
    });
    if (!parsed.success) {
      const next: typeof phoneErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof phoneErrors;
        if (key !== undefined && next[key] === undefined) {
          next[key] = issue.message;
        }
      }
      setPhoneErrors(next);
      return;
    }
    const phone = composePhoneNumber(parsed.data.phoneNumber);
    if (phone === null) {
      setPhoneErrors({ phoneNumber: INVALID_PHONE_MESSAGE });
      return;
    }
    setPhoneErrors({});
    setIsSubmitting(true);
    setPhoneFlow("running");
    try {
      // 步 1：建号 + 建会话。inviteCode 是 additionalFields 里的 input:true 字段，
      // 经 body 透传到 validateUserInfo（客户端 types 不认识它，故用 spread 绕过多余属性检查）。
      const { error } = await authClient.phoneNumber.verify({
        phoneNumber: phone,
        code: parsed.data.code.trim(),
        ...(normalizeInviteCode(parsed.data.inviteCode).length > 0
          ? { inviteCode: normalizeInviteCode(parsed.data.inviteCode) }
          : {}),
      });
      if (error) {
        // 失败留在本屏（含邀请码错误）：会话未建立，不能前进
        setFormError(smsErrorMessage(error as SmsErrorLike, "register"));
        return;
      }
      setFormError(null);
      setStep("account");
    } finally {
      setIsSubmitting(false);
      setPhoneFlow("idle");
    }
  };

  // ---- 步 2 ----
  const handleAccountSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccountError(null);
    setPasswordFailed(null);
    const parsed = accountStepSchema.safeParse({
      name: accountName,
      password: accountPassword,
      confirmPassword: accountConfirmPassword,
    });
    if (!parsed.success) {
      const next: typeof accountErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof typeof accountErrors;
        if (key !== undefined && next[key] === undefined) {
          next[key] = issue.message;
        }
      }
      setAccountErrors(next);
      return;
    }
    setAccountErrors({});
    setIsSavingAccount(true);
    try {
      // 用户名写入走 Better Auth 内置端点（只发 name，避免 additionalFields 被误判为可写）
      const { error } = await authClient.updateUser({ name: parsed.data.name.trim() });
      if (error) {
        setAccountError(error.message ?? "Failed to save your name");
        return; // 用户名失败：留在本屏
      }
      try {
        // 密码设置走本仓端点（phone-number 插件不含 serverOnly 的 setPassword）
        await apiFetch("/api/me/password", {
          method: "POST",
          body: JSON.stringify({ newPassword: parsed.data.password }),
        });
      } catch (cause) {
        // 该号码其实已是注册用户（verify 走的是登录分支）—— 密码本来就在，
        // 用户此刻已登录，直接进入第三屏即可，不该谎报「密码没设上」。
        if (cause instanceof ApiError && cause.code === "PASSWORD_ALREADY_SET") {
          setStep("email");
          return;
        }
        // 账号已建立：提示 + 允许跳过（design §13.6）
        setPasswordFailed(PASSWORD_FAILURE_NOTICE);
        return;
      }
      setStep("email");
    } finally {
      setIsSavingAccount(false);
    }
  };

  // ---- 步 3 ----
  const handleBindEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBindEmailError(null);
    setBindEmailFormError(null);
    const parsed = bindEmailSchema.safeParse(bindEmail.trim());
    if (!parsed.success) {
      setBindEmailError(parsed.error.issues[0]?.message ?? "Enter a valid email address");
      return;
    }
    setIsSendingEmail(true);
    try {
      // changeEmail 的并更语义见 design §13.5：占位邮箱（emailVerified=false）命中
      // canUpdateWithoutVerification ⇒ 新地址立即写入，随后发验证信；点击链接后
      // emailVerified=true 并发放既有邮箱验证赠金。
      const { error } = await authClient.changeEmail({
        newEmail: parsed.data,
        callbackURL: `${window.location.origin}/dashboard`,
      });
      if (error) {
        setBindEmailFormError(error.message ?? "Failed to send the verification email");
        return;
      }
      setEmailSentTo(parsed.data);
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    } finally {
      setIsSendingEmail(false);
    }
  };

  const emailVerificationEnabled = profileQuery.data?.profile.emailVerificationEnabled === true;
  const profileUnavailable = profileQuery.isError || profileQuery.data === undefined;
  // 表单级错误只有一条：提交失败（formError）与发码失败（smsSender.error）落在同一位置，
  // 与登录页同一写法；两者不会同屏有意义（提交开始时 formError 已清空）。
  // 发码错误只属于步 1 —— hook 状态跨屏存活，进到第 2/3 屏后不能再翻出来。
  const pageError = step === "phone" ? (formError ?? smsSender.error) : formError;

  return (
    <AuthCard
      title="Create your account"
      description={
        smsEnabled && step !== "phone"
          ? step === "account"
            ? "Set up your name and password"
            : "Add an email address (optional)"
          : "You need an invite code to join this gateway"
      }
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      {smsEnabled ? <StepIndicator current={step} /> : null}

      {pageError ? (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {pageError}
        </p>
      ) : null}

      {smsEnabled && step === "phone" ? (
        <form onSubmit={handlePhoneSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            {/* 占位符须与 src/lib/invites.ts generateInviteCode 一致：10 位大写字母数字、无连字符。 */}
            <Label htmlFor="register-phone-invite">Invite code</Label>
            <Input
              id="register-phone-invite"
              placeholder="10-character invite code"
              value={inviteCode}
              onChange={handleInviteInput}
              onBlur={() => {
                void runInviteCheck(inviteCode);
              }}
              aria-invalid={phoneErrors.inviteCode !== undefined || gate.showInvalidAlert}
            />
            {phoneErrors.inviteCode ? (
              <p className="text-xs text-destructive">{phoneErrors.inviteCode}</p>
            ) : null}
            {gate.showInvalidAlert ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Invalid, used or expired invite code — ask an admin for a new one.
              </p>
            ) : gate.showRetryHint ? (
              <p className="text-xs text-muted-foreground">
                We couldn&apos;t verify this invite code right now — it will be checked again when you
                submit.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="register-phone-number">Phone number (China Only)</Label>
            <PhoneNumberInput
              id="register-phone-number"
              value={phoneNumber}
              onValueChange={setPhoneNumber}
              aria-invalid={phoneErrors.phoneNumber !== undefined}
            />
            {phoneErrors.phoneNumber !== undefined ? (
              <p className="text-xs text-destructive">{phoneErrors.phoneNumber}</p>
            ) : null}
          </div>

          {/* 发码按钮与验证码输入框同一行（与登录验证码视图一致）；
              提示行不再出现 —— 按钮标签本身（Resend in Ns）已表达发送结果 */}
          <div className="space-y-2">
            <Label htmlFor="register-phone-code">Verification code</Label>
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-2">
                <Input
                  id="register-phone-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  // 不加 maxLength：浏览器先截原始文本会在清洗前丢掉粘贴里的位数，截断交给 toSmsCode
                  placeholder="6-digit code"
                  value={phoneCode}
                  onChange={(event) => {
                    const next = toSmsCode(event.target.value);
                    if (event.target.value !== next) {
                      event.target.value = next;
                    }
                    setPhoneCode(next);
                  }}
                  aria-invalid={phoneErrors.code !== undefined}
                />
                {phoneErrors.code !== undefined ? (
                  <p className="text-xs text-destructive">{phoneErrors.code}</p>
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

          <Button type="submit" className="w-full" disabled={isSubmitting || gate.blockSubmit}>
            {isSubmitting ? "Creating account…" : "Create account"}
          </Button>
        </form>
      ) : null}

      {smsEnabled && step === "account" ? (
        <form onSubmit={handleAccountSubmit} className="space-y-4" noValidate>
          {accountError !== null ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {accountError}
            </p>
          ) : null}
          {passwordFailed !== null ? (
            <div className="space-y-2">
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {passwordFailed}
              </p>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setPasswordFailed(null);
                  setStep("email");
                }}
              >
                Skip for now
              </Button>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="register-account-name">Name</Label>
            <Input
              id="register-account-name"
              autoComplete="name"
              // 与 accountStepSchema 的 max(64) 同口径：超长在输入态就拦住，不留到提交才报错
              maxLength={64}
              placeholder="Ada Lovelace"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              aria-invalid={accountErrors.name !== undefined}
            />
            {accountErrors.name !== undefined ? (
              <p className="text-xs text-destructive">{accountErrors.name}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="register-account-password">Password</Label>
            <Input
              id="register-account-password"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              value={accountPassword}
              onChange={(event) => setAccountPassword(event.target.value)}
              aria-invalid={accountErrors.password !== undefined}
            />
            {accountErrors.password !== undefined ? (
              <p className="text-xs text-destructive">{accountErrors.password}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="register-account-confirm">Confirm password</Label>
            <Input
              id="register-account-confirm"
              type="password"
              autoComplete="new-password"
              value={accountConfirmPassword}
              onChange={(event) => setAccountConfirmPassword(event.target.value)}
              aria-invalid={accountErrors.confirmPassword !== undefined}
            />
            {accountErrors.confirmPassword !== undefined ? (
              <p className="text-xs text-destructive">{accountErrors.confirmPassword}</p>
            ) : null}
          </div>

          <Button type="submit" className="w-full" disabled={isSavingAccount}>
            {isSavingAccount ? "Saving…" : "Continue"}
          </Button>
        </form>
      ) : null}

      {smsEnabled && step === "email" ? (
        <div className="space-y-4">
          {emailSentTo !== null ? (
            <>
              <p role="status" className="text-sm text-muted-foreground">
                Verification email sent to {emailSentTo}. Open the link in that email to finish
                linking it. Check your spam folder if it does not arrive within a few minutes.
              </p>
              <Button
                type="button"
                className="w-full"
                onClick={() => navigate("/dashboard", { replace: true })}
              >
                Continue to dashboard
              </Button>
            </>
          ) : profileQuery.isPending && smsEnabled ? (
            <p className="text-sm text-muted-foreground" aria-busy="true">
              Loading your account settings…
            </p>
          ) : (
            <>
              {profileUnavailable ? (
                <p className="text-sm text-muted-foreground">
                  We couldn&apos;t check the email settings for this deployment. You can add an email
                  later from your profile.
                </p>
              ) : emailVerificationEnabled ? (
                <form onSubmit={handleBindEmail} className="space-y-2" noValidate>
                  {bindEmailFormError !== null ? (
                    <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                      {bindEmailFormError}
                    </p>
                  ) : null}
                  <div className="space-y-2">
                    <Label htmlFor="register-bind-email">Email address</Label>
                    <Input
                      id="register-bind-email"
                      type="email"
                      autoComplete="email"
                      // 邮箱地址上限（RFC 5321 的 254）
                      maxLength={254}
                      placeholder="you@example.com"
                      value={bindEmail}
                      onChange={(event) => {
                        setBindEmail(event.target.value);
                        setBindEmailError(null);
                      }}
                      aria-invalid={bindEmailError !== null}
                    />
                    {bindEmailError !== null ? (
                      <p className="text-xs text-destructive">{bindEmailError}</p>
                    ) : null}
                  </div>
                  <Button type="submit" className="w-full" disabled={isSendingEmail}>
                    {isSendingEmail ? "Sending…" : "Send verification email"}
                  </Button>
                </form>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Email verification is not enabled on this deployment. You can add an email later
                  from your profile if that changes.
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => navigate("/dashboard", { replace: true })}
              >
                Skip for now
              </Button>
            </>
          )}
        </div>
      ) : null}

      {!smsEnabled ? (
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="register-name">Name</Label>
            <Input
              id="register-name"
              autoComplete="name"
              // 与 registerFormSchema 的 max(64) 同口径
              maxLength={64}
              placeholder="Ada Lovelace"
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={errors.name !== undefined}
            />
            {errors.name ? <p className="text-xs text-destructive">{errors.name}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="register-email">Email</Label>
            <Input
              id="register-email"
              type="email"
              autoComplete="email"
              // 邮箱地址上限（RFC 5321 的 254）
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={errors.email !== undefined}
            />
            {errors.email ? <p className="text-xs text-destructive">{errors.email}</p> : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="register-password">Password</Label>
            <Input
              id="register-password"
              type="password"
              autoComplete="new-password"
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={errors.password !== undefined}
            />
            {errors.password ? <p className="text-xs text-destructive">{errors.password}</p> : null}
          </div>
          <div className="space-y-2">
            {/* 占位符须与 src/lib/invites.ts generateInviteCode 一致：10 位大写字母数字、无连字符。 */}
            <Label htmlFor="register-invite">Invite code</Label>
            <Input
              id="register-invite"
              placeholder="10-character invite code"
              value={inviteCode}
              onChange={handleInviteInput}
              onBlur={() => {
                // 手输/改码 blur → 预校验（D29 闭环的第二条触发路径；空码内部归位 unchecked）
                void runInviteCheck(inviteCode);
              }}
              aria-invalid={errors.inviteCode !== undefined || gate.showInvalidAlert}
            />
            {errors.inviteCode ? <p className="text-xs text-destructive">{errors.inviteCode}</p> : null}
            {/* 失效警示：仅服务端 valid:false 出现（role="alert" 是 AC50 的画面判据）。
                与表单顶部的 formError 同为 alert —— 两条同时出现时都是真警报，不构成歧义。 */}
            {gate.showInvalidAlert ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                Invalid, used or expired invite code — ask an admin for a new one.
              </p>
            ) : gate.showRetryHint ? (
              // 中性提示：**刻意不是** role="alert"、不带失效措辞 —— 网络故障 ≠ 码失效（AC50 第三分支）
              <p className="text-xs text-muted-foreground">
                We couldn&apos;t verify this invite code right now — it will be checked again when you
                submit.
              </p>
            ) : null}
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting || gate.blockSubmit}>
            {isSubmitting ? "Creating account…" : "Create account"}
          </Button>
        </form>
      ) : null}
    </AuthCard>
  );
}
