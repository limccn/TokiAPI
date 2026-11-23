// /tokimeki/tokens — master token 管理（11-18-tokimeki-master-token）。
//
// 语义（务必保留在 UI 文案里）：ES256 Host JWT **没有撤销列表** —— 删除记录不会让已签发的
// token 失效，只能等到期或轮换密钥。明文只展示一次。relay 侧的 root 静态 token 不受影响。
//
// 2026-11-22 console UI alignment（11-22-tokimeki-console-ui，确认 mock v1）：
// 表格改卡片列表（chips + 状态 Badge）；创建/明文弹窗布局对齐向导语言，文案不变。
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router";
import { Check, Copy, Plus } from "lucide-react";
import { useApiConfig } from "@/hooks/use-api-config";
import { useTokimekiTokens } from "@/modules/tokimeki/hooks/use-tokimeki-tokens";
import { useCreateTokimekiToken } from "@/modules/tokimeki/hooks/use-create-tokimeki-token";
import type {
  CreateTokimekiTokenOutput,
  TokimekiTokenRecord,
} from "@/modules/tokimeki/types";
import { copyToClipboard } from "@/lib/clipboard";
import { formatDateTime } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Chip } from "@/components/ui/command-block";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState } from "@/components/ui/states";

// ============= 创建对话框 =============

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: CreateTokimekiTokenOutput) => void;
}

function CreateTokenDialog({ open, onOpenChange, onCreated }: CreateDialogProps) {
  const createToken = useCreateTokimekiToken();
  const [name, setName] = useState("Master token");
  const [error, setError] = useState<string | null>(null);

  const [lastOpen, setLastOpen] = useState(false);
  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setName("Master token");
      setError(null);
    }
  }

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name is required");
      return;
    }
    if (trimmed.length > 100) {
      setError("Max 100 characters");
      return;
    }
    setError(null);
    try {
      const result = await createToken.mutateAsync({ name: trimmed });
      onOpenChange(false);
      onCreated(result);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to create token");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Create master token"
      description="A long-lived Host JWT for the tokimeki relay. The secret is shown only once."
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="space-y-2">
          <Label htmlFor="tokimeki-token-name">Name</Label>
          <Input
            id="tokimeki-token-name"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="laptop-claude"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          Default lifetime is 30 days. There is no revocation list — a leaked token stays valid
          until it expires or the signing key is rotated.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createToken.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createToken.isPending}>
            {createToken.isPending ? "Creating…" : "Create token"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// ============= 一次性明文对话框 =============

interface PlaintextDialogProps {
  result: CreateTokimekiTokenOutput | null;
  onClose: () => void;
}

function PlaintextDialog({ result, onClose }: PlaintextDialogProps) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    setCopied(false);
    setCopyError(null);
  }, [result]);

  const handleCopy = async () => {
    if (!result) {
      return;
    }
    const ok = await copyToClipboard(result.token);
    if (ok) {
      setCopied(true);
      setCopyError(null);
    } else {
      setCopyError("Copy failed — clipboard is unavailable. Select the token manually.");
    }
  };

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title="Master token created"
      description="Copy it now — it will not be shown again."
    >
      {result ? (
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/50 p-3">
            <code className="block break-all font-mono text-xs leading-relaxed">
              {result.token}
            </code>
          </div>
          {copyError ? (
            <p role="alert" className="text-xs text-destructive">
              {copyError}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              aria-label={copied ? "Copied" : "Copy token to clipboard"}
            >
              {copied ? <Check className="text-success" aria-hidden="true" /> : <Copy aria-hidden="true" />}
            </Button>
            <Button onClick={onClose}>Done</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Store it where the host runs. To rotate, create a new token and replace the old value;
            the previous token remains valid until it expires.
          </p>
        </div>
      ) : null}
    </Dialog>
  );
}

// ============= 列表 =============

function isExpired(record: TokimekiTokenRecord): boolean {
  return new Date(record.expiresAt).getTime() <= Date.now();
}

// ============= 页面 =============

export default function TokimekiTokensPage() {
  const config = useApiConfig();
  const enabled = config.data?.tokimekiEnabled === true;
  const tokensQuery = useTokimekiTokens(enabled);
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreateTokimekiTokenOutput | null>(null);

  const items = tokensQuery.data?.items ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Tokimeki tokens"
        description="Long-lived Host JWTs for the tokimeki relay (ES256)."
        actions={
          <>
            <Link className={buttonVariants({ variant: "outline" })} to="/tokimeki/sessions">
              Sessions &amp; links
            </Link>
            {enabled ? (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus aria-hidden="true" />
                Create token
              </Button>
            ) : null}
          </>
        }
      />

      {config.isLoading ? (
        <Card>
          <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            Loading…
          </CardContent>
        </Card>
      ) : enabled ? (
        <>
          <p className="text-xs text-muted-foreground">
            {tokensQuery.isLoading ? "…" : `${items.length} total`}. Tokens cannot be revoked —
            expiry or key rotation is the only way to invalidate one.
          </p>
          {tokensQuery.isLoading ? (
            <Card>
              <CardContent className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                Loading…
              </CardContent>
            </Card>
          ) : tokensQuery.isError ? (
            <ErrorState
              message={tokensQuery.error.message}
              onRetry={() => tokensQuery.refetch()}
            />
          ) : items.length === 0 ? (
            <EmptyState
              title="No tokens yet"
              description="Create a token to host a tokimeki session."
            />
          ) : (
            <div className="mt-3 space-y-2.5">
              {items.map((record) => (
                <Card key={record.id}>
                  <CardContent className="space-y-2.5 p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{record.name}</span>
                      <Badge variant={isExpired(record) ? "destructive" : "success"}>
                        {isExpired(record) ? "expired" : "active"}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      <Chip>jti {record.jti.slice(0, 8)}…</Chip>
                      <Chip>namespace {record.namespace}</Chip>
                      <Chip>created {formatDateTime(record.createdAt)}</Chip>
                      <Chip>expires {formatDateTime(record.expiresAt)}</Chip>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          <Link
            className="mt-3 inline-block py-1 text-sm underline underline-offset-4"
            to="/tokimeki/sessions"
          >
            Sessions &amp; links →
          </Link>
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Tokimeki is not configured</CardTitle>
            <CardDescription>
              Set the ES256 private key secret <code className="font-mono">TOKIMEKI_JWT_PRIVATE_JWK</code>{" "}
              to enable token issuing. The relay consumes the public key from{" "}
              <code className="font-mono">/api/tokimeki/jwks.json</code>.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={setCreated}
      />
      <PlaintextDialog result={created} onClose={() => setCreated(null)} />
    </PageContainer>
  );
}
