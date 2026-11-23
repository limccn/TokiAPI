// Mobile keypad byte sequences and latched Ctrl/Alt/Shift handling.
import { describe, expect, it } from "vitest";
import {
  applyModifiersToInput,
  encodeTerminalKey,
  NO_MODIFIERS,
  terminalKeyBytes,
  toggleModifier,
} from "../app/modules/tokimeki/viewer/keymap";

const ctrl = { ...NO_MODIFIERS, ctrl: true };
const alt = { ...NO_MODIFIERS, alt: true };
const shift = { ...NO_MODIFIERS, shift: true };

describe("encodeTerminalKey", () => {
  it("uses the standard control sequences without modifiers", () => {
    expect(encodeTerminalKey("escape")).toBe("\x1b");
    expect(encodeTerminalKey("tab")).toBe("\t");
    expect(encodeTerminalKey("enter")).toBe("\r");
    expect(encodeTerminalKey("backspace")).toBe("\x7f");
    expect(encodeTerminalKey("arrowUp")).toBe("\x1b[A");
    expect(encodeTerminalKey("arrowDown")).toBe("\x1b[B");
    expect(encodeTerminalKey("arrowRight")).toBe("\x1b[C");
    expect(encodeTerminalKey("arrowLeft")).toBe("\x1b[D");
  });

  it("encodes xterm modifier parameters for arrows", () => {
    expect(encodeTerminalKey("arrowUp", shift)).toBe("\x1b[1;2A");
    expect(encodeTerminalKey("arrowRight", alt)).toBe("\x1b[1;3C");
    expect(encodeTerminalKey("arrowLeft", ctrl)).toBe("\x1b[1;5D");
    expect(encodeTerminalKey("arrowDown", { ctrl: true, shift: true, alt: false })).toBe(
      "\x1b[1;6B",
    );
  });

  it("handles Tab, Enter and Backspace modifiers", () => {
    expect(encodeTerminalKey("tab", shift)).toBe("\x1b[Z");
    expect(encodeTerminalKey("tab", alt)).toBe("\x1b\t");
    expect(encodeTerminalKey("enter", alt)).toBe("\x1b\r");
    expect(encodeTerminalKey("backspace", alt)).toBe("\x1b\x7f");
  });

  it("encodes the sequences as UTF-8 bytes", () => {
    expect([...terminalKeyBytes("escape")]).toEqual([0x1b]);
    expect([...terminalKeyBytes("enter")]).toEqual([0x0d]);
    expect([...terminalKeyBytes("tab")]).toEqual([0x09]);
    expect([...terminalKeyBytes("arrowUp", ctrl)]).toEqual([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x41]);
  });
});

describe("applyModifiersToInput", () => {
  it("passes data through when no modifier is latched", () => {
    expect(applyModifiersToInput("a", NO_MODIFIERS)).toBe("a");
    expect(applyModifiersToInput("\x1b[A", NO_MODIFIERS)).toBe("\x1b[A");
    expect(applyModifiersToInput("hello", NO_MODIFIERS)).toBe("hello");
  });

  it("adds modifier parameters to arrow keys", () => {
    expect(applyModifiersToInput("\x1b[A", ctrl)).toBe("\x1b[1;5A");
    expect(applyModifiersToInput("\x1b[D", shift)).toBe("\x1b[1;2D");
  });

  it("maps Ctrl+letter to control codes", () => {
    expect(applyModifiersToInput("c", ctrl)).toBe("\x03");
    expect(applyModifiersToInput("C", ctrl)).toBe("\x03");
    expect(applyModifiersToInput("[", ctrl)).toBe("\x1b");
    expect(applyModifiersToInput("?", ctrl)).toBe("\x7f");
    expect(applyModifiersToInput(" ", ctrl)).toBe("\x00");
  });

  it("prefixes Alt and uppercases Shift input", () => {
    expect(applyModifiersToInput("x", alt)).toBe("\x1bx");
    expect(applyModifiersToInput("a", shift)).toBe("A");
    expect(applyModifiersToInput("a", { ctrl: false, alt: true, shift: true })).toBe("\x1bA");
  });

  it("handles Tab, Enter and Backspace", () => {
    expect(applyModifiersToInput("\t", shift)).toBe("\x1b[Z");
    expect(applyModifiersToInput("\t", alt)).toBe("\x1b\t");
    expect(applyModifiersToInput("\r", alt)).toBe("\x1b\r");
    expect(applyModifiersToInput("\x7f", alt)).toBe("\x1b\x7f");
  });

  it("leaves multi-character input (paste/query replies) untouched", () => {
    expect(applyModifiersToInput("hello", ctrl)).toBe("hello");
    expect(applyModifiersToInput("\x1b[?1;2c", ctrl)).toBe("\x1b[?1;2c");
  });
});

describe("toggleModifier", () => {
  it("latches and releases each modifier independently", () => {
    const withCtrl = toggleModifier(NO_MODIFIERS, "ctrl");
    expect(withCtrl).toEqual({ ctrl: true, alt: false, shift: false });
    expect(toggleModifier(withCtrl, "ctrl")).toEqual(NO_MODIFIERS);
    expect(toggleModifier(toggleModifier(NO_MODIFIERS, "alt"), "shift")).toEqual({
      ctrl: false,
      alt: true,
      shift: true,
    });
  });
});
