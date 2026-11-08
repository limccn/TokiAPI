// 阿里云 ACS3-HMAC-SHA256 签名（11-06-sms-alicloud-auth；design §4.2 / research R7/R8/R13）。
//
// 为什么自己实现而不引 SDK：Workers 里它只是一个 POST，`@alicloud/*` 会拖进一整套
// openapi-core + 依赖树；而签名本身不到 100 行，还有官方向量可以逐字节钉死（tests/aliyun-acs3.unit.test.ts）。
//
// 🔴 **最容易写错、而且错了还「看起来正常」的一处**（research R13，2026-11-06 实际踩过）：
//    CanonicalQueryString **只含业务参数**。`Action` / `Version` 由 `x-acs-action` /
//    `x-acs-version` 头承载，`Format` 根本不必传。把它们也塞进 query 会得到完全不同
//    的 HashedCanonicalRequest，服务端一律回 `SignatureDoesNotMatch` —— 而错误表现
//    与「AK 无效 / 权限不足」几乎一样，不看官方向量根本区分不出来。
//
// 另一个坑：`Host` 是 fetch 的 forbidden header，**不能手工设置**；但签名里必须包含它
// （值取目标域名）。运行时按请求 URL 还原，服务端也按同一个 URL 重算，故一致。
// 该路径已用真实 AccessKey 打通（Node fetch 与 workerd 同样拒设 Host）。

/** RFC3986 编码。`encodeURIComponent` 已保留 `A-Za-z0-9-_.!~*'()`，其中后五个须转义。 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replaceAll("!", "%21")
    .replaceAll("'", "%27")
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("*", "%2A");
}

/** `k=v` 按 key 升序、`&` 连接。空对象返回空串（RPC 风格下 `CanonicalQueryString` 可以为空）。 */
export function canonicalQueryString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? "")}`)
    .join("&");
}

export interface Acs3RpcInput {
  /** 目标服务域名，如 `dypnsapi.aliyuncs.com`（同时是签名里的 `host`）。 */
  host: string;
  /** 如 `SendSmsVerifyCode`（只进 `x-acs-action`，**不进 query**）。 */
  action: string;
  /** 如 `2017-05-25`（只进 `x-acs-version`，**不进 query**）。 */
  version: string;
  /** 业务参数（全部进 query）。 */
  params: Record<string, string>;
  accessKeyId: string;
  accessKeySecret: string;
  /** 请求体，缺省空串（RPC 风格 POST 无 body）。 */
  body?: string;
  /** 测试注入：固定 `x-acs-date`。 */
  date?: Date;
  /** 测试注入：固定 32 位 hex nonce。 */
  nonce?: string;
}

export interface Acs3HttpRequest {
  url: string;
  headers: Record<string, string>;
  /** 以下字段只为**可测性**暴露（官方向量要逐字节断言它们），调用方不应使用。 */
  readonly canonicalRequest: string;
  readonly hashedCanonicalRequest: string;
  readonly signedHeaders: string;
  readonly signature: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(digest);
}

async function hmacSha256Hex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return toHex(signature);
}

/** 32 位小写 hex nonce（16 随机字节）。 */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes.buffer);
}

/** `toISOString()` 去掉毫秒：阿里云要秒级 `2023-10-26T10:22:32Z`。 */
function toAcsDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * 构造一个签名完毕的 RPC 请求。返回的 `headers` **不含 `host`**（fetch 禁用），
 * 但签名集里包含它 —— 见文件头。
 */
export async function signRpcRequest(input: Acs3RpcInput): Promise<Acs3HttpRequest> {
  const { host, action, version, params, accessKeyId, accessKeySecret } = input;
  const body = input.body ?? "";
  const acsDate = toAcsDate(input.date ?? new Date());
  const nonce = input.nonce ?? randomNonce();

  // 🔴 只放业务参数（文件头第一段）
  const query = canonicalQueryString(params);
  const hashedPayload = await sha256Hex(body);

  const headersToSign: Record<string, string> = {
    host,
    "x-acs-action": action,
    "x-acs-version": version,
    "x-acs-date": acsDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-content-sha256": hashedPayload,
  };

  const signedHeaderNames = Object.keys(headersToSign).sort();
  // 每条 `name:value\n`（末尾自带换行），与 SignedHeaders 之间再由 join 的空行分隔
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${headersToSign[name]}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    "POST",
    "/",
    query,
    canonicalHeaders,
    signedHeaders,
    hashedPayload,
  ].join("\n");

  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `ACS3-HMAC-SHA256\n${hashedCanonicalRequest}`;
  const signature = await hmacSha256Hex(accessKeySecret, stringToSign);

  // accept 不在签名集内（文档明确：不在 SignedHeaders 的 header 不参与签名）
  const headers: Record<string, string> = {
    "x-acs-action": action,
    "x-acs-version": version,
    "x-acs-date": acsDate,
    "x-acs-signature-nonce": nonce,
    "x-acs-content-sha256": hashedPayload,
    accept: "application/json",
    authorization: `ACS3-HMAC-SHA256 Credential=${accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`,
  };

  return {
    url: `https://${host}/?${query}`,
    headers,
    canonicalRequest,
    hashedCanonicalRequest,
    signedHeaders,
    signature,
  };
}
