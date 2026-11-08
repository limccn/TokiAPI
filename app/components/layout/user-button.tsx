// 认证感知的用户菜单（spec authentication.md UserButton 模式：isMounted + 未登录回退）。
//
// 09-16-account-menu：头像升级为下拉菜单触发器 —— 登出收进菜单（行为与旧实现一字不差：
// await authClient.signOut() + queryClient.clear()），并新增 Profile 弹窗入口。
// 09-17-password-menu-and-dialog-overflow：改密从 Profile 弹窗的内嵌区块升为**并列菜单项**
// （顺序 Profile → Change password → 分隔线 → Sign out），点开自己的弹窗。
// compact（窄屏图标栏）与常规态**共用同一份菜单逻辑**，仅触发器可见内容不同（不复制两份）。
import { useState } from "react";
import { KeyRound, LogOut, User } from "lucide-react";
import { Link } from "react-router";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";
import { useSession } from "@/hooks/use-session";
import { Skeleton } from "@/components/ui/skeleton";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useProfile } from "@/modules/profile/hooks/use-profile";
// 占位邮箱判据与资料页共用同一份零依赖函数（src/lib/phone.ts）：
// 手机号注册账号的 `u<5hex>.+86…@phone.invalid` 是内部地址，不该展示给用户（PRD R18 / AC37）。
import { isPlaceholderEmail } from "../../../src/lib/phone";
import { ChangePasswordDialog } from "./change-password-dialog";
import { ProfileDialog } from "./profile-dialog";
import { SetPasswordDialog } from "./set-password-dialog";

export function UserButton({ compact = false }: { compact?: boolean }) {
  const { isMounted, isPending, user } = useSession();
  const [profileOpen, setProfileOpen] = useState(false);
  // 弹窗各持一份状态：开哪个由点的是哪个菜单项决定。共用一份会互相踩
  // （从 Profile 切到 Change password 时，前者 close 会顺手把后者也关掉）。
  //
  // 密码入口是**一个**菜单项、两种形态（11-06-sms-alicloud-auth）：有密码开 Change，
  // 没有密码开 Set —— 形态由 PasswordMenuItem 按服务端 hasPassword 决定并回报，这里只存结果。
  const [passwordDialog, setPasswordDialog] = useState<"change" | "set" | null>(null);

  if (!isMounted || isPending) {
    return <Skeleton className="h-9 w-9 rounded-full" aria-label="Loading user" />;
  }

  if (!user) {
    return (
      <Link to="/login" className={buttonVariants({ variant: "outline", size: "sm", className: "h-8" })}>
        Sign In
      </Link>
    );
  }

  const handleSignOut = async () => {
    await authClient.signOut();
    queryClient.clear();
  };

  // 菜单里的邮箱展示与资料页同口径：占位地址显示 Not set（与 profile-dialog 的 Email 行一致）
  const emailLabel = isPlaceholderEmail(user.email) ? "Not set" : user.email;

  const avatar = (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/20 text-sm font-semibold text-primary"
      aria-hidden="true"
    >
      {user.name.slice(0, 1).toUpperCase()}
    </span>
  );

  return (
    <>
      <DropdownMenu
        triggerLabel="Account menu"
        triggerTitle={compact ? user.name : undefined}
        triggerClassName={
          compact
            ? "rounded-full"
            : "flex w-full items-center gap-3 rounded-md p-1 text-left transition-colors hover:bg-muted"
        }
        trigger={
          compact ? (
            avatar
          ) : (
            <>
              {avatar}
              <span className="hidden min-w-0 flex-1 sm:block">
                <span className="block truncate text-sm font-medium leading-tight">{user.name}</span>
                <span className="block truncate text-xs leading-tight text-muted-foreground">
                  {emailLabel}
                </span>
              </span>
            </>
          )
        }
      >
        {/* 账户区：非交互（不参与 ↑/↓ 焦点移动），name + email 单行截断 */}
        <DropdownMenuLabel>
          <p className="truncate text-sm font-medium leading-tight">{user.name}</p>
          <p className="truncate text-xs leading-tight text-muted-foreground">{emailLabel}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => setProfileOpen(true)}>
          <User aria-hidden="true" />
          Profile
        </DropdownMenuItem>
        {/* 顺序（R1）：Profile → 密码项 → 分隔线 → Sign out。
            密码项**恒常驻**，可用性由判据门控（未就绪 / 查询失败一律置灰），见 PasswordMenuItem。 */}
        <PasswordMenuItem onSelect={(mode) => setPasswordDialog(mode)} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void handleSignOut()}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenu>
      <ProfileDialog open={profileOpen} onOpenChange={setProfileOpen} />
      <ChangePasswordDialog
        open={passwordDialog === "change"}
        onOpenChange={(open) => {
          if (!open) setPasswordDialog(null);
        }}
      />
      <SetPasswordDialog
        open={passwordDialog === "set"}
        onOpenChange={(open) => {
          if (!open) setPasswordDialog(null);
        }}
      />
    </>
  );
}

