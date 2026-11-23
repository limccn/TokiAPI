// Wizard-style mini segment control (login-page segment language, compact form).
// aria-pressed buttons on a muted track; active segment is a raised card.
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface MiniSegmentProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  options: ReadonlyArray<{ id: T; label: ReactNode }>;
  /** Block layout: segments stretch full width (used inside dialogs). */
  block?: boolean;
}

export function MiniSegment<T extends string>({
  value,
  onChange,
  ariaLabel,
  options,
  block = false,
}: MiniSegmentProps<T>) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex gap-1 rounded-lg bg-muted p-0.5",
        block && "flex w-full [&>button]:flex-1",
      )}
    >
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded-md px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            block && "px-3 py-1.5 text-sm",
            value === option.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
