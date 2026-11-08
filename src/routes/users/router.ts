// 用户管理模块路由（M2 2.6）：/api/users/*（admin）。
// requireSession 已在 index.ts 对 /api/* 全局挂载；本模块再挂 adminOnly。
// 注意：/invites 必须注册在 /:id 之前（Hono 按注册顺序匹配）。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { listUsersRoute } from "./procedures/list";
import { updateUserRoute } from "./procedures/update";
import { unbindGithubRoute } from "./procedures/unbind-github";
import { unbindEmailRoute } from "./procedures/unbind-email";
import { deleteUserRoute } from "./procedures/delete";
import { createInviteRoute } from "./procedures/create-invite";
import { listInvitesRoute } from "./procedures/list-invites";
import { adjustBalanceRoute } from "./procedures/adjust-balance";

const app = new Hono<AppEnv>();

app.use("*", adminOnly());

listUsersRoute(app); // GET /
createInviteRoute(app); // POST /invites
listInvitesRoute(app); // GET /invites
updateUserRoute(app); // PATCH /:id
// 解绑身份（11-08 R10）：段数不同不会与 DELETE /:id 误匹配，注册在其前只为可读
unbindGithubRoute(app); // DELETE /:id/github
unbindEmailRoute(app); // DELETE /:id/email
deleteUserRoute(app); // DELETE /:id
adjustBalanceRoute(app); // POST /:id/balance

export default app;
