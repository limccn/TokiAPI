// 首次设置密码表单（11-06-sms-alicloud-auth，design §7.5）。
//
// 与 change-password-form.tsx 的分工：
//   - 「已有密码」→ Change password（现行动线，走库的 POST /api/auth/change-password，
//     要当前密码、带 revokeOtherSessions）；
//   - 「没有密码」（手机号注册刚建的号 / 纯 GitHub 号）→ 本表单：**不要求当前密码**
//     （没有可校验的东西），走自建 `POST /api/me/password`（内部是库的 serverOnly
//     `setPassword`，需要 sensitive session）。
//
// 判据不在本组件里 —— 可点击性与文案由 user-button.tsx 的 PasswordMenuItem 按服务端
// 下发的 `hasPassword` 决定；本组件只在被打开时渲染。
//
// 服务端对「已经有密码」的账号返回 400 `PASSWORD_ALREADY_SET`（不会静默覆盖）——
// 那张映射表在 app/lib/sms-errors.ts，这里不另写一份。
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch } from "@/lib/api";
import { smsErrorMessage } from "@/lib/sms-errors";
// 直取零依赖的属主模块（理由见 src/lib/password.ts 头注）
import { MIN_PASSWORD_LENGTH } from "../../../src/lib/password";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MIN_LENGTH_MESSAGE = `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

interface FieldErrors {
  next: string | null;
  confirm: string | null;
}

const NO_FIELD_ERRORS: FieldErrors = { next: null, confirm: null };

export function SetPasswordForm() {
  const queryClient = useQueryClient();
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>(NO_FIELD_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [succeeded, setSucceeded] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    setSucceeded(false);

    // 一次算全、全部展示（与改密表单同一纪律：不要停在第一条）
    const errors: FieldErrors = {
      next: next.length < MIN_PASSWORD_LENGTH ? MIN_LENGTH_MESSAGE : null,
      confirm: confirm !== next ? "Passwords do not match" : null,
    };
    setFieldErrors(errors);
    if (errors.next !== null || errors.confirm !== null) {
      return;
    }

    setIsSubmitting(true);
    try {
      await apiFetch<{ status: true }>("/api/me/password", {
        method: "POST",
        body: JSON.stringify({ newPassword: next }),
      });
      setNext("");
      setConfirm("");
      setFieldErrors(NO_FIELD_ERRORS);
      setSucceeded(true);
      // 让账户菜单下一次渲染读到 hasPassword=true（「Set password」→「Change password」）
      await queryClient.invalidateQueries({ queryKey: ["profile"] });
    } catch (cause) {
      setFormError(
        cause instanceof ApiError
          ? smsErrorMessage(
              { code: cause.code, message: cause.message, status: cause.status },
              "profile",
            )
          : "Failed to set your password",
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3" noValidate>
      {formError !== null ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <div className="space-y-2">
        <Label htmlFor="profile-set-password">New password</Label>
        <Input
          id="profile-set-password"
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => {
            setNext(event.target.value);
          }}
          aria-invalid={fieldErrors.next !== null}
          aria-describedby={fieldErrors.next !== null ? "profile-set-password-error" : undefined}
        />
        {fieldErrors.next !== null ? (
          <p id="profile-set-password-error" className="text-xs text-destructive">
            {fieldErrors.next}
          </p>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-set-password-confirm">Confirm new password</Label>
        <Input
          id="profile-set-password-confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(event) => {
            setConfirm(event.target.value);
          }}
          aria-invalid={fieldErrors.confirm !== null}
          aria-describedby={
            fieldErrors.confirm !== null ? "profile-set-password-confirm-error" : undefined
          }
        />
        {fieldErrors.confirm !== null ? (
          <p id="profile-set-password-confirm-error" className="text-xs text-destructive">
            {fieldErrors.confirm}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Setting…" : "Set password"}
        </Button>
      </div>

      {succeeded ? (
        // 诚实性：只承诺「这份密码可以用于登录」。标识可能是手机号也可能是邮箱
        //（纯 GitHub 账号同样能走到本表单），不写死「手机号 + 密码」。
        <p role="status" className="text-xs text-muted-foreground">
          Password set. You can now sign in with your password.
        </p>
      ) : null}
    </form>
  );
}
