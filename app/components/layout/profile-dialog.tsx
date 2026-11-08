// Profile 弹窗（09-16-account-menu，design §4.2）：自助查看账号资料 + 改 name。
//
// 09-17-password-menu-and-dialog-overflow：**改密区块已迁出**（原内嵌于本弹窗底部），
// 现在是账户菜单里的并列项 + 独立弹窗 —— 见 user-button.tsx 的 ChangePasswordMenuItem
// 与 change-password-dialog.tsx。本弹窗因此显著变矮，矮视口下不再咬着视口两头
// （642px 是改动前在 600px 视口下的实测值；改动后高度见本任务 verification.md）。
//
// 数据源：useProfile()（GET /api/me/profile）—— 一次请求拿到 name/email/emailVerified/验证开关，
// 且是服务端最新值（session 可能因 staleTime 滞后，且 SessionUser 不含 emailVerified）。
//
// name 写入复用 Better Auth 内置 POST /api/auth/update-user（authClient.updateUser）：
//   - 库内部硬拦 email 改动（R5/AC6 是结构性保证，非本组件校验）；
//   - 更新后回写 session cookie → 客户端 session store 自动刷新 → 菜单头部与页面立即显示新值
//     （R8/AC7，无需手动刷新）；
//   - **只发 name**：additionalFields 里的 inviteCode 是 input:true，混发会被 parseUserInput
//     当作可写字段（design §2.2 注意项）。
//
// 邮箱不可改：输入框 readOnly + 旁注（AC5），界面上无任何编辑途径。
// 查询未就绪 / 失败时不渲染可提交表单 —— 避免用空 name 覆盖服务端数据（design §6）。
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { useSmsCodeSender } from "@/hooks/use-sms-code";
import { smsErrorMessage, type SmsErrorLike } from "@/lib/sms-errors";
import {
  INVALID_CODE_MESSAGE,
  INVALID_PHONE_MESSAGE,
  composePhoneNumber,
  toSmsCode,
} from "@/lib/phone-input";
// 直取零依赖的 src/lib/phone.ts（理由见该文件头注：中转模块会拖进首屏）
import { isPlaceholderEmail, maskPhone } from "../../../src/lib/phone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PhoneNumberInput } from "@/components/ui/phone-number-input";
import { SendCodeButton } from "@/components/ui/send-code-button";
import { useProfile } from "@/modules/profile/hooks/use-profile";
import type { Profile } from "@/modules/profile/types";

export interface ProfileDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileDialog({ open, onOpenChange }: ProfileDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Profile"
      description="Your account details."
    >
      {/* 只在打开时挂载内容：关闭态不发起 /api/me/profile 请求，重开即拿最新数据 */}
      {open ? <ProfileContent onClose={() => onOpenChange(false)} /> : null}
    </Dialog>
  );
}

