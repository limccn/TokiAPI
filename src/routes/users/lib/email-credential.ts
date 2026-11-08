// 账户绑定事实的读取收口（09-21-email-admin-promotion-switch；11-08 R10 扩为「账户绑定事实」）。
//
// 两个判据都只回答「accounts 表里存在哪类绑定行」，供三处消费：
//   1. `emailRegistered`（credential 行）：账户安全总开关的写边界门控 + 管理列表字段；
//   2. `githubLinked`（providerId='github' 行，11-08 R10）：用户列表字段 + 解绑/护栏的判据
//      （与 GET /api/me/profile 的 githubLinked 同口径：OAuth 建号与 link-social 都落这一行）。
//
// 判据刻意**宽**（credential 行不判 issuer、不要求 password 非空）：与 src/routes/profile/
// procedures/get-profile.ts 的 hasPassword 同取向（那里的注释写了取舍：把 issuer 硬编码进来
// 只会带来「库改了 issuer 编码而我们失配」这一种失败，而判宽了的那一侧付出的只是多拦一次）。
// 注意两者**语义不同**，不得互相复用：get-profile 的 hasPassword 回答「能不能改密」，
// 本判据回答「是不是邮箱注册的账户」—— 一个邮箱注册用户的 credential 行 password 为 null
// 时，前者 false（改密无入口，正确），后者仍应为 true（他就是邮箱注册的）。故这里刻意
// **不**把 hasPassword 拿来当地基。
//
// 本文件**只负责取事实**（查库 → 布尔/集合）。「该不该拦」一律由 src/lib/admin-promotion-policy.ts
// 的 shouldBlockAdminPromotion 回答 —— 若在这里再拼一个「开关 + 角色 + 凭据」的复合判断，就等于
// 把唯一判据复制成两份，正是本设计要消除的漂移（那份判据还要给前端用，前端拿不到 DB）。
//
// 消费方：src/routes/users/procedures/update.ts（单查：写边界门控 + 响应体，一次查询两处用）
//         src/routes/users/procedures/list.ts  （批量：列表契约的 emailRegistered 字段）
//         src/routes/users/procedures/unbind-github.ts / unbind-email.ts（护栏判据）
import { and, eq, inArray } from "drizzle-orm";
import { accounts } from "../../../db/schema";
import type { Db } from "../../../db";

/** Better Auth 本地凭据账户的 provider_id 取值（库建号时写入；字符串字面量集中在此处）。 */
export const EMAIL_CREDENTIAL_PROVIDER_ID = "credential";

/** GitHub OAuth 账户的 provider_id 取值（OAuth 建号与 link-social 同值）。 */
export const GITHUB_PROVIDER_ID = "github";

/**
 * 单账户判据：该用户在 accounts 表是否有邮件凭据行。
 * 只 select id（不取 password / token —— 本判据不需要，也不该把凭据内容带进内存）。
 */
export async function hasEmailCredential(db: Db, userId: number): Promise<boolean> {
  const row = await db.query.accounts.findFirst({
    where: and(
      eq(accounts.userId, userId),
      eq(accounts.providerId, EMAIL_CREDENTIAL_PROVIDER_ID),
    ),
    columns: { id: true },
  });
  return row !== undefined;
}

/**
 * 批量判据（列表用）：一次查询回答一页用户，避免 N 次单查。
 * 返回**命中集合**而非 Map —— 调用方只问「在不在里面」，且空集合天然表示「一个都没有」。
 */
export async function emailCredentialUserIds(
  db: Db,
  userIds: number[],
): Promise<Set<number>> {
  if (userIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        inArray(accounts.userId, userIds),
        eq(accounts.providerId, EMAIL_CREDENTIAL_PROVIDER_ID),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}

/** 单账户判据：该用户是否已绑定 GitHub（与 profile 的 githubLinked 同口径）。 */
export async function hasGithubAccount(db: Db, userId: number): Promise<boolean> {
  const row = await db.query.accounts.findFirst({
    where: and(eq(accounts.userId, userId), eq(accounts.providerId, GITHUB_PROVIDER_ID)),
    columns: { id: true },
  });
  return row !== undefined;
}

/** 批量判据（列表用）：一次查询回答一页用户的 GitHub 绑定状态。 */
export async function githubAccountUserIds(
  db: Db,
  userIds: number[],
): Promise<Set<number>> {
  if (userIds.length === 0) {
    return new Set();
  }
  const rows = await db
    .select({ userId: accounts.userId })
    .from(accounts)
    .where(
      and(
        inArray(accounts.userId, userIds),
        eq(accounts.providerId, GITHUB_PROVIDER_ID),
      ),
    );
  return new Set(rows.map((r) => r.userId));
}
