// /tokimeki/sessions — invite 管理：创建一次性分享链接、列表、撤销、生成 CLI attach 命令。
//
// 安全语义（务必保留在 UI 文案里）：invite code 只存哈希，URL 只在创建成功那一刻出现一次；
// 刷新后无法恢复。已签发的 Session JWT 在 exp 前无法撤销 —— revoke 只挡新兑换。
//
// 2026-11-22 console UI alignment（11-22-tokimeki-console-ui，确认 mock v1）：
// 表格改卡片列表（chips + 右对齐操作），弹窗控件对齐向导语言（MiniSegment / Switch /
// Platform·Shell 下拉 / 换行命令块）。TTL 固定预设 1h/8h/24h/72h/7d，无自定义输入。
import { useEffect, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { Link } from "react-router";
import { useApiConfig } from "@/hooks/use-api-config";
import {
  useCreateTokimekiInvite,
  useRevokeTokimekiInvite,
  useTokimekiInviteToken,
  useTokimekiInvites,
  useTokimekiNamespace,
} from "@/modules/tokimeki/hooks/use-tokimeki-invites";
import { buildAttachCommand, type ShellKind } from "@/modules/tokimeki/lib/attach-command";
import {
  PLATFORM_OPTIONS,
  SHELLS_BY_PLATFORM,
  defaultShell,
  detectPlatform,
  type Platform,
} from "@/modules/tokimeki/lib/platform";
import { generateWordSlug } from "@/modules/tokimeki/lib/session-token";
import type {
  CreatedInvite,
  InviteSummaryOutput,
  InviteTokenResult,
} from "@/modules/tokimeki/types";
import { formatDateTime } from "@/lib/format";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Chip, CommandBlock } from "@/components/ui/command-block";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MiniSegment } from "@/components/ui/mini-segment";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { EmptyState, ErrorState, PageLoading } from "@/components/ui/states";

type TtlPreset = "1" | "8" | "24" | "72" | "168";

const TTL_OPTIONS: ReadonlyArray<{ id: TtlPreset; label: string }> = [
  { id: "1", label: "1h" },
  { id: "8", label: "8h" },
  { id: "24", label: "24h" },
  { id: "72", label: "72h" },
  { id: "168", label: "7d" },
];

function statusVariant(status: InviteSummaryOutput["status"]): "default" | "secondary" | "destructive" {
  if (status === "active") return "default";
  if (status === "revoked") return "destructive";
  return "secondary";
}

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  namespace: string | null;
  onCreated: (invite: CreatedInvite) => void;
}