/**
 * 账户菜单里的密码入口（09-17-password-menu-and-dialog-overflow §3.1/§3.3；
 * **09-21 由「占位槽 + 条件渲染」改为「常驻 + 置灰门控」**；
 * **11-06 起同一项按 hasPassword 变两种形态**，见下）。
 *
 * **挂载时机 = 菜单打开时机**（隐含契约，来自 dropdown-menu.tsx 的面板渲染式
 * `{open && pos ? createPortal(…{children}…) : null}` —— children 只在打开时挂载）。
 * 故这里的 useProfile() 语义天然就是「用户真的动了这个菜单」才发一次 GET /api/me/profile：
 * 60s staleTime 内重开菜单命中缓存，页面加载时零请求（AC5）。
 * **若将来把面板改成常驻挂载，本入口会静默退化成「页面加载即发请求」** —— 改那里必须同步重审本条。
 *
 * 判据唯一真源是服务端下发的 hasPassword（design §4）：前端不得从 provider / 登录方式推导。
 *
 * **09-21 变更（用户裁决，推翻 09-17 的占位槽与决策 D5「不置灰」）**：本项**无条件渲染**，
 * 未就绪与不可用一律置灰（`aria-disabled`）。两点理由：
 *   ① 位移**彻底**消失 —— 项常驻、菜单高度恒定，其下方 Sign out 在任何时序下都不动。
 *      09-17 的占位槽只护住了「查询中」这一段；判据最终解析为 false（OAuth 用户）时占位槽连同空间
 *      一起消失、下方项上移一次，那笔残余位移是当时「不为一次性的、无交互元素参与的上移引入常驻空位」
 *      的取舍（spec/components.md 的 async-entry-placeholder 原记录）—— 本次由用户改判；
 *   ② 灰项本身携带信息（「改密在这里，只是现在用不了」）；09-17 的不可见占位盒对用户是**零信息**。
 *
 * **11-06 变更（短信认证任务 design §7.5）**：`hasPassword === false` 不再是**永不可用**，
 * 而是变成可用的「Set password」（新表单：新密码 + 确认，不要求当前密码，打自建
 * `POST /api/me/password`）。这是「手机号注册要设密码」带来的自然结果 ——
 * 手机号注册的账号建号时没有密码，若此项仍置灰，用户就永远只能靠短信登录。
 * **有意接受的副作用（PRD R12）**：纯 GitHub 账号的此项也从「永远不可用」变为可用，
 * 与 09-21 裁决的表面相反。刻意**不**加「区分注册渠道」的判据 —— 那会引入新的前后端漂移点，
 * 而「给任意账号补一个密码」本身无害（凭据由本人会话下发）。
 *
 * 失败方向不变（fail-closed）：查询失败、查询中都落到**不可点击**，
 * 绝不出现「默认可点、点下去才发现打不开」—— 死键是可见的，死表单不是。
 * 刻意**不**为置灰态加「为什么不可用」的 title：本组件区分不了「查询失败」与「查询中」，
 * 一句通用文案只会更含糊。
 */
function PasswordMenuItem({ onSelect }: { onSelect: (mode: "change" | "set") => void }) {
  const { data, isPending } = useProfile();

  // 唯一判据：查询已就绪（拿得到 hasPassword）。查询中 / 查询失败 → 不可用（fail-closed）。
  const hasPassword = data?.profile.hasPassword;
  const enabled = !isPending && hasPassword !== undefined;

  return (
    <DropdownMenuItem disabled={!enabled} onSelect={() => onSelect(hasPassword ? "change" : "set")}>
      <KeyRound aria-hidden="true" />
      {/* 判据未就绪时沿用历史文案「Change password」：未知时不该断言「你还没有密码」，
          只有服务端**确定** hasPassword === false 才改口 */}
      {hasPassword === false ? "Set password" : "Change password"}
    </DropdownMenuItem>
  );
}
