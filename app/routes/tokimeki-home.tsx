// /tokimeki — public hub, redesigned as a 3-step wizard (2026-11-22, task
// 11-22-tokimeki-wizard-redesign; confirmed mock: mock.html v3 in the task dir):
//   1. Install — npm command + "Skip next time" switch (writes tokimeki_skip_install
//      cookie; the page then opens straight at step 2 on later visits);
//   2. Host / Attach — login-page-style segment. Host: Platform/Shell/ACP only, plus
//      (signed-in) collapsible Session / Passcode / Advanced sections. Attach: session
//      id + token + optional passcode;
//   3. Command — host command + share link (+ collapsible session/token/passcode rows)
//      or attach result (browser open when allowed + terminal command with its own
//      platform/shell picks). Back returns one step.
// Flows and APIs are unchanged from the pre-wizard hub: anon-host, signed-in
// createToken/createInvite, POST /api/tokimeki/attach/cli redemption, relay-url guard
// and the disabled-tenant card. Deliberate simplifications: env-style commands only
// (no Env/Config segment) and no windowTui input.
import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, ExternalLink, Pencil, RotateCcw } from "lucide-react";
import { Link } from "react-router";
import { useApiConfig } from "@/hooks/use-api-config";
import { useSession } from "@/hooks/use-session";
import { useAnonHost } from "@/modules/tokimeki/hooks/use-anon-host";
import { useCreateTokimekiToken } from "@/modules/tokimeki/hooks/use-create-tokimeki-token";
import {
  useCreateTokimekiInvite,
  useTokimekiNamespace,
} from "@/modules/tokimeki/hooks/use-tokimeki-invites";
import {
  buildAttachCommand,
  isSafeCommandValue,
  type ShellKind,
} from "@/modules/tokimeki/lib/attach-command";
import {
  isValidHostSessionName,
  parseAttachInput,
  resolveHostSessionName,
} from "@/modules/tokimeki/lib/hub-input";
import {
  ACP_COMMANDS,
  buildHostCommand,
  buildHostConfigEnvelope,
  type AgentKind,
} from "@/modules/tokimeki/lib/host-command";
import {
  PLATFORM_OPTIONS,
  SHELLS_BY_PLATFORM,
  defaultShell,
  detectPlatform,
  type Platform,
} from "@/modules/tokimeki/lib/platform";
import {
  generatePasscode,
  generateSessionToken,
  generateWordSlug,
  isValidPasscode,
  isValidSessionToken,
} from "@/modules/tokimeki/lib/session-token";
import { ApiError } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { PageContainer } from "@/components/layout/page-container";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Chip, CommandBlock } from "@/components/ui/command-block";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MiniSegment } from "@/components/ui/mini-segment";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

type Step = 1 | 2 | 3;
type Action = "host" | "attach";
type WindowSizePreset = "auto" | "80x24" | "120x40";
type TtlPreset = "1" | "8" | "24" | "168";

const TTL_OPTIONS: ReadonlyArray<{ id: TtlPreset; label: string }> = [
  { id: "1", label: "1h" },
  { id: "8", label: "8h" },
  { id: "24", label: "24h" },
  { id: "168", label: "7d" },
];

const INSTALL_COMMAND = "npm install -g @limccn/tokimeki@latest";
const SKIP_COOKIE = "tokimeki_skip_install";

function agentLabel(agent: AgentKind): string {
  return ACP_COMMANDS.find((entry) => entry.id === agent)?.label ?? agent;
}

function readSkipCookie(): boolean {
  return document.cookie
    .split(";")
    .some((entry) => entry.trim() === `${SKIP_COOKIE}=1`);
}

function writeSkipCookie(enabled: boolean): void {
  // ON keeps the flag for a year; OFF lets it lapse immediately.
  document.cookie =
    enabled === true
      ? `${SKIP_COOKIE}=1; max-age=31536000; path=/; SameSite=Lax`
      : `${SKIP_COOKIE}=; max-age=0; path=/; SameSite=Lax`;
}

interface HostOptions {
  readonly passcode?: string;
  readonly windowSize?: string;
}

interface HostResult {
  readonly token: string;
  readonly namespace: string;
  readonly session: string;
  readonly sessionToken: string;
  readonly inviteUrl: string;
  readonly expiresAt: string | null;
  readonly anonymous: boolean;
  readonly options: HostOptions;
}