function ProfileContent({ onClose }: { onClose: () => void }) {
  const { data, isPending, isError, refetch } = useProfile();

  if (isPending) {
    return (
      <p className="text-sm text-muted-foreground" aria-busy="true" aria-live="polite">
        Loading your profile…
      </p>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-3">
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          Failed to load your profile. Please try again.
        </p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // 数据就绪后一次性挂载表单：state 初值即服务端最新值（无需 useEffect 回填）
  return <ProfileForm profile={data.profile} onClose={onClose} />;
}

function ProfileForm({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(profile.name);
  const [nameError, setNameError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "pending" | "requested">("idle");
  const [resendError, setResendError] = useState<string | null>(null);

  // ---- 绑定邮箱（11-06-sms-alicloud-auth，PRD R16 / design §13.5）----
  // 只对**占位邮箱**账号开放，且部署开启邮箱验证时才有入口；已绑定真实邮箱的账号本轮不可改绑。
  const [emailBinding, setEmailBinding] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newEmailError, setNewEmailError] = useState<string | null>(null);
  const [emailBindError, setEmailBindError] = useState<string | null>(null);
  const [emailBindStatus, setEmailBindStatus] = useState<"idle" | "pending" | "sent">("idle");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      // AC8：前端拦截，不发送请求
      setNameError("Name cannot be empty");
      return;
    }
    setNameError(null);
    setIsSaving(true);
    try {
      const { error } = await authClient.updateUser({ name: trimmed });
      if (error) {
        setFormError(error.message ?? "Failed to update your name");
        return;
      }
      // session store 已由 better-auth 客户端在 /update-user 后刷新（菜单头部即时更新）；
      // 这里只负责让本弹窗下次打开时拿到新的 profile 快照
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      onClose();
    } catch {
      setFormError("Failed to update your name");
    } finally {
      setIsSaving(false);
    }
  };

  const handleResend = async () => {
    setResendError(null);
    setResendStatus("pending");
    try {
      const { error } = await authClient.sendVerificationEmail({
        email: profile.email,
        callbackURL: "/dashboard",
      });
      if (error) {
        setResendStatus("idle");
        setResendError(error.message ?? "Failed to request a verification email");
        return;
      }
      setResendStatus("requested");
    } catch {
      setResendStatus("idle");
      setResendError("Failed to request a verification email");
    }
  };

  const handleBindEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNewEmailError(null);
    setEmailBindError(null);
    const target = newEmail.trim();
    // 轻量格式判据：真正的校验在服务端（Better Auth changeEmail）；这里只挡明显笔误
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      setNewEmailError("Enter a valid email address");
      return;
    }
    setEmailBindStatus("pending");
    try {
      // 占位邮箱未验证 ⇒ changeEmail 命中 canUpdateWithoutVerification：地址立即写入，
      // 随后发验证信；点击链接后 emailVerified=true（design §13.5）。
      const { error } = await authClient.changeEmail({
        newEmail: target,
        callbackURL: window.location.href,
      });
      if (error) {
        setEmailBindStatus("idle");
        setEmailBindError(error.message ?? "Failed to send the verification email");
        return;
      }
      setEmailBindStatus("sent");
      setEmailBinding(false);
      // 地址已即时写入：重取 profile，让邮箱行从 Not set 切到新地址（未验证）
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    } catch {
      setEmailBindStatus("idle");
      setEmailBindError("Failed to send the verification email");
    }
  };

  // 判据取后端同一份零依赖函数（后缀 `@phone.invalid`）：新旧占位邮箱格式同时命中。
  // 不在前端另写正则 —— 格式升级时两处必然漂移（design §13.2）。
  const placeholderEmail = isPlaceholderEmail(profile.email);

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-3" noValidate>
        {formError ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {formError}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="profile-name">Name</Label>
          <div className="flex items-center gap-2">
            <Input
              id="profile-name"
              autoComplete="name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              aria-invalid={nameError !== null}
              aria-describedby={nameError !== null ? "profile-name-error" : undefined}
            />
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </div>
          {nameError !== null ? (
            <p id="profile-name-error" className="text-xs text-destructive">
              {nameError}
            </p>
          ) : null}
        </div>
      </form>

      <div className="space-y-2">
        <Label htmlFor="profile-email">Email</Label>
        <Input
          id="profile-email"
          // 手机号注册的账号没有真实邮箱：显示 `Not set`，而不是把内部占位地址亮给用户
          // （11-06-sms-alicloud-auth，PRD R18 / design §7.5）
          value={placeholderEmail ? "Not set" : profile.email}
          readOnly
          className="bg-muted text-muted-foreground"
          aria-describedby={
            !placeholderEmail || !emailBinding ? "profile-email-note" : undefined
          }
        />
        {placeholderEmail ? (
          profile.smsAuthEnabled && profile.emailVerificationEnabled ? (
            emailBinding ? (
              <form onSubmit={handleBindEmail} className="space-y-2" noValidate>
                {emailBindError !== null ? (
                  <p role="alert" className="text-xs text-destructive">
                    {emailBindError}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Input
                    id="profile-new-email"
                    type="email"
                    autoComplete="email"
                    // 邮箱地址上限（RFC 5321 的 254）
                    maxLength={254}
                    placeholder="you@example.com"
                    value={newEmail}
                    onChange={(event) => {
                      setNewEmail(event.target.value);
                      setNewEmailError(null);
                    }}
                    aria-label="Email address"
                    aria-invalid={newEmailError !== null}
                    // 窄视口独占一行（三个控件挤一行会把输入框压到 150px 以下），
                    // 宽视口回到「输入框 + 两个按钮」同一行
                    className="min-w-0 flex-1 basis-full sm:basis-0"
                  />
                  <Button type="submit" size="sm" disabled={emailBindStatus === "pending"}>
                    {emailBindStatus === "pending" ? "Sending…" : "Bind email"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEmailBinding(false);
                      setNewEmailError(null);
                      setEmailBindError(null);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
                {newEmailError !== null ? (
                  <p className="text-xs text-destructive">{newEmailError}</p>
                ) : null}
              </form>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <p id="profile-email-note" className="text-xs text-muted-foreground">
                  This account signs in with a phone number. Add an email to receive notifications
                  and recover access.
                </p>
                <Button variant="outline" size="sm" onClick={() => setEmailBinding(true)}>
                  Bind email
                </Button>
              </div>
            )
          ) : (
            <p id="profile-email-note" className="text-xs text-muted-foreground">
              This account signs in with a phone number. Email binding is not enabled on this
              deployment.
            </p>
          )
        ) : (
          <p id="profile-email-note" className="text-xs text-muted-foreground">
            Email cannot be changed.
          </p>
        )}
        {emailBindStatus === "sent" ? (
          // 只在服务端确认 changeEmail 成功后出现；验证完成前新地址仍是「未验证」。
          <p role="status" className="text-xs text-muted-foreground">
            Verification email sent to {newEmail}. Open the link in that email to finish linking it.
            Check your spam folder if it does not arrive within a few minutes.
          </p>
        ) : null}
      </div>

      {/* 占位邮箱整块不渲染：既没有可发的地址，也不该对「从未提供过的邮箱」催验证。
          开关关闭 + 未验证的普通账号仍走原分支（R6/R7/AC9）。 */}
      {placeholderEmail ? null : (
        <div className="space-y-2">
          <p className="text-sm font-medium leading-none">Email verification</p>
          <div className="flex flex-wrap items-center gap-2">
            {profile.emailVerified ? (
              <Badge variant="success">Verified</Badge>
            ) : (
              <Badge variant="muted">Not verified</Badge>
            )}
            {/* R6/R7/AC9：只有「未验证 + 开关开启」才出现操作入口；开关关闭时仅静默展示状态 */}
            {!profile.emailVerified && profile.emailVerificationEnabled ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleResend()}
                disabled={resendStatus === "pending"}
              >
                {resendStatus === "pending" ? "Requesting…" : "Resend verification email"}
              </Button>
            ) : null}
          </div>
          {resendError !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {resendError}
            </p>
          ) : null}
          {resendStatus === "requested" ? (
            // 文案诚实性（design §5 前端文案）：这句只在服务端**真把信交给 Resend** 时出现 ——
            // 交互式路径的发送失败会由 better-auth 上抛成非 2xx（走上面的 resendError 分支），
            // 不会落到这里。故不得写「可能没发」这类含糊措辞，只说发送结果与后续动作。
            <p role="status" className="text-xs text-muted-foreground">
              Verification email sent to {profile.email}. Check your spam folder if it does not
              arrive within a few minutes.
            </p>
          ) : null}
        </div>
      )}

      <PhoneSection profile={profile} />
      <GithubSection profile={profile} />
    </div>
  );
}

