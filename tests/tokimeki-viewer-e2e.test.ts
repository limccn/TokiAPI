// Viewer protocol e2e: TUI fixed-grid vs non-TUI reflow, using a fake relay
// WebSocket. No browser/Playwright: this exercises the real viewer client.
import { encodeFrame } from "@limccn/tokimeki-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TokimekiViewerClient,
  type DisplayInfo,
} from "../app/modules/tokimeki/viewer/client";

type Listener = (event: { readonly data?: unknown }) => void;

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];

  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit("open");
  }

  message(data: string | ArrayBuffer): void {
    this.emit("message", { data });
  }

  private emit(type: string, event: { readonly data?: unknown } = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

interface Harness {
  readonly client: TokimekiViewerClient;
  readonly socket: FakeSocket;
  readonly display: DisplayInfo[];
  readonly writes: Uint8Array[];
  readonly events: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function fixedHost(cols: number, rows: number): string {
  return json({
    v: 1,
    type: "welcome",
    session: "demo",
    hostOnline: true,
    clients: [
      { role: "host", capabilities: { display: { modes: ["fixed-grid"], fixed: { cols, rows } } } },
    ],
  });
}

function reflowHost(): string {
  return json({
    v: 1,
    type: "welcome",
    session: "demo",
    hostOnline: true,
    clients: [{ role: "host" }],
  });
}

function outputFrame(payload: string): ArrayBuffer {
  return encodeFrame({
    type: "output",
    seq: 1,
    payload: new TextEncoder().encode(payload),
  }).slice().buffer;
}

function waitForSocket(): Promise<FakeSocket> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tick = (): void => {
      const socket = FakeSocket.instances.at(-1);
      if (socket !== undefined) {
        resolve(socket);
        return;
      }
      attempts += 1;
      if (attempts > 50) {
        reject(new Error("viewer socket was not created"));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

async function startViewer(): Promise<Harness> {
  const display: DisplayInfo[] = [];
  const writes: Uint8Array[] = [];
  const events: string[] = [];
  const client = new TokimekiViewerClient({
    code: "demo-code",
    session: "demo",
    mode: "viewer",
    passcode: null,
    onWrite: (bytes) => {
      writes.push(bytes);
      events.push("write");
    },
    onSnapshot: (bytes) => {
      writes.push(bytes);
      events.push("snapshot");
    },
    onState: () => {},
    onHostOnline: () => {},
    onError: () => {},
    onDisplay: (info) => {
      display.push(info);
      events.push("display");
    },
  });
  client.start();
  const socket = await waitForSocket();
  socket.open();
  return { client, socket, display, writes, events };
}

function messagesOfType(socket: FakeSocket, type: string): Array<Record<string, unknown>> {
  return socket.sent
    .map((message) => JSON.parse(message) as Record<string, unknown>)
    .filter((message) => message.type === type);
}

async function settle(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("window", { location: { protocol: "http:", host: "localhost" } });
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("viewer e2e: TUI fixed grid", () => {
  it("applies the host grid, cancels the pre-welcome resize, buffers output, and resyncs on a grid change", async () => {
    const harness = await startViewer();

    // The page fits the viewport before welcome; TUI must cancel this resize.
    harness.client.resize(150, 40);
    harness.socket.message(outputFrame("early-output"));
    harness.socket.message(fixedHost(120, 40));
    await settle(350);

    expect(harness.display).toEqual([{ fixed: { cols: 120, rows: 40 } }]);
    expect(harness.events).toEqual(["display", "write"]);
    expect(new TextDecoder().decode(harness.writes[0])).toBe("early-output");
    expect(messagesOfType(harness.socket, "resize")).toHaveLength(0);

    harness.socket.message(
      json({
        v: 1,
        type: "presence",
        clients: [
          {
            role: "host",
            capabilities: { display: { modes: ["fixed-grid"], fixed: { cols: 100, rows: 30 } } },
          },
        ],
      }),
    );
    await settle(20);

    expect(harness.display.at(-1)).toEqual({ fixed: { cols: 100, rows: 30 } });
    expect(messagesOfType(harness.socket, "resync")).toHaveLength(1);
  });
});

describe("viewer e2e: non-TUI reflow", () => {
  it("keeps the legacy resize path and writes live output", async () => {
    const harness = await startViewer();

    harness.client.resize(100, 30);
    harness.socket.message(reflowHost());
    await settle(350);

    expect(harness.display).toEqual([{ fixed: null }]);
    const resizes = messagesOfType(harness.socket, "resize");
    expect(resizes).toHaveLength(1);
    expect(resizes[0]).toMatchObject({ cols: 100, rows: 30 });

    harness.socket.message(outputFrame("live-output"));
    expect(harness.events).toEqual(["display", "write"]);
    expect(new TextDecoder().decode(harness.writes[0])).toBe("live-output");
  });
});
