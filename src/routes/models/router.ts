// 价格表管理模块路由：/api/models。
// requireSession 已在 index.ts 对 /api/* 全局挂载（未登录 401 由它给）。
//
// 读写分权（批次 P，09-14-admin-ui-adjustments-2 D18）：GET 任何已登录用户可读（member 只读
// 看价格表），POST/PATCH/DELETE 仍仅 admin。本资源**没有**可切的前缀（不像 billing 用 /admin
// 子应用），所以用「先注册读路由、再挂 adminOnly」这个形状。
//
// ⚠⚠ 顺序敏感（已实测，2026-09-23）：Hono 的 `app.use("*", mw)` **只作用于注册时刻之后**
// 添加的路由 —— 它是"追加到后续路由的处理器链头"，不是全局重写。故 GET 必须先注册。
//   把 `app.use("*", adminOnly())` 挪到**文件末尾** ⇒ GET 仍受保护（看着没问题），
//   但 POST/PATCH/DELETE 变成**全员可写**：member 能改价格表、能删行，而且**静默、无报错**。
//   护栏 = tests/models-api.test.ts 的「member 三个写动词全 403」三连 + 「admin 全 200」对照。
//   改本文件后**必须**跑那条测试；只看 GET 的 200/403 是查不出这个错的。
import { Hono } from "hono";
import type { AppEnv } from "../../types";
import { adminOnly } from "../../middleware/auth";
import { listModelsRoute } from "./procedures/list";
import { createModelRoute } from "./procedures/create";
import { updateModelRoute } from "./procedures/update";
import { deleteModelRoute } from "./procedures/delete";
import { syncOpenrouterRoute } from "./procedures/sync-openrouter";

const app = new Hono<AppEnv>();

listModelsRoute(app); // GET /          —— 任何已登录用户（admin 全量 / member 过滤后 + 价格置 0）
app.use("*", adminOnly()); // ↓ 以下全部仅 admin（顺序敏感：必须在 listModelsRoute 之后）
createModelRoute(app); // POST /
updateModelRoute(app); // PATCH /:id
deleteModelRoute(app); // DELETE /:id
syncOpenrouterRoute(app); // POST /sync-openrouter —— OpenRouter 价格同步（仅 admin；无 body）

export default app;
