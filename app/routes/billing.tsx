// /billing — 账单页（M6 6.3 + M8）：余额卡片 + 管理员代充/扣减 + 真实流水表
// （GET /api/me/transactions，分页 + type 过滤；无伪造数据）。
// 批次 I（2026-09-18）：type 下拉从流水表 header 移入 Ledger summary 卡（替换该卡的
// 「Types: recharge / usage / …」静态行）—— 该卡由只读摘要变成可操作的筛选器。
import { useState, type FormEvent } from "react";
import { CreditCard, Wallet } from "lucide-react";
import { z } from "zod";
import { useSession } from "@/hooks/use-session";
import { useIsMobile } from "@/hooks/use-media-query";
import { useUsers } from "@/modules/users/hooks/use-users";
import { useAdjustBalance } from "@/modules/users/hooks/use-adjust-balance";
import { useMeTransactions } from "@/modules/billing/hooks/use-me-transactions";
import type { BalanceTxType, TransactionItem } from "@/modules/billing/types";
import type { UserResponse } from "@/modules/users/types";
import { formatDateTime, formatDateTimeShort, formatNumber, formatUsd } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 20;

const adjustFormSchema = z.object({
  userId: z.string().min(1, "Select a user"),
  amount: z.coerce
    .number("Enter a number")
    .refine((v) => v !== 0, { message: "Amount must not be zero" }),
  note: z.string().max(500, "Max 500 characters").optional(),
});

type TypeFilter = "all" | BalanceTxType;

function typeBadgeVariant(type: BalanceTxType): "success" | "secondary" | "destructive" {
  // 进账（充值 / 三档绑定赠金）与扣费（usage）分色；adjust 可正可负 → 中性
  if (
    type === "recharge" ||
    type === "signup_bonus" ||
    type === "email_verify_bonus" ||
    type === "github_bind_bonus"
  ) {
    return "success";
  }
  if (type === "usage") {
    return "destructive";
  }
  return "secondary";
}

function AmountCell({ amount }: { amount: number }) {
  const positive = amount > 0;
  return (
    <span className={positive ? "text-success" : "text-foreground"}>
      {positive ? "+" : ""}
      {formatUsd(amount)}
    </span>
  );
}

