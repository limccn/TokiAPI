// 邀请链接构建与邀请码归一（批次 U，D28/D29）。
//
// 纯函数、零依赖 —— admin 复制按钮（app/routes/users.tsx 两处）与注册页预填
// （app/routes/register.tsx）共用同一份口径：两边各写一份必然漂移，而漂移的表现是
// 「复制出的链接注册不进去」或「链接里的码与行内展示的码对不上」。
//
// 归一化与服务端**逐字同口径**（src/lib/invites.ts 的 validateInviteCode / consumeInviteCode
// 都是 trim().toUpperCase()）：口径不一致的表现是「链接里能用、手输同一串却判无效」。

/** 邀请码长度（与 src/lib/invites.ts generateInviteCode 的缺省长度一致）。 */
export const INVITE_CODE_LENGTH = 10;

/** 邀请码归一：trim + 大写（与服务端同口径）。空/纯空白 → 空串。 */
export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * 邀请码输入框的清洗：只留字母数字，截到 10 位。
 *
 * 库里的码由 generateInviteCode 产出（10 位大写字母数字、无连字符），粘贴时常混入空格/连字符，
 * 故输入态就地清掉；大小写不在这里归一 —— 服务端与 normalizeInviteCode 都是 toUpperCase 判等。
 *
 * ⚠ 受控组件纪律：调用方必须把 `event.target.value` 改回返回值（见 app/lib/phone-input.ts 的
 * `toSmsCode` 注释）—— 清洗结果与 state 相同时 React 不重渲染，非法字符会残留在 DOM。
 */
export function toInviteCode(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, "").slice(0, INVITE_CODE_LENGTH);
}

/**
 * 构造邀请链接：`${origin}/register?invite=${CODE}`（D28）。
 *
 * - CODE **原样编码**（encodeURIComponent），不做归一 —— 保证「复制出的码与行内展示的码
 *   逐字一致」（AC48 判据）。库里的码由 generateInviteCode 产出（大写字母数字），
 *   在那里编码是恒等变换；保留 encodeURIComponent 只为防未来码字符集变化时链接被截断。
 * - origin 取 window.location.origin（恒无路径、无尾斜杠），调用方不拼斜杠。
 * - 注册页读取时统一走 normalizeInviteCode（trim + 大小写归一），
 *   故链接里即便带了小写/空白也能正确预填（AC49）。
 */
export function buildInviteLink(code: string, origin: string): string {
  return `${origin}/register?invite=${encodeURIComponent(code)}`;
}
