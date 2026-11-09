// POST /api/me/password —— 为**当前已登录用户**设置密码（11-06-sms-alicloud-auth，design §5.4）。
//
// 为什么需要这条端点：手机号注册的账号初始没有密码（users 表由 phone-number 插件建，
// accounts 表没有 `providerId='credential'` 行）。PRD R4/R12 要求这类账号能补设密码、
// 之后可用「手机号 + 密码」登录。而 Better Auth 的 `setPassword` 是
// `createAuthEndpoint.serverOnly(...)` —— **不经 HTTP 暴露**，客户端 SDK 上也没有对应方法，
// 所以只能由服务端包一层。
//
// 三条边界（改这个文件前先读）：
//   1. **只设置、不覆盖**：已有密码的账号调用它会被库以 `PASSWORD_ALREADY_SET`（400）拒绝。
//      改密仍走 `/api/auth/change-password`（要求当前密码）—— 这条路径永远不能变成
//      「会话在手就能静默换密码」，否则一次会话劫持就等于永久接管。
//   2. **鉴权是双层的**：本路由挂在 `requireSession()` 之后（index.ts），且库的
//      `sensitiveSessionMiddleware` 还会要求会话足够新（缺省 1 天）。未登录 → 401。
//   3. **不入限流桶**：与既有 `/api/auth/change-password` 同为已认证端点，匿名攻击面之外
//      （auth-rate-limit.ts 的白名单只收匿名路径）。
//
// 错误映射：库抛 `APIError` 时把 `statusCode` + `body.message`（有 code 时一并带上）
// **直接回统一错误体 `{error:{message, code?}}`，不走 HTTPException** —— 全局 onError
// 只透传 message，会把库的 code 丢掉，而前端要靠 `PASSWORD_ALREADY_SET` 区分分支
//（详见下方 catch 内注释）。前端因此能拿到稳定语义（以及 400 而不是 500）；
// 其余异常一律上抛交给全局 onError（那才是真 500，不能被这里吞成 400）。
import { zValidator } from "@hono/zod-validator";
import { isAPIError } from "better-auth/api";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { createAuth } from "../../../lib/auth";
import { MIN_PASSWORD_LENGTH } from "../../../lib/password";

// 下限取自唯一真源（src/lib/password.ts）：与前端文案插值、库的
// `emailAndPassword.minPasswordLength` 同一口径，三处不得各写一个数字。
const bodySchema = z.object({
  newPassword: z.string().min(MIN_PASSWORD_LENGTH),
});

export function setPasswordRoute(app: Hono<AppEnv>): void {
  app.post("/me/password", zValidator("json", bodySchema), async (c) => {
    const logger = c.get("logger");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底（同 get-profile）
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const { newPassword } = c.req.valid("json");

    const auth = createAuth(c.env, createDb(c.env));
    try {
      await auth.api.setPassword({
        body: { newPassword },
        // 只传 newPassword、**不传 currentPassword**：本端点的语义就是「首次设置」；
        // 库用 sensitiveSessionMiddleware 校验会话（cookie 在原始请求头里）。
        headers: c.req.raw.headers,
      });
    } catch (err) {
      if (isAPIError(err)) {
        // 只认 4xx/5xx 的合法区间；库给出怪值时收敛到 400（宁可让用户看到可读错误，
        // 也不要让 Hono 因非法状态码抛二次异常）
        const status = (
          err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400
        ) as ContentfulStatusCode;
        const message = err.body?.message ?? "Password not set";
        const code = err.body?.code;
        logger.warn("me_password_set_rejected", { userId, status, code });
        // **刻意直接回 JSON、不用 HTTPException**：全局 onError 只透传 message，
        // 会把库的 code 丢掉 —— 而 AC23 的判据就是 `PASSWORD_ALREADY_SET` 这个 code
        //（前端据此把「已有密码，请走改密码」与其它失败区分开；靠文案匹配跨库版本必脆）。
        // 形态仍是统一错误体 `{error:{message}}`，只是在有 code 时多一个字段（纯增量）。
        return c.json({ error: { message, ...(code === undefined ? {} : { code }) } }, status);
      }
      throw err;
    }

    // 只记 userId：密码、哈希、长度都不入日志（spec backend/security）
    logger.info("me_password_set", { userId });
    return c.json({ status: true });
  });
}
