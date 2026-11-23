// TokiAPI hub/attach command generation and session access code tests.
import { describe, expect, it } from "vitest";
import { buildAttachCommand, isSafeCommandValue } from "../app/modules/tokimeki/lib/attach-command";
import {
  buildHostCommand,
  buildHostConfigEnvelope,
} from "../app/modules/tokimeki/lib/host-command";
import {
  generatePasscode,
  generateSessionToken,
  isValidPasscode,
  isValidSessionToken,
} from "../app/modules/tokimeki/lib/session-token";
import {
  generateWordSlug,
  SLUG_ADJECTIVES,
  SLUG_ANIMALS,
} from "../src/lib/word-slug";

const RELAY = "wss://relay.example";
const TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiI0MiJ9.sig";

const BASE = {
  relayUrl: RELAY,
  token: TOKEN,
  namespace: "abcde",
  session: "abcde.brave-otter",
  sessionToken: "1234567",
  agent: "claude",
} as const;

describe("buildHostCommand", () => {
  it("emits bash env in the documented order and one agent command", () => {
    expect(buildHostCommand({ ...BASE, shell: "bash" })).toBe(
      [
        `export TOKIMEKI_RELAY_URL='${RELAY}'`,
        `export TOKIMEKI_TOKEN='${TOKEN}'`,
        "export TOKIMEKI_NAMESPACE='abcde'",
        "export TOKIMEKI_SESSION='abcde.brave-otter'",
        "export TOKIMEKI_SESSION_TOKEN='1234567'",
        "tokimeki claude",
      ].join("\n"),
    );
  });

  it("supports zsh, fish, pwsh, powershell, cmd, and custom agents", () => {
    const base = { ...BASE, customCommand: "vim" };
    expect(buildHostCommand({ ...base, shell: "zsh" })).toContain(
      "export TOKIMEKI_SESSION_TOKEN='1234567'\ntokimeki claude",
    );
    expect(buildHostCommand({ ...base, shell: "fish", agent: "pi" })).toContain(
      "set -gx TOKIMEKI_SESSION_TOKEN '1234567'\ntokimeki pi",
    );
    expect(buildHostCommand({ ...base, shell: "pwsh", agent: "custom" })).toContain(
      '$env:TOKIMEKI_SESSION_TOKEN="1234567"\ntokimeki run -- vim',
    );
    expect(buildHostCommand({ ...base, shell: "powershell" })).toContain(
      '$env:TOKIMEKI_SESSION_TOKEN="1234567"\ntokimeki claude',
    );
    const cmd = buildHostCommand({ ...base, shell: "cmd", agent: "pi" });
    expect(cmd).toContain('set "TOKIMEKI_SESSION=');
    expect(cmd.endsWith("tokimeki pi")).toBe(true);
    expect(cmd).not.toContain("&&");
  });

  // 2026-11-22 用户报告：单行拼接在 pwsh/powershell/cmd 解析失败或吞参（PS 把命令当
  // 表达式、cmd 的 set 把后续参数并入变量值）。多行脚本下最后一行必须是裸命令。
  it("renders a multi-line script whose last line is the bare command for every shell", () => {
    for (const shell of ["bash", "zsh", "sh", "fish", "pwsh", "powershell", "cmd"] as const) {
      const command = buildHostCommand({ ...BASE, shell });
      const lines = command.split("\n");
      expect(lines.length, shell).toBeGreaterThan(1);
      expect(lines.at(-1), shell).toBe("tokimeki claude");
      for (const line of lines.slice(0, -1)) {
        expect(line, shell).not.toMatch(/\btokimeki\b/u);
      }
    }
  });

  it("appends advanced env only when provided", () => {
    const command = buildHostCommand({
      ...BASE,
      shell: "bash",
      windowSize: "120x40",
      windowTui: "claude,pi",
      passcode: "hunter2@",
    });
    expect(command).toContain("TOKIMEKI_WINDOW_SIZE='120x40'");
    expect(command).toContain("TOKIMEKI_WINDOW_TUI='claude,pi'");
    expect(command).toContain("TOKIMEKI_PASSCODE='hunter2@'");
  });

  it("builds a v2 config envelope and config-mode commands", () => {
    const envelope = JSON.parse(buildHostConfigEnvelope(BASE)) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      v: 2,
      relayUrl: RELAY,
      token: TOKEN,
      namespace: "abcde",
      session: "abcde.brave-otter",
      sessionToken: "1234567",
    });
    expect(envelope).not.toHaveProperty("passcode");

    const bash = buildHostCommand({ ...BASE, shell: "bash", mode: "config" });
    expect(bash.startsWith("export TOKIMEKI_CONFIG='")).toBe(true);
    expect(bash).toContain('"relayUrl"');
    expect(bash.endsWith("\ntokimeki claude")).toBe(true);

    const pwsh = buildHostCommand({ ...BASE, shell: "pwsh", mode: "config" });
    expect(pwsh.startsWith("$env:TOKIMEKI_CONFIG='")).toBe(true);
    const cmd = buildHostCommand({ ...BASE, shell: "cmd", mode: "config" });
    expect(cmd.startsWith('set "TOKIMEKI_CONFIG={')).toBe(true);
    expect(cmd.endsWith("\ntokimeki claude")).toBe(true);
    expect(cmd.split("\n")).toHaveLength(2);
  });

  it("rejects shell-unsafe values and missing custom commands", () => {
    expect(() =>
      buildHostCommand({ ...BASE, shell: "bash", token: "bad token" }),
    ).toThrow();
    expect(() =>
      buildHostCommand({ ...BASE, shell: "bash", agent: "custom" }),
    ).toThrow();
  });
});