export default function BillingPage() {
  const { user } = useSession();
  const isAdmin = user?.role === "admin";
  const isMobile = useIsMobile();

  const usersQuery = useUsers(isAdmin ? { limit: 100 } : { limit: 1, enabled: false });

  const [userId, setUserId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const adjustBalance = useAdjustBalance();

  // ===== 流水表：type 过滤 + 分页 =====
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [offset, setOffset] = useState(0);
  const transactionsQuery = useMeTransactions({
    ...(typeFilter !== "all" ? { type: typeFilter } : {}),
    limit: PAGE_SIZE,
    offset,
  });

  const switchTypeFilter = (next: TypeFilter) => {
    setTypeFilter(next);
    setOffset(0);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrors({});
    const parsed = adjustFormSchema.safeParse({
      userId,
      amount,
      note: note.length > 0 ? note : undefined,
    });
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? "root"), i.message])));
      return;
    }
    try {
      await adjustBalance.mutateAsync({
        id: parsed.data.userId,
        amount: parsed.data.amount,
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      });
      setAmount("");
      setNote("");
    } catch {
      // 错误显示在表单下方
    }
  };

  const users = usersQuery.data?.items ?? [];
  const selectedUser = users.find((u: UserResponse) => u.id === userId);

  const items: TransactionItem[] = transactionsQuery.data?.items ?? [];
  const total = transactionsQuery.data?.total ?? 0;

  return (
    <PageContainer>
      <PageHeader title="Billing" description="Balance and transaction history" />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="size-4 text-primary" aria-hidden="true" />
              Current balance
            </CardTitle>
            <CardDescription>Prepaid balance used by your API traffic</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-4xl font-semibold tracking-tight">
              {user?.balance === null || user?.balance === undefined
                ? "—"
                : formatUsd(user.balance)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Contact an administrator to top up your balance.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="size-4 text-primary" aria-hidden="true" />
              Ledger summary
            </CardTitle>
            <CardDescription>Totals from your history</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Total</span>
              <span className="font-medium">{formatNumber(total)}</span>
            </div>
            {/* 类型筛选（批次 I）：原是本卡的一行静态罗列
                「Types | recharge / usage / adjust / signup_bonus / email_verify_bonus / github_bind_bonus」，
                现改为承接流水表原先那个下拉 —— 该卡因此从「只读摘要」变成**可操作的筛选器**，
                选中的类型即时作用于下方流水表（即选即查，与 usage 页同一范式）。
                批次 L（2026-09-21）由竖排改回**一行**：标签从 "Transaction type" 缩成 "Type" 后
                只用 ~28px，本卡最窄处（lg 起 1/3 列，内容盒 ~215px）也放得下 —— 当初竖排是因为
                长标签 + `w-40` 固定宽下拉会挤爆，前提随标签变短已不成立。下拉取 `flex-1 min-w-0`
                而非 `w-40`：`min-w-0` 是它在窄列里不被内容顶宽的关键（本仓 grid 老坑的同族）。 */}
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="billing-type" className="shrink-0 font-normal text-muted-foreground">
                Type
              </Label>
              <Select
                id="billing-type"
                value={typeFilter}
                onChange={(e) => switchTypeFilter(e.target.value as TypeFilter)}
                className="min-w-0 flex-1"
              >
                <option value="all">All types</option>
                <option value="recharge">Recharge</option>
                <option value="usage">Usage</option>
                <option value="adjust">Adjustment</option>
                <option value="signup_bonus">Signup bonus</option>
                <option value="email_verify_bonus">Email bound bonus</option>
                <option value="github_bind_bonus">GitHub linked bonus</option>
              </Select>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 流水表 */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Transactions</CardTitle>
          <CardDescription>{formatNumber(total)} total</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {transactionsQuery.isLoading ? (
            <div className="px-6 py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : transactionsQuery.isError ? (
            <div className="p-6">
              <ErrorState
                message={transactionsQuery.error.message}
                onRetry={() => transactionsQuery.refetch()}
              />
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 pb-6">
              <EmptyState title="No transactions yet" description="Balance adjustments and API usage charges will appear here." />
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Amount</TableHead>
                      <TableHead>Note</TableHead>
                      <TableHead className="hidden sm:table-cell">Request</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((tx) => (
                      <TableRow key={tx.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {isMobile
                            ? formatDateTimeShort(tx.createdAt)
                            : formatDateTime(tx.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={typeBadgeVariant(tx.type)}>{tx.type}</Badge>
                        </TableCell>
                        <TableCell className="font-medium">
                          <AmountCell amount={tx.amount} />
                        </TableCell>
                        <TableCell className="max-w-64 truncate text-muted-foreground">
                          {tx.note ?? "—"}
                        </TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                          {tx.refRequestId ?? "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-6 pb-6">
                <span className="text-sm text-muted-foreground">
                  Showing {offset + 1}–{offset + items.length} of {total}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={offset + PAGE_SIZE >= total}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Adjust user balance</CardTitle>
            <CardDescription>Add or deduct funds for any user (admin only)</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4" noValidate>
              {adjustBalance.error?.message ? (
                <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {adjustBalance.error.message}
                </p>
              ) : null}
              {adjustBalance.data ? (
                <p
                  role="status"
                  className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-sm"
                >
                  Updated — new balance {formatUsd(adjustBalance.data.balance)} on{" "}
                  {formatDateTime(adjustBalance.data.tx.createdAt)}
                </p>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label htmlFor="billing-user">User</Label>
                  <Select
                    id="billing-user"
                    value={userId}
                    onChange={(e) => setUserId(e.target.value)}
                    aria-invalid={errors.userId !== undefined}
                  >
                    <option value="">Select user…</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                  </Select>
                  {errors.userId ? <p className="text-xs text-destructive">{errors.userId}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="billing-amount">Amount (USD)</Label>
                  <Input
                    id="billing-amount"
                    type="number"
                    step="any"
                    placeholder="10 or -5"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    aria-invalid={errors.amount !== undefined}
                  />
                  {errors.amount ? <p className="text-xs text-destructive">{errors.amount}</p> : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="billing-note">Note</Label>
                  <Input
                    id="billing-note"
                    placeholder="Optional"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    aria-invalid={errors.note !== undefined}
                  />
                  {errors.note ? <p className="text-xs text-destructive">{errors.note}</p> : null}
                </div>
              </div>
              {selectedUser ? (
                <p className="text-xs text-muted-foreground">
                  {selectedUser.name} — current balance {formatUsd(selectedUser.balance)}
                </p>
              ) : null}
              <div className="flex justify-end">
                <Button type="submit" disabled={adjustBalance.isPending}>
                  {adjustBalance.isPending ? "Applying…" : "Apply adjustment"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </PageContainer>
  );
}
