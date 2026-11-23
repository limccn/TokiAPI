// Wizard-style command block + meta chips.
// 块体照 keys.tsx CopyBlock 的体例（批次 L 用户裁决 + 2026-11-22 tokimeki 用户裁决）：
// copy 按钮**只有图标**、绝对定位在代码块右上角，命令行单行 `overflow-x-auto`
// 水平滚动 —— 竖屏下不再被 break-all 撑出十几行高度。
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";

/** Single-line horizontally-scrollable command block; icon-only Copy floats top-right. */
export function CommandBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  // 卸载时清掉复位定时器，避免离开页面后仍触发 setState（keys.tsx CopyBlock 同款）
  useEffect(
    () => () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    },
    [],
  );

  return (
    <div className="relative rounded-md border bg-muted/40 p-2.5">
      <pre className="overflow-x-auto pr-9 font-mono text-xs leading-relaxed whitespace-pre">
        {value}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copied ? "Copied" : "Copy to clipboard"}
        className="absolute right-1.5 top-1.5 h-7 w-7 text-muted-foreground hover:text-foreground"
        onClick={async () => {
          const ok = await copyToClipboard(value);
          if (!ok) return;
          setCopied(true);
          if (resetTimer.current !== null) {
            window.clearTimeout(resetTimer.current);
          }
          resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}

/** Small meta chip used in wizard result cards and console list cards. */
export function Chip({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
