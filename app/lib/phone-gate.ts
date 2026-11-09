// 手机硬门禁的前端单一判据（11-08-reward-semantics-overhaul，R8 / design §12.3）。
//
// 为什么单独一个零运行时依赖的模块：`profile` 契约里的 `phoneGateBypassed` 由服务端
// 按 ADMIN_EMAILS 名单计算，前端**不得**自行解析名单（那是第二份真源，必然与后端漂移）。
// 两个调用方（AppLayout 的受保护路由守卫、登录页的已登录去向与登录成功后去向）必须走
// 同一个函数 —— 各自写一份 `phoneNumberVerified || phoneGateBypassed` 时，任何一处漏项
// 都会让后门账号在登录后被踢回 /bind-phone（或反过来把普通账号放过门禁）。
//
// type-only 导入：`import type` 在构建期被完全擦除，不会把后端 schema（及其 zod 依赖）
// 拉进首屏分块（背景见 app/modules/profile/types.ts 头注）。
import type { Profile } from "@/modules/profile/types";

/**
 * 是否需要先去 /bind-phone。
 *
 * 判据 = 手机未验证 **且** 未命中 ADMIN_EMAILS 后门。`!== true` 而非 `=== false`：
 * 字段来自服务端最新值的 boolean，但用宽松形态与既有的 `phoneNumberVerified !== true`
 * 守卫保持同一写法，避免契约将来允许 null 时出现「null 被当成已绑定」。
 *
 * 调用方负责「SMS 开关是否开启」那一层：开关关闭时后端门禁整体不存在，
 * 页面不应据此重定向（`phoneGateBypassed` 此时恒 false，若仍按本函数跳转会误伤所有人）。
 */
export function needsPhoneBinding(
  profile: Pick<Profile, "phoneNumberVerified" | "phoneGateBypassed">,
): boolean {
  return profile.phoneNumberVerified !== true && profile.phoneGateBypassed !== true;
}
