// 发送短信验证码按钮（11-06-sms-alicloud-auth，design §7.6）。
//
// 登录、注册、找回密码、资料页弹窗五处共用：文案（Sending… / Resend in Ns / Send code）、
// 禁用规则（在途或冷却中）与有效期提示都只在这里改。
// 布局三态：登录/注册/绑定/找回第二步的验证码行用 button（只出按钮，与验证码输入框
// 由调用方拼成一行，不带提示行）；找回第一步没有验证码框可配对，用 stacked（整宽按钮，
// hint={null} 不渲染提示行）；资料页弹窗用 inline（小按钮 + 同行提示）。
import type { ReactNode } from "react";
import { smsCodeValidityMessage } from "@/lib/phone-input";
import { Button } from "./button";

export interface SendCodeButtonProps {
  isSending: boolean;
  cooldownSeconds: number;
  onSend: () => void;
  /**
   * 常驻提示；缺省为「Codes are valid for N minutes.」。冷却中一律改为发送结果，不叠加。
   * 传 `null` 表示不显示提示行（与验证码输入框同排的布局没有提示行的位置）。
   */
  hint?: ReactNode;
  /**
   * 冷却中（= 刚发送成功）的那一句。缺省「Code sent.」。
   * 找回密码页刻意不用它：那里的发送端点在**号码未注册时同样成功**，
   * 「已发送」会给号码登记状态一个 oracle（见该页头注），故该页在验证码行下方
   * 常驻「若已注册，验证码已发出」，按钮只表达 Resend in Ns。
   */
  sentMessage?: ReactNode;
  layout?: "stacked" | "inline" | "button";
}

export function SendCodeButton({
  isSending,
  cooldownSeconds,
  onSend,
  hint,
  sentMessage = "Code sent.",
  layout = "stacked",
}: SendCodeButtonProps) {
  const label = isSending
    ? "Sending…"
    : cooldownSeconds > 0
      ? `Resend in ${cooldownSeconds}s`
      : "Send code";
  // 始终**只占一行**：冷却中显示发送结果，其余显示常驻提示。两者同时出现即为重复。
  // hint 传 null = 不显示提示行（undefined 才落到缺省的有效期文案）。
  const message =
    cooldownSeconds > 0 ? sentMessage : hint === undefined ? smsCodeValidityMessage() : hint;
  const status =
    message === null || message === undefined ? null : (
      <p role={cooldownSeconds > 0 ? "status" : undefined} className="text-xs text-muted-foreground">
        {message}
      </p>
    );

  // 只出按钮：与验证码输入框同排时，提示行没有位置；发送结果由按钮标签（Resend in Ns）表达。
  // 用默认尺寸（h-9）与 Input 等高，保证同一行内上下边缘对齐。
  if (layout === "button") {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={onSend}
        disabled={isSending || cooldownSeconds > 0}
      >
        {label}
      </Button>
    );
  }

  if (layout === "inline") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onSend}
          disabled={isSending || cooldownSeconds > 0}
        >
          {label}
        </Button>
        {status}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onSend}
        disabled={isSending || cooldownSeconds > 0}
      >
        {label}
      </Button>
      {status}
    </div>
  );
}
