// GET /api/invites/validate?code= —— 注册页提交前的邀请码预校验（批次 U，D29）。
//
// 公开端点：挂载于 src/index.ts 的 `app.use("/api/*", requireSession())` **之前**
// （照 /api/config 公开体例）—— 注册页此时本来就没有会话，未登录必须 200（AC51）。
//
// 契约（AC51）：
//   - 恒 200 `{ success: true, valid: boolean }`；**不细分**失效原因（不存在 / 已用 /
//     过期统一 false），与 Better Auth 注册 403 的 "Invalid, used or expired invite code" 同语义；
//     缺参 / 空码统一 false（少一个错误分支）。
//   - **不消费码**：只调 validateInviteCode（只读，不置 usedAt）—— 建号前烧掉一次性码
//     会让注册失败的用户白白损失一个码。
//   - 大小写 / 空白归一由 validateInviteCode 内部完成（trim + toUpperCase），与消费侧同口径 ⇒
//     复制链接里的码、手输的码、大小写写错的码，判定一致。
//
// 限流（D30）：index.ts 对本路径挂 authRateLimit()，路径白名单在
// src/middleware/auth-rate-limit.ts（credential 桶，10/60s/IP，复用 AUTH_CREDENTIAL_LIMIT
// binding ⇒ 零配置改动）。与登录共享计数（校验 1 次 + 登录 ≤9 次每分钟），
// 副作用已由 prd D30 认可。
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { validateInviteCode } from "../../../lib/invites";
import type { ValidateInviteOutput } from "../types";

export function validateInviteRoute(app: Hono<AppEnv>): void {
  app.get("/validate", async (c) => {
    // 缺参 → undefined → 按空码处理（validateInviteCode 内 trim 后判空返回 false）
    const code = c.req.query("code") ?? "";
    const db = createDb(c.env);
    const valid = await validateInviteCode(db, code);
    const output: ValidateInviteOutput = { success: true, valid };
    return c.json(output);
  });
}
