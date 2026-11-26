// GET /api/tokimeki/ws — 浏览器 WebSocket 代理（relay-only）。
//
// 浏览器从不接触 Session JWT；Worker 在握手时签发 Web-JWT 并注入
// `X-Tokimeki-Session`。代理会：
//   - 校验一次性 ticket cookie + Origin；
//   - 重新校验 invite（撤销/过期/allowWeb 在 60s ticket 窗口内也生效）；
//   - 删除客户端所有 `x-tokimeki-*` 内部头；
//   - 从 welcome/ice 文本帧剥离 TURN 凭据；二进制终端帧原样透传；
//   - passcodeRequired 时等待客户端首条 `{"type":"passcode","value":...}`，
//     再连接上游并注入 `X-Tokimeki-Passcode`。
import type { Context } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import {
  findActiveInviteById,
  consumeAttachTicket,
} from "../lib/invites";
import {
  readTokimekiJwtConfig,
  signSessionJwt,
  WEB_SESSION_JWT_TTL_SECONDS,
} from "../lib/jwt";
import { buildRelayWsUrl } from "../lib/relay-url";
import {
  ATTACH_COOKIE_NAME,
  readCookie,
  relayBaseUrl,
  sanitizeRelayText,
} from "./common";
import { buildUpstreamHeaders, type UpstreamTarget } from "./ws-headers";

const UNAUTHORIZED_CLOSE = 4001;
const INTERNAL_CLOSE = 4006;
const MAX_PASSCODE_LENGTH = 128;
const MIN_PASSCODE_LENGTH = 6;

type WebSocketPairLike = { 0: WebSocket; 1: WebSocket };

async function connectUpstream(
  target: UpstreamTarget,
  passcode: string | null,
  clientIp: string | null,
): Promise<WebSocket | Response> {
  // Workers `fetch` rejects ws:// URLs; an http(s) URL with
  // `Upgrade: websocket` performs the upstream handshake.
  const upstreamUrl = new URL(target.url);
  if (upstreamUrl.protocol === "wss:") {
    upstreamUrl.protocol = "https:";
  } else if (upstreamUrl.protocol === "ws:") {
    upstreamUrl.protocol = "http:";
  }
  const headers = buildUpstreamHeaders(target, passcode, clientIp);
  const response = await fetch(upstreamUrl, { method: "GET", headers, redirect: "manual" });
  const webSocket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (response.status !== 101 || webSocket === undefined) {
    return response;
  }
  webSocket.accept();
  return webSocket;
}

function closeWithError(ws: WebSocket, code: string, message: string, closeCode: number): void {
  try {
    ws.send(JSON.stringify({ v: 1, type: "error", code, message }));
  } catch {
    // Socket already gone.
  }
  try {
    ws.close(closeCode, code);
  } catch {
    // Already closed.
  }
}

async function toSendable(data: unknown): Promise<string | ArrayBuffer | Uint8Array | null> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.arrayBuffer();
  }
  return null;
}

function pipe(server: WebSocket, upstream: WebSocket): void {
  // `fetch`-created upstream WebSockets may deliver binary frames as Blob;
  // converting them is async, so a promise chain keeps frame order intact.
  let upstreamChain = Promise.resolve();
  let downstreamChain = Promise.resolve();

  server.addEventListener("message", (event) => {
    upstreamChain = upstreamChain.then(async () => {
      const data = await toSendable(event.data);
      if (data === null) return;
      try {
        upstream.send(data);
      } catch {
        // Upstream closed.
      }
    });
  });
  upstream.addEventListener("message", (event) => {
    downstreamChain = downstreamChain.then(async () => {
      const sendable = await toSendable(event.data);
      if (sendable === null) return;
      if (typeof sendable === "string") {
        const sanitized = sanitizeRelayText(sendable);
        if (sanitized === null) return;
        try {
          server.send(sanitized);
        } catch {
          // Client closed.
        }
        return;
      }
      try {
        server.send(sendable);
      } catch {
        // Client closed.
      }
    });
  });
  server.addEventListener("close", (event) => {
    try {
      upstream.close(event.code, event.reason);
    } catch {
      // Already closed.
    }
  });
  upstream.addEventListener("close", (event) => {
    try {
      server.close(event.code, event.reason);
    } catch {
      // Already closed.
    }
  });
  server.addEventListener("error", () => {
    try {
      upstream.close(INTERNAL_CLOSE, "proxy client error");
    } catch {
      // Already closed.
    }
  });
  upstream.addEventListener("error", () => {
    try {
      server.close(INTERNAL_CLOSE, "proxy upstream error");
    } catch {
      // Already closed.
    }
  });
}

function parsePasscodeMessage(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const message = parsed as Record<string, unknown>;
  if (message.type !== "passcode" || typeof message.value !== "string") return null;
  const value = message.value;
  if (value.length < MIN_PASSCODE_LENGTH || value.length > MAX_PASSCODE_LENGTH) return null;
  return value;
}

