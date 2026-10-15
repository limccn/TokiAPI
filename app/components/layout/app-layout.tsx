// 应用主布局（M6 6.2）：受保护路由 + 侧边导航（member/admin 视角菜单隔离）。
// 认证守卫：isMounted → isPending → 未登录重定向 /login；停用账号提示登出。
import type { ReactNode } from "react";
import {
  BarChart3,
  KeyRound,
  LayoutDashboard,
  Server,
  Settings,
  ShieldCheck,
  Tag,
  Users,
  Wallet,
} from "lucide-react";
import { Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useSession } from "@/hooks/use-session";
import { authClient } from "@/lib/auth-client";
import { queryClient } from "@/lib/query-client";
import { cn } from "@/lib/utils";
import { PageLoading } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { WelcomeDialog } from "@/components/onboarding/welcome-dialog";
import { UserButton } from "./user-button";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  adminOnly?: boolean;
  end?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: <LayoutDashboard />, end: true },
  { to: "/keys", label: "API Keys", icon: <KeyRound /> },
  { to: "/billing", label: "Billing", icon: <Wallet /> },
  { to: "/usage", label: "Usage", icon: <BarChart3 /> },
  { to: "/providers", label: "Providers", icon: <Server />, adminOnly: true },
  // Models 对 member 也可见（批次 P，D18）：member 只读价格表 —— 他们得知道自己按什么价计费
  { to: "/models", label: "Models", icon: <Tag /> },
  { to: "/users", label: "Users", icon: <Users />, adminOnly: true },
  { to: "/settings", label: "Settings", icon: <Settings />, adminOnly: true },
];

export function AppLayout() {
  const { isMounted, isPending, user } = useSession();
  const location = useLocation();

  if (!isMounted || isPending) {
    return (
      <div className="min-h-screen">
        <PageLoading />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (user.status === "disabled") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
        <h1 className="text-lg font-semibold">Account disabled</h1>
        <p className="text-sm text-muted-foreground">
          Your account has been disabled by an administrator. Please contact support.
        </p>
        <Button
          variant="outline"
          onClick={async () => {
            await authClient.signOut();
            queryClient.clear();
          }}
        >
          Sign out
        </Button>
      </div>
    );
  }

  const visibleItems = NAV_ITEMS.filter((item) => !item.adminOnly || user.role === "admin");

  return (
    <div className="min-h-screen">
      <div className="flex">
        {/* 侧边栏（全宽度可见：<lg 为 w-16 图标栏，lg 起全宽；图标 title 提示） */}
        <aside className="sticky top-0 flex h-screen w-16 shrink-0 flex-col border-r lg:w-60">
          <div className="flex h-14 items-center justify-center border-b px-0 lg:justify-start lg:px-5">
            <LinkBrand compact />
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main navigation">
            {visibleItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={item.label}
                className={({ isActive }) =>
                  cn(
                    "flex items-center justify-center gap-3 rounded-md px-0 py-2 text-sm font-medium transition-colors lg:justify-start lg:px-3",
                    isActive
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <span className="[&_svg]:size-4">{item.icon}</span>
                <span className="hidden lg:inline">{item.label}</span>
              </NavLink>
            ))}
          </nav>
          <div className="border-t p-3">
            <div className="flex justify-center lg:hidden">
              <UserButton compact />
            </div>
            <div className="hidden lg:block">
              <UserButton />
            </div>
          </div>
        </aside>

        {/* 主内容 */}
        <main className="min-w-0 flex-1">
          {/* 首登赠金引导弹窗（09-16-first-login-welcome）：挂在已认证分支内，
              未登录/停用账号已在上方 return，不会挂载（避免无谓的 401 查询）。
              组件自身处理 isPending/isError/无赠金 → 不渲染，不阻塞页面。 */}
          <WelcomeDialog />
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function LinkBrand({ compact = false }: { compact?: boolean }) {
  return (
    <NavLink to="/dashboard" className="flex items-center gap-2" title="TokiAPI">
      <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden="true" />
      <span
        className={cn(
          "text-sm font-semibold tracking-tight",
          compact ? "hidden lg:inline" : "inline",
        )}
      >
        TokiAPI
      </span>
    </NavLink>
  );
}
