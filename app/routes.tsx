// 显式路由表（spec directory-structure.md：所有路由必须在此注册，非文件系统路由）。
// 非关键路由懒加载（spec quality.md：lazy-load non-critical routes）。
// 权限隔离：admin 路由在布局菜单中隐藏（AppLayout）+ 路由级拒绝（RequireAdmin）。
// 例外：`/models` 任何已登录用户可读（批次 P，D18）—— 它**不在** RequireAdmin 里，
// 页内再按角色收敛可写控件；后端只对写动词设 adminOnly。
import { lazy, Suspense, type ComponentType } from "react";
import { createBrowserRouter } from "react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { RequireAdmin } from "@/components/layout/require-admin";
import { MarketingLayout } from "@/components/marketing/marketing-layout";
import { PageLoading } from "@/components/ui/states";

function lazyPage(loader: () => Promise<{ default: ComponentType }>) {
  const Component = lazy(loader);
  return (
    <Suspense fallback={<PageLoading />}>
      <Component />
    </Suspense>
  );
}

export const router = createBrowserRouter([
  // 公开营销面（/ 与 /docs）：不经认证守卫，未登录直接可见。
  // index 精确匹配 `/`，不会吞掉 /login、/register 等同级静态路径（design.md §2 风险 1）。
  {
    element: <MarketingLayout />,
    children: [
      { index: true, element: lazyPage(() => import("@/routes/home")) },
      { path: "docs", element: lazyPage(() => import("@/routes/docs")) },
    ],
  },

  // 认证页（public；已登录时内部重定向到 /dashboard）
  { path: "/login", element: lazyPage(() => import("@/routes/login")) },
  { path: "/register", element: lazyPage(() => import("@/routes/register")) },
  // 短信找回密码（11-06-sms-alicloud-auth）：登录页的 Forgot password? 入口仅在开关开启时出现，
  // 但路由本身无条件注册 —— 直接输 URL 的已登录用户由页面内部重定向接管。
  { path: "/forgot-password", element: lazyPage(() => import("@/routes/forgot-password")) },
  // 强制绑定手机（11-06-sms-alicloud-auth，PRD R19 / design §13.8）：独立页，**不套 AppLayout**。
  // 已登录但未验手机的用户由登录成功回调 / AppLayout 守卫送到这里。
  { path: "/bind-phone", element: lazyPage(() => import("@/routes/bind-phone")) },

  // 受保护布局：认证守卫 + 侧边导航
  {
    element: <AppLayout />,
    children: [
      { path: "dashboard", element: lazyPage(() => import("@/routes/dashboard")) },
      { path: "keys", element: lazyPage(() => import("@/routes/keys")) },
      { path: "billing", element: lazyPage(() => import("@/routes/billing")) },
      { path: "usage", element: lazyPage(() => import("@/routes/usage")) },
      {
        path: "providers",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/providers"))}</RequireAdmin>,
      },
      // models 刻意**不**包 RequireAdmin（批次 P，D18）：member 只读价格表 —— 页内的
      // Add price / 两个行控制 / Actions 列由 useSession 的角色判断自行收敛。写操作的
      // 真防线在后端 router.ts，不在这一层。
      { path: "models", element: lazyPage(() => import("@/routes/models")) },
      {
        path: "users",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/users"))}</RequireAdmin>,
      },
      {
        path: "settings",
        element: <RequireAdmin>{lazyPage(() => import("@/routes/settings"))}</RequireAdmin>,
      },
    ],
  },

  // 404（catch-all）
  { path: "*", element: lazyPage(() => import("@/routes/not-found")) },
]);
