// 运行期前端配置（GET /api/config，public 端点；双域名分流 09-21-dual-domain-split）。
//
// **为什么必须运行期取**：管理台展示的 API base URL 不能构建期烘焙 —— SPA 是同一份静态产物，
// 同时服务 prod（两个域名）/ stg / 本地 dev，`assets.directory` 是构建产物，`[env.*]` 改不了
// 前端 bundle。这正是 spec big-question/env-configuration.md 记录的那类坑（构建期 URL 会
// 把 localhost 或错误的域名带进线上）。
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface ApiConfig {
  /** 公开 API 域的 origin，**不带 `/v1` 后缀**（调用方按 `${apiBaseUrl}${basePath}` 拼接）。 */
  apiBaseUrl: string;
  /** 管理台域的 origin。 */
  platformBaseUrl: string;
  /**
   * 短信认证是否开启（11-06-sms-alicloud-auth）。关闭时 phone-number 插件整段不注册
   * （端点 404），所以**不能**靠调用失败来发现 —— 登录页/注册页/找回密码入口一律先读本字段。
   */
  smsAuthEnabled: boolean;
}

/** GET /api/config —— 公开端点（无需会话），故无需 enabled 门控。 */
export function useApiConfig() {
  return useQuery({
    queryKey: ["config"],
    queryFn: () => apiFetch<ApiConfig>("/api/config"),
    // 静态配置（spec hooks.md：Static config → 1hr）
    staleTime: 60 * 60 * 1000,
  });
}
