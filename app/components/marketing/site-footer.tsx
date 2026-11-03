// 公开页页脚（/ 与 /docs 共用）：品牌一行 + Docs / GitHub / 登录态入口（design.md §3/§5）。
import { Link } from "react-router";
import { GITHUB_URL } from "@/lib/site-links";
import type { MarketingChromeProps } from "./types";

export function SiteFooter({ signedIn }: MarketingChromeProps) {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="text-sm text-muted-foreground">TokiAPI — Self-hosted AI API gateway.</p>
        <nav aria-label="Footer" className="flex items-center gap-4 text-sm">
          <Link to="/docs" className="text-muted-foreground transition-colors hover:text-foreground">
            Docs
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          {signedIn ? (
            <Link to="/dashboard" className="text-muted-foreground transition-colors hover:text-foreground">
              Dashboard
            </Link>
          ) : (
            <Link to="/login" className="text-muted-foreground transition-colors hover:text-foreground">
              Sign in
            </Link>
          )}
        </nav>
      </div>
    </footer>
  );
}
