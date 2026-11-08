// /users — 用户管理（M6 6.3，admin）：列表搜索/过滤、角色与状态操作、邀请码管理。
import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  Copy,
  MailX,
  Search,
  ShieldAlert,
  ShieldMinus,
  ShieldPlus,
  Trash2,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import { z } from "zod";
import { useSession } from "@/hooks/use-session";
import { useUsers } from "@/modules/users/hooks/use-users";
import { useUpdateUser } from "@/modules/users/hooks/use-update-user";
import { useDeleteUser } from "@/modules/users/hooks/use-delete-user";
import {
  useUnbindUserIdentity,
  type UserIdentityKind,
} from "@/modules/users/hooks/use-unbind-user-identity";
import { useInvites } from "@/modules/users/hooks/use-invites";
import { useCreateInvite } from "@/modules/users/hooks/use-create-invite";
import { useSettings } from "@/modules/settings/hooks/use-settings";
import type { UserResponse } from "@/modules/users/types";
// 与写边界**同一个**判据模块（零依赖，不牵入服务端依赖链；理由见该文件头）
import {
  ADMIN_PROMOTION_BLOCKED_REASON,
  ADMIN_PROMOTION_POLICY_NOTICE,
  shouldBlockAdminPromotion,
} from "../../src/lib/admin-promotion-policy";
import { formatDateTime, formatUsd } from "@/lib/format";
import { copyToClipboard } from "@/lib/clipboard";
import { buildInviteLink } from "@/lib/invite-link";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, EmptyState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const inviteFormSchema = z.object({
  expiresInDays: z.coerce.number().int().min(1, "At least 1 day").max(90, "At most 90 days"),
});

/** Invite codes 客户端分页：每页 6 条（grid 3 列 × 2 行，移动端 1 列 × 6 行）。 */
const INVITE_PAGE_SIZE = 6;

/**
 * GitHub 品牌标记（11-08 R10）。
 *
 * 为什么不从 lucide-react 取 `Github`：本仓装的 lucide-react 1.34 已移除品牌图标
 * （`Github` 不再是导出，design §14.4 的图标名是该库旧版本的写法）。这里内联 SVG，
 * 尺寸由 Button 的 `[&_svg]:size-4` 统一控制，与相邻 lucide 图标同视觉。
 */
