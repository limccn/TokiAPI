// 认证页共用外壳（登录/注册）。
import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";

export interface AuthCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthCard({ title, description, children, footer }: AuthCardProps) {
  return (
    // 认证页第一屏优先：py-6 + 品牌 mb-5（原 py-10 / mb-6）把上下的留白压掉 20px，
    // 短视口（768/720 高）与手机首屏不必滚动就能看到 GitHub 入口。
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-6">
      <div className="w-full max-w-md">
        <div className="mb-5 flex items-center justify-center gap-2">
          <ShieldCheck className="size-6 text-primary" aria-hidden="true" />
          {/* 品牌是字标，不是页面标题：认证页的 h1 应是卡片标题（与 PageHeader 同一角色），
              否则 h1「TokiAPI」直接跳到 h3「Sign in」，读屏大纲缺一级。 */}
          <span className="text-xl font-semibold tracking-tight">TokiAPI</span>
        </div>
        <Card>
          {/* 认证页用 p-5 而非卡片原语的 p-6：表单控件本身高度固定（h-9），
              省下的是纯留白，不动任何可点击尺寸。 */}
          <CardHeader className="p-5">
            <h1 className="text-base font-semibold leading-none tracking-tight">{title}</h1>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </CardHeader>
          <CardContent className="p-5 pt-0">{children}</CardContent>
        </Card>
        {footer ? (
          <div className="mt-3 text-center text-sm text-muted-foreground">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}
