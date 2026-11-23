// 分享链接 → CLI attach 命令（bash/zsh/fish/pwsh/powershell/cmd）。
// 纯函数，可单测；不写文件、不执行命令。Session JWT 只存在组件 state 与命令文本中。
import type { InviteMode } from "../types";

export type ShellKind = "bash" | "zsh" | "fish" | "sh" | "pwsh" | "powershell" | "cmd";

export interface AttachCommandInput {
  readonly shell: ShellKind;
  readonly relayUrl: string;
  readonly session: string;
  readonly token: string;
  readonly mode: InviteMode;
  /** Optional TOKIMEKI_PASSCODE for passcode-protected sessions. */
  readonly passcode?: string;
}

// No `$`, `%`, `!`, `&`, quotes, backticks, or `^`: pwsh/cmd would expand or
// reinterpret them inside the generated command.
const SAFE_VALUE = /^[-A-Za-z0-9._~:/?#\[\]@*+,;=]+$/u;

/**
 * True when a value can be embedded in a generated command without shell expansion.
 * Exported so the hub can reject unsafe passcodes before rendering step 3.
 */
export function isSafeCommandValue(value: string): boolean {
  return SAFE_VALUE.test(value);
}

function assertSafe(name: string, value: string): string {
  if (!SAFE_VALUE.test(value)) {
    throw new Error(`${name} contains characters that are not safe for shell commands`);
  }
  return value;
}

// 多行脚本：每行一条语句，最后一行执行命令（2026-11-22 用户裁决）。
// 单行拼接在 pwsh/powershell/cmd 会解析失败或吞参（PS 把命令当表达式、cmd 的 set
// 把后续参数并入变量值），fish 也缺语句分隔符；多行逐行粘贴在三种 shell 均可靠。
// bash/zsh/sh 用 `export` 逐行（不用前缀式 —— 前缀无法与命令分行）。
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

/** Build one command matching the invite mode (viewer attach / listener --listen). */
export function buildAttachCommand(input: AttachCommandInput): string {
  const relayUrl = assertSafe("relayUrl", input.relayUrl);
  const session = assertSafe("session", input.session);
  const token = assertSafe("token", input.token);
  const entries: Array<readonly [string, string]> = [
    ["TOKIMEKI_RELAY_URL", relayUrl],
    ["TOKIMEKI_SESSION", session],
    ["TOKIMEKI_SESSION_TOKEN", token],
  ];
  if (input.passcode !== undefined && input.passcode.length > 0) {
    entries.push(["TOKIMEKI_PASSCODE", assertSafe("passcode", input.passcode)]);
  }
  const suffix = input.mode === "listener" ? "tokimeki attach --listen" : "tokimeki attach";
  return [...envLines(input.shell, entries), suffix].join("\n");
}
