// Better Auth 实例工厂（M2 2.1）。
// 设计要点：
// - 每次请求由 c.env + D1 创建实例（spec environment.md：env 禁止全局缓存）。
// - D1 adapter 通过 drizzleAdapter + schema 映射，将 Better Auth 的
//   user/session/account/verification 模型映射到应用表（users/sessions/accounts/verifications）。
// - advanced.database.generateId = "serial"：用户/会话 id 由 D1 自增生成（与 M1 users.id 整数自增兼容）。
// - user.additionalFields：role/status/balance 注册为只读附加字段（input: false，客户端不可写），
//   随 session 用户对象下发；inviteCode 仅允许注册时提交（input: true），写入前由 create.before 钩子剥离。
// - user.validateUserInfo：注册准入门（邀请码校验），通过 source.method/action 区分
//   email-password 注册、手机号注册与 GitHub OAuth 流程。GitHub **不再**有邮箱白名单门槛
//   （11-06-sms-alicloud-auth：白名单改名为 ADMIN_EMAILS，语义变为「自动提权名单」，
//   见下方 databaseHooks 与 src/lib/admin-emails.ts）。
// - 本文件不读任何种子用户环境开关（09-22-seed-users-dev-only）：此前"种子邮箱白名单直接放行"的
//   逃生口已整体删除 —— dev 种子用户改由 dev-only 路由自铸一次性邀请码、走与真实用户完全相同的
//   校验 + 消费链路（该 dev-only 路由已于 2026-10-14 一键发布适配中随整个 seed 脚手架移除）。
//   于是生产鉴权路径中不再存在任何"靠变量没被设置"来兜底的判定，隔离是**结构性**的而非约定性的。
//
// 赠金与邮箱验证（09-16-signup-bonus-grant；11-08-reward-semantics-overhaul 改语义）：
// - 三档赠金挂**绑定动作**，不挂建号（语义矩阵见 src/lib/bonus.ts 文件头）：
//     · signup_bonus ← phoneNumber 插件的 `callbackOnVerification`（手机号注册 / 已登录绑定手机）；
//     · email_verify_bonus ← `emailVerification.afterEmailVerification`（邮箱绑定并验证）；
//     · github_bind_bonus ← `databaseHooks.account.create.after` 且 providerId === "github"
//       （是否算「注册后绑定」由 grantGithubBindBonus 的库内证据判定，钩子不做启发式）。
//   `databaseHooks.user.create.after` **不再发钱** —— 邮箱注册与 GitHub 注册建号时零发放；
//   挂 before 也从来不行：建号失败会在库里留下孤儿赠金。
// - 邮箱验证**开关语义**：EMAIL_VERIFICATION_ENABLED 关闭（缺省）时整个 emailVerification
//   段不配置 —— 而非「配置了但内部 no-op」。后果（刻意设计）：
//     1) sendOnSignUp 一并消失 → 注册不签发验证 token、不发信；
//     2) afterEmailVerification 未接线 → 即使有人拿旧 token 打通 GET /api/auth/verify-email
//        （Better Auth 内置端点恒在）也不会发邮箱绑定赠金 —— 开关关闭期间该档结构性不可达。
// - 存量账号冻结：迁移把上线前的用户全部置 users.bonus_eligible=false，三档一律不发；
//   判据在 src/lib/bonus.ts 的包装层（钩子本身不分支）。
// - 真发送（08-27-email-notification，2026-09-22）：sendVerificationEmail 回调接 Resend
//   （src/lib/email.ts）。**失败不在回调里 catch**：注册路径由库侧 runInBackgroundOrAwait
//   吞错（fail-open），交互式端点须上抛（fail-loud）—— 自己 catch 会让后者谎报「已发送」。
//   通道未配置（RESEND_API_KEY 空/缺失）时降级为只记 email_not_configured，不发信。
// 短信认证（11-06-sms-alicloud-auth）：
// - phoneNumber 插件由 SMS_AUTH_ENABLED 门控，关闭时**整段不注册**（端点结构性 404，
//   同 emailVerification 的手法）；发码一律经 src/lib/sms.ts 的 sendSmsCode（三道静默门 + 四类抛错）。
// - 手机号注册与邮箱注册是**两条独立路径**（PRD：两类账号允许单独存在），但共用同一套
//   邀请码准入门与赠金钩子 —— 换渠道不等于绕过准入。
// - 占位邮箱随机生成、不可由号码推导（见 plugins 段的 🔴 注释）。
// - 不开 emailAndPassword.requireEmailVerification、不设 autoSignIn:false：
//   未验证邮箱仍可登录与调用（D3），且注册响应形状零变更
//   （Better Auth sign-up 的 shouldReturnGenericDuplicateResponse = requireEmailVerification
//    || autoSignIn === false；二者都不动 → 重复邮箱仍返回既有 422）。
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { phoneNumber } from "better-auth/plugins";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db";
import * as schema from "../db/schema";
import { isAdminEmail, parseAdminEmails } from "./admin-emails";
import {
  grantEmailVerifyBonus,
  grantGithubBindBonus,
  grantSignupBonus,
  isEmailVerificationEnabled,
} from "./bonus";
import { sendMail, verificationEmail } from "./email";
import { consumeInviteCode, validateInviteCode } from "./invites";
import { logger } from "./logger";
import { MIN_PASSWORD_LENGTH } from "./password";
import {
  SMS_CODE_TTL_SECONDS,
  buildPhonePlaceholderEmail,
  isCanonicalPhone,
  isSmsAuthEnabled,
  toNationalNumber,
} from "./phone";
import { sendSmsCode } from "./sms";