/**
 * 手机号行（11-06-sms-alicloud-auth，design §7.5）。
 *
 * 三种形态，判据全部来自 GET /api/me/profile（**不**另取 /api/config —— 同一个开关
 * 两处下发就有了漂移点）：
 *   ① 已绑定 → 打码展示 + Verified 徽标；
 *   ② 未绑定 + 开关开启 → Bind phone → 号码 + 验证码 → `verify({ updatePhoneNumber: true })`；
 *   ③ 未绑定 + 开关关闭 → 整行不渲染（没有可做之事，留一个永远用不了的入口只会让人点）。
 */
function PhoneSection({ profile }: { profile: Profile }) {
  const queryClient = useQueryClient();
  const [binding, setBinding] = useState(false);
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  // 字段错误内联在各自输入框下方（与 /bind-phone 同一形态），error 只留绑定失败的整段错误
  const [fieldErrors, setFieldErrors] = useState<{ phone?: string; code?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const smsSender = useSmsCodeSender();

  if (profile.phoneNumber !== null) {
    return (
      <div className="space-y-2">
        <p className="text-sm font-medium leading-none">Phone number</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm">{maskPhone(profile.phoneNumber)}</span>
          {profile.phoneNumberVerified ? (
            <Badge variant="success">Verified</Badge>
          ) : (
            <Badge variant="muted">Not verified</Badge>
          )}
        </div>
      </div>
    );
  }

  if (!profile.smsAuthEnabled) {
    return null;
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

  const handleBind = async (event: FormEvent<HTMLFormElement>) => {
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
      const { error: verifyError } = await authClient.phoneNumber.verify({
        phoneNumber,
        code: trimmedCode,
        updatePhoneNumber: true,
      });
      if (verifyError) {
        setError(smsErrorMessage(verifyError as SmsErrorLike, "profile"));
        return;
      }
      // 绑定成功后让本弹窗重取 profile（已绑定形态 + Verified 徽标由服务端值决定）
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
      setBinding(false);
      setPhone("");
      setCode("");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium leading-none">Phone number</p>
      {binding ? (
        <form onSubmit={handleBind} className="space-y-3">
          {error !== null || smsSender.error !== null ? (
            <p role="alert" className="text-xs text-destructive">
              {error ?? smsSender.error}
            </p>
          ) : null}
          <div className="space-y-1">
            <PhoneNumberInput
              id="profile-phone-input"
              value={phone}
              onValueChange={(digits) => {
                setPhone(digits);
                setFieldErrors((prev) => ({ ...prev, phone: undefined }));
              }}
              aria-label="Phone number"
              aria-invalid={fieldErrors.phone !== undefined}
            />
            {fieldErrors.phone !== undefined ? (
              <p className="text-xs text-destructive">{fieldErrors.phone}</p>
            ) : null}
          </div>
          <div className="space-y-1">
            {/* 发码按钮与验证码输入框同一行（与登录/注册/绑定页一致）；提示行不再出现 */}
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <Input
                  id="profile-phone-code"
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
                  aria-label="Verification code"
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
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" disabled={isSaving}>
                {isSaving ? "Binding…" : "Bind phone"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setBinding(false);
                  setError(null);
                  setFieldErrors({});
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Not set</span>
          <Button variant="outline" size="sm" onClick={() => setBinding(true)}>
            Bind phone
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * GitHub 绑定行（11-06-sms-alicloud-auth，PRD R16 / design §13.3）。
 *
 * 本轮**只做绑定**：已绑定显示状态，不提供解绑入口。
 * 判据是服务端下发的 `githubLinked`（accounts 表 providerId='github' 的存在性）——
 * 前端不得从 session/provider 推导。
 */
function GithubSection({ profile }: { profile: Profile }) {
  const [error, setError] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);

  const handleLink = async () => {
    setError(null);
    setIsLinking(true);
    try {
      const { error: linkError } = await authClient.linkSocial({
        provider: "github",
        callbackURL: `${window.location.origin}/dashboard`,
      });
      if (linkError) {
        setError(linkError.message ?? "Failed to start GitHub linking");
        setIsLinking(false);
      }
      // 成功时浏览器会被重定向到 GitHub，保持 pending 避免按钮闪回可用
    } catch {
      setError("Failed to start GitHub linking");
      setIsLinking(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium leading-none">GitHub</p>
      {profile.githubLinked ? (
        // 与上方 Email verification 段同形：状态只由徽标表达，不再重复一行文字
        <Badge variant="success">Linked</Badge>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Not linked</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleLink()}
            disabled={isLinking}
          >
            {isLinking ? "Redirecting…" : "Link GitHub"}
          </Button>
        </div>
      )}
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
