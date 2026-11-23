// TokiAPI Web 终端客户端（无 React 依赖，可单测）。
//
// 浏览器只连 TokiAPI 同源 WS 代理；每次新建 WebSocket 前都重新 POST
// /api/tokimeki/attach 换一次性 ticket（D13）。Session JWT 从不进入浏览器。
import {
  decodeFrame,
  encodeFrame,
  PROTOCOL_VERSION,
} from "@limccn/tokimeki-protocol";
import { resolveHostFixed, type DisplayFixedSize, type DisplayInfo } from "./display";

export type { DisplayFixedSize, DisplayInfo } from "./display";

export type ViewerMode = "viewer" | "listener";

export type ViewerState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "host-offline"
  | "invalid-link"
  | "failed";

export interface ViewerClientOptions {
  readonly code: string;
  readonly session: string;
  readonly mode: ViewerMode;
  readonly passcode: string | null;
  /** Force the proxy's first-frame gate even when the invite flag is false. */
  readonly passcodeGate?: boolean;
  /** Initial terminal size advertised in `hello` before the first resize. */
  readonly initialSize?: DisplayFixedSize;
  readonly onWrite: (bytes: Uint8Array) => void;
  readonly onSnapshot: (bytes: Uint8Array) => void;
  readonly onState: (state: ViewerState, detail?: string) => void;
  readonly onHostOnline: (online: boolean) => void;
  readonly onError: (message: string) => void;
  /** Resolved host display capability (fixed grid or legacy passthrough). */
  readonly onDisplay?: (info: DisplayInfo) => void;
  /** The relay requires a passcode the invite did not advertise. */
  readonly onPasscodeRequired?: (message: string) => void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const ACK_INTERVAL_MS = 100;
const RESIZE_DEBOUNCE_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class TokimekiViewerClient {
  readonly #options: ViewerClientOptions;
  #socket: WebSocket | null = null;
  #clientId = "";
  #lastSeq = 0;
  #stopped = false;
  #attempt = 0;
  #pendingAck: number | null = null;
  #ackTimer: ReturnType<typeof setTimeout> | null = null;
  #lastSize: { cols: number; rows: number } | null = null;
  #resizeTimer: ReturnType<typeof setTimeout> | null = null;
  #hostExited = false;
  #reconnectScheduled = false;
  /** True until the first `welcome` resolves the host display capability. */
  #displayPending = true;
  /** Binary frames received before `welcome`; flushed after the grid is applied. */
  #pendingFrames: Uint8Array[] = [];
  /** undefined = not resolved yet, null = legacy passthrough, object = fixed grid. */
  #lastDisplay: DisplayFixedSize | null | undefined = undefined;

  constructor(options: ViewerClientOptions) {
    this.#options = options;
    if (options.mode === "viewer" && options.initialSize !== undefined) {
      this.#lastSize = options.initialSize;
    }
  }

  start(): void {
    this.#stopped = false;
    void this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#displayPending = false;
    this.#pendingFrames = [];
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
    }
  }

  sendInput(bytes: Uint8Array): void {
    if (this.#options.mode !== "viewer") return;
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(encodeFrame({ type: "input", payload: bytes }));
    } catch {
      // Socket closed between checks.
    }
  }

  resize(cols: number, rows: number): void {
    if (this.#options.mode !== "viewer") return;
    this.#lastSize = { cols, rows };
    if (this.#resizeTimer !== null) clearTimeout(this.#resizeTimer);
    this.#resizeTimer = setTimeout(() => {
      this.#resizeTimer = null;
      const size = this.#lastSize;
      if (size === null) return;
      this.#sendControl({ v: PROTOCOL_VERSION, type: "resize", clientId: this.#clientId, ...size });
    }, RESIZE_DEBOUNCE_MS);
  }

