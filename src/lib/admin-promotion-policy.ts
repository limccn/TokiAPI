// 账户安全：邮件注册账户不可提升为 admin —— **唯一判据**（09-21-email-admin-promotion-switch）。
//
// 为什么单独成文件（照 src/lib/password.ts 的先例）：后端拒绝（PATCH /api/users/:id）与前端置灰
// （/users 页的提升按钮）必须是**同一判据**。两边各写一个 if，改口径时必然先漂一边 —— 于是出现
// 「画面能点、API 拒绝」（死表单）或「画面灰着、API 其实放行」（假防线）。本模块让这两种漂移
// 在构造上不可表示。
//
// **本文件零依赖：不得出现任何 import（含 type-only）**。src/types.ts 会牵出 logger / auth /
// db / schema 整条服务端依赖链，一旦建立运行时边，那串东西会被并进前端分块（password.ts 记录了
// 同类事故：首屏 index 182 kB → 255 kB）。故角色用**本地**字面量联合类型，不从 src/types.ts 取。
//
// 语义（用户裁决 2026-09-21）：「开关关闭时，邮件注册的账户在这个系统里不构成成为 admin 的通路 ——
// 不是「按钮不能点」，而是「这件事没有入口」。」四条性质落在本文件的代码里：
//   ① **方向性**：只拦 member → admin；降级与停用不受影响（判据只看 requestedRole / currentRole）；
//   ② **不静默**：调用方必须显式拒绝（403 + ADMIN_PROMOTION_BLOCKED_MESSAGE），
//      不得把 role 字段吞掉当没看见 —— 静默忽略会让调用方以为成功了；
//   ③ **不倒查存量**：currentRole 已是 admin 的幂等 no-op 不拦，否则开关一关，
//      存量的邮箱制 admin 连「重复写一次角色字段」都会失败；
//   ④ **缺省即关闭**（fail-closed）：未配置 / 空 / 非法值一律 false —— 与
//      EMAIL_VERIFICATION_ENABLED 等策略开关同一取向。
//      （11-06-sms-alicloud-auth 起 ADMIN_EMAILS 的语义是**自动提权名单** —— 那是部署方
//      亲授的通道，不受本开关约束；本开关只拦人工提升动作。）
//
// 判据「邮件注册的账户」不在这里：它要查库（accounts 表 provider_id='credential' 行），
// 见 src/routes/users/lib/email-credential.ts。本文件只收一个**已判定好的布尔**，因此可被前后端共用。
//
// 消费方：src/routes/users/procedures/update.ts（写边界，权威）
//         app/routes/users.tsx（呈现，第二处）
//         src/routes/settings/（把开关当前值下发给管理画面）
//         tests/admin-promotion-policy.unit.test.ts（真值表 = 本判据的规格）

/** 角色判据的本地字面量（与 src/types.ts 的 UserRole 结构相同；刻意不复用以免牵连依赖链）。 */
export type PromotionRole = "admin" | "member";

/**
 * 开关解析（**唯一解析点**）：`EMAIL_ACCOUNT_ADMIN_PROMOTION_ENABLED` env（[vars] 渲染烘焙）为
 * true/1/yes/on（大小写与首尾空白不敏感）才允许「邮件注册账户被提升为 admin」；
 * **缺省 / 空 / 其他任何值 = 关闭**。
 *
 * 与 isEmailVerificationEnabled（bonus.ts）/ isGlobalCacheEnabled（response-cache.ts）同形。
 * 刻意**不**抽公共解析函数：抽出去要动那两个已交付文件，收益只是一个四字比较；三者一致这件事
 * 由各自单测的矩阵表保证。
 */
export function isEmailAccountAdminPromotionEnabled(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" || v === "on";
}

/**
 * 提权门控的**唯一判据**：返回 true = 这次请求该被拒绝。
 *
 * 四个入参都是「已事实化」的布尔/枚举（不做任何 IO）—— 故后端能拿它当守卫，前端能拿它决定置灰。
 * `currentRole !== "admin"` 就是「只拦真实跃迁」（见文件头性质③）。
 */
export function shouldBlockAdminPromotion(input: {
  /** 开关当前值（isEmailAccountAdminPromotionEnabled 的返回值）。 */
  promotionEnabled: boolean;
  /** 本次请求要写入的角色（body.role）；不带 role 字段的请求（如仅改 status）为 undefined。 */
  requestedRole: PromotionRole | undefined;
  /** 目标账户当前角色。 */
  currentRole: PromotionRole;
  /** 目标账户是否为邮件注册账户（有 accounts.provider_id='credential' 行）。 */
  targetHasEmailCredential: boolean;
}): boolean {
  return (
    !input.promotionEnabled &&
    input.requestedRole === "admin" &&
    input.currentRole !== "admin" &&
    input.targetHasEmailCredential
  );
}

/**
 * 写边界拒绝时的 message（PATCH /api/users/:id 的 403 响应体）。
 * 与既有的 "Cannot demote your own account" 同体例：短、陈述句、不用感叹号。
 */
export const ADMIN_PROMOTION_BLOCKED_MESSAGE =
  "Email-registered accounts cannot be promoted to admin";

/**
 * /users 页的**页面级说明**（开关关闭 且 本页确有被拦的行时渲染）。
 * 必须同时说到两件事：这是**本部署的策略**、**存量 admin 不受影响** —— 少说后者，管理员会以为
 * 一开开关自己的账号就危险了。
 * 禁用词（单测锁）：demote / remove / permanently / never —— 开关是可翻转的部署设置，
 * 文案不得把它说成对这个账户的永久判决。
 */
export const ADMIN_PROMOTION_POLICY_NOTICE =
  "Promotion to admin is disabled for email-registered accounts on this deployment. " +
  "Accounts that are already admins are unaffected, and no account is modified by this policy.";

/**
 * 行级原因（提升按钮的 title + 可及名后缀）。该按钮是 icon-only，可及名是 AT 用户唯一的信息来源，
 * 故这里必须说清「为什么这一行不能点」——理由是**这个账户的登录形态**，不是这个账户有问题。
 */
export const ADMIN_PROMOTION_BLOCKED_REASON =
  "Email-registered account — promotion is disabled by policy";
