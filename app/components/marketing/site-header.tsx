// 公开页顶栏（/ 与 /docs 共用；design.md §3/§6）。
// 左：品牌（→ /）+ [docs]；右：GitHub 外链 + 登录态入口（Sign in/Register 或 Dashboard）。
// 无 <a><button> 嵌套：链接一律用 <Link>/<a> + buttonVariants。
import { ArrowUpRight, ShieldCheck } from "lucide-react";
import { Link, NavLink } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { GITHUB_URL } from "@/lib/site-links";
import { cn } from "@/lib/utils";
import type { MarketingChromeProps } from "./types";

export function SiteHeader({ sessionReady, signedIn }: MarketingChromeProps) {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link to="/" className="flex items-center gap-2">
            <ShieldCheck className="size-5 shrink-0 text-brand" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-tight">TokiAPI</span>
          </Link>
          <NavLink
            to="/docs"
            className={({ isActive }) =>
              cn(
                "rounded-sm px-1 py-1 font-mono text-sm transition-colors",
                isActive ? "text-brand" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            [docs]
          </NavLink>
        </div>

        <nav aria-label="Site" className="flex items-center gap-1 sm:gap-2">
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="TokiAPI on GitHub (opens in a new tab)"
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="hidden sm:inline">GitHub</span>
            <ArrowUpRight aria-hidden="true" />
          </a>

          {sessionReady ? (
            signedIn ? (
              <Link to="/dashboard" className={buttonVariants({ variant: "brand", size: "sm" })}>
                Dashboard
              </Link>
            ) : (
              <>
                <Link to="/login" className={buttonVariants({ variant: "ghost", size: "sm" })}>
                  Sign in
                </Link>
                <Link to="/register" className={buttonVariants({ variant: "brand", size: "sm" })}>
                  Register
                </Link>
              </>
            )
          ) : (
            // 未就绪：与「Sign in + Register」组逐像素等宽的不可见占位（同一 cva 度量、
            // 非交互 <span>、aria-hidden）—— 首屏不会先画 Sign in/Register 再跳成 Dashboard。
            <span aria-hidden="true" className="invisible flex items-center gap-1 sm:gap-2">
              <span className={buttonVariants({ variant: "ghost", size: "sm" })}>Sign in</span>
              <span className={buttonVariants({ variant: "brand", size: "sm" })}>Register</span>
            </span>
          )}
        </nav>
      </div>
    </header>
  );
}
