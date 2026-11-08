// 认证与权限中间件（M2 2.2 / 2.5）。
// - requireSession：Bearer/会话 Cookie 鉴权（Better Auth getSession），注入 userId + role；未登录 401。
// - requireVerifiedPhone：手机号硬门禁（11-06-sms-alicloud-auth）—— 开关开启且未验证手机时
//   除 allowlist 外一律 403 PHONE_BINDING_REQUIRED。挂在 requireSession 之后、模块路由之前。
// - adminOnly：要求 role === 'admin'，否则 403。
// - selfOrAdmin：admin 放行；member 仅当路径参数 :id 等于自身 userId 时放行，否则 403。
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, UserRole } from "../types";
import { createAuth } from "../lib/auth";
import { createDb } from "../db";
import { isSmsAuthEnabled } from "../lib/phone";

export const requireSession = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const logger = c.get("logger");
    const auth = createAuth(c.env, createDb(c.env));
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      logger.warn("unauthorized_access", { path: c.req.path });
      throw new HTTPException(401, { message: "Unauthorized" });
    }

    if (session.user.status === "disabled") {
      logger.warn("disabled_user_access", {
        userId: session.user.id,
        path: c.req.path,
      });
      throw new HTTPException(403, { message: "Account disabled" });
    }

    const role: UserRole = session.user.role === "admin" ? "admin" : "member";
    c.set("session", session.session);
    c.set("user", session.user);
    c.set("userId", session.user.id);
    c.set("role", role);

    logger.info("authenticated_request", {
      userId: session.user.id,
      role,
      path: c.req.path,
    });
    await next();
  };
};

/**
 * 手机号硬门禁（11-06-sms-alicloud-auth，PRD R19 / AC30 / AC38 / design §13.4）。
 *
 * 只有 `SMS_AUTH_ENABLED` 开启时才存在：关闭（部署缺省）直接放行 —— 门禁不是「配置了但内部
 * no-op」，而是与 phone-number 插件同一开关的结构性行为。
 *
 * 判定顺序（缺一不可）：
 *   1. 开关关闭 → 放行；
 *   2. 会话用户 `phoneNumberVerified === true` → 放行；
 *   3. 绑定流程自身需要的端点（allowlist）→ 放行；
 *   4. 其余一律 403 `PHONE_BINDING_REQUIRED`。
 *
 * 判断源**只取会话**（design §13.4「二选一」）：better-auth 的 phone-number 插件把
 * phoneNumber/phoneNumberVerified 并入 user schema，`getSession` 返回的 user 行即含该列
 * （运行时已核对：internalAdapter.findSession → drizzle 全列查询）。不再按 userId 查库 ——
 * 两处都查只会让「会话说没绑、库里说绑了」这种漂移变成两个答案。
 *
 * 作用面：只挂在 `/api/*` 的会话面（index.ts 中在 requireSession 之后）。
 * `/api/auth/*`（登录/绑定/改密等）在本中间件之前挂载，`/v1/*`、`/anthropic/*` 是网关 Key
 * 鉴权、不经过这里 —— 已有 API 流量不因账号未绑手机而中断（AC39）。
 */
const PHONE_GATE_ALLOWLIST: ReadonlyArray<{ method: string; path: string }> = [
  // 绑定页要渲染资料（未绑手机时前端唯一能调的 /api/me 端点）
  { method: "GET", path: "/api/me/profile" },
  // 注册第二屏「设置密码」；时序上实际不会命中（此时手机刚验证完），保留防未来回退
  { method: "POST", path: "/api/me/password" },
];

export const requireVerifiedPhone = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    // 1. 开关关闭 = 门禁整体不存在（AC38）
    if (!isSmsAuthEnabled(c.env.SMS_AUTH_ENABLED)) {
      await next();
      return;
    }

    // 2. 已通过短信验证（插件写入 users.phone_number_verified）
    const user = c.get("user");
    if (user?.phoneNumberVerified === true) {
      await next();
      return;
    }

    // 3. 绑定流程所需端点（完整路径 + 方法精确匹配；不用前缀匹配，避免将来子路径静默扩权）
    const method = c.req.method;
    const path = c.req.path;
    if (PHONE_GATE_ALLOWLIST.some((entry) => entry.method === method && entry.path === path)) {
      await next();
      return;
    }

    // 4. 拦截。日志只记 userId + path（**不含号码**）；返回统一错误体 + 稳定 code，
    //    前端据此把用户送到 /bind-phone（不靠文案匹配）。
    c.get("logger").warn("phone_binding_required_blocked", {
      userId: c.get("userId"),
      path,
    });
    return c.json(
      {
        error: {
          message: "Phone number verification required.",
          code: "PHONE_BINDING_REQUIRED",
        },
      },
      403,
    );
  };
};

export const adminOnly = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (c.get("role") !== "admin") {
      c.get("logger").warn("admin_only_access_denied", {
        userId: c.get("userId"),
        path: c.req.path,
      });
      throw new HTTPException(403, { message: "Forbidden" });
    }
    await next();
  };
};

export const selfOrAdmin = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    if (c.get("role") === "admin") {
      await next();
      return;
    }
    const userId = c.get("userId");
    const targetId = c.req.param("id");
    if (!targetId || targetId !== userId) {
      c.get("logger").warn("self_or_admin_access_denied", {
        userId,
        targetId,
        path: c.req.path,
      });
      throw new HTTPException(403, { message: "Forbidden" });
    }
    await next();
  };
};
