import type { TokimekiToken } from "../../../db/schema";
import type { TokimekiTokenRecord } from "../types";

/** DB 行 → 响应记录（不包含 JWT 明文）。 */
export function toTokimekiTokenRecord(row: TokimekiToken): TokimekiTokenRecord {
  return {
    id: row.id,
    name: row.name,
    jti: row.jti,
    kid: row.kid,
    namespace: row.namespace,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}
