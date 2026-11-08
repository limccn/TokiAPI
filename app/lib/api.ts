// 统一 API fetch 封装（spec hooks.md：错误响应类型化）。
// 前后端同域（同一 Worker 托管 /api/* 与静态资源），一律使用相对路径。

export class ApiError extends Error {
  readonly status: number;
  /**
   * 服务端错误码（11-06-sms-alicloud-auth）。可选：多数端点只回 `{ error: { message } }`，
   * 只有明确需要前端分支的端点才带 code（如 `POST /api/me/password` 的 `PASSWORD_ALREADY_SET`）。
   * **不要**把 code 当展示文案 —— 文案映射见 `app/lib/sms-errors.ts`。
   */
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ApiErrorBody {
  error?: { message?: string; code?: string };
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    let code: string | undefined;
    try {
      const body = (await response.json()) as ApiErrorBody;
      const detail = body.error?.message;
      if (detail) {
        message = detail;
      }
      code = typeof body.error?.code === "string" ? body.error.code : undefined;
    } catch {
      // 非 JSON 错误体：保留默认消息
    }
    throw new ApiError(message, response.status, code);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** 把查询参数对象序列化为 URLSearchParams（仅写入已定义的字段）。 */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : "";
}
