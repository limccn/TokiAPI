// 移动端自定义按键栏使用的终端字节序列与组合键处理。
// 纯数据/逻辑，无 DOM/React 依赖，可单测。
export type TerminalKeyId =
  | "escape"
  | "tab"
  | "enter"
  | "backspace"
  | "arrowUp"
  | "arrowDown"
  | "arrowLeft"
  | "arrowRight";

export interface ModifierState {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export type ModifierId = keyof ModifierState;

export const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false, shift: false };

export function toggleModifier(state: ModifierState, id: ModifierId): ModifierState {
  return { ...state, [id]: !state[id] };
}

const ARROW_LETTERS: Readonly<Record<string, string>> = {
  arrowUp: "A",
  arrowDown: "B",
  arrowRight: "C",
  arrowLeft: "D",
};

/** xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4). */
function modifierParameter(modifiers: ModifierState): number {
  return 1 + (modifiers.shift ? 1 : 0) + (modifiers.alt ? 2 : 0) + (modifiers.ctrl ? 4 : 0);
}

/** Encode a keypad key with the currently latched modifiers. */
export function encodeTerminalKey(
  id: TerminalKeyId,
  modifiers: ModifierState = NO_MODIFIERS,
): string {
  if (id === "escape") return "\x1b";
  if (id === "tab") {
    if (modifiers.shift) return "\x1b[Z"; // backtab
    return modifiers.alt ? "\x1b\t" : "\t";
  }
  if (id === "enter") return modifiers.alt ? "\x1b\r" : "\r";
  if (id === "backspace") return modifiers.alt ? "\x1b\x7f" : "\x7f";
  const letter = ARROW_LETTERS[id];
  if (letter === undefined) return "";
  const parameter = modifierParameter(modifiers);
  return parameter === 1 ? `\x1b[${letter}` : `\x1b[1;${parameter}${letter}`;
}

export function terminalKeyBytes(
  id: TerminalKeyId,
  modifiers: ModifierState = NO_MODIFIERS,
): Uint8Array {
  return new TextEncoder().encode(encodeTerminalKey(id, modifiers));
}

function applyCtrl(char: string): string | null {
  if (char === " ") return "\x00";
  if (char === "?") return "\x7f";
  const code = char.toUpperCase().charCodeAt(0);
  // '@'..'_' map to NUL..US; A..Z map to 1..26.
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return null;
}

/**
 * Emulate latched Ctrl/Alt/Shift for input coming from the native keyboard.
 *
 * Only single-character input and the common special keys are transformed.
 * Multi-character data (bracketed paste, terminal query replies) passes through
 * untouched so a latched modifier cannot corrupt it.
 */
export function applyModifiersToInput(data: string, modifiers: ModifierState): string {
  if (!modifiers.ctrl && !modifiers.alt && !modifiers.shift) return data;

  const arrow = /^\x1b\[([ABCD])$/.exec(data);
  if (arrow !== null) {
    const parameter = modifierParameter(modifiers);
    return parameter === 1 ? data : `\x1b[1;${parameter}${arrow[1]}`;
  }
  if (data === "\t") {
    if (modifiers.shift) return "\x1b[Z";
    return modifiers.alt ? "\x1b\t" : data;
  }
  if (data === "\r") return modifiers.alt ? "\x1b\r" : data;
  if (data === "\x7f") return modifiers.alt ? "\x1b\x7f" : data;
  if (data.length !== 1) return data;

  let char = data;
  if (modifiers.ctrl) {
    const mapped = applyCtrl(char);
    if (mapped !== null) char = mapped;
  } else if (modifiers.shift) {
    char = char.toUpperCase();
  }
  if (modifiers.alt) char = "\x1b" + char;
  return char;
}
