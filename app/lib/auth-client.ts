// Better Auth 客户端（M6 6.2；spec frontend/authentication.md）。
// 使用官方 React 集成（better-auth/react）：提供 useSession() hook。
// baseURL 使用 window.location.origin —— 前后端同域（同一 Worker），无跨域 cookie 问题。
// 注意：不能用 "/" —— better-auth 内部会对 baseURL 执行 new URL(baseURL)，相对路径
// 会抛 "Invalid base URL: /"，导致整个 SPA bundle 崩溃（登录页黑屏）。
// 纯 SPA 无 SSR，模块只在浏览器加载；typeof 守卫仅为 typecheck 与未来 SSR 安全。
import { createAuthClient } from "better-auth/react";
// 短信认证（11-06-sms-alicloud-auth）：客户端插件补上 phoneNumber 命名空间
// （sendOtp / verify / requestPasswordReset / resetPassword）。
// ⚠ 客户端插件**只是类型与请求封装**，不改变服务端是否注册 —— 开关关闭时
// 这些端点 404，故调用前必须先看 useApiConfig().data?.smsAuthEnabled。
// ⚠ `setPassword` 不在这个插件里：它是 serverOnly 端点，走我们自己的 POST /api/me/password。
import { phoneNumberClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:5173",
  plugins: [phoneNumberClient()],
});
