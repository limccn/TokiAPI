// 中国内地手机号输入（11-06-sms-alicloud-auth，PRD R20）。
//
// 缺省形态 = 静态 `+86` 前缀 + 11 位本地号：前缀是**纯展示**（不是选择器，也不可交互）。
// 注册屏 1、找回密码、/bind-phone、资料页四处的号码输入统一走本组件 ——
// 各自手拼 span 时，高度、圆角、底色和 `min-w-0` 迟早各写各的。
//
// `withCountrySelector`（11-08 R9 / design §13.3）是登录页专用例外：Email / Phone 分段控件
// 旁的号码框把前缀渲染成原生 Select，让「选 Phone」这一段在视觉上可辨认。选项目前只有
// +86（PRD R20 不提供多国家码），Select 只是占位形态 —— 未来扩国家码从这里改，不另建组件。
import type { InputHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { PHONE_COUNTRY_CODE, toNationalDigits } from "@/lib/phone-input";
import { Input } from "./input";
import { Select } from "./select";

export interface PhoneNumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "inputMode" | "value" | "onChange"> {
  /** 已清洗的本地 11 位号码（输入态，不保证合法）。 */
  value: string;
  /** 收到的是清洗后的本地号码，调用方无需再调 toNationalDigits。 */
  onValueChange: (nationalDigits: string) => void;
  /** 把 `+86` 前缀渲染成原生 Select（缺省 false = 静态前缀）。登录页分段控件用。 */
  withCountrySelector?: boolean;
}

export function PhoneNumberInput({
  value,
  onValueChange,
  className,
  autoComplete = "tel-national",
  withCountrySelector = false,
  ...props
}: PhoneNumberInputProps) {
  return (
    <div className="flex gap-2">
      {withCountrySelector ? (
        <div className="relative shrink-0">
          <Select
            aria-label="Country code"
            // 受控常量：目前只有 +86，故 onChange 是空实现。写成非受控或省掉 onChange
            // 会触发 React 的只读字段警告（value 有值但无变更处理）。
            value={PHONE_COUNTRY_CODE}
            onChange={() => {
              // 单一选项，无需处理；扩国家码时在此同步输入清洗规则。
            }}
            className="w-[4.5rem] pr-7"
          >
            <option value={PHONE_COUNTRY_CODE}>{PHONE_COUNTRY_CODE}</option>
          </Select>
          {/* 原生 select 的箭头被 `appearance-none` 去掉了；不补一个，这个控件读起来
              就像静态前缀（与左侧无交互的 +86 同形）。箭头纯装饰，点击穿透到 select。 */}
          <ChevronDown
            className="pointer-events-none absolute right-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
        </div>
      ) : (
        // 不设 aria-hidden：+86 是区域性约束，读屏用户同样需要知道
        <span className="inline-flex h-9 shrink-0 select-none items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
          {PHONE_COUNTRY_CODE}
        </span>
      )}
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
