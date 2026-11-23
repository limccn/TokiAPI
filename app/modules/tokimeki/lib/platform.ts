// Platform / shell catalog shared by the tokimeki hub wizard and console dialogs.
import type { ShellKind } from "./attach-command";

export type Platform = "windows" | "macos" | "linux";

export const PLATFORM_OPTIONS: ReadonlyArray<{ id: Platform; label: string }> = [
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

export const SHELLS_BY_PLATFORM: Record<Platform, readonly ShellKind[]> = {
  windows: ["pwsh", "powershell", "cmd"],
  macos: ["zsh", "bash"],
  linux: ["bash", "zsh", "fish"],
};

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const text = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (text.includes("win")) return "windows";
  if (text.includes("mac")) return "macos";
  return "linux";
}

export function defaultShell(platform: Platform): ShellKind {
  return SHELLS_BY_PLATFORM[platform][0] ?? "bash";
}