function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export default function UsersPage() {
  const { user: sessionUser } = useSession();

  // ===== 列表筛选 =====
  const [searchDraft, setSearchDraft] = useState("");
  const [roleDraft, setRoleDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [filters, setFilters] = useState<{ search?: string; role?: "admin" | "member"; status?: "active" | "disabled" }>({});

  // 用户列表分页：limit=50（后端上限），超过 50 人时更多用户不可达 → 加分页
  const [offset, setOffset] = useState(0);
  const usersQuery = useUsers({ ...filters, limit: 50, offset });
  const invitesQuery = useInvites();
  const settingsQuery = useSettings();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();
  const createInvite = useCreateInvite();

  const totalUsers = usersQuery.data?.total ?? 0;
  const [updateErrorDismissed, setUpdateErrorDismissed] = useState(false);
  // 新错误出现时重置 dismiss 状态；操作成功或用户手动关闭后不显示
  useEffect(() => setUpdateErrorDismissed(false), [updateUser.error]);

  const [deleteErrorDismissed, setDeleteErrorDismissed] = useState(false);
  // 删除错误条独立 dismiss（与 updateUser.error 错误条互不影响）
  useEffect(() => setDeleteErrorDismissed(false), [deleteUser.error]);

  // ===== 邀请码创建 =====
  const [inviteOpen, setInviteOpen] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteFieldError, setInviteFieldError] = useState<string | null>(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  /** 最近一次成功复制的邀请码（对应卡片/弹窗的 copy 按钮切成对勾图标，2s 复位）。 */
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  // ===== Invite codes 客户端分页状态（slice 逻辑见 invites 派生区） =====
  const [invitePage, setInvitePage] = useState(0);

  // ===== 用户删除（admin） =====
  const [deleteTarget, setDeleteTarget] = useState<UserResponse | null>(null);

  // ===== 解绑登录方式（11-08 R10）：GitHub / 邮箱共用同一确认弹窗 =====
  const unbindIdentity = useUnbindUserIdentity();
  const [unbindTarget, setUnbindTarget] = useState<{
    user: UserResponse;
    kind: UserIdentityKind;
  } | null>(null);
  // busy 状态按目标 id 判定，避免一处 pending 让所有行的按钮一起转
  const isUnbindPending =
    unbindIdentity.isPending && unbindIdentity.variables?.id === unbindTarget?.user.id;

  const applyFilters = () => {
    setFilters({
      search: searchDraft || undefined,
      role: roleDraft === "" ? undefined : (roleDraft as "admin" | "member"),
      status: statusDraft === "" ? undefined : (statusDraft as "active" | "disabled"),
    });
    setOffset(0);
  };

  const items = usersQuery.data?.items ?? [];
  const invites = invitesQuery.data?.items ?? [];

  // ===== 账户安全总开关（09-21-email-admin-promotion-switch）=====
  // 判据与写边界是**同一个函数**，故「画面灰掉的行」与「API 会拒的请求」在构造上不可能漂移。
  // `=== true` 是刻意的 fail-closed：设置查询未就绪或失败一律按「关闭」处理 —— 不留
  // 「看起来能点、点下去才发现打不开」的窗口（开关开启的部署上，首帧短暂置灰是这条取舍的代价）。
  const promotionEnabled =
    settingsQuery.data?.settings.emailAccountAdminPromotionEnabled === true;
  /** 本页被政策拦下的行（开关关闭 + 邮件注册 + 当前 member）。空集 = 不渲染页面级说明。 */
  const blockedPromotionIds = new Set(
    items
      .filter((item) =>
        shouldBlockAdminPromotion({
          promotionEnabled,
          requestedRole: item.role === "admin" ? "member" : "admin",
          currentRole: item.role,
          targetHasEmailCredential: item.emailRegistered,
        }),
      )
      .map((item) => item.id),
  );

  // ===== Invite codes 客户端分页（后端上限 100 条，切片在客户端完成） =====
  const maxInvitePage = Math.max(0, Math.ceil(invites.length / INVITE_PAGE_SIZE) - 1);
  const safeInvitePage = Math.min(invitePage, maxInvitePage); // 总数变少时钳制
  const pageInvites = invites.slice(
    safeInvitePage * INVITE_PAGE_SIZE,
    safeInvitePage * INVITE_PAGE_SIZE + INVITE_PAGE_SIZE,
  );

  // 删除确认弹窗 busy：按目标 id 判定，防串行时全行禁转
  const isDeletePending = deleteUser.isPending && deleteUser.variables === deleteTarget?.id;

  const handleCreateInvite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setInviteError(null);
    setInviteFieldError(null);
    setCreatedCode(null);
    const parsed = inviteFormSchema.safeParse({ expiresInDays });
    if (!parsed.success) {
      setInviteFieldError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }
    try {
      const result = await createInvite.mutateAsync(parsed.data);
      setCreatedCode(result.invite.code);
      setInviteOpen(false);
      setInvitePage(0); // 新邀请码置顶，跳回第 1 页
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : "Failed to create invite");
    }
  };

  /** 确认删除：成功关弹窗；失败保留弹窗展示错误条（deleteErrorDismissed 控制）。 */
  const handleConfirmDelete = async () => {
    if (!deleteTarget) {
      return;
    }
    try {
      await deleteUser.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    } catch {
      // 错误经 deleteUser.error 在弹窗内展示
    }
  };

  /** 打开删除确认弹窗：先清掉上一次的 mutation 状态，避免旧错误串到新目标。 */
  const openDeleteConfirm = (target: UserResponse) => {
    deleteUser.reset();
    setDeleteErrorDismissed(false);
    setDeleteTarget(target);
  };

  /** 确认解绑：成功关弹窗；失败保留弹窗展示错误（与删除同一形态）。 */
  const handleConfirmUnbind = async () => {
    if (!unbindTarget) {
      return;
    }
    try {
      await unbindIdentity.mutateAsync({
        id: unbindTarget.user.id,
        kind: unbindTarget.kind,
      });
      setUnbindTarget(null);
    } catch {
      // 错误经 unbindIdentity.error 在弹窗内展示
    }
  };

  /** 打开解绑确认弹窗：先 reset，避免上一次的失败信息串到新目标。 */
  const openUnbindConfirm = (target: UserResponse, kind: UserIdentityKind) => {
    unbindIdentity.reset();
    setUnbindTarget({ user: target, kind });
  };

  /** 复制**邀请链接**（D28，批次 U）：{origin}/register?invite={CODE} ——
   *  收到链接的人点开即自动填充邀请码，码明文含在链接里（不再是裸码）。
   *  copiedCode 仍以**裸码**为键（行内高亮与 aria-label 切换的判据不变）。 */
  const handleCopy = async (code: string) => {
    const ok = await copyToClipboard(buildInviteLink(code, window.location.origin));
    if (ok) {
      setCopiedCode(code);
      setCopyError(null);
      setTimeout(() => {
        setCopiedCode((current) => (current === code ? null : current));
      }, 2000);
    } else {
      setCopyError("Copy failed — clipboard is unavailable. Select the code manually.");
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Users"
        description="Manage accounts, roles and invite codes (admin)"
        actions={
          <Button onClick={() => setInviteOpen(true)}>
            <ShieldPlus aria-hidden="true" />
            Create invite
          </Button>
        }
      />

      {/* 邀请码区 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Invite codes</CardTitle>
          <CardDescription>One-time codes required for email sign-up</CardDescription>
        </CardHeader>
        <CardContent>
          {invitesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading invites…</p>
          ) : invitesQuery.isError ? (
            <ErrorState message={invitesQuery.error.message} onRetry={() => invitesQuery.refetch()} />
          ) : invites.length === 0 ? (
            <EmptyState title="No invite codes" description="Create one to let new members register." />
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {pageInvites.map((invite) => (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between gap-2 rounded-md border p-3"
                  >
                    <div className="min-w-0">
                      <code className="block truncate font-mono text-sm">{invite.code}</code>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <Badge variant={invite.status === "active" ? "success" : "muted"}>{invite.status}</Badge>{" "}
                        expires {formatDateTime(invite.expiresAt)}
                      </p>
                    </div>
                    {/* 只有图标（批次 L，2026-09-21 用户裁决：copy 按钮统一去文字）。
                        复制的是**邀请链接**（批次 U D28）；可访问名必须点名**是哪条**邀请码
                        （aria-label 含码是探针唯一的行级定位器 —— 批次 R D23 三要件），
                        否则屏幕阅读器只报一串同名的 "Copy invite link"。 */}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => handleCopy(invite.code)}
                      disabled={invite.status !== "active"}
                      aria-label={
                        copiedCode === invite.code ? "Copied" : `Copy invite link ${invite.code}`
                      }
                    >
                      {copiedCode === invite.code ? (
                        <Check className="text-success" aria-hidden="true" />
                      ) : (
                        <Copy aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                ))}
              </div>
              {invites.length > INVITE_PAGE_SIZE ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-muted-foreground">
                    Showing {safeInvitePage * INVITE_PAGE_SIZE + 1}–
                    {safeInvitePage * INVITE_PAGE_SIZE + pageInvites.length} of {invites.length}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeInvitePage === 0}
                      onClick={() => setInvitePage(safeInvitePage - 1)}
                    >
                      Prev
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={safeInvitePage >= maxInvitePage}
                      onClick={() => setInvitePage(safeInvitePage + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {copyError ? (
        <p role="alert" className="mb-6 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {copyError}
        </p>
      ) : null}

      {updateUser.error && !updateErrorDismissed ? (
        <p
          role="alert"
          className="mb-6 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{updateUser.error.message}</span>
          <Button variant="ghost" size="sm" onClick={() => setUpdateErrorDismissed(true)}>
            Dismiss
          </Button>
        </p>
      ) : null}

      {deleteUser.error && !deleteErrorDismissed ? (
        <p
          role="alert"
          className="mb-6 flex items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <span>{deleteUser.error.message}</span>
          <Button variant="ghost" size="sm" onClick={() => setDeleteErrorDismissed(true)}>
            Dismiss
          </Button>
        </p>
      ) : null}

      {/* 用户列表 */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>User list</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-4 grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="user-search">Search</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  id="user-search"
                  className="pl-9"
                  placeholder="Name or email"
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select id="user-role" value={roleDraft} onChange={(e) => setRoleDraft(e.target.value)}>
                <option value="">All roles</option>
                <option value="admin">Admin</option>
                <option value="member">Member</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-status">Status</Label>
              <Select id="user-status" value={statusDraft} onChange={(e) => setStatusDraft(e.target.value)}>
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="disabled">Disabled</option>
              </Select>
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={applyFilters}>Apply</Button>
          </div>

          {/* 开关关闭且本页确有被拦的行时才出现（空集 = 这个部署上没人受影响，不必打扰） */}
          {blockedPromotionIds.size > 0 ? (
            <div className="mt-4 flex items-start gap-2 rounded-md border border-muted bg-muted/40 p-3 text-sm text-muted-foreground">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>{ADMIN_PROMOTION_POLICY_NOTICE}</p>
            </div>
          ) : null}

          {usersQuery.isLoading ? (
            <p className="mt-4 text-sm text-muted-foreground">Loading users…</p>
          ) : usersQuery.isError ? (
            <div className="mt-4">
              <ErrorState message={usersQuery.error.message} onRetry={() => usersQuery.refetch()} />
            </div>
          ) : items.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No users match" />
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead className="hidden md:table-cell">Joined</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const isSelf = sessionUser?.id === item.id;
                    const isBusy = updateUser.isPending && updateUser.variables?.id === item.id;
                    const isDeleteBusy = deleteUser.isPending && deleteUser.variables === item.id;
                    // 解绑按钮的禁用原因（11-08 R10 / design §14.4）：null = 可解绑。
                    // 判据与服务端护栏同形 —— 未绑定 / 解掉会没有登录方式 / 邮箱解绑需先有手机。
                    const githubUnbindBlockedReason = !item.githubLinked
                      ? `${item.name} has no GitHub account linked`
                      : !item.emailRegistered && item.phoneNumber === null
                        ? "Cannot unlink the last sign-in method"
                        : null;
                    const emailUnbindBlockedReason = !item.emailRegistered
                      ? `${item.name} has no email address bound`
                      : item.phoneNumber === null
                        ? "Bind a phone number before unbinding email"
                        : null;
                    const isUnbindBusy =
                      unbindIdentity.isPending && unbindIdentity.variables?.id === item.id;
                    // 本行是否被账户安全政策拦下（与写边界同一判据；置灰**不是**隐藏原因：
                    // 可及名与 title 都带上为什么，页面级说明另有一份 —— AC12/AC15）
                    const promotionBlocked = blockedPromotionIds.has(item.id);
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <p className="font-medium">{item.name}</p>
                          <p className="text-xs text-muted-foreground">{item.email}</p>
                        </TableCell>
                        <TableCell>
                          {/* 规范形 `+8613800138000` → 展示为 `+86 13800138000`（design §14.4）。
                              未验证的号码仍可登录，但加上 unverified 徽章提示风险。 */}
                          {item.phoneNumber ? (
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="font-mono text-xs">
                                {item.phoneNumber.slice(0, 3)} {item.phoneNumber.slice(3)}
                              </span>
                              {item.phoneNumberVerified ? null : (
                                <Badge variant="outline">unverified</Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.role === "admin" ? "default" : "outline"}>{item.role}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={item.status === "active" ? "success" : "destructive"}>
                            {item.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{formatUsd(item.balance)}</TableCell>
                        <TableCell className="hidden text-muted-foreground md:table-cell">
                          {formatDateTime(item.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isBusy || isSelf || promotionBlocked}
                              onClick={() =>
                                updateUser.mutate({
                                  id: item.id,
                                  role: item.role === "admin" ? "member" : "admin",
                                })
                              }
                              aria-label={
                                isSelf
                                  ? "You cannot change your own role"
                                  : promotionBlocked
                                    ? `Promote ${item.name} to admin — ${ADMIN_PROMOTION_BLOCKED_REASON}`
                                    : item.role === "admin"
                                      ? `Demote ${item.name} to member`
                                      : `Promote ${item.name} to admin`
                              }
                              title={
                                isSelf
                                  ? "You cannot change your own role"
                                  : promotionBlocked
                                    ? ADMIN_PROMOTION_BLOCKED_REASON
                                    : item.role === "admin"
                                      ? "Demote to member"
                                      : "Promote to admin"
                              }
                            >
                              {item.role === "admin" ? (
                                <ShieldMinus aria-hidden="true" />
                              ) : (
                                <ShieldPlus aria-hidden="true" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isBusy || isSelf}
                              className="text-destructive hover:text-destructive"
                              onClick={() =>
                                updateUser.mutate({
                                  id: item.id,
                                  status: item.status === "active" ? "disabled" : "active",
                                })
                              }
                              aria-label={
                                item.status === "active"
                                  ? `Disable ${item.name}`
                                  : `Enable ${item.name}`
                              }
                              title={isSelf ? "You cannot disable your own account" : item.status === "active" ? "Disable account" : "Enable account"}
                            >
                              {item.status === "active" ? (
                                <UserRoundX aria-hidden="true" />
                              ) : (
                                <UserRoundCheck aria-hidden="true" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={githubUnbindBlockedReason !== null || isUnbindBusy}
                              onClick={() => openUnbindConfirm(item, "github")}
                              aria-label={
                                githubUnbindBlockedReason ??
                                `Unbind GitHub from ${item.name}`
                              }
                              title={githubUnbindBlockedReason ?? "Unbind GitHub"}
                            >
                              <GithubMark />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={emailUnbindBlockedReason !== null || isUnbindBusy}
                              onClick={() => openUnbindConfirm(item, "email")}
                              aria-label={
                                emailUnbindBlockedReason ??
                                `Unbind email from ${item.name}`
                              }
                              title={emailUnbindBlockedReason ?? "Unbind email"}
                            >
                              <MailX aria-hidden="true" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={isSelf || item.role === "admin" || isDeleteBusy}
                              className="text-destructive hover:text-destructive"
                              onClick={() => openDeleteConfirm(item)}
                              aria-label={
                                isSelf
                                  ? "You cannot delete your own account"
                                  : item.role === "admin"
                                    ? "Admins cannot be deleted"
                                    : `Delete ${item.name}`
                              }
                              title={
                                isSelf
                                  ? "You cannot delete your own account"
                                  : item.role === "admin"
                                    ? "Admins cannot be deleted — demote first"
                                    : "Delete user"
                              }
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {items.length > 0 ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                Showing {offset + 1}–{offset + items.length} of {totalUsers}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - 50))}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + 50 >= totalUsers}
                  onClick={() => setOffset(offset + 50)}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* 创建邀请码对话框 */}
      <Dialog
        open={inviteOpen}
        onOpenChange={(open) => {
          setInviteOpen(open);
          setInviteError(null);
          setInviteFieldError(null);
        }}
        title="Create invite code"
        description="New members need this code to register with email."
      >
        <form onSubmit={handleCreateInvite} className="space-y-4" noValidate>
          {inviteError ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {inviteError}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="invite-days">Expires in (days)</Label>
            <Input
              id="invite-days"
              type="number"
              min={1}
              max={90}
              value={expiresInDays}
              onChange={(e) => setExpiresInDays(e.target.value)}
              aria-invalid={inviteFieldError !== null}
            />
            {inviteFieldError ? <p className="text-xs text-destructive">{inviteFieldError}</p> : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setInviteOpen(false)} disabled={createInvite.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={createInvite.isPending}>
              {createInvite.isPending ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* 创建成功展示 */}
      <Dialog
        open={createdCode !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedCode(null);
          }
        }}
        title="Invite code created"
        description="Share this code with the new member."
      >
        {createdCode ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/50 p-3">
              <code className="block break-all font-mono text-sm">{createdCode}</code>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="icon"
                onClick={() => handleCopy(createdCode)}
                aria-label={copiedCode === createdCode ? "Copied" : `Copy invite link ${createdCode}`}
              >
                {copiedCode === createdCode ? (
                  <Check className="text-success" aria-hidden="true" />
                ) : (
                  <Copy aria-hidden="true" />
                )}
              </Button>
              <Button onClick={() => setCreatedCode(null)}>Done</Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* 确认删除用户（admin，member only；成功后关闭，失败保留弹窗 + 顶部错误条） */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null);
          }
        }}
        title="Delete user"
        description="This action cannot be undone."
      >
        {deleteTarget ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/50 p-3">
              <p className="text-sm font-medium">{deleteTarget.name}</p>
              <p className="text-xs text-muted-foreground">{deleteTarget.email}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Balance {formatUsd(deleteTarget.balance)} will be permanently deleted along with all
              API keys and usage history.
            </p>
            {deleteUser.error && !isDeletePending ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {deleteUser.error.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={isDeletePending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleConfirmDelete} disabled={isDeletePending}>
                {isDeletePending ? "Deleting…" : "Delete"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>

      {/* 解绑登录方式（11-08 R10）：GitHub / 邮箱共用同一个确认弹窗。
          与删除弹窗同形态：错误显示在弹窗内，成功后关闭并靠 invalidate 刷新列表。 */}
      <Dialog
        open={unbindTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setUnbindTarget(null);
          }
        }}
        title={unbindTarget?.kind === "github" ? "Unbind GitHub" : "Unbind email"}
        description="The user keeps their account and remaining sign-in methods."
      >
        {unbindTarget ? (
          <div className="space-y-4">
            <div className="rounded-md border bg-muted/50 p-3">
              <p className="text-sm font-medium">{unbindTarget.user.name}</p>
              <p className="text-xs text-muted-foreground">{unbindTarget.user.email}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {unbindTarget.kind === "github"
                ? "The GitHub sign-in will be removed. Password and phone sign-in are unaffected."
                : "The email sign-in will be removed and the address reset to a placeholder. Password login is disabled until the user binds an email again; bonus history is kept."}
            </p>
            {unbindIdentity.error && !isUnbindPending ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {unbindIdentity.error.message}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setUnbindTarget(null)}
                disabled={isUnbindPending}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleConfirmUnbind} disabled={isUnbindPending}>
                {isUnbindPending ? "Unbinding…" : "Unbind"}
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
    </PageContainer>
  );
}
