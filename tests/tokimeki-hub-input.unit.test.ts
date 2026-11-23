// Pure helpers for the /tokimeki hub: namespace-prefixed session ids and attach input
// parsing (2026-11-22 tri-task audit, gaps G1/G4).
import { describe, expect, it } from "vitest";
import {
  HOST_SESSION_NAME_PATTERN,
  isValidHostSessionName,
  parseAttachInput,
  resolveHostSessionName,
} from "../app/modules/tokimeki/lib/hub-input";

const CODE = "abcdefghjkmnpqrs";

describe("resolveHostSessionName", () => {
  it("uses the generated slug when no override is given", () => {
    expect(resolveHostSessionName("", "1234", "brave-otter")).toBe(
      "1234.brave-otter",
    );
  });

  it("prefixes bare overrides and keeps already-prefixed ids", () => {
    expect(resolveHostSessionName("my-session", "1234", "brave-otter")).toBe(
      "1234.my-session",
    );
    expect(
      resolveHostSessionName("1234.my-session", "1234", "brave-otter"),
    ).toBe("1234.my-session");
    expect(
      resolveHostSessionName("  my-session  ", "1234", "brave-otter"),
    ).toBe("1234.my-session");
  });

  it("rejects an empty namespace", () => {
    expect(() => resolveHostSessionName("", "", "brave-otter")).toThrow(
      /namespace/u,
    );
  });
});

describe("isValidHostSessionName", () => {
  it("accepts the server shape up to 64 chars and rejects longer/invalid ids", () => {
    expect(isValidHostSessionName("1234.brave-otter")).toBe(true);
    expect(isValidHostSessionName("a".repeat(64))).toBe(true);
    expect(isValidHostSessionName("a".repeat(65))).toBe(false);
    expect(isValidHostSessionName(".leading-dot")).toBe(false);
    expect(isValidHostSessionName("bad space")).toBe(false);
    expect(HOST_SESSION_NAME_PATTERN.test("1234.x")).toBe(true);
  });
});

describe("parseAttachInput", () => {
  it("extracts codes from share URLs and #t- fragments", () => {
    expect(parseAttachInput(`https://gw.example/#t-${CODE}`)).toEqual({
      kind: "link",
      code: CODE,
    });
    expect(parseAttachInput(`#t-${CODE}`)).toEqual({ kind: "link", code: CODE });
  });

  it("accepts a bare invite code", () => {
    expect(parseAttachInput(CODE)).toEqual({ kind: "code", code: CODE });
    expect(parseAttachInput(`  ${CODE}  `)).toEqual({
      kind: "code",
      code: CODE,
    });
  });

  it("falls back to a session id and trims", () => {
    expect(parseAttachInput("  1234.my-session  ")).toEqual({
      kind: "session",
      session: "1234.my-session",
    });
    // 16 chars, but the leading 0 is outside the readable invite alphabet.
    expect(parseAttachInput("0bcdefghjkmnpqrs")).toEqual({
      kind: "session",
      session: "0bcdefghjkmnpqrs",
    });
  });

  it("returns null for empty input", () => {
    expect(parseAttachInput("   ")).toBeNull();
  });
});
