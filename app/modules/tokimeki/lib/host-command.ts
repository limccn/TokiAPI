// Host command generation (bash/zsh/fish/pwsh/powershell/cmd).
// Pure functions; no execution, no file writes.
// Env order: relay -> token -> namespace -> session -> session token -> advanced.
import type { ShellKind } from "./attach-command";

/** Data-driven ACP catalog; add entries here to grow the hub without UI changes. */
export const ACP_COMMANDS = [
  { id: "claude", label: "Claude Code", suffix: "tokimeki claude" },
  { id: "pi", label: "pi", suffix: "tokimeki pi" },
  { id: "codex", label: "Codex CLI", suffix: "tokimeki run -- codex" },
  { id: "gemini", label: "Gemini CLI", suffix: "tokimeki run -- gemini" },
  { id: "cursor", label: "Cursor CLI", suffix: "tokimeki run -- cursor" },
  { id: "aider", label: "Aider", suffix: "tokimeki run -- aider" },
  { id: "opencode", label: "OpenCode", suffix: "tokimeki run -- opencode" },
  { id: "goose", label: "Goose", suffix: "tokimeki run -- goose" },
  { id: "amp", label: "Amp", suffix: "tokimeki run -- amp" },
  { id: "custom", label: "Custom TUI command", suffix: "" },
] as const;

export type AgentKind = (typeof ACP_COMMANDS)[number]["id"];
export type HostCommandMode = "env" | "config";

export interface HostCommandInput {
  readonly shell: ShellKind;
  readonly relayUrl: string;
  readonly token: string;
  readonly namespace: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly agent: AgentKind;
  /** Required for `agent=custom`; the raw TUI command after `run --`. */
  readonly customCommand?: string;
  readonly windowSize?: string;
  readonly windowTui?: string;
  /** Optional session passcode (TOKIMEKI_PASSCODE, not the session token). */
  readonly passcode?: string;
  /** `env` (default) writes separate TOKIMEKI_* variables; `config` uses TOKIMEKI_CONFIG. */
  readonly mode?: HostCommandMode;
}

// No `$`, `%`, `!`, `&`, quotes, backticks, or `^`: pwsh/cmd would expand or
// reinterpret them inside the generated command (e.g. `pa$word` in pwsh).
const SAFE_VALUE = /^[-A-Za-z0-9._~:/?#\[\]@*+,;=]+$/u;

function safe(name: string, value: string): string {
  if (!SAFE_VALUE.test(value)) {
    throw new Error(`${name} contains characters that are not safe for shell commands`);
  }
  return value;
}

function commandSuffix(input: HostCommandInput): string {
  if (input.agent === "custom") {
    const raw = input.customCommand?.trim() ?? "";
    if (raw.length === 0) {
      throw new Error("customCommand is required for the custom agent");
    }
    return `tokimeki run -- ${raw}`;
  }
  const entry = ACP_COMMANDS.find((item) => item.id === input.agent);
  if (entry === undefined || entry.suffix.length === 0) {
    throw new Error(`unsupported ACP command: ${String(input.agent)}`);
  }
  return entry.suffix;
}

function hostEntries(input: HostCommandInput): Array<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [
    ["TOKIMEKI_RELAY_URL", safe("relayUrl", input.relayUrl)],
    ["TOKIMEKI_TOKEN", safe("token", input.token)],
    ["TOKIMEKI_NAMESPACE", safe("namespace", input.namespace)],
    ["TOKIMEKI_SESSION", safe("session", input.session)],
    ["TOKIMEKI_SESSION_TOKEN", safe("sessionToken", input.sessionToken)],
  ];
  if (input.passcode !== undefined && input.passcode.length > 0) {
    entries.push(["TOKIMEKI_PASSCODE", safe("passcode", input.passcode)]);
  }
  if (input.windowSize !== undefined && input.windowSize.length > 0) {
    entries.push(["TOKIMEKI_WINDOW_SIZE", safe("windowSize", input.windowSize)]);
  }
  if (input.windowTui !== undefined && input.windowTui.length > 0) {
    entries.push(["TOKIMEKI_WINDOW_TUI", safe("windowTui", input.windowTui)]);
  }
  return entries;
}

// 多行脚本：每行一条语句，最后一行执行命令（2026-11-22 用户裁决；与 attach-command.ts
// 同一格式约定）。逐行粘贴在 bash/zsh/sh/fish/pwsh/powershell/cmd 均可靠。
function envLines(shell: ShellKind, entries: ReadonlyArray<readonly [string, string]>): string[] {
  switch (shell) {
    case "bash":
    case "zsh":
    case "sh":
      return entries.map(([key, value]) => `export ${key}='${value}'`);
    case "fish":
      return entries.map(([key, value]) => `set -gx ${key} '${value}'`);
    case "pwsh":
    case "powershell":
      return entries.map(([key, value]) => `$env:${key}="${value}"`);
    case "cmd":
      return entries.map(([key, value]) => `set "${key}=${value}"`);
  }
}

function renderEnvCommand(
  shell: ShellKind,
  entries: ReadonlyArray<readonly [string, string]>,
  suffix: string,
): string {
  return [...envLines(shell, entries), suffix].join("\n");
}

export type HostConfigInput = Omit<
  HostCommandInput,
  "shell" | "agent" | "customCommand" | "mode"
>;

/** Build the TOKIMEKI_CONFIG JSON envelope (v2) from the host inputs. */
export function buildHostConfigEnvelope(input: HostConfigInput): string {
  const envelope: Record<string, unknown> = {
    v: 2,
    relayUrl: safe("relayUrl", input.relayUrl),
    token: safe("token", input.token),
    namespace: safe("namespace", input.namespace),
    session: safe("session", input.session),
    sessionToken: safe("sessionToken", input.sessionToken),
  };
  if (input.passcode !== undefined && input.passcode.length > 0) {
    envelope.passcode = safe("passcode", input.passcode);
  }
  if (input.windowSize !== undefined && input.windowSize.length > 0) {
    envelope.windowSize = safe("windowSize", input.windowSize);
  }
  if (input.windowTui !== undefined && input.windowTui.length > 0) {
    envelope.windowTui = safe("windowTui", input.windowTui);
  }
  return JSON.stringify(envelope);
}

function renderConfigCommand(
  shell: ShellKind,
  envelope: string,
  suffix: string,
): string {
  // 信封 JSON 本身含双引号，不能走 envLines 的 pwsh 双引号形态：bash/fish/pwsh 用单引号
  // 字面量（SAFE_VALUE 保证字段内无单引号），cmd 靠 set "VAR=…" 首尾引号规则。
  const assign = (() => {
    switch (shell) {
      case "bash":
      case "zsh":
      case "sh":
        return `export TOKIMEKI_CONFIG='${envelope}'`;
      case "fish":
        return `set -gx TOKIMEKI_CONFIG '${envelope}'`;
      case "pwsh":
      case "powershell":
        return `$env:TOKIMEKI_CONFIG='${envelope}'`;
      case "cmd":
        return `set "TOKIMEKI_CONFIG=${envelope}"`;
    }
  })();
  return [assign, suffix].join("\n");
}

export function buildHostCommand(input: HostCommandInput): string {
  const suffix = commandSuffix(input);
  if (input.mode === "config") {
    return renderConfigCommand(input.shell, buildHostConfigEnvelope(input), suffix);
  }
  return renderEnvCommand(input.shell, hostEntries(input), suffix);
}
