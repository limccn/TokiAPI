// / — 公开产品首页（10-23-marketing-home-docs）。
// 单页极简：eyebrow → 产品名 → 一句话简介 → 两个 CTA → 产品截图。
// 刻意不含 playground / 功能清单 / 定价 / FAQ（prd.md 页面 1）。
import { ArrowUpRight } from "lucide-react";
import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { GITHUB_URL } from "@/lib/site-links";
// doc/screenshot.png 由 Vite 内容哈希化（不复制二进制、不落 public/）；1439×783 原始尺寸。
import screenshotUrl from "../../doc/screenshot.png";

export default function HomePage() {
  return (
    <div className="relative">
      {/* 顶部品牌光晕（纯装饰，不拦截指针） */}
      <div
        className="marketing-glow pointer-events-none absolute inset-x-0 top-0 h-[30rem]"
        aria-hidden="true"
      />

      <div className="relative mx-auto w-full max-w-6xl px-5 pt-16 sm:px-6 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-brand">
            Open source · Self-hosted
          </p>
          <h1 className="mt-6 text-5xl font-semibold tracking-tight sm:text-7xl">
            Toki<span className="text-brand">API</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            One gateway for every model provider — OpenAI-compatible and Anthropic-native,
            running entirely on <em className="italic text-foreground">your own</em> Cloudflare
            account.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "brand", size: "lg" })}
            >
              View on GitHub
              <ArrowUpRight aria-hidden="true" />
            </a>
            <Link to="/docs" className={buttonVariants({ variant: "outline", size: "lg" })}>
              Read the docs
            </Link>
          </div>
        </div>

        <figure className="mt-14 pb-20 sm:mt-20">
          <div className="rounded-xl border bg-card/60 p-1.5 shadow-2xl ring-1 ring-brand/15">
            <img
              src={screenshotUrl}
              width={1439}
              height={783}
              loading="eager"
              decoding="async"
              alt="TokiAPI management console showing balance, usage charts, and the keys and models pages"
              className="h-auto w-full rounded-lg border"
            />
          </div>
          <figcaption className="mt-3 text-center text-xs text-muted-foreground">
            The console: keys, balances, usage and prices in one place.
          </figcaption>
        </figure>
      </div>
    </div>
  );
}