  /**
   * Ask the host for a fresh full snapshot. Used after the viewer switches to a
   * different fixed grid so bytes rendered under the old geometry are replaced.
   */
  resync(): void {
    if (this.#options.mode !== "viewer") return;
    this.#sendControl({ v: PROTOCOL_VERSION, type: "resync", clientId: this.#clientId });
  }

  #sendControl(message: Record<string, unknown>): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Socket closed.
    }
  }

  #resolveDisplay(clients: unknown): void {
    this.#applyDisplay(resolveHostFixed(clients));
  }

  #applyDisplay(fixed: DisplayFixedSize | null): void {
    const previous = this.#lastDisplay;
    const unchanged =
      previous !== undefined &&
      ((previous === null && fixed === null) ||
        (previous !== null &&
          fixed !== null &&
          previous.cols === fixed.cols &&
          previous.rows === fixed.rows));
    if (unchanged) return;
    this.#lastDisplay = fixed;
    if (fixed !== null) {
      // Fixed-grid sessions must not resize the host; cancel any resize queued
      // during the pre-welcome fit and advertise the grid we actually render.
      if (this.#resizeTimer !== null) {
        clearTimeout(this.#resizeTimer);
        this.#resizeTimer = null;
      }
      this.#lastSize = fixed;
    }
    this.#options.onDisplay?.({ fixed });
    // A grid change after the initial welcome means the terminal may already
    // hold bytes rendered under the old geometry. Ask for a clean snapshot.
    if (previous !== undefined) {
      this.resync();
    }
  }

  #flushPendingFrames(): void {
    if (this.#pendingFrames.length === 0) return;
    const frames = this.#pendingFrames;
    this.#pendingFrames = [];
    for (const bytes of frames) this.#handleBinary(bytes);
  }

  #scheduleAck(seq: number): void {
    if (this.#options.mode !== "viewer") return;
    this.#pendingAck = seq;
    if (this.#ackTimer !== null) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = null;
      const pending = this.#pendingAck;
      this.#pendingAck = null;
      if (pending === null) return;
      this.#sendControl({ v: PROTOCOL_VERSION, type: "ack", seq: String(pending) });
    }, ACK_INTERVAL_MS);
  }

  async #fetchTicket(): Promise<"ok" | "invalid" | "error"> {
    try {
      const response = await fetch("/api/tokimeki/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ code: this.#options.code }),
      });
      if (response.status === 410) return "invalid";
      if (!response.ok) return "error";
      return "ok";
    } catch {
      return "error";
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    this.#reconnectScheduled = false;
    this.#options.onState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const ticket = await this.#fetchTicket();
    if (ticket === "invalid") {
      this.#stopped = true;
      this.#options.onState("invalid-link");
      return;
    }
    if (ticket === "error") {
      this.#retryOrFail("The server is temporarily unavailable. Retrying…");
      return;
    }
    if (this.#stopped) return;

    // Hold binary output until the relay's `welcome` tells us the host grid.
    // The relay always sends `welcome` before routing any terminal bytes.
    this.#displayPending = true;
    this.#pendingFrames = [];
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = new URL(`${protocol}//${window.location.host}/api/tokimeki/ws`);
    if (this.#options.passcodeGate === true) {
      wsUrl.searchParams.set("gate", "1");
    }
    const socket = new WebSocket(wsUrl);
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#clientId = crypto.randomUUID();

    socket.addEventListener("open", () => {
      if (this.#options.passcode !== null) {
        socket.send(
          JSON.stringify({ v: PROTOCOL_VERSION, type: "passcode", value: this.#options.passcode }),
        );
      }
      const hello: Record<string, unknown> = {
        v: PROTOCOL_VERSION,
        type: "hello",
        role: this.#options.mode,
        session: this.#options.session,
        clientId: this.#clientId,
        protocolVersion: PROTOCOL_VERSION,
        client: { name: "tokiapi-web", version: "1", kind: "web" },
        capabilities: {
          display: { modes: ["viewport"] },
          transports: { modes: ["relay"] },
          ...(this.#options.mode === "listener"
            ? { listener: { modes: ["snapshot-only"] } }
            : {}),
        },
        ...(this.#options.mode === "listener" || this.#lastSize === null
          ? {}
          : { cols: this.#lastSize.cols, rows: this.#lastSize.rows }),
      };
      socket.send(JSON.stringify(hello));
    });

    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.#handleBinary(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data === "string") {
        this.#handleText(event.data);
      }
    });

    socket.addEventListener("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#clearTimers();
      this.#displayPending = false;
      this.#pendingFrames = [];
      if (this.#stopped) return;
      if (this.#hostExited) {
        this.#options.onState("host-offline");
        return;
      }
      this.#retryOrFail("Connection lost. Reconnecting…");
    });
  }

  #retryOrFail(detail: string): void {
    if (this.#stopped || this.#reconnectScheduled) return;
    this.#reconnectScheduled = true;
    this.#attempt += 1;
    if (this.#attempt > MAX_RECONNECT_ATTEMPTS) {
      this.#stopped = true;
      this.#options.onState("failed", detail);
      return;
    }
    const delay = Math.min(1000 * 2 ** (this.#attempt - 1), 15_000);
    this.#options.onState("reconnecting", detail);
    void sleep(delay).then(() => this.#connect());
  }

  #handleText(text: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (message.type === "welcome") {
      this.#attempt = 0;
      this.#options.onHostOnline(message.hostOnline === true);
      // Resolve the host grid before flushing any queued terminal bytes so the
      // first snapshot is written into the correct cols/rows.
      this.#displayPending = false;
      this.#resolveDisplay(message.clients);
      this.#flushPendingFrames();
      this.#options.onState("live");
      return;
    }
    if (message.type === "presence") {
      this.#resolveDisplay(message.clients);
      return;
    }
    if (message.type === "peer-joined") {
      if (message.role === "host") {
        this.#applyDisplay(
          resolveHostFixed([{ role: "host", capabilities: message.capabilities }]),
        );
      }
      return;
    }
    if (message.type === "host") {
      const online = message.online === true;
      this.#hostExited = false;
      // A restarted host starts its output counter at 0; reset the reducer so
      // its seq-0 snapshot and early frames are not dropped as stale.
      if (online) this.#lastSeq = 0;
      this.#options.onHostOnline(online);
      this.#options.onState("live");
      return;
    }
    if (message.type === "ping") {
      this.#sendControl({ v: PROTOCOL_VERSION, type: "pong", ts: message.ts });
      return;
    }
    if (message.type === "host-exited") {
      this.#hostExited = true;
      this.#options.onHostOnline(false);
      this.#options.onState("host-offline");
      return;
    }
    if (message.type === "error") {
      const code = typeof message.code === "string" ? message.code : "internal";
      const detail = typeof message.message === "string" ? message.message : "Relay error";
      if (code === "slow_consumer") {
        // Close this socket first; the close handler is then ignored by its
        // identity guard, avoiding a second concurrent reconnect.
        const socket = this.#socket;
        this.#socket = null;
        try {
          socket?.close();
        } catch {
          // Already closed.
        }
        this.#retryOrFail("The viewer fell behind. Reconnecting…");
        return;
      }
      if (code.startsWith("passcode_")) {
        this.#stopped = true;
        this.#options.onPasscodeRequired?.(detail);
        return;
      }
      if (code === "host_offline") {
        this.#options.onHostOnline(false);
        this.#options.onState("live");
        return;
      }
      if (code === "invalid_session" && /host must connect first/i.test(detail)) {
        this.#retryOrFail("Waiting for the host to start…");
        return;
      }
      if (code === "host_exited") {
        this.#hostExited = true;
        this.#options.onHostOnline(false);
        this.#options.onState("host-offline");
        return;
      }
      this.#stopped = true;
      this.#options.onState("failed", detail);
      this.#options.onError(detail);
    }
  }

  #handleBinary(bytes: Uint8Array): void {
    if (this.#displayPending) {
      this.#pendingFrames.push(bytes);
      return;
    }
    let frame: ReturnType<typeof decodeFrame>;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }
    if (frame.type === "output") {
      if (frame.seq <= this.#lastSeq) return;
      this.#lastSeq = frame.seq;
      this.#options.onWrite(frame.payload);
      this.#scheduleAck(frame.seq);
      return;
    }
    if (frame.type === "snapshot_to") {
      if (frame.targetId !== this.#clientId || frame.seq < this.#lastSeq) return;
      this.#lastSeq = frame.seq;
      this.#options.onSnapshot(frame.payload);
      this.#scheduleAck(frame.seq);
    }
  }

  #clearTimers(): void {
    if (this.#ackTimer !== null) {
      clearTimeout(this.#ackTimer);
      this.#ackTimer = null;
    }
    if (this.#resizeTimer !== null) {
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = null;
    }
  }
}
