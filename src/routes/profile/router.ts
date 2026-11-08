// 账户 Profile 模块路由（09-16-account-menu / 11-06-sms-alicloud-auth）：member 自己的资料与密码设置。
//
// 挂载位置：src/index.ts 的 `app.route("/api", profileRouter)`，**必须在
// `app.use("/api/*", requireSession())` 之后**注册，否则未登录访问不会返回 401。
//
// 路由归属：沿用「member 端点由所属**域模块**承载」的既有惯例（/api/me/usage 在 usage/、
// /api/me/transactions 在 billing/、/api/me/onboarding 在 onboarding/ 下），而非建集中式
// me 模块 —— 各任务独占目录，并行开发互不踩文件。本模块只承载 profile 端点，不搬迁既有路由。
//
// 两个端点：
//   GET  /api/me/profile  —— 只读资料（09-16-account-menu）
//   POST /api/me/password —— 为无密码账号**首次设置**密码（11-06-sms-alicloud-auth）
// 改 name 仍复用 Better Auth 内置 POST /api/auth/update-user（design §2.2），本模块不重复实现。
// 改密码（需当前密码）走 /api/auth/change-password —— 与「首次设置」是两条不同语义的路。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getProfileRoute } from "./procedures/get-profile";
import { setPasswordRoute } from "./procedures/set-password";

const app = new Hono<AppEnv>();
getProfileRoute(app);
setPasswordRoute(app);

export default app;
