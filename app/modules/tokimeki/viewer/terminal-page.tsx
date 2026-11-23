// /#t-<code> — TokiAPI Web 终端（relay-only，浏览器不接触 Session JWT）。
//
// 固定窗口会话（host 在 hello.capabilities.display.fixed 声明逻辑网格）：
// xterm 的 cols/rows 固定为 host 的网格，再用 CSS transform 等比缩放并居中到
// 浏览器可视区；绝不发送 resize 改变 host 的 PTY。非固定会话保持原来的
// fit + resize 直通行为（兼容旧 relay / 旧 host）。
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import type { Terminal } from "@xterm/xterm";
import {
  Keyboard,
  KeyboardOff,
  Maximize2,
  Minimize2,
  RotateCcw,
  SendHorizontal,
} from "lucide-react";
import { useIsMobile } from "@/hooks/use-media-query";
import {
  TokimekiViewerClient,
  type DisplayFixedSize,
  type ViewerMode,
  type ViewerState,
} from "./client";
import { computeFixedLayout } from "./display";
import {
  applyModifiersToInput,
  encodeTerminalKey,
  NO_MODIFIERS,
  toggleModifier,
  type ModifierId,
  type ModifierState,
  type TerminalKeyId,
} from "./keymap";
import {
  forgetPasscodeValue,
  readRememberedPasscode,
  rememberPasscode,
} from "./passcode-store";

interface AttachInfo {
  readonly session: string;
  readonly mode: ViewerMode;
  readonly passcodeRequired: boolean;
}

type Phase = "connecting" | "passcode" | "live" | "invalid-link" | "error";

const MIN_PASSCODE_LENGTH = 6;
const TEXT_ENCODER = new TextEncoder();
const FLOAT_BUTTON_CLASS =
  "flex size-11 items-center justify-center rounded-full border border-white/15 bg-black/40 text-white/80 backdrop-blur-sm active:bg-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400";

function codeFromHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith("#t-")) return null;
  const code = hash.slice(3);
  return code.length > 0 ? code : null;
}

