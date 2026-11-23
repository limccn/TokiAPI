// Session passcode memory semantics for the web viewer (same-tab refresh keeps the
// value; forgetting keeps the "needs a passcode" flag; codes stay isolated).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetPasscodeValue,
  readRememberedPasscode,
  rememberPasscode,
} from "../app/modules/tokimeki/viewer/passcode-store";

function createStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

describe("passcode-store", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { sessionStorage: createStorage() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty state for an unseen code", () => {
    expect(readRememberedPasscode("code-a")).toEqual({
      value: null,
      needed: false,
    });
  });

  it("remembers a value per code and forgets only the value", () => {
    rememberPasscode("code-a", "123456");
    expect(readRememberedPasscode("code-a")).toEqual({
      value: "123456",
      needed: true,
    });
    forgetPasscodeValue("code-a");
    expect(readRememberedPasscode("code-a")).toEqual({
      value: null,
      needed: true,
    });
  });

  it("keeps codes isolated", () => {
    rememberPasscode("code-a", "111111");
    rememberPasscode("code-b", "222222");
    expect(readRememberedPasscode("code-a").value).toBe("111111");
    expect(readRememberedPasscode("code-b").value).toBe("222222");
  });

  it("no-ops without a window", () => {
    vi.stubGlobal("window", undefined);
    expect(readRememberedPasscode("code-a")).toEqual({
      value: null,
      needed: false,
    });
    expect(() => rememberPasscode("code-a", "123456")).not.toThrow();
    expect(() => forgetPasscodeValue("code-a")).not.toThrow();
  });
});
