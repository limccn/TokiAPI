// Tokimeki relay URL 校验与上游 WebSocket URL 组装（11-18-tokimeki-share-link-attach）。
//
// relay URL 只来自部署配置（前端只读展示，禁止用户填写，避免 SSRF）。
// 允许 https/wss 与本地 http/ws；拒绝 userinfo、query、fragment；路径统一改写为
// `/ws/<session>`（部署级 relay 没有自定义 path 语义）。

const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type RelayUrlError =
  | "missing"
  | "invalid_url"
  | "unsupported_protocol"
  | "userinfo"
  | "query"
  | "fragment"
  | "invalid_session";

export type RelayUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: RelayUrlError };

/** Validate and normalize the deployment relay base URL (origin only). */
export function parseRelayBaseUrl(raw: string | undefined): RelayUrlResult {
  const text = raw?.trim() ?? "";
  if (text.length === 0) {
    return { ok: false, error: "missing" };
  }
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "invalid_url" };
  }
  if (!["https:", "wss:", "http:", "ws:"].includes(parsed.protocol)) {
    return { ok: false, error: "unsupported_protocol" };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: "userinfo" };
  }
  if (parsed.search.length > 0) {
    return { ok: false, error: "query" };
  }
  if (parsed.hash.length > 0) {
    return { ok: false, error: "fragment" };
  }
  const protocol = parsed.protocol === "https:" || parsed.protocol === "wss:" ? "wss:" : "ws:";
  return { ok: true, url: `${protocol}//${parsed.host}` };
}

/** Build `wss://<relay>/ws/<session>` from a validated base URL. */
export function buildRelayWsUrl(baseUrl: string, session: string): string {
  if (!SESSION_PATTERN.test(session)) {
    throw new Error("invalid session id");
  }
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  url.pathname = `/ws/${session}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** True when `session` is a safe `<namespace>.<slug>`-compatible session id. */
export function isSafeSessionId(session: string): boolean {
  return SESSION_PATTERN.test(session);
}
