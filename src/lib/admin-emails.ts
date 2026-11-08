// 管理员邮箱名单（11-06-sms-alicloud-auth design §13.1）。
//
// 语义变更：名单**不再**是 GitHub 登录准入门（GitHub 已开放注册，validateUserInfo 里
// 「邮箱不在名单即拒绝登录」的分支已删除），而是「自动提权名单」—— 列表内邮箱的账号在
// 注册（databaseHooks.user.create.after）与每次登录（databaseHooks.session.create.after）
// 时被提升为 admin，见 src/lib/auth.ts 的 promoteAdminIfListed。
//
// 规则：逗号分隔；比较不区分大小写、忽略空白。
// 空名单 = **无人自动提权**（不是拒绝登录）：普通用户照常注册/登录，第一个 admin 仍可
// 用 D1 手工 `UPDATE users SET role='admin'` 完成 bootstrap（README 收尾清单的既有手法）。
//
// **本文件保持零依赖**（与 src/lib/phone.ts 同一纪律；这里连 import type 都不写）：
// 名单解析是纯函数，将来若前端也需要展示「本部署的管理员名单是否配置」，
// 直接取用不会把服务端依赖链（auth/db/schema）拖进任何分块。
//
// 刻意不复用 EMAIL_ALLOWED_RECIPIENTS 的解析实现：那是**收件人白名单**，
// 空值语义相反（空 = 全放行）。两个空值语义共用一份解析，迟早会有一边被写错。

/**
 * 解析名单：trim + 小写 + 丢弃空项。
 * 未配置（undefined）与空串都返回空数组 —— 调用方不需要区分这两种「没人」的形态。
 */
export function parseAdminEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
}

/**
 * 邮箱是否在名单内（空名单恒 false；空邮箱恒 false）。
 * @param raw env.ADMIN_EMAILS 的原始值（逗号分隔）
 * @param email 用户邮箱
 */
export function isAdminEmail(raw: string | undefined, email: string): boolean {
  const target = email.trim().toLowerCase();
  if (target === "") {
    return false;
  }
  return parseAdminEmails(raw).includes(target);
}