interface AttachResult {
  readonly session: string;
  readonly token: string;
  /** Absolute share URL for the browser-open shortcut; null on direct attach. */
  readonly webUrl: string | null;
  readonly mode: "viewer" | "listener";
  readonly allowWeb: boolean;
  readonly passcodeRequired: boolean;
  readonly passcode?: string;
  readonly expiresAt: string | null;
}

function CopyButton({ value, iconOnly = false }: { value: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label={iconOnly ? "Copy" : undefined}
      className={cn(iconOnly && "shrink-0")}
      onClick={async () => {
        setCopied(await copyToClipboard(value));
        window.setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? <Check /> : <Copy />}
      {iconOnly ? null : copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** Session-details quote row: fixed label / wrapping value / fixed Copy. */
function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-r-md border-l-[3px] border-border bg-muted/60 px-3 py-1.5">
      <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-xs [overflow-wrap:anywhere]">
        {value}
      </code>
      <CopyButton value={value} iconOnly />
    </div>
  );
}

/** Input disabled by default with fixed-width regenerate + edit-toggle buttons. */
function EditableField({
  id,
  label,
  value,
  placeholder,
  inputMode,
  onChange,
  onRegenerate,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: "numeric";
  onChange: (value: string) => void;
  onRegenerate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          readOnly={!editing}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "min-w-0 flex-1 font-mono text-xs",
            !editing && "bg-muted/50 text-muted-foreground",
          )}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Regenerate ${label}`}
          title="Regenerate"
          onClick={onRegenerate}
        >
          <RotateCcw />
        </Button>
        <Button
          type="button"
          variant={editing ? "default" : "outline"}
          size="icon"
          aria-label={`${editing ? "Finish editing" : "Edit"} ${label}`}
          title={editing ? "Finish editing" : "Edit"}
          onClick={() => setEditing(!editing)}
        >
          {editing ? <Check /> : <Pencil />}
        </Button>
      </div>
    </div>
  );
}

/** Single-column collapsible option row; trailing slot sits on the summary line.
 *  标题前的 ▼/▲ 三角指示展开状态（group-open 旋转，无需受控 state）。 */
function OptionSection({
  title,
  children,
  trailing,
}: {
  title: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <details className="group rounded-lg border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <ChevronDown
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
        />
        {title}
        <span className="flex-1" />
        {trailing}
      </summary>
      <div className="space-y-3 border-t px-3 py-3">{children}</div>
    </details>
  );
}

export default function TokimekiHomePage() {
  const config = useApiConfig();
  const session = useSession();
  const signedIn = session.user !== null;
  const namespaceQuery = useTokimekiNamespace(signedIn);
  const createToken = useCreateTokimekiToken();
  const createInvite = useCreateTokimekiInvite();
  const anonHost = useAnonHost();

  const [step, setStep] = useState<Step>(1);
  const [skipInstall, setSkipInstall] = useState(false);

  // Platform/shell default to the SSR-safe "linux" pair; the real detection runs in
  // the mount effect so server and first client render agree (no hydration mismatch).
  const [platform, setPlatform] = useState<Platform>("linux");
  const [shell, setShell] = useState<ShellKind>("bash");
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [customCommand, setCustomCommand] = useState("");
  const [nameValue, setNameValue] = useState("");
  const [tokenValue, setTokenValue] = useState("");
  const [passcodeOn, setPasscodeOn] = useState(false);
  const [passcodeValue, setPasscodeValue] = useState("");
  const [windowSize, setWindowSize] = useState<WindowSizePreset>("auto");
  const [allowWeb, setAllowWeb] = useState(true);
  const [listener, setListener] = useState(false);
  const [ttlPreset, setTtlPreset] = useState<TtlPreset>("24");
  const [hostError, setHostError] = useState<string | null>(null);
  const [hostPending, setHostPending] = useState(false);
  const [hostResult, setHostResult] = useState<HostResult | null>(null);
  const [configDownloadError, setConfigDownloadError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);

  const [action, setAction] = useState<Action>("host");
  const [attachLink, setAttachLink] = useState("");
  const [attachInput, setAttachInput] = useState("");
  const [attachTokenInput, setAttachTokenInput] = useState("");
  const [attachPasscode, setAttachPasscode] = useState("");
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachPending, setAttachPending] = useState(false);
  const [attachResult, setAttachResult] = useState<AttachResult | null>(null);
  const [attachPlatform, setAttachPlatform] = useState<Platform>("linux");
  const [attachShell, setAttachShell] = useState<ShellKind>("bash");

  const enabled = config.data?.tokimekiEnabled === true;
  const relayUrl = config.data?.tokimekiRelayUrl ?? "";
  const namespaceValue = namespaceQuery.data?.namespace;

  useEffect(() => {
    const detected = detectPlatform();
    const detectedShell = defaultShell(detected);
    setPlatform(detected);
    setShell(detectedShell);
    setAttachPlatform(detected);
    setAttachShell(detectedShell);
    if (readSkipCookie()) {
      setSkipInstall(true);
      setStep(2);
    }
  }, []);

  // Session ids must carry the signed-in namespace prefix (server 400 otherwise).
  const regenerateSessionName = async () => {
    const resolved =
      namespaceValue ?? (await namespaceQuery.refetch()).data?.namespace;
    if (resolved === undefined) {
      setHostError("Could not resolve your namespace");
      return;
    }
    setNameValue(`${resolved}.${generateWordSlug()}`);
  };

  const generateHost = async () => {
    setHostError(null);
    if (relayUrl.length === 0) {
      setHostError("TOKIMEKI_RELAY_URL is not configured for this deployment");
      return;
    }
    if (agent === "custom" && customCommand.trim().length === 0) {
      setHostError("Enter the custom TUI command");
      return;
    }
    const passcode = passcodeValue.trim();
    if (passcodeOn && !isValidPasscode(passcode)) {
      setHostError("Passcode must be exactly 6 digits");
      return;
    }
    const sessionNameOverride = nameValue.trim();
    const sessionTokenOverride = tokenValue.trim();
    if (sessionNameOverride.length > 0 && !isValidHostSessionName(sessionNameOverride)) {
      setHostError("Session name may use letters, digits, dot, dash and underscore (max 64)");
      return;
    }
    if (
      sessionTokenOverride.length > 0 &&
      signedIn &&
      !isValidSessionToken(sessionTokenOverride)
    ) {
      setHostError("Session token must be 6-8 digits");
      return;
    }
    setHostPending(true);
    try {
      const sessionToken =
        signedIn && sessionTokenOverride.length > 0
          ? sessionTokenOverride
          : generateSessionToken();
      let hostToken: string;
      let namespace: string;
      let sessionName: string;
      let inviteUrl: string;
      let expiresAt: string | null = null;
      if (signedIn) {
        const nsResult =
          namespaceQuery.data ?? (await namespaceQuery.refetch()).data ?? undefined;
        if (nsResult === undefined) {
          throw new Error("Could not resolve your namespace");
        }
        namespace = nsResult.namespace;
        sessionName = resolveHostSessionName(
          sessionNameOverride,
          namespace,
          generateWordSlug(),
        );
        if (!isValidHostSessionName(sessionName)) {
          throw new Error(
            "Session name may use letters, digits, dot, dash and underscore (max 64)",
          );
        }
        const created = await createToken.mutateAsync({ name: `host-${sessionName}` });
        hostToken = created.token;
        expiresAt = created.record.expiresAt;
        const invite = await createInvite.mutateAsync({
          session: sessionName,
          mode: listener ? "listener" : "viewer",
          ttlSeconds: Number(ttlPreset) * 3600,
          allowWeb,
          passcodeRequired: passcodeOn,
        });
        inviteUrl = invite.invite.url;
      } else {
        const anonymous = await anonHost.mutateAsync();
        hostToken = anonymous.token;
        namespace = anonymous.namespace;
        sessionName = anonymous.session;
        inviteUrl = anonymous.inviteUrl;
        expiresAt = anonymous.expiresAt;
      }
      setHostResult({
        token: hostToken,
        namespace,
        session: sessionName,
        sessionToken,
        inviteUrl,
        expiresAt,
        anonymous: !signedIn,
        options: signedIn
          ? {
              ...(passcodeOn ? { passcode } : {}),
              ...(windowSize !== "auto" ? { windowSize } : {}),
            }
          : {},
      });
      // Bug fix (11-22 user report): going back and switching flows must not show the
      // previous flow's result card (host token leaking into the attach view).
      setAttachResult(null);
      setAttachError(null);
      setStep(3);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : "Failed to generate the command");
    } finally {
      setHostPending(false);
    }
  };

  const generateAttach = async () => {
    setAttachError(null);
    if (relayUrl.length === 0) {
      setAttachError("TOKIMEKI_RELAY_URL is not configured for this deployment");
      return;
    }
    // 2026-11-23 attach 分区改版：Link 填了走兑换，否则走手动 Session + Token。
    const linkRaw = attachLink.trim();
    const sessionRaw = attachInput.trim();
    const passcode = attachPasscode.trim();
    const redeeming = linkRaw.length > 0;
    let code: string | null = null;
    if (redeeming) {
      const parsed = parseAttachInput(linkRaw);
      if (parsed === null || parsed.kind === "session") {
        setAttachError("Enter a share link (https://…/#t-…) or a bare invite code");
        return;
      }
      code = parsed.code;
    } else {
      if (sessionRaw.length === 0) {
        setAttachError("Paste a share link, or enter the session name and token");
        return;
      }
      if (attachTokenInput.trim().length === 0) {
        setAttachError("Enter the session token for manual attach");
        return;
      }
    }
    if (passcode.length > 0 && !isSafeCommandValue(passcode)) {
      setAttachError("Passcode may only use characters that are safe in shell commands");
      return;
    }
    setAttachPending(true);
    try {
      if (redeeming && code !== null) {
        const response = await fetch("/api/tokimeki/attach/cli", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ code }),
        });
        if (response.status === 410) {
          setAttachError("This link is invalid or has expired");
          return;
        }
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          throw new Error(body?.error?.message ?? "Failed to redeem the link");
        }
        const body = (await response.json()) as {
          token: string;
          session: string;
          mode: "viewer" | "listener";
          allowWeb: boolean;
          passcodeRequired: boolean;
          expiresAt: string;
        };
        if (body.passcodeRequired && passcode.length === 0) {
          setAttachError(
            "This link requires a session passcode. Enter TOKIMEKI_PASSCODE to generate the command.",
          );
          return;
        }
        setAttachResult({
          session: body.session,
          token: body.token,
          webUrl: linkRaw.startsWith("http") ? linkRaw : `${window.location.origin}/#t-${code}`,
          mode: body.mode,
          allowWeb: body.allowWeb,
          passcodeRequired: body.passcodeRequired,
          ...(passcode.length > 0 ? { passcode } : {}),
          expiresAt: body.expiresAt,
        });
      } else {
        const passcodeProvided = passcode.length > 0;
        setAttachResult({
          session: sessionRaw,
          token: attachTokenInput.trim(),
          webUrl: null,
          mode: "viewer",
          allowWeb: true,
          passcodeRequired: passcodeProvided,
          ...(passcodeProvided ? { passcode } : {}),
          expiresAt: null,
        });
      }
      // Same family: attach generate must not keep the previous host result card around.
      setHostResult(null);
      setHostError(null);
      setConfigDownloadError(null);
      setStep(3);
    } catch (error) {
      setAttachError(
        error instanceof ApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Failed",
      );
    } finally {
      setAttachPending(false);
    }
  };

  const handleSkipToggle = (next: boolean) => {
    setSkipInstall(next);
    writeSkipCookie(next);
  };

  // 2026-11-23 用户裁决：分享文案为纯英文模板（不要中文）。
  const copyShareMessage = async () => {
    if (hostResult === null) return;
    const ok = await copyToClipboard(
      [
        "I created a shared session on Tokimeki.",
        `Join: ${hostResult.inviteUrl}`,
        "",
        `Session: ${hostResult.session}`,
        `Token: ${hostResult.sessionToken}`,
      ].join("\n"),
    );
    if (!ok) return;
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 1500);
  };

  const handleDone = () => {
    setHostResult(null);
    setHostError(null);
    setConfigDownloadError(null);
    setAttachResult(null);
    setAttachError(null);
    setStep(1);
  };

  // JSON config (TOKIMEKI_CONFIG v2 envelope) built from the same inputs as the
  // rendered env command — incl. passcode / windowSize when set — as a file download.
  const downloadJsonConfig = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (hostResult === null) return;
    setConfigDownloadError(null);
    try {
      const envelope = buildHostConfigEnvelope({
        relayUrl,
        token: hostResult.token,
        namespace: hostResult.namespace,
        session: hostResult.session,
        sessionToken: hostResult.sessionToken,
        ...hostResult.options,
      });
      const pretty = JSON.stringify(JSON.parse(envelope), null, 2);
      const url = URL.createObjectURL(new Blob([pretty], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tokimeki-config.json";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setConfigDownloadError(
        error instanceof Error ? error.message : "Could not build the JSON config",
      );
    }
  };

  let hostCommand: string | null = null;
  let hostCommandError: string | null = null;
  if (hostResult !== null && relayUrl.length > 0) {
    try {
      hostCommand = buildHostCommand({
        shell,
        relayUrl,
        token: hostResult.token,
        namespace: hostResult.namespace,
        session: hostResult.session,
        sessionToken: hostResult.sessionToken,
        agent,
        customCommand,
        ...hostResult.options,
      });
    } catch (error) {
      hostCommandError = error instanceof Error ? error.message : "Could not render the command";
    }
  }

  let attachCommand: string | null = null;
  let attachCommandError: string | null = null;
  if (attachResult !== null && relayUrl.length > 0) {
    try {
      attachCommand = buildAttachCommand({
        shell: attachShell,
        relayUrl,
        session: attachResult.session,
        token: attachResult.token,
        mode: attachResult.mode,
        ...(attachResult.passcode === undefined ? {} : { passcode: attachResult.passcode }),
      });
    } catch (error) {
      attachCommandError = error instanceof Error ? error.message : "Could not render the command";
    }
  }

  if (config.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!enabled) {
    return (
      <PageContainer className="py-16">
        <PageHeader title="Tokimeki" description="Share a live terminal session." />
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Tokimeki is not configured on this deployment. Set
            <code className="mx-1">TOKIMEKI_JWT_PRIVATE_JWK</code> and
            <code className="mx-1">TOKIMEKI_RELAY_URL</code> first.
          </CardContent>
        </Card>
      </PageContainer>
    );
  }

  const platformLabel = PLATFORM_OPTIONS.find((item) => item.id === platform)?.label ?? platform;
  const attachPlatformLabel =
    PLATFORM_OPTIONS.find((item) => item.id === attachPlatform)?.label ?? attachPlatform;

  const stepPill = (target: Step, label: string) => (
    <button
      key={target}
      type="button"
      disabled={target >= step}
      onClick={() => setStep(target)}
      className={cn(
        "min-w-0 flex-1 truncate rounded-full border px-2 py-1.5 text-[11px] transition-colors",
        target === step
          ? "border-primary bg-primary font-medium text-primary-foreground"
          : target < step
            ? "border-ring/60 text-foreground"
            : "border-border text-muted-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <PageContainer className="py-8">
      <PageHeader
        title="Tokimeki"
        description="Share a live terminal session in three steps."
        actions={
          signedIn ? (
            <div className="flex flex-wrap gap-2">
              <Link className="inline-block py-1 text-sm underline underline-offset-4" to="/tokimeki/sessions">
                Sessions &amp; links
              </Link>
              <Link className="inline-block py-1 text-sm underline underline-offset-4" to="/tokimeki/tokens">
                Host tokens
              </Link>
            </div>
          ) : (
            <Link
              className="inline-block py-1 text-sm underline underline-offset-4"
              to="/login"
              state={{ from: "/tokimeki" }}
            >
              Sign in for advanced options
            </Link>
          )
        }
      />

      {relayUrl.length === 0 ? (
        <p className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          TOKIMEKI_RELAY_URL is not configured; commands cannot be generated.
        </p>
      ) : null}

      <div className="mx-auto mt-4 max-w-md">
        <div className="mb-4 flex items-center gap-1.5" aria-label="Wizard progress">
          {stepPill(1, "1 · Install")}
          {stepPill(2, "2 · Host / Attach")}
          {stepPill(3, "3 · Command")}
        </div>

        {/* ---------- Step 1: install ---------- */}
        {step === 1 ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm">Install tokimeki</p>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">Requires Node.js ≥ 22.12.0.</span>
                <a
                  className="inline-block py-1 text-xs text-muted-foreground underline underline-offset-2"
                  href="https://nodejs.org/en/download"
                  target="_blank"
                  rel="noreferrer"
                >
                  Install Node.js ↗
                </a>
              </div>
              <CommandBlock value={INSTALL_COMMAND} />
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <span className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={skipInstall}
                    onCheckedChange={handleSkipToggle}
                    aria-label="Skip this step next time"
                  />
                  Skip next time
                </span>
                <Button onClick={() => setStep(2)}>Installed, next step →</Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* ---------- Step 2: host / attach ---------- */}
        {step === 2 ? (
          <Card>
            <CardContent className="p-4">
              <form
                className="space-y-3"
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  if (action === "host") void generateHost();
                  else void generateAttach();
                }}
              >
                <div role="group" aria-label="Action" className="flex gap-1 rounded-lg bg-muted p-0.5">
                  <button
                    type="button"
                    aria-pressed={action === "host"}
                    onClick={() => setAction("host")}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      action === "host"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Host
                  </button>
                  <button
                    type="button"
                    aria-pressed={action === "attach"}
                    onClick={() => setAction("attach")}
                    className={cn(
                      "flex-1 rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      action === "attach"
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Attach
                  </button>
                </div>

                {action === "host" ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="hub-platform">Platform</Label>
                        <Select
                          id="hub-platform"
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
                        <Label htmlFor="hub-shell">Shell</Label>
                        <Select
                          id="hub-shell"
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
                    <div className="space-y-1">
                      <Label htmlFor="hub-acp">ACP command</Label>
                      <Select
                        id="hub-acp"
                        value={agent}
                        onChange={(event) => setAgent(event.target.value as AgentKind)}
                      >
                        {ACP_COMMANDS.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {entry.label}
                          </option>
                        ))}
                      </Select>
                    </div>
                    {agent === "custom" ? (
                      <div className="space-y-1">
                        <Label htmlFor="hub-custom">Custom command</Label>
                        <Input
                          id="hub-custom"
                          value={customCommand}
                          onChange={(event) => setCustomCommand(event.target.value)}
                          placeholder="vim"
                        />
                      </div>
                    ) : null}

                    <hr className="border-border" />

                    {signedIn ? (
                      <>
                        <OptionSection title="Session">
                          <EditableField
                            id="hub-session-name"
                            label="Session name"
                            value={nameValue}
                            placeholder="Auto-generated on Generate"
                            onChange={setNameValue}
                            onRegenerate={regenerateSessionName}
                          />
                          {namespaceValue === undefined ? null : (
                            <p className="text-xs text-muted-foreground">
                              Prefixed with your namespace ({namespaceValue}.) when omitted.
                            </p>
                          )}
                          <EditableField
                            id="hub-session-token"
                            label="Session token"
                            value={tokenValue}
                            placeholder="Auto-generated on Generate"
                            inputMode="numeric"
                            onChange={setTokenValue}
                            onRegenerate={() => setTokenValue(generateSessionToken())}
                          />
                        </OptionSection>

                        <OptionSection
                          title="Passcode"
                          trailing={
                            // preventDefault keeps the click from toggling the <details>.
                            <span onClick={(event) => event.preventDefault()}>
                              <Switch
                                checked={passcodeOn}
                                onCheckedChange={(next) => {
                                  setPasscodeOn(next);
                                  if (next && passcodeValue.trim().length === 0) {
                                    setPasscodeValue(generatePasscode());
                                  }
                                }}
                                aria-label="Enable passcode"
                              />
                            </span>
                          }
                        >
                          {passcodeOn ? (
                            <>
                              <EditableField
                                id="hub-passcode"
                                label="Passcode"
                                value={passcodeValue}
                                inputMode="numeric"
                                onChange={setPasscodeValue}
                                onRegenerate={() => setPasscodeValue(generatePasscode())}
                              />
                              <p className="text-xs text-muted-foreground">
                                6 digits. Attaching the share link will require it.
                              </p>
                            </>
                          ) : (
                            <p className="text-xs text-muted-foreground">
                              Off — anyone with the link can attach.
                            </p>
                          )}
                        </OptionSection>

                        <OptionSection title="Advanced options">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">Window size</span>
                            <MiniSegment
                              value={windowSize}
                              onChange={setWindowSize}
                              ariaLabel="Window size"
                              options={[
                                { id: "auto", label: "Auto" },
                                { id: "80x24", label: "80×24" },
                                { id: "120x40", label: "120×40" },
                              ]}
                            />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">
                              Browser access
                              <span className="block text-xs font-normal text-muted-foreground">
                                Open the share link in a browser
                              </span>
                            </span>
                            <Switch
                              checked={allowWeb}
                              onCheckedChange={setAllowWeb}
                              aria-label="Browser access"
                            />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">Mode</span>
                            <MiniSegment
                              value={listener ? "listener" : "viewer"}
                              onChange={(next) => setListener(next === "listener")}
                              ariaLabel="Share mode"
                              options={[
                                { id: "viewer", label: "Viewer" },
                                { id: "listener", label: "Listener" },
                              ]}
                            />
                          </div>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-sm font-medium">TTL</span>
                            <MiniSegment
                              value={ttlPreset}
                              onChange={setTtlPreset}
                              ariaLabel="Share link TTL"
                              options={TTL_OPTIONS}
                            />
                          </div>
                        </OptionSection>
                      </>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed px-3 py-2.5 text-sm text-muted-foreground">
                        More options available
                        <Link
                          className="inline-block py-1 font-medium text-foreground underline underline-offset-2"
                          to="/login"
                          state={{ from: "/tokimeki" }}
                        >
                          Sign in →
                        </Link>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {/* 2026-11-23 attach 分区改版：上半 Link 兑换 / 分割线 / 下半手动
                        Session + Token（mock-v6）。Link 填了走兑换，否则走手动路径。 */}
                    <p className="text-xs text-muted-foreground">Redeem a share link</p>
                    <div className="space-y-1">
                      <Label htmlFor="hub-attach-link">Link</Label>
                      <Input
                        id="hub-attach-link"
                        value={attachLink}
                        onChange={(event) => setAttachLink(event.target.value)}
                        placeholder="https://…/#t-xxxxxxxx"
                        className="font-mono text-sm"
                      />
                    </div>
                    <hr className="my-2 border-border" />
                    <p className="text-xs text-muted-foreground">Or attach manually</p>
                    <div className="space-y-1">
                      <Label htmlFor="hub-attach-session">Session</Label>
                      <Input
                        id="hub-attach-session"
                        value={attachInput}
                        onChange={(event) => setAttachInput(event.target.value)}
                        placeholder="c6a2.bohemian-skunk"
                        className="font-mono text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="hub-attach-token">Token</Label>
                      <Input
                        id="hub-attach-token"
                        value={attachTokenInput}
                        onChange={(event) => setAttachTokenInput(event.target.value)}
                        placeholder="482613"
                        className="font-mono text-sm"
                      />
                    </div>
                    <OptionSection title="Passcode">
                      <Input
                        id="hub-attach-passcode"
                        type="password"
                        value={attachPasscode}
                        onChange={(event) => setAttachPasscode(event.target.value)}
                        placeholder="123456"
                        className="font-mono text-sm"
                      />
                    </OptionSection>
                  </>
                )}

                {action === "host" && hostError !== null ? (
                  <p role="alert" className="text-sm text-destructive">
                    {hostError}
                  </p>
                ) : null}
                {action === "attach" && attachError !== null ? (
                  <p role="alert" className="text-sm text-destructive">
                    {attachError}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                  <Button type="button" variant="ghost" onClick={() => setStep(1)}>
                    ← Back
                  </Button>
                  <Button
                    type="submit"
                    disabled={action === "host" ? hostPending || relayUrl.length === 0 : attachPending || relayUrl.length === 0}
                  >
                    {action === "host"
                      ? hostPending
                        ? "Generating…"
                        : "Generate →"
                      : attachPending
                        ? "Redeeming…"
                        : "Generate →"}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        ) : null}

        {/* ---------- Step 3: command ---------- */}
        {step === 3 && hostResult !== null ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm font-medium">Run the host</p>
              <div className="flex flex-wrap gap-1.5">
                <Chip>
                  {platformLabel} · {shell}
                </Chip>
                <Chip>{agentLabel(agent)}</Chip>
                {!hostResult.anonymous ? (
                  <Chip>{listener ? "Listener" : "Viewer"}</Chip>
                ) : null}
                {hostResult.expiresAt === null ? null : (
                  <Chip>host token expires {new Date(hostResult.expiresAt).toLocaleString()}</Chip>
                )}
              </div>
              {hostCommandError === null && hostCommand !== null ? (
                <>
                  <CommandBlock value={hostCommand} />
                  <p className="text-xs text-muted-foreground">
                    Prefer JSON?{" "}
                    <a
                      className="inline-block py-1 text-xs text-muted-foreground underline underline-offset-2"
                      href="#"
                      onClick={downloadJsonConfig}
                    >
                      Download
                    </a>{" "}
                    the config
                  </p>
                  {configDownloadError === null ? null : (
                    <p role="alert" className="text-sm text-destructive">
                      {configDownloadError}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-sm text-destructive">
                  {hostCommandError ?? "Could not render the command."}
                </p>
              )}

              <p className="pt-1 text-sm font-medium">Share link</p>
              <CommandBlock value={hostResult.inviteUrl} />

              <OptionSection title="Session details">
                <CopyRow label="Session" value={hostResult.session} />
                <CopyRow label="Token" value={hostResult.sessionToken} />
                {hostResult.options.passcode === undefined ? null : (
                  <CopyRow label="Passcode" value={hostResult.options.passcode} />
                )}
                {/* 2026-11-23 用户裁决：分享文案为纯英文模板（不要中文）。 */}
                <button
                  type="button"
                  className="inline-block py-1 text-sm text-foreground underline underline-offset-2"
                  onClick={() => void copyShareMessage()}
                >
                  Copy share message
                </button>
                {shareCopied ? (
                  <span className="ml-1 text-xs text-muted-foreground" role="status">
                    Copied ✓
                  </span>
                ) : null}
              </OptionSection>

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <Button type="button" variant="ghost" onClick={() => setStep(2)}>
                  ← Back
                </Button>
                <Button type="button" onClick={handleDone}>
                  Done
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {step === 3 && attachResult !== null ? (
          <Card>
            <CardContent className="space-y-3 p-4">
              <p className="text-sm font-medium">Attach to the session</p>
              <div className="flex flex-wrap gap-1.5">
                <Chip>{attachResult.session}</Chip>
                <Chip>{attachResult.mode === "listener" ? "Listener" : "Viewer"}</Chip>
                {attachResult.expiresAt === null ? null : (
                  <Chip>expires {new Date(attachResult.expiresAt).toLocaleString()}</Chip>
                )}
              </div>
              {attachResult.allowWeb &&
              attachResult.mode === "viewer" &&
              attachResult.webUrl !== null ? (
                <>
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => {
                      if (attachResult.webUrl !== null) {
                        window.open(attachResult.webUrl, "_blank", "noopener");
                      }
                    }}
                  >
                    <ExternalLink /> Open in browser now
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Available because the host allowed browser access.
                  </p>
                </>
              ) : null}

              <p className="pt-1 text-sm font-medium">…or attach from a terminal</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="hub-attach-platform">Platform</Label>
                  <Select
                    id="hub-attach-platform"
                    value={attachPlatform}
                    onChange={(event) => {
                      const next = event.target.value as Platform;
                      setAttachPlatform(next);
                      setAttachShell(defaultShell(next));
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
                  <Label htmlFor="hub-attach-shell">Shell</Label>
                  <Select
                    id="hub-attach-shell"
                    value={attachShell}
                    onChange={(event) => setAttachShell(event.target.value as ShellKind)}
                  >
                    {SHELLS_BY_PLATFORM[attachPlatform].map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {attachPlatformLabel} · {attachShell}
              </p>
              {attachCommandError === null && attachCommand !== null ? (
                <CommandBlock value={attachCommand} />
              ) : (
                <p className="text-sm text-destructive">
                  {attachCommandError ?? "Could not render the command."}
                </p>
              )}
              {attachResult.passcodeRequired ? (
                <p className="text-xs text-muted-foreground">
                  The command includes TOKIMEKI_PASSCODE; keep it out of logs.
                </p>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <Button type="button" variant="ghost" onClick={() => setStep(2)}>
                  ← Back
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </PageContainer>
  );
}
