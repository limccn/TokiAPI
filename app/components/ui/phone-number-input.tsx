// 中国内地手机号输入（11-06-sms-alicloud-auth，PRD R20）。
//
// 静态 `+86` 前缀 + 11 位本地号：前缀是**纯展示**（不是选择器，也不可交互）。
// 注册屏 1、找回密码、/bind-phone、资料页四处的号码输入统一走本组件 ——
// 各自手拼 span 时，高度、圆角、底色和 `min-w-0` 迟早各写各的。
import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { PHONE_COUNTRY_CODE, toNationalDigits } from "@/lib/phone-input";
import { Input } from "./input";

export interface PhoneNumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "value" | "onChange"> {
  /** 已清洗的本地 11 位号码（输入态，不保证合法）。 */
  value: string;
  /** 收到的是清洗后的本地号码，调用方无需再调 toNationalDigits。 */
  onValueChange: (nationalDigits: string) => void;
}

export function PhoneNumberInput({
  value,
  onValueChange,
  className,
  autoComplete = "tel-national",
  ...props
}: PhoneNumberInputProps) {
  return (
    <div className="flex gap-2">
      {/* 不设 aria-hidden：+86 是区域性约束，读屏用户同样需要知道 */}
      <span className="inline-flex h-9 shrink-0 select-none items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
        {PHONE_COUNTRY_CODE}
      </span>
      <Input
        {...props}
        type="tel"
        inputMode="numeric"
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => {
          const next = toNationalDigits(event.target.value);
          // 受控组件陷阱：清洗结果与 value 相同时 React 不重渲染，第 12 位数字/字母
          // 会留在 DOM 里（state 是干净的）。把输入框值直接改回清洗结果。
          if (event.target.value !== next) {
            event.target.value = next;
          }
          onValueChange(next);
        }}
        className={cn("min-w-0", className)}
      />
    </div>
  );
}