function CreateInviteDialog({ open, onOpenChange, namespace, onCreated }: CreateDialogProps) {
  const createInvite = useCreateTokimekiInvite();
  const [session, setSession] = useState("");
  const [mode, setMode] = useState<"viewer" | "listener">("viewer");
  const [ttl, setTtl] = useState<TtlPreset>("24");
  const [allowWeb, setAllowWeb] = useState(true);
  const [passcodeRequired, setPasscodeRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastOpen, setLastOpen] = useState(false);

  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setSession(namespace === null ? "" : `${namespace}.${generateWordSlug()}`);
      setMode("viewer");
      setTtl("24");
      setAllowWeb(true);
      setPasscodeRequired(false);
      setError(null);
    }
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    try {
      const result = await createInvite.mutateAsync({
        session: session.trim(),
        mode,
        ttlSeconds: Number(ttl) * 3600,
        allowWeb,
        passcodeRequired,
      });
      onOpenChange(false);
      onCreated(result.invite);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "Failed to create link");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="New share link"
      description="The link contains a one-time code and is shown only once."
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        {error === null ? null : (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-2">
          <Label htmlFor="invite-session">Session</Label>
          <div className="flex items-center gap-2">
            <Input
              id="invite-session"
              value={session}
              onChange={(event) => setSession(event.target.value)}
              placeholder="abcde.xyz"
              maxLength={64}
              className="min-w-0 flex-1 font-mono text-xs"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Regenerate session name"
              title="Regenerate"
              onClick={() =>
                setSession(namespace === null ? generateWordSlug() : `${namespace}.${generateWordSlug()}`)
              }
            >
              <RefreshCw />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Must start with your namespace <code>{namespace ?? "<namespace>"}.</code>
          </p>
        </div>
        <div className="space-y-2">
          <Label>Access</Label>
          <MiniSegment
            value={mode}
            onChange={setMode}
            ariaLabel="Access mode"
            block
            options={[
              { id: "viewer", label: "Viewer — can type" },
              { id: "listener", label: "Listener — read-only" },
            ]}
          />
        </div>
        <div className="space-y-2">
          <Label>Valid for</Label>
          <MiniSegment value={ttl} onChange={setTtl} ariaLabel="Link validity" block options={TTL_OPTIONS} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            Browser access
            <span className="block text-xs font-normal text-muted-foreground">
              The web viewer is relay-only; TURN credentials are stripped by the proxy.
            </span>
          </span>
          <Switch checked={allowWeb} onCheckedChange={setAllowWeb} aria-label="Browser access" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium">
            Require passcode
            <span className="block text-xs font-normal text-muted-foreground">
              Only for hosts started with <code>TOKIMEKI_PASSCODE</code>. This is not the 6-digit
              session token.
            </span>
          </span>
          <Switch
            checked={passcodeRequired}
            onCheckedChange={setPasscodeRequired}
            aria-label="Require passcode"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createInvite.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={createInvite.isPending}>
            {createInvite.isPending ? "Creating…" : "Create link"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface OneTimeLinkDialogProps {
  invite: CreatedInvite | null;
  onClose: () => void;
}

function OneTimeLinkDialog({ invite, onClose }: OneTimeLinkDialogProps) {
  if (invite === null) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Link created"
      description="Copy it now — the code is stored only as a hash and cannot be shown again."
    >
      <div className="space-y-4">
        <CommandBlock value={invite.url} />
        <div className="flex flex-wrap gap-1.5">
          <Chip>{invite.session}</Chip>
          <Chip>{invite.mode}</Chip>
          <Chip>expires {formatDateTime(invite.expiresAt)}</Chip>
        </div>
        <p className="text-xs text-muted-foreground">The link works once the host starts.</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Dialog>
  );
}

interface CommandDialogProps {
  result: InviteTokenResult | null;
  relayUrl: string;
  onClose: () => void;
}

function CommandDialog({ result, relayUrl, onClose }: CommandDialogProps) {
  // SSR-safe defaults; real platform detection runs when the dialog opens.
  const [platform, setPlatform] = useState<Platform>("linux");
  const [shell, setShell] = useState<ShellKind>("bash");
  const [passcode, setPasscode] = useState("");
  useEffect(() => {
    if (result === null) return;
    const detected = detectPlatform();
    setPlatform(detected);
    setShell(defaultShell(detected));
    setPasscode("");
  }, [result]);

  if (result === null) return null;
  let command: string | null = null;
  let commandError: string | null = null;
  if (relayUrl.length === 0) {
    commandError = "TOKIMEKI_RELAY_URL is not configured; the command cannot be generated.";
  } else if (result.passcodeRequired && passcode.trim().length === 0) {
    commandError =
      "This session requires a passcode. Enter TOKIMEKI_PASSCODE to generate the command.";
  } else {
    try {
      command = buildAttachCommand({
        shell,
        relayUrl,
        session: result.session,
        token: result.token,
        mode: result.mode,
        ...(passcode.trim().length === 0 ? {} : { passcode: passcode.trim() }),
      });
    } catch (error) {
      commandError = error instanceof Error ? error.message : "Invalid command input";
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="CLI attach command"
      description="The Session JWT is embedded in the command and expires with the invite."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="invite-command-platform">Platform</Label>
            <Select
              id="invite-command-platform"
              value={platform}
              onChange={(event) => {
                const next = event.target.value as Platform;
                setPlatform(next);
                setShell(defaultShell(next));
              }}
            >
              {PLATFORM_OPTIONS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="invite-command-shell">Shell</Label>
            <Select
              id="invite-command-shell"
              value={shell}
              onChange={(event) => setShell(event.target.value as ShellKind)}
            >
              {SHELLS_BY_PLATFORM[platform].map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </Select>
          </div>
        </div>
        {result.passcodeRequired ? (
          <div className="space-y-2">
            <Label htmlFor="invite-command-passcode">Session passcode — this session requires one</Label>
            <Input
              id="invite-command-passcode"
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="TOKIMEKI_PASSCODE"
            />
          </div>
        ) : null}
        {commandError === null && command !== null ? (
          <CommandBlock value={command} />
        ) : (
          <p role="alert" className="text-sm text-destructive">
            {commandError ?? "Could not render the command."}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Revoking the link only blocks new redemptions; this JWT stays valid until{" "}
          {formatDateTime(result.expiresAt)}.
        </p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Close</Button>
        </div>
      </div>
    </Dialog>
  );
}

export default function TokimekiSessionsPage() {
  const config = useApiConfig();
  const namespaceQuery = useTokimekiNamespace();
  const invitesQuery = useTokimekiInvites();
  const revokeInvite = useRevokeTokimekiInvite();
  const inviteToken = useTokimekiInviteToken();
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [commandResult, setCommandResult] = useState<InviteTokenResult | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<InviteSummaryOutput | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  if (config.data?.tokimekiEnabled === false) {
    return (
      <PageContainer>
        <PageHeader title="Tokimeki sessions" />
        <EmptyState
          title="Tokimeki is not configured"
          description="Set TOKIMEKI_JWT_PRIVATE_JWK and TOKIMEKI_RELAY_URL to enable share links."
        />
      </PageContainer>
    );
  }

  const relayUrl = config.data?.tokimekiRelayUrl ?? "";
  const namespace = namespaceQuery.data?.namespace ?? null;

  const requestCommand = async (invite: InviteSummaryOutput) => {
    setActionError(null);
    try {
      const result = await inviteToken.mutateAsync(invite.id);
      setCommandResult(result);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to issue a session token");
    }
  };

  const confirmRevoke = async () => {
    if (pendingRevoke === null) return;
    setActionError(null);
    try {
      await revokeInvite.mutateAsync(pendingRevoke.id);
      setPendingRevoke(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to revoke the link");
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Tokimeki sessions & links"
        description="Create one-time viewer or listener links. The link works once the host starts."
        actions={
          <Button onClick={() => setCreateOpen(true)} disabled={relayUrl.length === 0}>
            <Plus /> New link
          </Button>
        }
      />

      {relayUrl.length === 0 ? (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          TOKIMEKI_RELAY_URL is not configured; commands cannot be generated.
        </p>
      ) : null}
      {actionError === null ? null : (
        <p role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}

      {invitesQuery.isLoading ? <PageLoading /> : null}
      {invitesQuery.isError ? (
        <ErrorState
          message={invitesQuery.error instanceof Error ? invitesQuery.error.message : undefined}
          onRetry={() => void invitesQuery.refetch()}
        />
      ) : null}
      {invitesQuery.data !== undefined && invitesQuery.data.items.length === 0 ? (
        <EmptyState title="No links yet" description="Create one to share a running session." />
      ) : null}

      {invitesQuery.data !== undefined && invitesQuery.data.items.length > 0 ? (
        <div className="space-y-2.5">
          {invitesQuery.data.items.map((invite) => (
            <Card key={invite.id}>
              <CardContent className="space-y-2.5 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-xs font-semibold">{invite.session}</code>
                  <Badge variant={statusVariant(invite.status)}>{invite.status}</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Chip>{invite.mode === "listener" ? "Listener" : "Viewer"}</Chip>
                  <Chip className={invite.allowWeb ? "text-success" : undefined}>
                    {invite.allowWeb ? "Web" : "Web off"}
                  </Chip>
                  {invite.passcodeRequired ? <Chip>Passcode</Chip> : null}
                  <Chip>created {formatDateTime(invite.createdAt)}</Chip>
                  <Chip>expires {formatDateTime(invite.expiresAt)}</Chip>
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void requestCommand(invite)}
                    disabled={
                      relayUrl.length === 0 ||
                      invite.status !== "active" ||
                      inviteToken.isPending
                    }
                  >
                    <RefreshCw /> Command
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={invite.status === "active" ? "text-destructive hover:text-destructive" : undefined}
                    onClick={() => setPendingRevoke(invite)}
                    disabled={invite.status === "revoked"}
                  >
                    <Trash2 /> Revoke
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      <p className="mt-3 text-xs text-muted-foreground">
        Codes are stored as hashes. Use “New link” to share again; old URLs cannot be recovered.
      </p>
      <Link className="mt-1 inline-block py-1 text-sm underline underline-offset-4" to="/tokimeki/tokens">
        Host tokens →
      </Link>

      <CreateInviteDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        namespace={namespace}
        onCreated={(invite) => setCreated(invite)}
      />
      <OneTimeLinkDialog invite={created} onClose={() => setCreated(null)} />
      <CommandDialog
        result={commandResult}
        relayUrl={relayUrl}
        onClose={() => setCommandResult(null)}
      />
      <Dialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null);
        }}
        title="Revoke this link?"
        description="New redemptions stop immediately. Session JWTs already issued stay valid until they expire."
      >
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setPendingRevoke(null)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void confirmRevoke()} disabled={revokeInvite.isPending}>
            {revokeInvite.isPending ? "Revoking…" : "Revoke link"}
          </Button>
        </div>
      </Dialog>
    </PageContainer>
  );
}