/** SSR-safe boolean media query (initial false, real value after mount). */
function useMediaFlag(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

type KeypadItem =
  | { readonly kind: "key"; readonly id: TerminalKeyId; readonly label: string }
  | { readonly kind: "modifier"; readonly id: ModifierId; readonly label: string }
  | { readonly kind: "paste"; readonly label: string }
  | { readonly kind: "keyboard" };

// Portrait: two rows of six. Landscape: one row of twelve.
const PORTRAIT_KEYPAD: readonly KeypadItem[] = [
  { kind: "key", id: "escape", label: "Esc" },
  { kind: "key", id: "tab", label: "Tab" },
  { kind: "modifier", id: "ctrl", label: "Ctrl" },
  { kind: "key", id: "arrowUp", label: "↑" },
  { kind: "modifier", id: "shift", label: "Shift" },
  { kind: "keyboard" },
  { kind: "modifier", id: "alt", label: "Alt" },
  { kind: "paste", label: "Paste" },
  { kind: "key", id: "arrowLeft", label: "←" },
  { kind: "key", id: "arrowDown", label: "↓" },
  { kind: "key", id: "arrowRight", label: "→" },
  { kind: "key", id: "enter", label: "Enter" },
];

const LANDSCAPE_KEYPAD: readonly KeypadItem[] = [
  { kind: "key", id: "escape", label: "Esc" },
  { kind: "key", id: "tab", label: "Tab" },
  { kind: "modifier", id: "ctrl", label: "Ctrl" },
  { kind: "modifier", id: "alt", label: "Alt" },
  { kind: "modifier", id: "shift", label: "Shift" },
  { kind: "key", id: "arrowLeft", label: "←" },
  { kind: "key", id: "arrowUp", label: "↑" },
  { kind: "key", id: "arrowDown", label: "↓" },
  { kind: "key", id: "arrowRight", label: "→" },
  { kind: "key", id: "enter", label: "Enter" },
  { kind: "paste", label: "Paste" },
  { kind: "keyboard" },
];

const KEY_BUTTON_CLASS =
  "flex h-11 min-w-0 touch-manipulation select-none items-center justify-center rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400";
const KEY_BUTTON_IDLE = "bg-neutral-800 text-neutral-100 active:bg-neutral-700";
const KEY_BUTTON_ACTIVE = "bg-sky-400 text-neutral-950";

function keyAriaLabel(item: KeypadItem, keyboardVisible: boolean): string {
  if (item.kind === "key") {
    if (item.id === "arrowUp") return "Arrow up";
    if (item.id === "arrowDown") return "Arrow down";
    if (item.id === "arrowLeft") return "Arrow left";
    if (item.id === "arrowRight") return "Arrow right";
    if (item.id === "escape") return "Escape";
    if (item.id === "tab") return "Tab";
    if (item.id === "enter") return "Enter";
    return item.label;
  }
  if (item.kind === "modifier") return item.label;
  if (item.kind === "paste") return "Paste";
  return keyboardVisible ? "Hide system keyboard" : "Show system keyboard";
}

function MobileKeypad({
  layout,
  modifiers,
  keyboardVisible,
  onKey,
  onToggleModifier,
  onPaste,
  onToggleKeyboard,
  onInteract,
}: {
  layout: "portrait" | "landscape";
  modifiers: ModifierState;
  keyboardVisible: boolean;
  onKey: (id: TerminalKeyId) => void;
  onToggleModifier: (id: ModifierId) => void;
  onPaste: () => void;
  onToggleKeyboard: () => void;
  onInteract: () => void;
}) {
  const items = layout === "landscape" ? LANDSCAPE_KEYPAD : PORTRAIT_KEYPAD;
  const handlePointerDown =
    (item: KeypadItem) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      // Keep the composer alive when a keypad tap blurs the textarea.
      onInteract();
      // Paste needs a real click gesture for the Clipboard API.
      if (item.kind === "paste") return;
      event.preventDefault();
      if (item.kind === "key") onKey(item.id);
      else if (item.kind === "modifier") onToggleModifier(item.id);
      else onToggleKeyboard();
    };
  return (
    <div className="shrink-0 border-t border-neutral-800 bg-neutral-950/95 px-1.5 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
      <div
        className={`grid gap-1.5 ${layout === "landscape" ? "overflow-x-auto" : "grid-cols-6"}`}
        style={
          layout === "landscape"
            ? { gridTemplateColumns: "repeat(12, minmax(44px, 1fr))" }
            : undefined
        }
      >
        {items.map((item) => {
          const activeModifier = item.kind === "modifier" && modifiers[item.id];
          const activeKeyboard = item.kind === "keyboard" && keyboardVisible;
          const label = item.kind === "keyboard" ? "" : item.label;
          const itemKey =
            item.kind === "key" || item.kind === "modifier" ? item.id : item.kind;
          const ariaLabel = keyAriaLabel(item, keyboardVisible);
          return (
            <button
              key={`${item.kind}-${itemKey}`}
              type="button"
              aria-label={ariaLabel}
              title={ariaLabel}
              aria-pressed={
                item.kind === "modifier"
                  ? activeModifier
                  : item.kind === "keyboard"
                    ? keyboardVisible
                    : undefined
              }
              className={`${KEY_BUTTON_CLASS} ${
                activeModifier || activeKeyboard ? KEY_BUTTON_ACTIVE : KEY_BUTTON_IDLE
              }`}
              onPointerDown={handlePointerDown(item)}
              onClick={item.kind === "paste" ? onPaste : undefined}
            >
              {item.kind === "keyboard" ? (
                keyboardVisible ? (
                  <KeyboardOff className="size-5" aria-hidden="true" />
                ) : (
                  <Keyboard className="size-5" aria-hidden="true" />
                )
              ) : (
                label
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function TerminalPage() {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sizerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<TokimekiViewerClient | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const layoutRafRef = useRef<number | null>(null);
  const fixedRef = useRef<DisplayFixedSize | null>(null);
  const fitScreenRef = useRef(true);
  const relayoutRef = useRef<(() => void) | null>(null);
  const startedRef = useRef(false);
  const modifiersRef = useRef<ModifierState>(NO_MODIFIERS);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const keypadInteractingRef = useRef(false);
  const [code, setCode] = useState<string | null>(() => codeFromHash());
  const [attachInfo, setAttachInfo] = useState<AttachInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [viewerState, setViewerState] = useState<ViewerState>("connecting");
  const [hostOnline, setHostOnline] = useState(true);
  const [detail, setDetail] = useState<string | null>(null);
  const [passcode, setPasscode] = useState("");
  const [passcodeError, setPasscodeError] = useState<string | null>(null);
  const [fixedSize, setFixedSize] = useState<DisplayFixedSize | null>(null);
  const [fitScreen, setFitScreen] = useState(true);
  const [systemKeyboardVisible, setSystemKeyboardVisible] = useState(false);
  const [draft, setDraft] = useState("");
  const [modifiers, setModifiers] = useState<ModifierState>(NO_MODIFIERS);
  const [forcedLandscape, setForcedLandscape] = useState(false);
  const isCoarsePointer = useMediaFlag("(pointer: coarse)");
  const isLandscapeDevice = useMediaFlag("(orientation: landscape)");
  const isMobile = useIsMobile() || isCoarsePointer;
  const landscape = isLandscapeDevice || forcedLandscape;

  useEffect(() => {
    // Rotating the device is the real landscape state; drop any manual override.
    if (isLandscapeDevice) setForcedLandscape(false);
  }, [isLandscapeDevice]);

  useEffect(() => {
    const onHashChange = () => {
      clientRef.current?.stop();
      clientRef.current = null;
      observerRef.current?.disconnect();
      observerRef.current = null;
      setCode(codeFromHash());
      startedRef.current = false;
      fixedRef.current = null;
      setFixedSize(null);
      setPhase("connecting");
      setAttachInfo(null);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (code === null) {
      setPhase("invalid-link");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/tokimeki/attach", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ code }),
        });
        if (cancelled) return;
        if (response.status === 410) {
          setPhase("invalid-link");
          return;
        }
        if (!response.ok) {
          setDetail("The server is temporarily unavailable");
          setPhase("error");
          return;
        }
        const body = (await response.json()) as AttachInfo;
        setAttachInfo(body);
      } catch {
        if (!cancelled) {
          setDetail("The server is temporarily unavailable");
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  const begin = useCallback(
    async (info: AttachInfo, passcodeValue: string | null) => {
      if (startedRef.current) return;
      startedRef.current = true;
      const [{ Terminal: Xterm }, { FitAddon: XtermFitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");
      const host = hostRef.current;
      if (host === null) return;
      // A passcode retry re-enters this function; drop the previous terminal and
      // client so two xterm instances / sockets never stack.
      clientRef.current?.stop();
      clientRef.current = null;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (layoutRafRef.current !== null) {
        cancelAnimationFrame(layoutRafRef.current);
        layoutRafRef.current = null;
      }
      terminalRef.current?.dispose();
      terminalRef.current = null;
      host.replaceChildren();
      // A previous fixed session may have left inline sizing/transform behind;
      // clear it so the legacy fit measures the viewport again.
      host.style.removeProperty("width");
      host.style.removeProperty("height");
      host.style.transform = "";
      fixedRef.current = null;
      fitScreenRef.current = true;
      relayoutRef.current = null;
      setFixedSize(null);
      setFitScreen(true);

      const terminal = new Xterm({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        theme: { background: "#0b0d10", foreground: "#e6e6e6" },
        scrollback: 5000,
        convertEol: false,
      });
      const fit = new XtermFitAddon();
      terminal.loadAddon(fit);
      terminal.open(host);
      // Tapping the terminal also opens the native keyboard; surface the
      // buffered composer so both input paths show the same UI.
      terminal.textarea?.addEventListener("focus", () => setSystemKeyboardVisible(true));
      terminalRef.current = terminal;

      const relayout = (): void => {
        const viewport = viewportRef.current;
        if (viewport === null) return;
        const fixed = fixedRef.current;
        if (fixed === null) {
          // Legacy live-fit mode: the host follows the browser viewport.
          const sizer = sizerRef.current;
          if (sizer !== null) {
            sizer.style.width = "100%";
            sizer.style.height = "100%";
          }
          host.style.removeProperty("width");
          host.style.removeProperty("height");
          host.style.transform = "";
          if (viewport.clientWidth > 0 && viewport.clientHeight > 0) {
            fit.fit();
            clientRef.current?.resize(terminal.cols, terminal.rows);
          }
          return;
        }
        if (terminal.cols !== fixed.cols || terminal.rows !== fixed.rows) {
          terminal.resize(fixed.cols, fixed.rows);
        }
        const screen = host.querySelector<HTMLElement>(".xterm-screen");
        if (screen === null) return;
        const width = screen.offsetWidth;
        const height = screen.offsetHeight;
        // Classic scrollbars take layout space inside `.xterm-viewport`; widen
        // the box so they never overlap the rightmost columns of the grid.
        const viewportEl = host.querySelector<HTMLElement>(".xterm-viewport");
        const scrollbar =
          viewportEl === null ? 0 : Math.max(0, viewportEl.offsetWidth - viewportEl.clientWidth);
        const boxWidth = width + scrollbar;
        const layout = computeFixedLayout(
          viewport.clientWidth,
          viewport.clientHeight,
          boxWidth,
          height,
        );
        if (layout === null) return;
        // Fit on: scale both axes. Fit off: fit height only so the grid can
        // overflow horizontally and pan without a vertical scrollbar.
        const scale = fitScreenRef.current
          ? layout.scale
          : Math.min(1, viewport.clientHeight / height);
        const sizer = sizerRef.current;
        if (sizer !== null) {
          sizer.style.width = `${boxWidth * scale}px`;
          sizer.style.height = `${height * scale}px`;
        }
        host.style.width = `${boxWidth}px`;
        host.style.height = `${height}px`;
        host.style.transform = `scale(${scale})`;
      };

      const scheduleRelayout = (): void => {
        if (layoutRafRef.current !== null) cancelAnimationFrame(layoutRafRef.current);
        // Two frames: xterm updates the screen element inside its own rAF.
        layoutRafRef.current = requestAnimationFrame(() => {
          layoutRafRef.current = requestAnimationFrame(() => {
            layoutRafRef.current = null;
            relayout();
          });
        });
      };
      relayoutRef.current = scheduleRelayout;

      // Size the legacy grid before the first hello so the host gets cols/rows.
      const viewport = viewportRef.current;
      if (viewport !== null && viewport.clientWidth > 0 && viewport.clientHeight > 0) {
        fit.fit();
      }

      const client = new TokimekiViewerClient({
        code: code ?? "",
        session: info.session,
        mode: info.mode,
        passcode: passcodeValue,
        passcodeGate: passcodeValue !== null,
        initialSize: { cols: terminal.cols, rows: terminal.rows },
        onWrite: (bytes) => terminal.write(bytes),
        onSnapshot: (bytes) => {
          terminal.reset();
          terminal.write(bytes);
        },
        onDisplay: ({ fixed }) => {
          const previous = fixedRef.current;
          const changed =
            previous === null || fixed === null
              ? previous !== fixed
              : previous.cols !== fixed.cols || previous.rows !== fixed.rows;
          fixedRef.current = fixed;
          setFixedSize(fixed);
          // Apply the grid synchronously: the client flushes buffered terminal
          // bytes immediately after this callback returns.
          if (fixed !== null && (terminal.cols !== fixed.cols || terminal.rows !== fixed.rows)) {
            terminal.resize(fixed.cols, fixed.rows);
          }
          if (changed) scheduleRelayout();
        },
        onState: (state, message) => {
          setViewerState(state);
          if (message !== undefined) setDetail(message);
          if (state === "live") setPhase("live");
          if (state === "invalid-link") setPhase("invalid-link");
          if (state === "failed") {
            setPhase("error");
            if (message !== undefined) setDetail(message);
          }
          if (state === "host-offline") {
            setPhase("live");
            setHostOnline(false);
          }
        },
        onHostOnline: (online) => setHostOnline(online),
        onPasscodeRequired: (message) => {
          if (code !== null) forgetPasscodeValue(code);
          setPasscode("");
          setPasscodeError(message);
          setPhase("passcode");
          startedRef.current = false;
        },
        onError: (message) => setDetail(message),
      });
      clientRef.current = client;
      terminal.onResize(() => scheduleRelayout());

      if (info.mode === "viewer") {
        terminal.onData((data) =>
          client.sendInput(
            TEXT_ENCODER.encode(applyModifiersToInput(data, modifiersRef.current)),
          ),
        );
        const observer = new ResizeObserver(() => scheduleRelayout());
        if (viewport !== null) observer.observe(viewport);
        observerRef.current = observer;
      } else if (viewport !== null) {
        const observer = new ResizeObserver(() => scheduleRelayout());
        observer.observe(viewport);
        observerRef.current = observer;
      }
      scheduleRelayout();
      client.start();
    },
    [code],
  );

  useEffect(() => {
    if (attachInfo === null) return;
    const remembered = code === null ? null : readRememberedPasscode(code);
    if (
      remembered !== null &&
      remembered.value !== null &&
      (attachInfo.passcodeRequired || remembered.needed)
    ) {
      setPasscode(remembered.value);
      setPhase("connecting");
      void begin(attachInfo, remembered.value);
      return;
    }
    if (attachInfo.passcodeRequired) {
      setPhase("passcode");
      return;
    }
    setPhase("connecting");
    void begin(attachInfo, null);
  }, [attachInfo, begin, code]);

  useEffect(
    () => () => {
      clientRef.current?.stop();
      clientRef.current = null;
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (layoutRafRef.current !== null) {
        cancelAnimationFrame(layoutRafRef.current);
        layoutRafRef.current = null;
      }
      relayoutRef.current = null;
      terminalRef.current?.dispose();
      terminalRef.current = null;
    },
    [],
  );

  const sendKey = (id: TerminalKeyId): void => {
    clientRef.current?.sendInput(
      TEXT_ENCODER.encode(encodeTerminalKey(id, modifiersRef.current)),
    );
  };

  const toggleMod = (id: ModifierId): void => {
    setModifiers((previous) => {
      const next = toggleModifier(previous, id);
      modifiersRef.current = next;
      return next;
    });
  };

  const pasteClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 0) {
        clientRef.current?.sendInput(TEXT_ENCODER.encode(text));
      }
    } catch {
      // Permission denied or no clipboard: the native paste menu still works.
    }
  };

  const resizeComposer = (element: HTMLTextAreaElement): void => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 112)}px`;
  };

  const showSystemKeyboard = (): void => {
    // Mount the composer synchronously inside the tap gesture, then focus it;
    // Safari only opens the native keyboard for focus inside a user gesture.
    flushSync(() => setSystemKeyboardVisible(true));
    const composer = composerRef.current;
    if (composer !== null) {
      resizeComposer(composer);
      composer.focus();
    }
  };

  const hideSystemKeyboard = (): void => {
    setSystemKeyboardVisible(false);
    composerRef.current?.blur();
    terminalRef.current?.blur();
  };

  const toggleSystemKeyboard = (): void => {
    if (systemKeyboardVisible) hideSystemKeyboard();
    else showSystemKeyboard();
  };

  const sendDraft = (): void => {
    if (draft.trim().length === 0) return;
    // Composer text is literal multi-character passthrough; the Ctrl/Alt/Shift
    // latches apply to keypad keys and direct xterm input, not to typed draft text.
    // Textarea newlines become Enter; a final Enter runs the last line.
    const normalized = draft.replace(/\r\n?/g, "\n").replace(/\n/g, "\r");
    const payload = normalized.endsWith("\r") ? normalized : `${normalized}\r`;
    clientRef.current?.sendInput(TEXT_ENCODER.encode(payload));
    setDraft("");
    requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (composer !== null) {
        composer.style.height = "auto";
        composer.focus();
      }
    });
  };

  const toggleFitScreen = (): void => {
    const next = !fitScreenRef.current;
    fitScreenRef.current = next;
    setFitScreen(next);
    const scroller = scrollRef.current;
    if (scroller !== null) {
      scroller.scrollLeft = 0;
      scroller.scrollTop = 0;
    }
    relayoutRef.current?.();
  };

  const toggleOrientation = (): void => {
    const next = !forcedLandscape;
    setForcedLandscape(next);
    if (typeof screen === "undefined") return;
    // Best-effort device rotation; the keypad layout switches regardless.
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: string) => Promise<void>;
      unlock?: () => void;
    };
    try {
      if (next) {
        const locked = orientation.lock?.("landscape");
        if (locked !== undefined) void locked.catch(() => {});
      } else {
        orientation.unlock?.();
      }
    } catch {
      // Unsupported or blocked (e.g. iOS): keep the manual layout.
    }
  };

  const submitPasscode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (attachInfo === null) return;
    const value = passcode.trim();
    if (value.length < MIN_PASSCODE_LENGTH) {
      setPasscodeError("Passcode must be at least 6 characters");
      return;
    }
    if (code !== null) rememberPasscode(code, value);
    setPasscodeError(null);
    setPhase("connecting");
    void begin(attachInfo, value);
  };

  if (phase === "invalid-link") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-[#0b0d10] p-6 text-center text-neutral-200">
        <div className="max-w-md space-y-3">
          <h1 className="text-lg font-semibold">This link is invalid or has expired</h1>
          <p className="text-sm text-neutral-400">
            Ask the host to create a new share link. Links are shown only once.
          </p>
          <a className="text-sm underline underline-offset-4" href="/">
            Back to TokiAPI
          </a>
        </div>
      </main>
    );
  }

  if (phase === "passcode") {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center bg-[#0b0d10] p-6 text-neutral-200">
        <form
          onSubmit={submitPasscode}
          className="w-full max-w-sm space-y-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5"
        >
          <h1 className="text-lg font-semibold">Session passcode required</h1>
          <p className="text-sm text-neutral-400">
            {attachInfo === null ? "Loading…" : `Session ${attachInfo.session}`}
          </p>
          {passcodeError === null ? null : (
            <p role="alert" className="text-sm text-red-400">
              {passcodeError}
            </p>
          )}
          <input
            type="password"
            autoComplete="off"
            aria-label="Session passcode"
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
            className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-500"
            placeholder="Passcode"
          />
          <p className="text-xs text-neutral-500">
            Remembered for this tab, so a refresh reconnects without asking again.
          </p>
          <button
            type="submit"
            className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900"
          >
            Connect
          </button>
        </form>
      </main>
    );
  }

  const showOverlay = viewerState !== "live" || !hostOnline || phase === "error";

  return (
    <main className="relative flex h-[100dvh] flex-col overflow-hidden bg-[#0b0d10]">
      <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
        <span className="truncate font-mono">{attachInfo?.session ?? "tokimeki"}</span>
        <span className="flex shrink-0 items-center gap-2">
          {fixedSize === null ? null : (
            <span className="font-mono text-neutral-500">
              {fixedSize.cols}×{fixedSize.rows}
            </span>
          )}
          <span>
            {attachInfo?.mode ?? "viewer"} ·{" "}
            {hostOnline ? (viewerState === "live" ? "live" : viewerState) : "host offline"}
          </span>
        </span>
      </header>
      <div ref={viewportRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          ref={scrollRef}
          className={`absolute inset-0 ${
            fitScreen
              ? "flex items-center justify-center overflow-hidden"
              : "overflow-x-auto overflow-y-hidden"
          }`}
        >
          <div ref={sizerRef} className="relative h-full w-full shrink-0 overflow-hidden">
            <div
              ref={hostRef}
              className="absolute left-0 top-0 h-full w-full origin-top-left overflow-hidden"
            />
          </div>
        </div>
        {showOverlay ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60 text-center text-neutral-200">
            <div className="pointer-events-auto max-w-md space-y-2 p-6">
              <p role="status" aria-live="polite" className="text-lg font-medium">
                {phase === "error"
                  ? "Connection failed"
                  : hostOnline
                    ? viewerState === "connecting"
                      ? "Connecting…"
                      : viewerState === "reconnecting"
                        ? "Reconnecting…"
                        : "Waiting for host…"
                    : "Host is offline"}
              </p>
              {detail === null ? null : <p className="text-sm text-neutral-400">{detail}</p>}
              {phase === "error" ? (
                <a className="text-sm underline underline-offset-4" href="/">
                  Back to TokiAPI
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
        {fixedSize !== null ? (
          <div className="absolute right-2 top-2 z-20 flex items-center gap-2">
            {isMobile && (!isLandscapeDevice || forcedLandscape) ? (
              <button
                type="button"
                onClick={toggleOrientation}
                onPointerDown={(event) => event.preventDefault()}
                aria-label={forcedLandscape ? "Switch to portrait" : "Switch to landscape"}
                title={forcedLandscape ? "Switch to portrait" : "Switch to landscape"}
                className={FLOAT_BUTTON_CLASS}
              >
                <RotateCcw className="size-5" aria-hidden="true" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={toggleFitScreen}
              onPointerDown={(event) => event.preventDefault()}
              aria-label={fitScreen ? "Disable fit to screen" : "Fit to screen"}
              title={fitScreen ? "Disable fit to screen" : "Fit to screen"}
              aria-pressed={fitScreen}
              className={`${FLOAT_BUTTON_CLASS} ${fitScreen ? "text-sky-300" : ""}`}
            >
              {fitScreen ? (
                <Minimize2 className="size-5" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-5" aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
      </div>
      {isMobile && attachInfo?.mode !== "listener" ? (
        <>
          {systemKeyboardVisible ? (
            <div className="shrink-0 border-t border-neutral-800 bg-neutral-950/95 px-1.5 pt-1.5">
              <div className="flex items-end gap-1.5">
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    resizeComposer(event.currentTarget);
                  }}
                  onBlur={() => {
                    // A tap on Send uses pointerdown+preventDefault, so the
                    // textarea keeps focus and this check stays true. A keypad
                    // tap may blur it on some browsers; keep the composer then.
                    window.setTimeout(() => {
                      if (keypadInteractingRef.current) return;
                      const active = document.activeElement;
                      if (
                        active !== composerRef.current &&
                        active !== terminalRef.current?.textarea
                      ) {
                        setSystemKeyboardVisible(false);
                      }
                    }, 0);
                  }}
                  placeholder="Type, then send (adds Enter)"
                  aria-label="Terminal input buffer"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="max-h-28 min-h-11 flex-1 resize-none rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-neutral-500"
                />
                <button
                  type="button"
                  aria-label="Send buffered input"
                  title="Send buffered input"
                  disabled={draft.trim().length === 0}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    sendDraft();
                  }}
                  className="flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-md bg-neutral-100 text-neutral-900 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
                >
                  <SendHorizontal className="size-5" aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
          <MobileKeypad
            layout={landscape ? "landscape" : "portrait"}
            modifiers={modifiers}
            keyboardVisible={systemKeyboardVisible}
            onKey={sendKey}
            onToggleModifier={toggleMod}
            onPaste={() => void pasteClipboard()}
            onToggleKeyboard={toggleSystemKeyboard}
            onInteract={() => {
              keypadInteractingRef.current = true;
              window.setTimeout(() => {
                keypadInteractingRef.current = false;
              }, 300);
            }}
          />
        </>
      ) : null}
    </main>
  );
}
