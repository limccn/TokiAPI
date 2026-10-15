// Better Auth 实例工厂（M2 2.1）。
// 设计要点：
// - 每次请求由 c.env + D1 创建实例（spec environment.md：env 禁止全局缓存）。
// - D1 adapter 通过 drizzleAdapter + schema 映射，将 Better Auth 的
//   user/session/account/verification 模型映射到应用表（users/sessions/accounts/verifications）。
// - advanced.database.generateId = "serial"：用户/会话 id 由 D1 自增生成（与 M1 users.id 整数自增兼容）。
// - user.additionalFields：role/status/balance 注册为只读附加字段（input: false，客户端不可写），
//   随 session 用户对象下发；inviteCode 仅允许注册时提交（input: true），写入前由 create.before 钩子剥离。
// - user.validateUserInfo：注册/登录准入门（邀请码校验 + GitHub 白名单），
//   通过 source.method/action 区分 email-password 注册与 GitHub OAuth 流程。
// - 本文件不读任何种子用户环境开关（09-22-seed-users-dev-only）：此前"种子邮箱白名单直接放行"的
//   逃生口已整体删除 —— dev 种子用户改由 dev-only 路由自铸一次性邀请码、走与真实用户完全相同的
//   校验 + 消费链路（该 dev-only 路由已于 2026-10-14 一键发布适配中随整个 seed 脚手架移除）。
//   于是生产鉴权路径中不再存在任何"靠变量没被设置"来兜底的判定，隔离是**结构性**的而非约定性的。
//
// 赠金与邮箱验证（09-16-signup-bonus-grant）：
// - 注册赠金挂在 `databaseHooks.user.create.after` —— 该钩子**不区分 provider**，
//   email/password 与 GitHub OAuth 两条注册路径都触发（PRD R9/D4）；
//   挂 before 不行：建号失败会在库里留下孤儿赠金。
// - 邮箱验证**开关语义**：EMAIL_VERIFICATION_ENABLED 关闭（缺省）时整个 emailVerification
//   段不配置 —— 而非「配置了但内部 no-op」。后果（刻意设计）：
//     1) sendOnSignUp 一并消失 → 注册不签发验证 token、不发信；
//     2) afterEmailVerification 未接线 → 即使有人拿旧 token 打通 GET /api/auth/verify-email
//        （Better Auth 内置端点恒在）也不会发验证赠金 —— 开关关闭期间赠金结构性不可达。
// - 真发送（08-27-email-notification，2026-09-22）：sendVerificationEmail 回调接 Resend
//   （src/lib/email.ts）。**失败不在回调里 catch**：注册路径由库侧 runInBackgroundOrAwait
//   吞错（fail-open），交互式端点须上抛（fail-loud）—— 自己 catch 会让后者谎报「已发送」。
//   通道未配置（RESEND_API_KEY 空/缺失）时降级为只记 email_not_configured，不发信。
// - 不开 emailAndPassword.requireEmailVerification、不设 autoSignIn:false：
//   未验证邮箱仍可登录与调用（D3），且注册响应形状零变更
//   （Better Auth sign-up 的 shouldReturnGenericDuplicateResponse = requireEmailVerification
//    || autoSignIn === false；二者都不动 → 重复邮箱仍返回既有 422）。
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { grantEmailVerifyBonus, grantSignupBonus, isEmailVerificationEnabled } from "./bonus";
import { sendMail, verificationEmail } from "./email";
import { consumeInviteCode, validateInviteCode } from "./invites";
import { logger } from "./logger";
import { MIN_PASSWORD_LENGTH } from "./password";

// F2（安全评审）：先消费后建号 —— create.before 钩子内消费邀请码（乐观锁条件 UPDATE），
// 消费失败 return false 阻止建号，关闭「两并发同码注册都通过校验、一码两用」的重放窗口。
// 权衡：before 消费后若 Better Auth 内部建号失败 → 码被烧（一次性码语义，管理员可补发）。
import { isEmailAllowed } from "./github-whitelist";

const INVITE_CODE_REQUIRED = "INVITE_CODE_REQUIRED";
const INVITE_CODE_INVALID = "INVITE_CODE_INVALID";
const GITHUB_EMAIL_NOT_ALLOWED = "GITHUB_EMAIL_NOT_ALLOWED";

