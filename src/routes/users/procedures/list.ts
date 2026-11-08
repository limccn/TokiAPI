// GET /api/users — 用户列表（admin；search/role/status 过滤 + limit/offset 分页）。
import { and, count, desc, eq, like, or } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import type { AppEnv } from "../../../types";
import { users } from "../../../db/schema";
import { createDb } from "../../../db";
import { listUsersQuerySchema } from "../types";
import { toUserResponse } from "../lib/convert";
import { emailCredentialUserIds, githubAccountUserIds } from "../lib/email-credential";

export function listUsersRoute(app: Hono<AppEnv>): void {
  app.get("/", zValidator("query", listUsersQuerySchema), async (c) => {
    const logger = c.get("logger");
    const query = c.req.valid("query");
    const db = createDb(c.env);

    const conditions = [];
    if (query.search) {
      const pattern = `%${query.search}%`;
      conditions.push(
        or(like(users.email, pattern), like(users.name, pattern)),
      );
    }
    if (query.role) {
      conditions.push(eq(users.role, query.role));
    }
    if (query.status) {
      conditions.push(eq(users.status, query.status));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const rows = await db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.id))
      .limit(query.limit)
      .offset(query.offset);
    const totalRow = await db
      .select({ value: count() })
      .from(users)
      .where(where);
    const total = totalRow[0]?.value ?? 0;

    // 邮件注册判据（09-21-email-admin-promotion-switch）：**一次**批量查询回答整页，
    // 不在 map 里按行走 N 次单查。查询范围 = 本页实际返回的 id（不是全表）。
    const pageUserIds = rows.map((row) => row.id);
    const emailRegisteredIds = await emailCredentialUserIds(db, pageUserIds);
    // GitHub 绑定判据（11-08 R10）：与邮件判据同批、同范围（列表的 githubLinked 字段
    // 与解绑按钮可用性都读它）。
    const githubLinkedIds = await githubAccountUserIds(db, pageUserIds);

    logger.info("users_listed", {
      total,
      limit: query.limit,
      offset: query.offset,
    });
    return c.json({
      success: true as const,
      items: rows.map((row) =>
        toUserResponse(row, emailRegisteredIds.has(row.id), githubLinkedIds.has(row.id)),
      ),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });
}
