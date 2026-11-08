// 账户 Profile 模块（09-16-account-menu）：GET /api/me/profile（member 自己，只读）。
//
// 为什么只读、为什么不复用 session（design §1）：
// - name 的写入走 Better Auth 内置 POST /api/auth/update-user —— 库内部硬拦 email 改动
//   （结构性满足「不支持改邮箱」），且更新后回写 session cookie → 前端 session store
//   立即拿到新值。自建写端点只会多一条与库行为可能漂移的路径。
// - session 下发的 SessionUser（app/lib/session.ts）不含 emailVerified 与验证开关，
//   且可能因 staleTime 滞后；本端点一次给全 Dialog 渲染所需的服务端最新值。
//
// 前后端唯一真源：前端 app/modules/profile/types.ts 从本文件 re-export（type-safety spec），
// 前端不另写一份字段联合 —— 改契约只改这里。
import { z } from "zod";

// ============= 输出 Schemas =============

export const profileSchema = z.object({
  name: z.string(),
  email: z.string(),
  emailVerified: z.boolean(),
  /**
   * 邮箱验证功能总开关（EMAIL_VERIFICATION_ENABLED env 经 isEmailVerificationEnabled 解析的
   * 生效值，非原始字符串）。关闭时前端不展示「重新发送验证邮件」入口（R7/AC9）——
   * 该判断必须走本字段，不能靠调用失败来发现（开关关闭时 emailVerification 段整段不存在）。
   */
  emailVerificationEnabled: z.boolean(),
  /**
   * 该用户是否持有密码凭据（09-17-change-password）。前端「Password 区块是否渲染」的**唯一**
   * 判据 —— 前端不得自行从 session/accounts 推导（design §3.2）。
   * 判据取宽容侧：只匹配 providerId='credential' 且 password 非空，不判 issuer（design §3.1）。
   * 注意：密码下限常量（MIN_PASSWORD_LENGTH）**不经本模块**下发给前端 —— 本模块 import 了 zod，
   * 而从本模块取一个常量会把整份 schema + zod 拖进调用方的分块（实测：把首屏 index 从
   * 182 kB 顶到 255 kB）。前端一律直取零依赖的 src/lib/password.ts。
   */
  hasPassword: z.boolean(),
  /**
   * 规范形手机号（`+861…`），未绑定为 null（11-06-sms-alicloud-auth）。
   * 只向**本人**下发完整号码 —— 本端点的 userId 恒取自会话（/me 路径），不接参数。
   */
  phoneNumber: z.string().nullable(),
  /** 号码是否已验证（插件写入；本轮只有 verify 链路会置 true）。 */
  phoneNumberVerified: z.boolean(),
  /**
   * 短信认证总开关（SMS_AUTH_ENABLED 经 isSmsAuthEnabled 解析的生效值）。
   * 与 emailVerificationEnabled 同一口径：开关关闭时 phone-number 插件整段不注册，
   * 前端不能靠「调一下看看」发现，必须读这个字段。
   */
  smsAuthEnabled: z.boolean(),
  /**
   * 手机硬门禁是否对该账号放行（11-08 R8 / D7）。判据 = SMS 开关开启 且 邮箱已验证 且
   * isAdminEmail(ADMIN_EMAILS, email) —— 与 src/middleware/auth.ts 的后门分支同一判据。
   * 未验证邮箱不享受后门（`changeEmail` 可把未验证地址立即写库，不能作为管理员自证依据）。
   * SPA 的 AppLayout / 登录页用 `phoneNumberVerified || phoneGateBypassed` 决定是否送
   * /bind-phone；不得在前端另写名单解析（app/lib/phone-gate.ts 是唯一判据入口）。
   */
  phoneGateBypassed: z.boolean(),
  /**
   * 是否已绑定 GitHub 账号（11-06-sms-alicloud-auth，PRD R16 / design §13.3）。
   * 判据：accounts 表存在 providerId='github' 且 userId=本人的行（OAuth 建号与
   * 「已登录用户 link-social 绑定」两条路径都会落这一行）。
   * 资料页据此显示「已绑定 / 可绑定」；不暴露 GitHub 侧的 id 或 token。
   */
  githubLinked: z.boolean(),
});

export const profileOutputSchema = z.object({
  success: z.literal(true),
  profile: profileSchema,
});

// ============= 类型导出 =============

export type Profile = z.infer<typeof profileSchema>;
export type ProfileOutput = z.infer<typeof profileOutputSchema>;
