// 命名空间（namespace）生成与懒回填。
//
// 语义：`namespace_id` 是用户的公开命名空间标识（不是权限边界）；`namespace_short` 是其前 5 位，
// 用于 session 名前缀与 JWT 的 `namespace` claim（relay 侧按 `<namespace>.<slug>` 校验）。
// 字符集刻意选「方便可读」的 30 个字符：去掉 0/1/i/l/o 等易混字符，并按产品要求去掉数字 4。
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { users } from "../db/schema";

/** 随机字符集：0/1/i/l/o 易混字符与数字 4 均不在内（30 字符）。 */
export const NAMESPACE_CHARSET = "2356789abcdefghjkmnpqrstuvwxyz";

export const NAMESPACE_SHORT_LENGTH = 5;
const NAMESPACE_SUFFIX_LENGTH = 11;
const MAX_ATTEMPTS = 5;

/** 生成指定长度的随机串（拒绝采样，避免取模偏差）。 */
function randomString(length: number): string {
  const bytes = new Uint8Array(length * 2);
  crypto.getRandomValues(bytes);
  let out = "";
  let index = 0;
  while (out.length < length) {
    if (index >= bytes.length) {
      crypto.getRandomValues(bytes);
      index = 0;
    }
    const byte = bytes[index];
    index += 1;
    // 240 = floor(256 / 30) * 30；落在尾部 16 个值上直接丢弃，避免字符分布偏斜。
    if (byte === undefined || byte >= 240) {
      continue;
    }
    out += NAMESPACE_CHARSET[byte % NAMESPACE_CHARSET.length] ?? "";
  }
  return out;
}

/** 5 位短 id（session 前缀 / JWT namespace claim）。 */
export function generateNamespaceShort(): string {
  return randomString(NAMESPACE_SHORT_LENGTH);
}

/** 完整 namespace_id：5 位短 id + 11 位随机后缀。 */
export function generateNamespaceId(short: string): string {
  return `${short}${randomString(NAMESPACE_SUFFIX_LENGTH)}`;
}

/**
 * 任意长度的可读随机串（invite code / 匿名 namespace/slug 共用）。
 *
 * 字符集与 namespace 一致：排除 0/1/i/l/o 与数字 4。
 */
export function generateReadableCode(length: number): string {
  if (!Number.isInteger(length) || length <= 0 || length > 128) {
    throw new Error("generateReadableCode length must be 1..128");
  }
  return randomString(length);
}

/** 校验短 id 是否满足字符集与长度（不做唯一性判断）。 */
export function isNamespaceShort(value: string): boolean {
  if (value.length !== NAMESPACE_SHORT_LENGTH) {
    return false;
  }
  return [...value].every((char) => NAMESPACE_CHARSET.includes(char));
}

export interface UserNamespace {
  namespaceId: string;
  namespaceShort: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.toLowerCase().includes("unique constraint failed")
  );
}

/**
 * 读取用户的 namespace；缺失时生成并持久化（懒回填）。
 *
 * - 唯一性由 `namespace_short` 唯一索引兜底：并发下失败的写入会重试，
 *   已存在的值以重读结果为准。
 * - 返回 `null` 表示用户不存在。
 */
export async function ensureNamespace(
  db: Db,
  userId: number,
): Promise<UserNamespace | null> {
  const read = () =>
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { namespaceId: true, namespaceShort: true },
    });

  const current = await read();
  if (!current) {
    return null;
  }
  if (current.namespaceShort !== null && current.namespaceId !== null) {
    return {
      namespaceShort: current.namespaceShort,
      namespaceId: current.namespaceId,
    };
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const short = generateNamespaceShort();
    const namespaceId = generateNamespaceId(short);

    try {
      const updated = await db
        .update(users)
        .set({ namespaceShort: short, namespaceId })
        .where(and(eq(users.id, userId), isNull(users.namespaceShort)))
        .returning({
          namespaceShort: users.namespaceShort,
          namespaceId: users.namespaceId,
        });

      const row = updated[0];
      if (row?.namespaceShort && row.namespaceId) {
        return { namespaceShort: row.namespaceShort, namespaceId: row.namespaceId };
      }
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // 短 id 撞车：换一个重试。
      continue;
    }

    // 条件 UPDATE 未命中：并发请求已经写入，重读即可。
    const latest = await read();
    if (latest?.namespaceShort && latest.namespaceId) {
      return {
        namespaceShort: latest.namespaceShort,
        namespaceId: latest.namespaceId,
      };
    }
  }

  // 连续撞车或行在读写之间被删除：交由调用方决定（签端点返回 503/500）。
  const latest = await read();
  if (latest?.namespaceShort && latest.namespaceId) {
    return {
      namespaceShort: latest.namespaceShort,
      namespaceId: latest.namespaceId,
    };
  }
  return null;
}