// F2（安全评审）：先消费后建号 —— create.before 钩子内消费邀请码（乐观锁条件 UPDATE），
// 消费失败 return false 阻止建号，关闭「两并发同码注册都通过校验、一码两用」的重放窗口。
// 权衡：before 消费后若 Better Auth 内部建号失败 → 码被烧（一次性码语义，管理员可补发）。

const INVITE_CODE_REQUIRED = "INVITE_CODE_REQUIRED";
const INVITE_CODE_INVALID = "INVITE_CODE_INVALID";
/** 短信注册时号码形态非法（非 `+86` 规范形）。与既有三条同源：都是 validateUserInfo 的返回值。 */
const SMS_PHONE_INVALID = "SMS_PHONE_INVALID";

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

    account: {
      accountLinking: {
        // GitHub 绑定（11-06-sms-alicloud-auth，PRD R16 / AC36）。
        // 手机号注册的账号邮箱是占位地址（`…@phone.invalid`），与 GitHub 的真实邮箱**必然不同**；
        // better-auth 1.7 的 linkSocial 回调默认 `allowDifferentEmails=false`
        // （api/routes/callback.mjs: 邮箱不等 ⇒ EMAIL_DOES_NOT_MATCH），绑定会直接失败。
        // 只放开「已登录用户显式 linkSocial」这一条路径：它本身就是当前会话的主动授权动作，
        // 且仍受库的另两道检查约束 —— accountLinking.enabled !== false 与
        // GitHub 邮箱已验证（trustedProviders 未包含 github 时要求 userInfo.emailVerified）。
        // **不**影响隐式关联（同邮箱 OAuth 登录）：那条走 oauth2/link-account.mjs，
        // 由独立的 requireLocalEmailVerified（默认 true）守卫，本开关不参与。
        allowDifferentEmails: true,
      },
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
      // 邮箱绑定（11-06-sms-alicloud-auth，PRD R15 屏 3 / design §13.5）。
      // 只新增这一段，不改既有 emailVerification 段（开关语义不变）。
      // 手机号账号的占位邮箱 emailVerified=false ⇒ 命中 canUpdateWithoutVerification 分支：
      // 新邮箱**立即写入**，随后（EMAIL_VERIFICATION_ENABLED=true 时）向新地址发验证信；
      // 验证完成后 emailVerified=true，既有 afterEmailVerification 照常发验证赠金。
      // 前端据 profile.emailVerificationEnabled 决定是否显示入口（关闭时第三屏只剩 Skip）。
      changeEmail: {
        enabled: true,
        updateEmailWithoutVerification: true,
      },
      // 准入门：email-password / 手机号注册需邀请码（GitHub OAuth 已开放，无邮箱名单门槛）
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
        // 短信注册（11-06-sms-alicloud-auth，design §5.2）：与 email-password **同一套邀请码语义**
        // —— 不因为换了个渠道就绕过准入门。触发点已实证：`/phone-number/verify` 的注册分支调
        // `createUser(..., { method: "phone-number" })`；verify 的 body schema 带 `z.record`，
        // 故 `inviteCode` 能随 body 透传到 user 数据（create 过滤后保留 input:true 的字段）。
        // 消费仍由既有 create.before 完成（它只看 `"inviteCode" in user`，与 provider 无关），
        // 这里只校验不消费 —— 与上面 email-password 分支同构。
        if (source.method === "phone-number" && source.action === "create-user") {
          const phone = typeof user.phoneNumber === "string" ? user.phoneNumber : "";
          // 防御纵深：插件侧已用 phoneNumberValidator 挡过一次，这里是落库前最后一道。
          // 存进去的号码形态若与白名单/登录比对用的规范形不一致，同一号码会变成两个身份。
          if (!isCanonicalPhone(phone)) {
            return { error: SMS_PHONE_INVALID, errorDescription: "Invalid phone number" };
          }
          const inviteCode = readInviteCode(user);
          if (inviteCode === "") {
            return { error: INVITE_CODE_REQUIRED, errorDescription: "Invite code is required for phone signup" };
          }
          const ok = await validateInviteCode(db, inviteCode);
          if (!ok) {
            return { error: INVITE_CODE_INVALID, errorDescription: "Invalid, used or expired invite code" };
          }
          return;
        }
        // GitHub OAuth：**开放注册**（11-06-sms-alicloud-auth，PRD R17 / AC31）。
        // 此处刻意没有分支 —— 旧的白名单拒绝分支已随语义改版删除；
        // ADMIN_EMAILS 只影响建号后的自动提权，不构成登录准入。
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

    // 短信认证（11-06-sms-alicloud-auth，design §5.1）。**开关关闭时整段不存在** ——
    // 与上面的 emailVerification 同一手法：不是「注册了但内部 no-op」，而是
    // `/api/auth/phone-number/*` 与 `/api/auth/sign-in/phone-number` **结构性 404**。
    // 好处是不必依赖回调里的开关判断来守端点（漏判即线上敞口），代价是关闭态下
    // 前端必须读 /api/config 才知道要不要渲染短信入口（smsAuthEnabled）。
    plugins: isSmsAuthEnabled(env.SMS_AUTH_ENABLED)
      ? [
          phoneNumber({
            // 有效期常量与前端文案共用（src/lib/phone.ts）—— 写死两处必漂
            expiresIn: SMS_CODE_TTL_SECONDS,
            otpLength: 6,
            allowedAttempts: 3,
            // 只认规范形：非 +86 号码在插件层就被 400 掉，不会进入验证码存储
            phoneNumberValidator: (value) => isCanonicalPhone(value),
            // 注册赠金（11-08 语义 = **手机验证赠金**）：手机号注册成功与「已登录用户绑定手机」
            // 两条路径都会走到这里（routes.mjs 的 register / updatePhoneNumber 两个分支）。
            // 找回密码（reset）不触发本回调（库内该路径直调 verifyPhoneNumberOTP）—— 语义正确：
            // 重置密码既不是注册也不是绑定。资格判定（存量账号冻结）在 grantSignupBonus 内部，
            // 这里不做分支；fail-open 同样由它保证（赠金异常不让验证失败）。
            callbackOnVerification: async ({ user }) => {
              await grantSignupBonus(env, db, logger, Number(user.id));
            },
            // 🔴 **不配 `verifyOTP`**：配了它，校验就整体交给外部（阿里云侧的数字码），
            // 而 reset-password 链路读不到阿里云的答案（research R4）。本仓采 B 模式：
            // 自己生成/存储/校验，阿里云只负责投递。
            // 两个回调都直连 sendSmsCode —— 三/七分支门控（开关/AK/白名单/配置）都在那里，
            // 这里不重复判断；抛错语义也一致（交互式端点 fail-loud）。
            // purpose 决定模板 CODE（SMS_TEMPLATE_CODE vs SMS_TEMPLATE_CODE_RESET）：
            // 阿里云五个赠送模板只是文案不同，找密码用 100003 更贴合场景。
            sendOTP: async ({ phoneNumber: phone, code }) => {
              await sendSmsCode(env, logger, { phoneNumber: phone, code, purpose: "login" });
            },
            sendPasswordResetOTP: async ({ phoneNumber: phone, code }) => {
              await sendSmsCode(env, logger, { phoneNumber: phone, code, purpose: "reset" });
            },
            signUpOnVerification: {
              // users.email 是 UNIQUE NOT NULL，手机号注册必须造一个占位邮箱。
              // 格式与随机段的必要性见 src/lib/phone.ts 的 buildPhonePlaceholderEmail
              // （单一真源：admin 解绑邮箱时的重置地址用同一函数，11-08 R10 / design §14.3）。
              // 识别统一走同文件的 isPlaceholderEmail（后缀判据，新旧格式同时命中）。
              getTempEmail: (phone) => buildPhonePlaceholderEmail(phone),
              // 名称只取后四位：前端展示用，不构成身份（完整号码不落在 name 里）
              getTempName: (phone) => `User ${toNationalNumber(phone).slice(-4)}`,
            },
          }),
        ]
      : [],

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
          // 建号**不发赠金**（11-08-reward-semantics-overhaul）：注册赠金改挂手机验证
          //（phoneNumber.callbackOnVerification），邮箱/GitHub 注册建号时零发放。
          // 这里只保留管理员名单自动提权。
          after: async (user) => {
            // 管理员名单自动提权（PRD R17 / AC32，design §13.1 触发点①）：建号即判定 ——
            // 覆盖「全新部署没有 admin，第一个命中名单的账号免手工 UPDATE」的 bootstrap 场景。
            // 与注册渠道无关（GitHub / 邮箱 / 手机一视同仁），也**不受**
            // EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED 约束 —— 那个开关只拦人工提升
            //（PATCH /api/users/:id）；本路径由部署方亲自维护的名单直接授权。
            const userId = Number(user.id);
            const email = typeof user.email === "string" ? user.email : "";
            if (Number.isInteger(userId) && userId > 0 && email !== "") {
              await promoteAdminIfListed(env, db, { id: userId, email });
            }
          },
        },
      },
      account: {
        create: {
          // GitHub 绑定赠金（11-08-reward-semantics-overhaul）：account.create.after 对应
          // 「新建一个 OAuth/凭据账户行」。GitHub OAuth 首登时该钩子同样触发 —— 是否算
          // 「注册后绑定」由 grantGithubBindBonus 的**库内证据判定**（phone_number 非空 /
          // 存在 credential 账户行）决定，钩子本身不做启发式。
          // 非 github 的 provider（email/password 建 credential 行等）在包装里直接返回：
          // 一次函数调用 + 一次字符串比较，零查询开销。
          after: async (account) => {
            await grantGithubBindBonus(
              env,
              db,
              logger,
              Number(account.userId),
              account.providerId,
            );
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
          // 管理员名单自动提权（design §13.1 触发点②）：**每次登录**重新判定，
          // 覆盖「账号先存在、后加进名单」的场景（部署方改名单后无需等用户重新注册）。
          // 只升不降由 promoteAdminIfListed 的条件 UPDATE 保证。
          after: async (session) => {
            // 空名单 = 无人自动提权（部署缺省）：跳过用户查询，登录路径零额外开销。
            if (parseAdminEmails(env.ADMIN_EMAILS).length === 0) {
              return;
            }
            const userId = Number(session.userId);
            if (!Number.isInteger(userId) || userId <= 0) {
              return;
            }
            try {
              const user = await db.query.users.findFirst({
                where: eq(schema.users.id, userId),
                columns: { id: true, email: true },
              });
              if (user) {
                await promoteAdminIfListed(env, db, user);
              }
            } catch (error) {
              // 提权失败**不得**阻断登录（fail-open）：登录能力优先于角色正确性。
              logger.error("admin_email_promotion_failed", {
                userId,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          },
        },
      },
    },

    // 内部日志关闭：事件由本应用结构化日志（requestContext logger）记录
    logger: { disabled: true },
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;

/**
 * ADMIN_EMAILS 命中则把账号提升为 admin（PRD R17 / AC32，design §13.1）。
 *
 * **只升不降**：条件 UPDATE 带 `role != 'admin'` —— 自动逻辑从不把 admin 降回 member，
 * 人工降级后也不会被下一次登录弹回来（部署方若想停用某邮箱的自动提权，把它移出名单；
 * 想把已降级的账号留在 member，移出名单后即可保持）。这也让重复登录成为零写操作。
 *
 * **fail-open**：任何异常只记 admin_email_promotion_failed，不抛出 —— 自动提权是便利功能，
 * 不该让注册/登录失败（登录能力优先于角色正确性）。
 *
 * 不检查 EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED：那个开关只约束人工提升动作
 *（PATCH /api/users/:id 的写边界），本函数由部署方维护的名单直接授权。
 *
 * 🔴 已知边界（11-08 code check MEDIUM，未在本轮修改）：本判据只比邮箱字符串，不要求
 * emailVerified。`changeEmail` 在 `updateEmailWithoutVerification: true` 下会把**未验证**的
 * 新地址立即写库，再触发一次登录即可被自动提权。手机门禁后门（src/middleware/auth.ts）
 * 已要求 emailVerified；本处未收紧是因为 `EMAIL_VERIFICATION_ENABLED=false` 的部署上邮箱
 * 密码账号可以长期 emailVerified=false，收紧会让合法管理员无法自动提权（11-06 行为变更）。
 * 待所有者决定：要么开启邮箱验证，要么在此处加 emailVerified 并接受该部署形态的回归。
 */
async function promoteAdminIfListed(
  env: Env,
  db: Db,
  user: { id: number; email: string },
): Promise<void> {
  try {
    if (!isAdminEmail(env.ADMIN_EMAILS, user.email)) {
      return;
    }
    const updated = await db
      .update(schema.users)
      .set({ role: "admin" })
      .where(and(eq(schema.users.id, user.id), ne(schema.users.role, "admin")))
      .returning({ id: schema.users.id });
    if (updated.length > 0) {
      // 模块级 logger：钩子为非请求上下文（无 requestId）。只记 userId，
      // 邮箱与名单内容不入日志（部署侧配置，不随请求泄漏）。
      logger.info("admin_email_promoted", { userId: user.id });
    }
  } catch (error) {
    logger.error("admin_email_promotion_failed", {
      userId: user.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 从 validateUserInfo 的 user 数据中安全读取邀请码（trim + 大写归一）。 */
function readInviteCode(user: Record<string, unknown>): string {
  const raw = user.inviteCode;
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().toUpperCase();
}
