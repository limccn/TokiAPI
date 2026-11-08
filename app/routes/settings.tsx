// /settings — 系统设置（M6 6.3 + M8，admin）：通过 GET /api/admin/settings 拉取
// 当前生效的运行时默认配置（真实数据，无伪造）。只读：这些值为代码常量，
// 无运行时修改端点（PATCH 不做，已知偏差，见 README）。
import { Info } from "lucide-react";
import { useSettings } from "@/modules/settings/hooks/use-settings";
import type { RuntimeSettings } from "@/modules/settings/types";
import { formatUsd } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface SettingRow {
  key: string;
  value: string;
  description: string;
}

function toSettingRows(settings: RuntimeSettings): SettingRow[] {
  return [
    {
      key: "default_cache_ttl",
      value: `${settings.cacheTtlSeconds}s`,
      description: "Default response cache TTL when caching is enabled on a key.",
    },
    {
      key: "rate_limit_window",
      value: `${settings.rateLimitWindowSeconds}s`,
      description: "Fixed-window length for the per-key rate limiter.",
    },
    {
      key: "usage_retention_days",
      value: String(settings.requestLogRetentionDays),
      description:
        "Request detail records are retained for this many days before being purged.",
    },
    {
      key: "signup_bonus_amount",
      value: formatUsd(settings.signupBonusAmount),
      description:
        "Bonus credited once a new account verifies a phone number (0 disables the grant).",
    },
    {
      key: "email_verify_bonus_amount",
      value: formatUsd(settings.emailVerifyBonusAmount),
      description:
        "Bonus credited once a user binds and verifies an email address (0 disables the grant).",
    },
    {
      key: "github_bind_bonus_amount",
      value: formatUsd(settings.githubBindBonusAmount),
      description:
        "Bonus credited once a user links a GitHub account after registration (0 disables the grant).",
    },
    {
      key: "email_verification_enabled",
      value: settings.emailVerificationEnabled ? "enabled" : "disabled",
      description:
        "When disabled, verification emails are not sent and the email binding bonus is unreachable.",
    },
    {
      key: "email_account_admin_promotion_enabled",
      value: settings.emailAccountAdminPromotionEnabled ? "enabled" : "disabled",
      description:
        "When disabled, accounts registered with an email credential cannot be promoted to admin on this deployment (accounts that are already admins are unaffected).",
    },
  ];
}

export default function SettingsPage() {
  const settingsQuery = useSettings();
  const settings = settingsQuery.data?.settings;

  return (
    <PageContainer>
      <PageHeader title="Settings" description="Gateway configuration (read-only)" />

      <Card>
        <CardHeader>
          <CardTitle>Current defaults</CardTitle>
          <CardDescription>
            Values applied by the backend when nothing else is configured.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {settingsQuery.isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
          ) : settingsQuery.isError ? (
            <ErrorState
              message={settingsQuery.error.message}
              onRetry={() => settingsQuery.refetch()}
            />
          ) : settings ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Setting</TableHead>
                  <TableHead>Value</TableHead>
                  <TableHead>Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {toSettingRows(settings).map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>
                      <code className="font-mono text-xs">{row.key}</code>
                    </TableCell>
                    <TableCell className="font-medium">{row.value}</TableCell>
                    <TableCell className="text-muted-foreground">{row.description}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <div className="mt-4 flex items-start gap-2 rounded-md border border-muted bg-muted/40 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p>
              These values are applied at deploy time (code constants or environment
              configuration) — there is no runtime update endpoint (PATCH /api/admin/settings
              is not implemented; see the known deviations in the README).
            </p>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  );
}
