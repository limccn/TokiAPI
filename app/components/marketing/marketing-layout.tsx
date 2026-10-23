// 公开页外壳（/ 与 /docs）：SiteHeader + main + SiteFooter（design.md §2/§3）。
// 会话只在这里查一次，再下发给两个 chrome 组件；页面本体不看登录态。
import { Outlet } from "react-router";
import { useSession } from "@/hooks/use-session";
import { SiteFooter } from "./site-footer";
import { SiteHeader } from "./site-header";

export function MarketingLayout() {
  const { isMounted, isPending, user } = useSession();
  // 未就绪（挂载前 / 查询中）与「未登录」必须可区分：前者 header 渲染等宽占位，
  // 否则首屏会闪一下 Sign in/Register 再变成 Dashboard。
  const sessionReady = isMounted && !isPending;
  const signedIn = sessionReady && user !== null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader sessionReady={sessionReady} signedIn={signedIn} />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter sessionReady={sessionReady} signedIn={signedIn} />
    </div>
  );
}
