// GET /api/me/profile —— 当前 member 自己的账号资料（name/email/emailVerified + 验证开关 + hasPassword）。
// userId 取自会话（/me 路径天然 self；admin 也看自己的资料）。
//
// 数据取**服务端最新值**（单表主键查询），不从 session 透传：session 可能因 staleTime 滞后，
// 且 SessionUser 不含 emailVerified 与开关。返回值只暴露 profile 契约里的字段 ——
// role/balance/status 等应用自有字段不下发（本端点无此需求，少暴露一分是一分）。
//
// 为什么下发 hasPassword（09-17-change-password）：它是前端「改密码区块是否渲染」的**唯一**判据。
// 前端拿不到 accounts 表，也不该从 session 推导 —— 判据若在两处实现必然漂移，而漂移的两种方向
// 代价不对称（详见 design §3.1）：说 true 而库说 false 只是多一次被拒的提交；说 false 而库说 true
// 会让合法邮箱用户永久失去自助改密入口。故本端点必须给出与库同口径、且取**宽容侧**的答案。
import { and, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { createDb } from "../../../db";
import { accounts, users } from "../../../db/schema";
import { isEmailVerificationEnabled } from "../../../lib/bonus";
import { isSmsAuthEnabled, maskPhone } from "../../../lib/phone";
import { isAdminEmail } from "../../../lib/admin-emails";
import type { ProfileOutput } from "../types";

export function getProfileRoute(app: Hono<AppEnv>): void {
  app.get("/me/profile", async (c) => {
    const logger = c.get("logger");
    const userId = Number(c.get("userId"));
    if (!Number.isInteger(userId) || userId <= 0) {
      // requireSession 正常已注入；防御性兜底（同 me-transactions）
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    const db = createDb(c.env);

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: {
        name: true,
        email: true,
        emailVerified: true,
        phoneNumber: true,
        phoneNumberVerified: true,
      },
    });
    if (!user) {
      // 会话有效但用户行已消失（理论不可达）：显式 404 而非返回空壳资料
      throw new HTTPException(404, { message: "User not found" });
    }

    // 开关值来自 isEmailVerificationEnabled（唯一解析点，与 src/lib/auth.ts 门控同一函数）；
    // 本文件不得写 env.X === "true" —— 否则两处解析漂移会让「有开关无入口/有入口无开关」。
    const emailVerificationEnabled = isEmailVerificationEnabled(
      c.env.EMAIL_VERIFICATION_ENABLED,
    );
    // 同上：开关解析只有一个真源（src/lib/phone.ts），本文件不得自写字符串比较
    const smsAuthEnabled = isSmsAuthEnabled(c.env.SMS_AUTH_ENABLED);
    // 门禁后门（11-08 R8 / D7）：与 src/middleware/auth.ts 的放行分支同一判据、同一函数。
    // 只有开关开启时后端门禁才存在，故前置 smsAuthEnabled（关闭时该字段恒 false，
    // 前端 `phoneNumberVerified || phoneGateBypassed` 也不会因此产生行为差异）。
    // emailVerified 是安全边界：未验证邮箱可经 changeEmail 立即自写，不能作为管理员自证依据。
    const phoneGateBypassed =
      smsAuthEnabled &&
      user.emailVerified === true &&
      isAdminEmail(c.env.ADMIN_EMAILS, user.email);

    // 凭据账号存在性 —— 刻意**不判 issuer**（design §3.1 / prd D7）。
    // 库的 findCredentialAccount 还匹配 issuer=createLocalAccountIssuer('credential') 与
    // accountId，但把 issuer 硬编码进来只会带来一种失败：库将来改了 issuer 编码而我们失配，
    // 于是合法邮箱用户被判 false → 改密入口消失。而这里判宽了的那一侧（判 true 而库判 false）
    // 只会在提交时被库以 CREDENTIAL_ACCOUNT_NOT_FOUND 拒绝，用户看到错误提示，无安全后果。
    // 现实中前者不可达：providerId 与 issuer 是库建号时同批写入的。
    // 若库改了 providerId 取值（非 issuer），本判据需同步 —— 由 tests/change-password.test.ts 锁住。
    const credential = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.userId, userId),
        eq(accounts.providerId, "credential"),
      ),
      columns: { password: true },
    });
    const hasPassword = Boolean(credential?.password);

    // GitHub 绑定状态（11-06-sms-alicloud-auth，PRD R16 / design §13.3）：OAuth 建号与
    // 已登录用户的 link-social 都会在 accounts 落 providerId='github' 的行，故存在性即绑定状态。
    // 只查存在性、只下发布尔 —— accountId / token 不属 profile 契约。
    const githubAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.userId, userId), eq(accounts.providerId, "github")),
      columns: { id: true },
    });
    const githubLinked = githubAccount !== undefined;

    logger.info("me_profile_reported", {
      userId,
      emailVerified: user.emailVerified,
      emailVerificationEnabled,
      smsAuthEnabled,
      // 号码只记打码形态（本人数据，但日志不需要明文；与 sms.ts 同一函数）
      phone: user.phoneNumber === null ? null : maskPhone(user.phoneNumber),
      phoneNumberVerified: user.phoneNumberVerified,
      phoneGateBypassed,
      // 布尔值本身不敏感（不泄露哈希/凭据内容），但线上排障需要它来判断「用户看不到入口」
      // 是判据错了还是账户形态确实如此
      hasPassword,
      githubLinked,
    });

    const output: ProfileOutput = {
      success: true,
      profile: {
        name: user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        emailVerificationEnabled,
        hasPassword,
        phoneNumber: user.phoneNumber,
        phoneNumberVerified: user.phoneNumberVerified,
        smsAuthEnabled,
        phoneGateBypassed,
        githubLinked,
      },
    };
    return c.json(output);
  });
}
