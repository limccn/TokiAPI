// 过期 invite/ticket 的每日清理（11-18-tokimeki-share-link-attach）。
import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db";
import { tokimekiAttachTickets, tokimekiInvites } from "../src/db/schema";
import { runTokimekiCleanup } from "../src/routes/tokimeki/lib/invites";
import { applyMigrations, setupUser } from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

async function insertInvite(
  codeHash: string,
  expiresAt: Date,
  createdBy: number | null,
): Promise<number> {
  const db = createDb(env);
  const inserted = await db
    .insert(tokimekiInvites)
    .values({
      codeHash,
      createdBy,
      namespace: "abcde",
      session: "abcde.demo",
      mode: "viewer",
      allowWeb: true,
      passcodeRequired: false,
      createdAt: new Date(expiresAt.getTime() - 86_400_000),
      expiresAt,
    })
    .returning({ id: tokimekiInvites.id });
  return inserted[0]?.id ?? 0;
}

describe("runTokimekiCleanup", () => {
  it("removes expired tickets/invites past retention and keeps active rows", async () => {
    const userId = await setupUser("tk-cleanup@test.dev", 0);
    const now = new Date();
    const old = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const fresh = new Date(now.getTime() + 60 * 60 * 1000);

    const oldInviteId = await insertInvite("a".repeat(64), old, userId);
    const freshInviteId = await insertInvite("b".repeat(64), fresh, userId);
    const db = createDb(env);
    await db.insert(tokimekiAttachTickets).values({
      ticketHash: "c".repeat(64),
      inviteId: oldInviteId,
      createdAt: new Date(old.getTime() - 60_000),
      expiresAt: new Date(old.getTime() - 30_000),
    });
    await db.insert(tokimekiAttachTickets).values({
      ticketHash: "d".repeat(64),
      inviteId: freshInviteId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    });

    const result = await runTokimekiCleanup(db, now);
    expect(result.invites).toBe(1);
    expect(result.tickets).toBe(1);

    const remainingInvites = await db.select().from(tokimekiInvites);
    expect(remainingInvites.map((row) => row.id)).toEqual([freshInviteId]);
    const remainingTickets = await db.select().from(tokimekiAttachTickets);
    expect(remainingTickets).toHaveLength(1);
    expect(
      await db.query.tokimekiInvites.findFirst({
        where: eq(tokimekiInvites.id, oldInviteId),
      }),
    ).toBeUndefined();
  });
});