describe("buildAttachCommand", () => {
  it("emits exactly one command matching the invite mode", () => {
    const viewer = buildAttachCommand({
      shell: "bash",
      relayUrl: RELAY,
      session: "abcde.brave-otter",
      token: TOKEN,
      mode: "viewer",
    });
    expect(viewer.endsWith("tokimeki attach")).toBe(true);
    expect(viewer).not.toContain("--listen");

    const listener = buildAttachCommand({
      shell: "pwsh",
      relayUrl: RELAY,
      session: "abcde.brave-otter",
      token: TOKEN,
      mode: "listener",
    });
    expect(listener.endsWith("tokimeki attach --listen")).toBe(true);
  });

  it("supports zsh and fish env syntax", () => {
    expect(
      buildAttachCommand({
        shell: "zsh",
        relayUrl: RELAY,
        session: "abcde.brave-otter",
        token: TOKEN,
        mode: "viewer",
      }),
    ).toContain("export TOKIMEKI_SESSION='abcde.brave-otter'");
    expect(
      buildAttachCommand({
        shell: "fish",
        relayUrl: RELAY,
        session: "abcde.brave-otter",
        token: TOKEN,
        mode: "viewer",
      }),
    ).toContain("set -gx TOKIMEKI_SESSION 'abcde.brave-otter'\n");
  });

  // 2026-11-22 用户报告回归：attach 单行在 pwsh/cmd 解析失败；多行脚本最后一行必须是裸命令。
  it("renders a multi-line attach script whose last line is the bare attach command", () => {
    for (const shell of ["bash", "zsh", "sh", "fish", "pwsh", "powershell", "cmd"] as const) {
      const command = buildAttachCommand({
        shell,
        relayUrl: RELAY,
        session: "abcde.brave-otter",
        token: TOKEN,
        mode: "viewer",
      });
      const lines = command.split("\n");
      expect(lines.length, shell).toBe(4); // relay + session + token + command
      expect(lines.at(-1), shell).toBe("tokimeki attach");
    }
    const listener = buildAttachCommand({
      shell: "pwsh",
      relayUrl: RELAY,
      session: "abcde.brave-otter",
      token: TOKEN,
      mode: "listener",
      passcode: "123456",
    });
    const lines = listener.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[3]).toBe('$env:TOKIMEKI_PASSCODE="123456"');
    expect(lines.at(-1)).toBe("tokimeki attach --listen");
  });
});

describe("session access code", () => {
  it("generates a 6-8 digit token and validates the shape", () => {
    const lengths = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const token = generateSessionToken();
      expect(token).toMatch(/^[0-9]{6,8}$/u);
      expect(isValidSessionToken(token)).toBe(true);
      lengths.add(token.length);
    }
    expect([...lengths].some((length) => length >= 6 && length <= 8)).toBe(true);
    expect(isValidSessionToken("12345")).toBe(false);
    expect(isValidSessionToken("12345a")).toBe(false);
    expect(isValidSessionToken("123456789")).toBe(false);
    expect(isValidSessionToken("123456")).toBe(true);
    expect(isValidSessionToken("1234567")).toBe(true);
    expect(isValidSessionToken("12345678")).toBe(true);
  });
});

describe("session passcode", () => {
  it("generates exactly 6 digits and validates the shape", () => {
    for (let i = 0; i < 200; i += 1) {
      const passcode = generatePasscode();
      expect(passcode).toMatch(/^[0-9]{6}$/u);
      expect(isValidPasscode(passcode)).toBe(true);
    }
    expect(isValidPasscode("12345")).toBe(false);
    expect(isValidPasscode("1234567")).toBe(false);
    expect(isValidPasscode("12345a")).toBe(false);
    expect(isValidPasscode("123456")).toBe(true);
  });
});

describe("readable word slug", () => {
  it("has 256 unique lowercase adjective/animal entries", () => {
    for (const list of [SLUG_ADJECTIVES, SLUG_ANIMALS]) {
      expect(list).toHaveLength(256);
      expect(new Set(list).size).toBe(256);
      for (const word of list) expect(word).toMatch(/^[a-z]{3,8}$/u);
    }
  });

  it("generates an adjective-animal slug", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateWordSlug()).toMatch(/^[a-z]{3,8}-[a-z]{3,8}$/u);
    }
  });
});

describe("shell metacharacter hardening", () => {
  it("rejects passcodes that pwsh/cmd would expand or reinterpret", () => {
    for (const passcode of ["pa$word", "hun%ter", "abc!123", "a&b"]) {
      expect(() =>
        buildHostCommand({ ...BASE, shell: "pwsh", passcode }),
      ).toThrow();
    }
  });

  it("adds TOKIMEKI_PASSCODE to attach commands when provided", () => {
    const command = buildAttachCommand({
      shell: "bash",
      relayUrl: RELAY,
      session: "abcde.brave-otter",
      token: TOKEN,
      mode: "viewer",
      passcode: "hunter2@",
    });
    expect(command).toContain("TOKIMEKI_PASSCODE='hunter2@'");
  });

  it("validates attach passcodes by shell safety, not the hub-generated 6-digit shape", () => {
    // Hosts may set TOKIMEKI_PASSCODE manually; the relay enforces its value, so the
    // hub's only client-side constraint is that the value survives shell rendering.
    expect(isSafeCommandValue("hunter2@")).toBe(true);
    expect(isSafeCommandValue("123456")).toBe(true);
    for (const unsafe of ["pa$word", "two words", "a&b"]) {
      expect(isSafeCommandValue(unsafe)).toBe(false);
    }
  });
});