// 无显式返回类型标注：让 TS 推断 Auth<Options>，使 session.user 携带 additionalFields（role/status/balance）。
export function createAuth(env: Env, db: Db) {
  const baseUrl = env.BETTER_AUTH_URL;
  const baseOrigin = new URL(baseUrl).origin;

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: baseUrl,
    trustedOrigins: [baseOrigin],

    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),

    advanced: {
      // users.id 为 INTEGER 自增主键：由数据库生成数字 id（Better Auth 内部转字符串处理）
      database: { generateId: "serial" },
    },

    user: {
      additionalFields: {
        // 应用自有字段：只读（input: false），由服务端维护
        role: { type: "string", required: true, defaultValue: "member", input: false },
        status: { type: "string", required: true, defaultValue: "active", input: false },
        balance: { type: "number", required: true, defaultValue: 0, input: false },
        // 注册时客户端提交邀请码；create.before 钩子校验通过后剥离，不落库
        inviteCode: { type: "string", input: true },
      },
      // 准入门：email-password 注册需邀请码；GitHub OAuth 需白名单邮箱
      validateUserInfo: async ({ user, source }) => {
        if (source.method === "email-password" && source.action === "create-user") {
          const inviteCode = readInviteCode(user);
          if (inviteCode === "") {
            return { error: INVITE_CODE_REQUIRED, errorDescription: "Invite code is required for email/password signup" };
          }
          // 只校验不消费（F2：一次性码在 create.before 钩子消费，见文件头权衡注释）
          const ok = await validateInviteCode(db, inviteCode);
          if (!ok) {
            return { error: INVITE_CODE_INVALID, errorDescription: "Invalid, used or expired invite code" };
          }
          return;
        }
        if (source.method === "oauth" && source.oauth?.providerId === "github") {
          const email = typeof user.email === "string" ? user.email : "";
          if (!isEmailAllowed(env.GITHUB_ALLOWED_EMAILS, email)) {
            return { error: GITHUB_EMAIL_NOT_ALLOWED, errorDescription: "Your GitHub email is not on the allowed list" };
          }
        }
      },
    },

    emailAndPassword: {
      enabled: true,
      // 下限取自唯一真源：前端拦截文案插值同一个常量（见 src/lib/password.ts）
      minPasswordLength: MIN_PASSWORD_LENGTH,
    },

    // 邮箱验证：整段由 EMAIL_VERIFICATION_ENABLED 门控（缺省关闭 → 整段不配置，见文件头注释）。
    // 两种认证路径的影响：OAuth 用户建号即 emailVerified=true，Better Auth 在 verify-email
    // 端点会短路返回（不调 afterEmailVerification）→ OAuth 用户不获验证赠金（D5）。
    ...(isEmailVerificationEnabled(env.EMAIL_VERIFICATION_ENABLED)
      ? {
          emailVerification: {
            // D9：注册即自动发（09-22 起为**真实投递**：sendMail → Resend，见 src/lib/email.ts）
            sendOnSignUp: true,
            // 显式写出默认值，便于阅读：验证成功后自动为该邮箱建会话
            autoSignInAfterVerification: true,
            expiresIn: 60 * 60, // 1 小时（文案里的有效期说明与这里同一口径，改一处须同步另一处）
            sendVerificationEmail: async ({ user, url }) => {
              // 排障入口：记录 user id 与链接骨架（baseURL 配错会体现在这里，
              // 见 spec big-question/env-configuration）。**token 不入日志**（spec backend/security
              // 「Never log raw tokens」）—— 只留 token 参数的存在性。
              logger.info("email_verify_link_issued", {
                userId: Number(user.id),
                email: user.email,
                url: url.replace(/token=[^&]*/, "token=<redacted>"),
              });
              // **刻意不 try/catch**（design §2）：注册路径（sendOnSignUp）由 better-auth 的
              // runInBackgroundOrAwait 吞错 → 注册天然 fail-open；交互式
              // POST /api/auth/send-verification-email 是裸 await → 错误上抛给用户。
              // 在这里补 catch 会让交互式路径「谎报已发送」（返回 {status:true} 但没发），勿加。
              await sendMail(env, logger, { to: user.email, ...verificationEmail(url) });
            },
            // 完成验证 → 发放验证赠金（fail-open：赠金异常不影响验证结果）
            afterEmailVerification: async (user) => {
              await grantEmailVerifyBonus(env, db, logger, Number(user.id));
            },
          },
        }
      : {}),

    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },

    databaseHooks: {
      user: {
        create: {
          // F2：先消费后建号 —— 消费成功才放行建号（乐观锁保证并发下唯一赢家），
          // 消费失败（无效/已用/过期/并发被抢先）return false 阻止建号，关闭重放窗口。
          // 剥离 inviteCode：邀请码为一次性凭证，不随用户记录持久化。
          before: async (user) => {
            if ("inviteCode" in user) {
              // 空串不是"放行"而是"无码"：consumeInviteCode 首行即对空串返回 false ⇒ 阻止建号。
              // 这是第二道闸（email-password 注册已在 validateUserInfo 拦 INVITE_CODE_REQUIRED），
              // 也是 09-22-seed-users-dev-only 移除"空码放行"分支后空库/种子路径的兜底行为。
              const code = String(user.inviteCode ?? "").trim();
              const email = typeof user.email === "string" ? user.email.toLowerCase() : "";
              if (email === "") {
                return false;
              }
              const ok = await consumeInviteCode(db, code);
              if (!ok) {
                // 模块级 logger：钩子为非请求上下文（无 requestId）
                logger.warn("invite_code_consume_failed", { email });
                return false;
              }
              return { data: { inviteCode: undefined } };
            }
            return undefined;
          },
          // 注册赠金（R1/R9）：挂在 after —— 此时用户已落库、已有自增 id，且两条注册路径
          // （email/password 与 GitHub OAuth）都经过本钩子。fail-open 由 grantSignupBonus 保证。
          after: async (user) => {
            await grantSignupBonus(env, db, logger, Number(user.id));
          },
        },
      },
      session: {
        create: {
          // 停用用户（status='disabled'）禁止创建新会话（登录）
          before: async (session) => {
            const userId = Number(session.userId);
            const user = await db.query.users.findFirst({
              where: eq(schema.users.id, userId),
            });
            if (user && user.status === "disabled") {
              return false;
            }
            return undefined;
          },
        },
      },
    },

    // 内部日志关闭：事件由本应用结构化日志（requestContext logger）记录
    logger: { disabled: true },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

/** 从 validateUserInfo 的 user 数据中安全读取邀请码（trim + 大写归一）。 */
function readInviteCode(user: Record<string, unknown>): string {
  const raw = user.inviteCode;
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().toUpperCase();
}
