/**
 * Upstream relay handshake headers for the TokiAPI browser WS proxy.
 *
 * `clientIp` must come from the edge-set `cf-connecting-ip` header, never from
 * a client-supplied `x-real-ip`: same-zone Worker subrequests reflect
 * `x-real-ip` as the relay's `cf-connecting-ip`, which keeps relay per-IP
 * limits on the real browser IP.
 */
export interface UpstreamTarget {
  readonly url: string;
  readonly sessionJwt: string;
  readonly listener: boolean;
}

export function buildUpstreamHeaders(
  target: UpstreamTarget,
  passcode: string | null,
  clientIp: string | null,
): Headers {
  const headers = new Headers();
  headers.set("upgrade", "websocket");
  headers.set("x-tokimeki-session", target.sessionJwt);
  if (target.listener) {
    headers.set("x-tokimeki-listener", "1");
  }
  if (passcode !== null) {
    headers.set("x-tokimeki-passcode", passcode);
  }
  if (clientIp !== null && clientIp.length > 0) {
    headers.set("x-real-ip", clientIp);
  }
  return headers;
}