export async function wsHandler(c: Context<AppEnv>): Promise<Response> {
  const requestUrl = new URL(c.req.url);
  // Trust only the edge-set header. A client-supplied x-real-ip is never read.
  const clientIp = c.req.header("cf-connecting-ip") ?? null;
  const requestOrigin = c.req.header("origin");
  if (requestOrigin === undefined || requestOrigin !== requestUrl.origin) {
    return c.json({ error: { message: "Forbidden" } }, 403);
  }
  const ticket = readCookie(c.req.header("cookie"), ATTACH_COOKIE_NAME);
  if (ticket === null) {
    return c.json({ error: { message: "Unauthorized" } }, 401);
  }

  const relayUrl = relayBaseUrl(c.env);
  if (relayUrl === null) {
    return c.json({ error: { message: "relay_not_configured" } }, 503);
  }
  const config = readTokimekiJwtConfig(c.env);
  if (config === null) {
    return c.json({ error: { message: "Tokimeki is not configured" } }, 503);
  }

  const db = createDb(c.env);
  const inviteId = await consumeAttachTicket(db, ticket);
  if (inviteId === null) {
    return c.json({ error: { message: "Unauthorized" } }, 401);
  }
  const invite = await findActiveInviteById(db, inviteId);
  if (invite === null) {
    return c.json({ error: { message: "Unauthorized" } }, 401);
  }
  if (!invite.allowWeb) {
    return c.json({ error: { message: "Forbidden" } }, 403);
  }

  const mode = invite.mode === "listener" ? "listener" : "viewer";
  let sessionJwt: string;
  try {
    const signed = await signSessionJwt(config, {
      sub: String(invite.createdBy ?? "anon"),
      namespace: invite.namespace,
      session: invite.session,
      scope: mode === "listener" ? "listen web" : "attach web",
      ttlSeconds: WEB_SESSION_JWT_TTL_SECONDS,
    });
    sessionJwt = signed.token;
  } catch {
    return c.json({ error: { message: "Failed to sign session token" } }, 500);
  }
  const target: UpstreamTarget = {
    url: buildRelayWsUrl(relayUrl, invite.session),
    sessionJwt,
    listener: mode === "listener",
  };
  c.header("Cache-Control", "no-store");

  // A viewer that learned from `passcode_required` retries with `?gate=1`
  // even when the invite flag was false (e.g. an anonymous host configured
  // TOKIMEKI_PASSCODE). The relay remains the enforcement point.
  const gateRequested = new URL(c.req.url).searchParams.get("gate") === "1";
  if (!invite.passcodeRequired && !gateRequested) {
    let upstream: WebSocket | Response;
    try {
      upstream = await connectUpstream(target, null, clientIp);
    } catch {
      return c.json({ error: { message: "relay_unavailable" } }, 502);
    }
    if (upstream instanceof Response) {
      const status = upstream.status === 401 ? 401 : upstream.status === 503 ? 503 : 502;
      return c.json({ error: { message: "relay_unavailable" } }, status);
    }
    const pair = new WebSocketPair() as unknown as WebSocketPairLike;
    const client = pair[0];
    const server = pair[1];
    server.accept();
    pipe(server, upstream);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Passcode gate: accept the browser socket first, consume exactly one
  // `passcode` text message, then open the upstream connection.
  const pair = new WebSocketPair() as unknown as WebSocketPairLike;
  const client = pair[0];
  const server = pair[1];
  server.accept();
  const queued: unknown[] = [];
  let gatewayStarted = false;
  let firstMessageSeen = false;

  const queueMessages = (event: MessageEvent): void => {
    if (gatewayStarted) return;
    if (!firstMessageSeen) {
      // The first frame is the gate: a passcode frame is consumed, a protocol
      // frame is forwarded by startGateway after the upstream handshake.
      firstMessageSeen = true;
      return;
    }
    queued.push(event.data);
  };
  server.addEventListener("message", queueMessages);

  const startGateway = async (raw: unknown): Promise<void> => {
    const passcode = parsePasscodeMessage(raw);
    if (passcode === null) {
      server.removeEventListener("message", queueMessages);
      closeWithError(server, "passcode_required", "a passcode is required", UNAUTHORIZED_CLOSE);
      return;
    }
    let upstream: WebSocket | Response;
    try {
      upstream = await connectUpstream(target, passcode, clientIp);
    } catch {
      closeWithError(server, "transport_failed", "relay is unavailable", INTERNAL_CLOSE);
      return;
    }
    if (upstream instanceof Response) {
      closeWithError(server, "transport_failed", "relay is unavailable", INTERNAL_CLOSE);
      return;
    }
    gatewayStarted = true;
    pipe(server, upstream);
    // Keep queueing until `pipe` is attached: messages sent between the
    // passcode and the upstream handshake (typically `hello`) must not be lost.
    server.removeEventListener("message", queueMessages);
    for (const message of queued.splice(0)) {
      const data = await toSendable(message);
      if (data === null) continue;
      try {
        upstream.send(data);
      } catch {
        break;
      }
    }
  };

  server.addEventListener(
    "message",
    (event) => {
      void startGateway(event.data);
    },
    { once: true },
  );

  // Any message that arrives after the first but before the gateway is ready
  // has already been queued by `queueMessages`.
  void c;
  return new Response(null, { status: 101, webSocket: client });
}
