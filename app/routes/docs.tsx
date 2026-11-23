// /docs — 公开产品文档（10-23-marketing-home-docs；11-23 IA 重构）。
// 受众：Agent 工具使用者（Claude Code / Codex CLI / Pi / OpenCode / Cursor）、
// Router 用户（CC Switch / Magpie / OpenRouter BYOK）与 Tokimeki 使用者。
// 单页 + 两级侧栏：组（h2）→ 条目（h3）；Tokimeki 内的 CLI/Web 只作为 h4 子标题，不进菜单。
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GITHUB_README_TOKIMEKI_URL, GITHUB_README_URL, GITHUB_URL } from "@/lib/site-links";

interface DocNavItem {
  readonly id: string;
  readonly label: string;
}

interface DocNavGroup {
  readonly label: string;
  readonly items: readonly DocNavItem[];
}

/** 两级侧栏（组 → 条目）；Start here 是无组标签的单条目。 */
const DOC_NAV: readonly DocNavGroup[] = [
  { label: "", items: [{ id: "start", label: "Start here" }] },
  {
    label: "Code integration",
    items: [
      { id: "code-curl", label: "curl" },
      { id: "code-openai-sdk", label: "OpenAI SDK" },
      { id: "code-anthropic-sdk", label: "Anthropic SDK" },
    ],
  },
  {
    label: "Agents",
    items: [
      { id: "claude-code", label: "Claude Code" },
      { id: "codex-cli", label: "Codex CLI" },
      { id: "pi", label: "Pi" },
      { id: "opencode", label: "OpenCode" },
      { id: "cursor", label: "Cursor" },
      { id: "other-agents", label: "Other agents" },
    ],
  },
  {
    label: "Routers",
    items: [
      { id: "cc-switch", label: "CC Switch" },
      { id: "magpie", label: "Magpie" },
      { id: "byok-openrouter", label: "BYOK: OpenRouter" },
    ],
  },
  {
    label: "Tokimeki",
    items: [
      { id: "tokimeki", label: "Overview" },
      { id: "tokimeki-install", label: "Install" },
      { id: "tokimeki-host", label: "Host a session" },
      { id: "tokimeki-attach", label: "Attach to a session" },
      { id: "tokimeki-dashboard", label: "Dashboard" },
    ],
  },
  {
    label: "Reference",
    items: [
      { id: "models", label: "Models & verification" },
      { id: "troubleshooting", label: "Troubleshooting" },
      { id: "api", label: "API endpoints" },
    ],
  },
] as const;

const FEATURES = [
  {
    title: "One gateway, many providers",
    body: "Every client points at your gateway. TokiAPI routes each model name to the provider you configured, with failover across candidates.",
  },
  {
    title: "Swap the base URL only",
    body: "The official OpenAI and Anthropic SDKs work unchanged — no shims, no SDK forks, no code changes.",
  },
  {
    title: "Team keys",
    body: "One gateway key per person or app, each with its own rate limit and instant revocation.",
  },
  {
    title: "Prepaid, per-token billing",
    body: "Each request is priced against the model table in the console and deducted from the account balance.",
  },
  {
    title: "Optional response cache",
    body: "When caching is enabled for the deployment and on a key, repeated non-streaming requests are served from the edge and consume no upstream tokens.",
  },
  {
    title: "One console for everything",
    body: "Keys, balances, transactions, usage and prices live in the management console — no external dashboard.",
  },
] as const;

function Code({ children }: { children: string }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </code>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">{label}</p>
      <pre className="overflow-x-auto rounded-lg border bg-card/70 p-4 font-mono text-xs leading-relaxed text-foreground sm:text-sm">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function FieldTable({ rows }: { rows: ReadonlyArray<{ field: string; value: string }> }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-44">Field</TableHead>
          <TableHead>Value</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.field}>
            <TableCell className="align-top font-medium text-foreground">{row.field}</TableCell>
            <TableCell className="align-top">
              <Code>{row.value}</Code>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VersionTable({
  rows,
}: {
  rows: ReadonlyArray<{ version: string; status: string; notes: ReactNode }>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-36">Version</TableHead>
          <TableHead className="w-32">Status</TableHead>
          <TableHead>Notes</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.version}>
            <TableCell className="align-top font-mono text-xs text-foreground">
              {row.version}
            </TableCell>
            <TableCell className="align-top">{row.status}</TableCell>
            <TableCell className="align-top">{row.notes}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface DocSectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

/** 顶级条目（Start here）：h2 + 顶部分隔线。 */
function DocSection({ id, title, children }: DocSectionProps) {
  return (
    <section id={id} className="scroll-mt-24 border-t pt-10">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

/** 组标题（Code integration / Agents / Routers / Tokimeki / Reference）：h2，弱化 mono 样式。 */
function DocGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="scroll-mt-24 border-t pt-10">
      <h2 className="font-mono text-xs uppercase tracking-[0.24em] text-brand">{title}</h2>
      <div className="mt-6 space-y-10">{children}</div>
    </section>
  );
}

/** 组内条目：h3，锚点目标。 */
function DocItem({ id, title, children }: DocSectionProps) {
  return (
    <section id={id} className="scroll-mt-24">
      <h3 className="text-lg font-semibold tracking-tight text-foreground">{title}</h3>
      <div className="mt-3 space-y-4 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

/** Tokimeki 内部的 CLI/Web 子标题：h4，不进侧栏。 */
function DocSubSection({ id, title, children }: DocSectionProps) {
  return (
    <div id={id} className="scroll-mt-24 pt-2">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      <div className="mt-2 space-y-3">{children}</div>
    </div>
  );
}

function NavItems() {
  return (
    <ul className="space-y-5">
      {DOC_NAV.map((group) => (
        <li key={group.label || group.items[0]?.id}>
          {group.label.length > 0 ? (
            <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground/70">
              {group.label}
            </p>
          ) : null}
          <ul className="space-y-1">
            {group.items.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="block rounded-sm py-0.5 text-sm text-muted-foreground transition-colors hover:text-brand"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export default function DocsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
      <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="On this page" className="pt-6 lg:sticky lg:top-20 lg:self-start lg:pt-10">
          <details className="rounded-lg border bg-card/40 px-4 py-3 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              On this page
            </summary>
            <div className="mt-4">
              <NavItems />
            </div>
          </details>
          <div className="hidden lg:block">
            <NavItems />
          </div>
        </nav>

        <article className="min-w-0 max-w-3xl pb-16 pt-10">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Documentation</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Point Claude Code, Codex CLI, Pi, OpenCode, Cursor or any OpenAI / Anthropic SDK at your
            own TokiAPI gateway. Three steps, one key.
          </p>

          <div className="mt-10 space-y-10">
            <DocSection id="start" title="Start here">
              <p>
                TokiAPI is a self-hosted AI API gateway. It puts one OpenAI-compatible endpoint in
                front of many model providers — both OpenAI-compatible upstreams and
                Anthropic-native ones — so a single key, a single base URL and a single bill cover
                everything.
              </p>
              <p>
                It runs entirely on Cloudflare (Workers, D1, KV, Queues). Email verification and
                SMS sign-in are optional integrations with Resend and Alibaba Cloud; leave them
                unconfigured and the gateway runs without them. Your data — keys, balances, request
                logs — stays in your own account.
              </p>

              <h3 className="pt-2 text-sm font-semibold text-foreground">What you get</h3>
              <ul className="grid gap-3 sm:grid-cols-2">
                {FEATURES.map((feature) => (
                  <li key={feature.title} className="flex gap-2 rounded-lg border bg-card/50 p-3">
                    <Check className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
                    <div>
                      <p className="text-sm font-medium text-foreground">{feature.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {feature.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>

              <h3 className="pt-2 text-sm font-semibold text-foreground">What you need</h3>
              <ul className="space-y-2">
                <li>
                  <span className="font-medium text-foreground">Gateway address</span> — the origin
                  your TokiAPI instance is deployed to, for example{" "}
                  <Code>https://api.example.com</Code>.
                </li>
                <li>
                  <span className="font-medium text-foreground">Gateway key</span> — a{" "}
                  <Code>sk-…</Code> key you create in the console. It identifies you and carries
                  your rate limit.
                </li>
                <li>
                  <span className="font-medium text-foreground">A model name</span> — one registered
                  in the console (Models page). The name your client sends must match it exactly.
                </li>
              </ul>

              <h3 className="pt-2 text-sm font-semibold text-foreground">Keep credentials safe</h3>
              <ul className="space-y-2">
                <li>
                  A gateway key (<Code>sk-…</Code>) is a bearer credential. Keep it in an
                  environment variable or a secret manager; never commit it to a tracked config
                  file, paste it into a prompt, or share it in a screenshot.
                </li>
                <li>
                  Claude Code&apos;s <Code>settings.json</Code> stores{" "}
                  <Code>ANTHROPIC_AUTH_TOKEN</Code> in plaintext. Restrict the file permissions and
                  keep the file out of version control.
                </li>
                <li>
                  Magpie&apos;s CLI <Code>key=…</Code> argument is visible in shell history; prefer
                  the desktop app if that matters, or clear the history entry afterwards.
                </li>
                <li>
                  Tokimeki&apos;s generated block contains a host credential. The CLI removes it from
                  the hosted PTY environment, but your shell history may retain the pasted block.
                </li>
                <li>
                  If a gateway key leaks, revoke it on the Keys page. If a share link leaks, revoke
                  the invite in <Code>/tokimeki/sessions</Code> — this only blocks new redemptions.
                </li>
                <li>
                  A leaked Tokimeki session token has no revocation list. It stays valid until it
                  expires (5 minutes for the web proxy, up to 24 hours for CLI attach); end the host
                  session or wait it out.
                </li>
                <li>
                  A leaked master Host JWT also cannot be revoked — rotate the signing key or wait
                  for expiry.
                </li>
              </ul>

              <h3 className="pt-2 text-sm font-semibold text-foreground">Three steps</h3>
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  <span className="font-medium text-foreground">Sign in to the console</span> — open
                  your gateway&apos;s management domain and sign in with GitHub or email + password.
                </li>
                <li>
                  <span className="font-medium text-foreground">Create a gateway key</span> — go to
                  Keys → Create key, then copy the <Code>sk-…</Code> value. The full secret is shown
                  only once.
                </li>
                <li>
                  <span className="font-medium text-foreground">Connect your client</span> — pick a
                  path below, paste the configuration block, and restart the client.
                </li>
              </ol>
              <p>
                Next: <a className="text-brand underline-offset-4 hover:underline" href="#code-curl">call the API</a>,{" "}
                <a className="text-brand underline-offset-4 hover:underline" href="#claude-code">set up an agent</a>,{" "}
                <a className="text-brand underline-offset-4 hover:underline" href="#cc-switch">use a router</a>, or{" "}
                <a className="text-brand underline-offset-4 hover:underline" href="#tokimeki">share a terminal with Tokimeki</a>.
              </p>
            </DocSection>

            <DocGroup title="Code integration">
              <DocItem id="code-curl" title="Call the API with curl">
                <p>
                  Every proxy entry accepts the same gateway key as either{" "}
                  <Code>Authorization: Bearer sk-…</Code> or <Code>x-api-key: sk-…</Code>. Replace{" "}
                  <Code>&lt;model-name&gt;</Code> with a name registered in the console.
                </p>
                <CodeBlock
                  label="OpenAI Chat Completions"
                  code={`curl -s https://<your-gateway>/v1/chat/completions \\
  -H "Authorization: Bearer $TOKIAPI_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"<model-name>","messages":[{"role":"user","content":"hi"}]}'`}
                />
                <CodeBlock
                  label="OpenAI Responses"
                  code={`curl -s https://<your-gateway>/v1/responses \\
  -H "Authorization: Bearer $TOKIAPI_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"model":"<model-name>","input":"hi"}'`}
                />
                <CodeBlock
                  label="Anthropic Messages"
                  code={`curl -s https://<your-gateway>/anthropic/v1/messages \\
  -H "x-api-key: $TOKIAPI_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model":"<model-name>","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`}
                />
                <CodeBlock
                  label="List the models this gateway serves"
                  code={`curl -s https://<your-gateway>/v1/models \\
  -H "Authorization: Bearer $TOKIAPI_API_KEY"`}
                />
                <p>
                  Add <Code>&quot;stream&quot;: true</Code> for SSE. The Anthropic entry also accepts{" "}
                  <Code>Authorization: Bearer</Code>; the gateway prefers the Bearer token when both
                  headers are present.
                </p>
              </DocItem>

              <DocItem id="code-openai-sdk" title="OpenAI SDK">
                <p>
                  The official OpenAI SDK works unchanged. Point it at{" "}
                  <Code>https://&lt;your-gateway&gt;/v1</Code>:
                </p>
                <CodeBlock
                  label="TypeScript"
                  code={`import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: "sk-...",
  baseURL: "https://<your-gateway>/v1",
});

const chat = await openai.chat.completions.create({
  model: "<model-name>",
  messages: [{ role: "user", content: "hi" }],
});

const response = await openai.responses.create({
  model: "<model-name>",
  input: "hi",
});`}
                />
              </DocItem>

              <DocItem id="code-anthropic-sdk" title="Anthropic SDK">
                <p>
                  The official Anthropic SDK targets <Code>https://&lt;your-gateway&gt;/anthropic</Code>{" "}
                  and appends <Code>/v1/messages</Code> itself:
                </p>
                <CodeBlock
                  label="TypeScript"
                  code={`import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: "sk-...",
  baseURL: "https://<your-gateway>/anthropic",
});

const message = await anthropic.messages.create({
  model: "<model-name>",
  max_tokens: 1024,
  messages: [{ role: "user", content: "hi" }],
});`}
                />
              </DocItem>
            </DocGroup>

            <DocGroup title="Agents">
              <DocItem id="claude-code" title="Claude Code">
                <p>
                  Claude Code speaks the Anthropic Messages protocol. Point its base URL at{" "}
                  <Code>https://&lt;your-gateway&gt;/anthropic</Code> and authenticate with a
                  gateway key — Claude Code appends <Code>/v1/messages</Code> itself.
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">Supported versions</h4>
                <VersionTable
                  rows={[
                    {
                      version: ">= 2.1.319",
                      status: "Full support",
                      notes: (
                        <>
                          Server-side auto mode and message threads work with an
                          Anthropic-dialect upstream. With an OpenAI-dialect upstream, set{" "}
                          <Code>CLAUDE_CODE_AUTO_MODE_SERVER=0</Code>.
                        </>
                      ),
                    },
                    {
                      version: "2.1.207 – 2.1.318",
                      status: "Supported",
                      notes:
                        "Same passthrough behavior; auto mode and message threads depend on the upstream dialect.",
                    },
                    {
                      version: "< 2.1.207",
                      status: "Not targeted",
                      notes:
                        "Auto-mode opt-in era. Other Anthropic Messages traffic is unaffected.",
                    },
                  ]}
                />
                <p>
                  Latest verified: <Code>2.1.329</Code> (2026-11-20). Version behavior can drift; if
                  a request fails, record the client version and the request body before changing
                  gateway settings.
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">Known limits</h4>
                <ul className="space-y-2">
                  <li>
                    Server-side auto mode and message threads require an Anthropic-dialect upstream.
                    A <Code>thread</Code> request that resolves only to OpenAI-dialect candidates
                    returns <Code>400</Code> instead of silently dropping thread state.
                  </li>
                  <li>
                    <Code>anthropic-beta</Code> is forwarded verbatim to Anthropic-dialect upstreams.
                    If a third-party relay rejects an unknown beta, pin{" "}
                    <Code>anthropic-beta</Code> in the provider&apos;s advanced HTTP headers.
                  </li>
                  <li>
                    <Code>anthropic-version</Code> is fixed by the gateway at{" "}
                    <Code>2023-06-01</Code>; the client value is not forwarded.
                  </li>
                  <li>
                    Experimental beta failures: set{" "}
                    <Code>CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1</Code> or pin the beta on the
                    provider.
                  </li>
                  <li>
                    On convert paths, <Code>context_management</Code> and{" "}
                    <Code>mcp_servers</Code> are not reconstructed. Verbatim Anthropic upstreams
                    receive them untouched.
                  </li>
                </ul>

                <CodeBlock
                  label="macOS / Linux: ~/.claude/settings.json — Windows: %USERPROFILE%\.claude\settings.json"
                  code={`{
  "env": {
    "ANTHROPIC_BASE_URL": "https://<your-gateway>/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-...",
    "ANTHROPIC_MODEL": "<model-name>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<model-name>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<model-name>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<model-name>"
  }
}`}
                />
                <p>
                  <Code>settings.json</Code> is a plaintext file. Keep it readable only by your user
                  account and out of any repository or shared drive.
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">
                  Or use shell environment variables
                </h4>
                <CodeBlock
                  label="bash / zsh"
                  code={`export ANTHROPIC_BASE_URL="https://<your-gateway>/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-..."
export ANTHROPIC_MODEL="<model-name>"`}
                />
                <CodeBlock
                  label="PowerShell"
                  code={`$env:ANTHROPIC_BASE_URL = "https://<your-gateway>/anthropic"
$env:ANTHROPIC_AUTH_TOKEN = "sk-..."
$env:ANTHROPIC_MODEL = "<model-name>"`}
                />

                <h4 className="pt-2 text-sm font-semibold text-foreground">Model variables</h4>
                <ul className="space-y-2">
                  <li>
                    <Code>ANTHROPIC_MODEL</Code> — the model used for new sessions.
                  </li>
                  <li>
                    <Code>ANTHROPIC_DEFAULT_OPUS_MODEL</Code>,{" "}
                    <Code>ANTHROPIC_DEFAULT_SONNET_MODEL</Code> and{" "}
                    <Code>ANTHROPIC_DEFAULT_HAIKU_MODEL</Code> — what Claude Code sends when it
                    would use Opus, Sonnet or Haiku. <Code>HAIKU</Code> covers background and fast
                    tasks.
                  </li>
                  <li>
                    Set them to model names registered in your console. If you leave them unset,
                    Claude Code sends its built-in Claude model names, and the gateway answers{" "}
                    <Code>404</Code> unless those names are registered too.
                  </li>
                  <li>
                    <Code>ANTHROPIC_SMALL_FAST_MODEL</Code> is deprecated — use{" "}
                    <Code>ANTHROPIC_DEFAULT_HAIKU_MODEL</Code>.
                  </li>
                  <li>
                    Use <Code>ANTHROPIC_AUTH_TOKEN</Code> for the gateway key. If{" "}
                    <Code>ANTHROPIC_API_KEY</Code> is also set, Claude Code sends both headers; the
                    gateway prefers the Bearer token, so keep only <Code>AUTH_TOKEN</Code> to avoid
                    a stale value winning.
                  </li>
                </ul>

                <h4 className="pt-2 text-sm font-semibold text-foreground">
                  Auto mode and message threads
                </h4>
                <ul className="space-y-2">
                  <li>
                    With an Anthropic-protocol upstream, the gateway forwards{" "}
                    <Code>anthropic-beta</Code>, <Code>safeguards</Code> and <Code>thread</Code>{" "}
                    verbatim. Server-side auto mode and message threads work as they do against
                    Anthropic itself; non-stream responses keep the upstream{" "}
                    <Code>safeguard_results</Code> and the real message <Code>id</Code>.
                  </li>
                  <li>
                    With an OpenAI-dialect upstream, server-side auto mode cannot be reconstructed.
                    Set <Code>CLAUDE_CODE_AUTO_MODE_SERVER=0</Code> to use the client-side
                    classifier, or configure an Anthropic-dialect provider for the model.
                  </li>
                  <li>
                    Message threads require an Anthropic-dialect upstream. If a request carries{" "}
                    <Code>thread</Code> and resolves only to OpenAI-dialect candidates, the gateway
                    returns <Code>400</Code> with guidance instead of silently dropping the thread
                    state. Multi-provider pools skip OpenAI candidates and use an
                    Anthropic-dialect candidate when one exists.
                  </li>
                  <li>
                    <Code>anthropic-beta</Code> is forwarded verbatim. If a third-party relay rejects
                    unknown betas, ask an administrator to pin <Code>anthropic-beta</Code> in the
                    provider&apos;s advanced HTTP headers.
                  </li>
                </ul>

                <h4 className="pt-2 text-sm font-semibold text-foreground">Verify</h4>
                <p>
                  Run <Code>claude</Code>, then <Code>/status</Code> and check the{" "}
                  <em className="italic text-foreground">Anthropic base URL</em> line. A request that
                  fails with <Code>400</Code> and mentions experimental betas is fixed by setting{" "}
                  <Code>CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1</Code> or by pinning the beta value
                  on the provider.
                </p>
              </DocItem>

              <DocItem id="codex-cli" title="Codex CLI">
                <p>
                  Codex speaks the OpenAI Responses API. Add a provider to{" "}
                  <Code>~/.codex/config.toml</Code> (Windows:{" "}
                  <Code>%USERPROFILE%\.codex\config.toml</Code>):
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">Supported versions</h4>
                <VersionTable
                  rows={[
                    {
                      version: ">= 0.149",
                      status: "Full support",
                      notes:
                        "Responses Lite is adapted automatically: additional_tools, tool_search and reasoning replay work with no Codex setting.",
                    },
                    {
                      version: "0.113 – 0.148",
                      status: "Full support",
                      notes:
                        "Responses API with request_permissions; includes the 0.128–0.146 chat-deprecation period and the 0.147 approval-contract change. Interrupted tool calls are repaired by the gateway.",
                    },
                    {
                      version: "< 0.113",
                      status: "Not targeted",
                      notes:
                        'Chat wire-API era. Codex removed wire_api = "chat" in 2026-02; the gateway still serves chat-shaped HTTP clients.',
                    },
                  ]}
                />
                <p>
                  Latest verified: <Code>0.171.0</Code> (2026-11-20). Version behavior can drift; if
                  a request fails, record the client version and the request body before changing
                  gateway settings.
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">Known limits</h4>
                <ul className="space-y-2">
                  <li>
                    Only <Code>wire_api = &quot;responses&quot;</Code> is supported. The Responses
                    API is stateless: <Code>previous_response_id</Code> and{" "}
                    <Code>conversation</Code> return <Code>400</Code>; send the full input items
                    each turn.
                  </li>
                  <li>
                    On convert paths, paired server-side items (<Code>computer_call</Code> /{" "}
                    <Code>custom_tool_call</Code>) are dropped with a warning — the turn continues,
                    but that tool history is not reconstructed. Verbatim upstreams receive the raw
                    body.
                  </li>
                  <li>
                    Interrupted tool calls are repaired before forwarding: a missing output becomes{" "}
                    <Code>[tool result unavailable: call interrupted]</Code>, and orphan outputs are
                    dropped.
                  </li>
                </ul>

                <CodeBlock
                  label="~/.codex/config.toml"
                  code={`model = "<model-name>"
model_provider = "tokiapi"

[model_providers.tokiapi]
name = "TokiAPI"
base_url = "https://<your-gateway>/v1"
env_key = "TOKIAPI_API_KEY"
wire_api = "responses"
requires_openai_auth = false`}
                />
                <p>The key comes from an environment variable, never from the TOML file itself:</p>
                <CodeBlock label="bash / zsh" code={`export TOKIAPI_API_KEY="sk-..."`} />
                <CodeBlock label="PowerShell" code={`$env:TOKIAPI_API_KEY = "sk-..."`} />
                <ul className="space-y-2">
                  <li>
                    <Code>base_url</Code> must include <Code>/v1</Code> — Codex appends{" "}
                    <Code>/responses</Code>, so requests land on <Code>/v1/responses</Code>. Without{" "}
                    <Code>/v1</Code> the requests never reach the proxy and every call fails with{" "}
                    <Code>405</Code>.
                  </li>
                  <li>
                    <Code>wire_api = &quot;responses&quot;</Code> selects the Responses API;{" "}
                    <Code>chat</Code> is the older Chat Completions format.
                  </li>
                  <li>
                    <Code>requires_openai_auth = false</Code> stops Codex from expecting an OpenAI
                    login — the gateway key is the only credential.
                  </li>
                  <li>
                    Restart Codex (or the terminal) after editing — the config is read at startup.
                  </li>
                </ul>

                <h4 className="pt-2 text-sm font-semibold text-foreground">
                  Interrupted tool calls
                </h4>
                <p>
                  Codex can replay an interrupted tool call (for example a Smart Approvals{" "}
                  <Code>request_permissions</Code> call) without the matching output. The gateway
                  repairs the history before forwarding it: a missing output becomes{" "}
                  <Code>[tool result unavailable: call interrupted]</Code>, and orphan outputs are
                  dropped. Upstreams no longer reject the turn with a <Code>tool_calls</Code>{" "}
                  pairing <Code>400</Code>, and no Codex setting is needed.
                </p>
              </DocItem>

              <DocItem id="pi" title="Pi">
                <p>
                  Pi supports custom OpenAI- and Anthropic-compatible endpoints through{" "}
                  <Code>models.json</Code> (default <Code>~/.pi/agent/models.json</Code>;{" "}
                  <Code>PI_CODING_AGENT_DIR</Code> changes the directory). Add TokiAPI as a
                  provider:
                </p>
                <CodeBlock
                  label="~/.pi/agent/models.json"
                  code={`{
  "$schema": "https://pi.dev/schemas/models.schema.json",
  "providers": {
    "tokiapi": {
      "baseUrl": "https://<your-gateway>/v1",
      "api": "openai-completions",
      "apiKey": "$TOKIAPI_API_KEY",
      "models": [{ "id": "<model-name>" }]
    }
  }
}`}
                />
                <CodeBlock
                  label="bash / zsh"
                  code={`export TOKIAPI_API_KEY="sk-..."
pi --provider tokiapi --model <model-name>`}
                />
                <ul className="space-y-2">
                  <li>
                    <Code>api</Code> can be <Code>openai-completions</Code>,{" "}
                    <Code>openai-responses</Code> (the <Code>/v1/responses</Code> face), or{" "}
                    <Code>anthropic-messages</Code> (point <Code>baseUrl</Code> at{" "}
                    <Code>https://&lt;your-gateway&gt;/anthropic</Code> and confirm the final path
                    with a test request).
                  </li>
                  <li>
                    <Code>apiKey</Code> accepts <Code>$NAME</Code> / <Code>{"${NAME}"}</Code>{" "}
                    environment interpolation; the models array can pin context window and output
                    limits per model.
                  </li>
                  <li>
                    <Code>models.json</Code> reloads when <Code>/model</Code> opens;{" "}
                    <Code>pi update --models</Code> refreshes Pi&apos;s bundled catalog.
                  </li>
                  <li>
                    See <a className="text-brand underline-offset-4 hover:underline" href="https://pi.dev/docs/latest/models" target="_blank" rel="noopener noreferrer">Pi models configuration</a>.
                  </li>
                </ul>
              </DocItem>

              <DocItem id="opencode" title="OpenCode">
                <p>
                  OpenCode reads providers from <Code>opencode.json(c)</Code> (project root or{" "}
                  <Code>~/.config/opencode/opencode.json</Code>). Add an OpenAI-compatible
                  provider:
                </p>
                <CodeBlock
                  label="opencode.jsonc"
                  code={`{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "tokiapi": {
      "name": "TokiAPI",
      "env": ["TOKIAPI_API_KEY"],
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://<your-gateway>/v1"
      },
      "models": {
        "<model-name>": { "name": "<model-name>" }
      }
    }
  }
}`}
                />
                <CodeBlock
                  label="bash / zsh"
                  code={`export TOKIAPI_API_KEY="sk-..."
opencode
# then /models -> tokiapi/<model-name>`}
                />
                <ul className="space-y-2">
                  <li>
                    Model references use <Code>provider/model</Code>: <Code>tokiapi/&lt;model-name&gt;</Code>.
                  </li>
                  <li>
                    Current OpenCode uses <Code>providers</Code> / <Code>package</Code> /{" "}
                    <Code>settings</Code>; older releases used <Code>provider</Code> /{" "}
                    <Code>npm</Code> / <Code>options</Code>. Check <Code>opencode --version</Code>{" "}
                    before mixing formats.
                  </li>
                  <li>
                    See <a className="text-brand underline-offset-4 hover:underline" href="https://opencode.ai/docs/providers/" target="_blank" rel="noopener noreferrer">OpenCode providers</a>.
                  </li>
                </ul>
              </DocItem>

              <DocItem id="cursor" title="Cursor">
                <ol className="list-decimal space-y-2 pl-5">
                  <li>
                    Open <span className="font-medium text-foreground">Settings → Models → API Keys</span>.
                  </li>
                  <li>
                    Enter your gateway <Code>sk-…</Code> key in the{" "}
                    <span className="font-medium text-foreground">OpenAI API Key</span> field.
                  </li>
                  <li>
                    Enable <span className="font-medium text-foreground">Override OpenAI Base URL</span>{" "}
                    and enter <Code>https://&lt;your-gateway&gt;/v1</Code>. The URL must include{" "}
                    <Code>/v1</Code> and must not end with a slash.
                  </li>
                  <li>
                    Use <span className="font-medium text-foreground">+ Add Custom Model</span>, enter
                    the exact model name registered in the gateway, then verify.
                  </li>
                </ol>
                <ul className="space-y-2">
                  <li>
                    Cursor only exposes an OpenAI-compatible base URL override. The Anthropic and
                    Google panes have no base URL field.
                  </li>
                  <li>
                    The override is global: it applies to all OpenAI-key traffic, not per model.
                  </li>
                  <li>
                    Custom keys cover chat; Tab completion, indexing, Apply and some background
                    features still use Cursor-hosted services.
                  </li>
                </ul>
              </DocItem>

              <DocItem id="other-agents" title="Other agents">
                <p>
                  Any agent that accepts an OpenAI or Anthropic base URL can use the gateway.
                  Configure the base URL and a gateway key; the model name must match the console.
                </p>
                <CodeBlock
                  label="bash / zsh"
                  code={`# OpenAI-compatible agents
export OPENAI_BASE_URL="https://<your-gateway>/v1"
export OPENAI_API_KEY="sk-..."

# Anthropic-native agents
export ANTHROPIC_BASE_URL="https://<your-gateway>/anthropic"
export ANTHROPIC_AUTH_TOKEN="sk-..."`}
                />
                <ul className="space-y-2">
                  <li>
                    Gemini CLI upstream has no native custom OpenAI base URL. Route it through
                    Magpie (which supports Gemini CLI) or use an OpenAI-compatible fork.
                  </li>
                  <li>
                    Aider and Goose generally accept an OpenAI-compatible base URL; check their
                    current docs for the exact variable names.
                  </li>
                </ul>
              </DocItem>
            </DocGroup>

            <DocGroup title="Routers">
              <DocItem id="cc-switch" title="CC Switch">
                <p>
                  CC Switch stores and switches client configurations. It has two tabs, and both
                  point at the same gateway.
                </p>

                <h4 className="text-sm font-semibold text-foreground">Claude Code tab</h4>
                <FieldTable
                  rows={[
                    { field: "Provider name", value: "TokiAPI (any label)" },
                    { field: "Request URL", value: "https://<your-gateway>/anthropic" },
                    { field: "API format", value: "Anthropic Messages (Native)" },
                    { field: "Auth field", value: "ANTHROPIC_AUTH_TOKEN (default)" },
                    { field: "API key", value: "your gateway sk-... key" },
                    {
                      field: "Model mapping",
                      value: "Sonnet / Opus / Haiku → models registered in the gateway",
                    },
                  ]}
                />

                <h4 className="pt-2 text-sm font-semibold text-foreground">Codex tab</h4>
                <FieldTable
                  rows={[
                    { field: "Request URL", value: "https://<your-gateway>/v1" },
                    { field: "API format", value: "OpenAI (Responses)" },
                    { field: "API key", value: "the same gateway sk-... key" },
                    { field: "Model", value: "a model name registered in the gateway" },
                  ]}
                />

                <ul className="space-y-2">
                  <li>No trailing slash on either URL.</li>
                  <li>
                    Enable the provider, then restart Claude Code or Codex. In Claude Code,{" "}
                    <Code>/status</Code> confirms the base URL.
                  </li>
                </ul>

                <details className="rounded-lg border bg-card/50 p-4">
                  <summary className="cursor-pointer text-sm font-medium text-foreground">
                    Advanced: run OpenAI models inside Claude Code
                  </summary>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    CC Switch can run a local router that translates Anthropic Messages into OpenAI
                    Responses, so Claude Code can use models that only exist behind an
                    OpenAI-compatible endpoint. For that, point the provider at your gateway root
                    URL (no <Code>/anthropic</Code>), choose{" "}
                    <Code>OpenAI Responses API (requires routing)</Code> and enable Local routing.
                    You do not need this for normal use — this gateway has a native Anthropic entry.
                  </p>
                </details>
              </DocItem>

              <DocItem id="magpie" title="Magpie">
                <p>
                  Magpie is a local gateway and menu-bar app that rewrites each agent&apos;s own
                  config. Its gateway at <Code>127.0.0.1:3425</Code> speaks Chat Completions,
                  Responses, Anthropic Messages and Gemini, and translates between them.
                </p>
                <CodeBlock
                  label="Install (macOS / Linux / Docker / Termux; Windows: desktop app)"
                  code={`curl -fsSL https://usemagpie.ai/install.sh | sh`}
                />
                <p>
                  Review the script before piping it to a shell, or install the desktop app from{" "}
                  <a
                    href="https://usemagpie.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand underline-offset-4 hover:underline"
                  >
                    usemagpie.ai
                  </a>
                  .
                </p>
                <p>Add TokiAPI as a custom provider with your gateway key and model list:</p>
                <CodeBlock
                  label="bash / zsh"
                  code={`magpie provider add "TokiAPI" \\
  url=https://<your-gateway>/v1 \\
  key=sk-... \\
  models=<model-name>

magpie providers   # note the provider id it prints
magpie claude <provider>/<model-name>
magpie codex <provider>/<model-name>`}
                />
                <p>
                  The CLI form exposes the key in your shell history. If that is a concern, add the
                  provider from the desktop app instead, or clear the history entry afterwards.
                </p>
                <ul className="space-y-2">
                  <li>
                    Use the provider id printed by <Code>magpie providers</Code>; the label above is
                    only the display name.
                  </li>
                  <li>
                    In the desktop app, pick the provider/model on the{" "}
                    <span className="font-medium text-foreground">Agents</span> page instead of
                    running the CLI commands.
                  </li>
                  <li>
                    Any agent can also point at Magpie&apos;s gateway directly:{" "}
                    <Code>OPENAI_BASE_URL=http://127.0.0.1:3425/v1</Code> +{" "}
                    <Code>OPENAI_API_KEY=magpie</Code>, or{" "}
                    <Code>ANTHROPIC_BASE_URL=http://127.0.0.1:3425</Code> +{" "}
                    <Code>ANTHROPIC_API_KEY=magpie</Code>.
                  </li>
                  <li>
                    See <a className="text-brand underline-offset-4 hover:underline" href="https://usemagpie.ai/docs/start" target="_blank" rel="noopener noreferrer">Magpie docs</a>.
                  </li>
                </ul>
              </DocItem>

              <DocItem id="byok-openrouter" title="BYOK: OpenRouter">
                <p>
                  Bring your own OpenRouter key as an upstream provider. TokiAPI keeps the key
                  encrypted, bills against your model table, and treats OpenRouter as an
                  OpenAI-compatible aggregator.
                </p>
                <ol className="list-decimal space-y-2 pl-5">
                  <li>
                    In the console open <span className="font-medium text-foreground">Providers → Add provider</span>{" "}
                    and choose the <span className="font-medium text-foreground">OpenRouter</span>{" "}
                    preset.
                  </li>
                  <li>
                    Keep the base URL <Code>https://openrouter.ai/api/v1</Code>. The double segment
                    matters: <Code>https://openrouter.ai/api</Code> returns 404 for every model.
                  </li>
                  <li>Paste your OpenRouter key and save; run the provider test.</li>
                  <li>
                    Add the models you want to expose, or open{" "}
                    <span className="font-medium text-foreground">Models → Sync prices</span> to
                    pull the OpenRouter catalog (allowlisted models, prices refreshed).
                  </li>
                </ol>
                <ul className="space-y-2">
                  <li>
                    In the provider&apos;s model mapping, the <em>upstream</em> value must be the
                    OpenRouter catalog ID (for example <Code>openai/gpt-5.5</Code>). The internal
                    name clients send — and the name Sync prices matches — is the bare ID without
                    the vendor prefix (for example <Code>gpt-5.5</Code>).
                  </li>
                  <li>
                    The gateway key clients use is still your TokiAPI <Code>sk-…</Code> key. The
                    OpenRouter key is stored encrypted and used only for upstream calls.
                  </li>
                  <li>
                    See <a className="text-brand underline-offset-4 hover:underline" href="https://openrouter.ai/docs" target="_blank" rel="noopener noreferrer">OpenRouter docs</a>.
                  </li>
                </ul>
              </DocItem>
            </DocGroup>

            <DocGroup title="Tokimeki">
              <DocItem id="tokimeki" title="Tokimeki terminal sharing">
                <p>
                  TokiAPI can act as the{" "}
                  <strong className="font-semibold text-foreground">control plane</strong> for{" "}
                  <a
                    href="https://github.com/limccn/tokimeki"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand underline-offset-4 hover:underline"
                  >
                    tokimeki
                  </a>
                  : it signs Host and Session JWTs, creates invite and share links, serves anonymous
                  hosts, and proxies the browser WebSocket. The relay still owns the PTY and the
                  terminal data; TokiAPI only signs credentials and proxies the browser stream.
                </p>
                <p>
                  The integration is optional and deployment-wide. When it is off, everything else
                  on this page works unchanged.
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">
                  Enable it (self-hosted)
                </h4>
                <p>
                  Configure the relay URL and store an ES256 private JWK as a Worker secret. There
                  is no <Code>TOKIMEKI_ENABLED</Code> switch: a missing or invalid key turns the
                  feature off, and <Code>GET /api/config</Code> reports{" "}
                  <Code>tokimekiEnabled: false</Code>.
                </p>
                <ul className="space-y-2">
                  <li>
                    <Code>TOKIMEKI_RELAY_URL</Code> — relay origin, for example{" "}
                    <Code>wss://relay.example.com</Code>. Empty disables command/link generation and
                    the browser WS proxy.
                  </li>
                  <li>
                    <Code>TOKIMEKI_JWT_PRIVATE_JWK</Code> — ES256 private JWK. Generate it with{" "}
                    <Code>node scripts/generate-tokimeki-key.mjs</Code> and store it with{" "}
                    <Code>wrangler secret put</Code>.
                  </li>
                </ul>
                <p>
                  The relay must be a <Code>0.1.4+</Code> build (the Tokimeki v1.2 JWT line) with{" "}
                  <Code>TOKIMEKI_JWT_JWKS_URL</Code> pointed at this deployment. See the{" "}
                  <a
                    href={GITHUB_README_TOKIMEKI_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-brand underline-offset-4 hover:underline"
                  >
                    README deployment section
                  </a>{" "}
                  for the full variable table, issuer/audience matching and the legacy master-token
                  fallback.
                </p>

                <h4 className="pt-2 text-sm font-semibold text-foreground">Limits and security</h4>
                <ul className="space-y-2">
                  <li>
                    A share link is a capability: anyone who has it can redeem it until it expires
                    or the invite is revoked. Revoking an invite only blocks new redemptions.
                  </li>
                  <li>
                    A session token is also a capability, but there is no revocation list. A leaked
                    session token stays valid until it expires (5 minutes for the web proxy, up to
                    24 hours for CLI attach); end the host session or wait it out. Treat both like
                    passwords.
                  </li>
                  <li>
                    The optional 6-digit passcode is an additional gate, not a replacement for link
                    hygiene.
                  </li>
                  <li>
                    The attach ticket cookie is origin-wide. Opening two different share links in
                    the same browser profile can overwrite the pending ticket — use one active link
                    per profile.
                  </li>
                  <li>
                    The browser viewer reaches the relay through the gateway&apos;s WebSocket proxy;
                    TURN/ICE settings are stripped and TokiAPI does not store terminal data.
                  </li>
                  <li>
                    Expired invites and attach tickets are removed by the daily cleanup job after 7
                    days. Master Host JWTs have no revocation list: a leaked token stays valid until
                    it expires (30 days by default) or the signing key is rotated.
                  </li>
                </ul>
              </DocItem>

              <DocItem id="tokimeki-install" title="Install the CLI">
                <p>
                  Requirements: Node.js <Code>&gt;= 22.12</Code> and npm{" "}
                  <Code>&gt;= 11</Code>.
                </p>
                <CodeBlock
                  label="bash / zsh"
                  code={`npm install -g @limccn/tokimeki
tokimeki --version
tokimeki --help
tokimeki doctor`}
                />
                <p>
                  Windows uses ConPTY; macOS and Linux use the native PTY. The terminal data path
                  uses <Code>node-pty</Code> and <Code>node-datachannel</Code> native modules.
                </p>
              </DocItem>

              <DocItem id="tokimeki-host" title="Host a session">
                <DocSubSection id="tokimeki-host-cli" title="From the CLI">
                  <p>
                    The hub generates this command for you. It is a multi-line script: one{" "}
                    <Code>TOKIMEKI_*</Code> assignment per line, with the{" "}
                    <Code>tokimeki …</Code> command last, so it can be pasted as a block into bash,
                    zsh, fish, PowerShell or cmd.
                  </p>
                  <CodeBlock
                    label="bash / zsh — example"
                    code={`export TOKIMEKI_RELAY_URL='wss://relay.example.com'
export TOKIMEKI_TOKEN='<host-jwt-or-namespace-token>'
export TOKIMEKI_NAMESPACE='<namespace>'
export TOKIMEKI_SESSION='<namespace>.<session>'
export TOKIMEKI_SESSION_TOKEN='<session-token>'
# optional: export TOKIMEKI_PASSCODE='<passcode>'
tokimeki claude`}
                  />
                  <p>
                    Paste the generated block into a trusted shell and avoid sharing it. It contains
                    a host credential; clear your shell history if your shell records pasted lines.
                  </p>
                  <ul className="space-y-2">
                    <li>
                      Built-in commands: <Code>tokimeki claude</Code>, <Code>tokimeki pi</Code>, and{" "}
                      <Code>tokimeki run -- &lt;cmd&gt;</Code> for any other TUI command.
                    </li>
                    <li>
                      <Code>TOKIMEKI_CONFIG</Code> accepts the JSON envelope from{" "}
                      <Code>tokimeki-config.json</Code> instead of the separate variables. Explicit
                      environment variables win over config values. The downloaded file contains the
                      same host credential as the command block — store or delete it like the block.
                    </li>
                    <li>
                      Press <Code>F12</Code> (or the configured invite key) in the host viewport to
                      show the viewer-config overlay again. The overlay contains the session token —
                      treat it as a secret.
                    </li>
                    <li>
                      Fixed-window TUIs default to <Code>TOKIMEKI_WINDOW_TUI=claude,pi</Code> at{" "}
                      <Code>120x40</Code>; set <Code>TOKIMEKI_WINDOW=off</Code> for legacy
                      resize behavior. <Code>TOKIMEKI_WINDOW_TUI</Code> also enables{" "}
                      <Code>tokimeki &lt;cmd&gt;</Code> for those command names.
                    </li>
                  </ul>
                </DocSubSection>

                <DocSubSection id="tokimeki-host-web" title="From the web hub">
                  <ol className="list-decimal space-y-2 pl-5">
                    <li>
                      Open <Code>/tokimeki</Code>. Step 1 shows the install command and a “Skip next
                      time” switch remembered by cookie.
                    </li>
                    <li>
                      In step 2 choose <span className="font-medium text-foreground">Host</span>,
                      then pick Platform / Shell / ACP. Signed-in hosts can expand Session (name and
                      token), Passcode (6 digits), and Advanced (window size, browser access,
                      viewer/listener mode, share-link TTL 1h / 8h / 24h / 7d).
                    </li>
                    <li>
                      Anonymous visitors get a 4-character namespace and a Host JWT valid for 24
                      hours by default (<Code>TOKIMEKI_ANON_HOST_TTL_SECONDS</Code>).
                    </li>
                    <li>
                      Step 3 shows the command, the share link, and a{" "}
                      <Code>tokimeki-config.json</Code> download. The browser only generates
                      credentials and the command — the PTY itself still runs in your terminal.
                    </li>
                  </ol>
                </DocSubSection>
              </DocItem>

              <DocItem id="tokimeki-attach" title="Attach to a session">
                <DocSubSection id="tokimeki-attach-cli" title="From the CLI">
                  <CodeBlock
                    label="bash / zsh"
                    code={`export TOKIMEKI_RELAY_URL='wss://relay.example.com'
export TOKIMEKI_SESSION='<namespace>.<session>'
export TOKIMEKI_SESSION_TOKEN='<session-token>'
# optional: export TOKIMEKI_PASSCODE='<passcode>'

tokimeki attach
# read-only listener:
tokimeki attach --listen`}
                  />
                  <ul className="space-y-2">
                    <li>
                      Attach needs only the relay URL, session name and session token — not the host
                      token or namespace.
                    </li>
                    <li>
                      All viewers share control. <Code>--listen</Code> sends periodic ANSI snapshots
                      and ignores local input.
                    </li>
                    <li>
                      The host&apos;s <Code>TOKIMEKI_CONFIG</Code> JSON can be used instead of the
                      three variables; a passcode-protected session also needs{" "}
                      <Code>TOKIMEKI_PASSCODE</Code>.
                    </li>
                  </ul>
                </DocSubSection>

                <DocSubSection id="tokimeki-attach-web" title="From the browser">
                  <p>
                    Open the share link itself — it uses the platform/console origin, not the API
                    origin: <Code>https://&lt;your-platform-origin&gt;/#t-&lt;code&gt;</Code>. The
                    proxy injects a short-lived Session JWT server-side, so the browser never sees
                    it; TURN credentials are stripped from the relay messages.
                  </p>
                  <ul className="space-y-2">
                    <li>
                      If the host set a passcode, enter the 6 digits in the viewer. The passcode is
                      remembered for the current browser tab only.
                    </li>
                    <li>
                      Viewer and listener links are created in{" "}
                      <Code>/tokimeki/sessions</Code>; a listener link is read-only.
                    </li>
                    <li>
                      The attach ticket cookie is origin-wide: opening two different share links in
                      the same browser profile can overwrite the pending ticket.
                    </li>
                  </ul>
                </DocSubSection>
              </DocItem>

              <DocItem id="tokimeki-dashboard" title="Dashboard and management">
                <ul className="space-y-2">
                  <li>
                    <Code>/tokimeki</Code> — the public hub: host/attach wizard, anonymous host,
                    share links and TTL presets.
                  </li>
                  <li>
                    <Code>/tokimeki/sessions</Code> — signed-in hosts manage invites: create viewer
                    or listener links (access mode, TTL presets, switches), revoke them, and
                    regenerate per-shell attach commands.
                  </li>
                  <li>
                    <Code>/tokimeki/tokens</Code> — issue long-lived master Host JWTs for CLI use.
                    The plaintext token is shown once; the database keeps only metadata (no token or
                    hash). There is no revocation list: rotate by creating a new token and replacing
                    the old value.
                  </li>
                </ul>

                <h4 className="pt-2 text-sm font-semibold text-foreground">
                  Endpoints (for self-hosters)
                </h4>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Access</TableHead>
                      <TableHead>Purpose</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>GET /api/tokimeki/jwks.json</Code>
                      </TableCell>
                      <TableCell className="align-top">Public</TableCell>
                      <TableCell className="align-top">
                        ES256 public keys for relay verification.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /api/tokimeki/token</Code>
                      </TableCell>
                      <TableCell className="align-top">Session</TableCell>
                      <TableCell className="align-top">Host JWT for the signed-in user.</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>/api/tokimeki/invites</Code>
                      </TableCell>
                      <TableCell className="align-top">Session</TableCell>
                      <TableCell className="align-top">
                        Create, list and revoke invites; <Code>/invites/:id/token</Code> mints a
                        Session JWT.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /api/tokimeki/attach</Code>
                      </TableCell>
                      <TableCell className="align-top">Public</TableCell>
                      <TableCell className="align-top">
                        Redeem a share link with a one-time cookie.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /api/tokimeki/attach/cli</Code>
                      </TableCell>
                      <TableCell className="align-top">Public</TableCell>
                      <TableCell className="align-top">CLI Session JWT.</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>GET /api/tokimeki/ws</Code>
                      </TableCell>
                      <TableCell className="align-top">Browser (cookie + same-origin)</TableCell>
                      <TableCell className="align-top">Browser WebSocket proxy.</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /api/tokimeki/anon-host</Code>
                      </TableCell>
                      <TableCell className="align-top">Public</TableCell>
                      <TableCell className="align-top">Anonymous host JWT and invite.</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </DocItem>
            </DocGroup>

            <DocGroup title="Reference">
              <DocItem id="models" title="Models & verification">
                <p>
                  The model name is the contract: whatever your client sends must match a model
                  registered in the console. An unregistered name returns <Code>404</Code>.
                </p>
                <CodeBlock
                  label="List the models this gateway serves"
                  code={`curl -s https://<your-gateway>/v1/models \\
  -H "Authorization: Bearer $TOKIAPI_API_KEY"`}
                />
                <p>
                  The smallest Anthropic-shape check — the same request Claude Code makes. Note that{" "}
                  <Code>https://&lt;your-gateway&gt;/anthropic</Code> plus{" "}
                  <Code>/v1/messages</Code> is the full path:
                </p>
                <CodeBlock
                  label="Verify the Anthropic entry"
                  code={`curl -s https://<your-gateway>/anthropic/v1/messages \\
  -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" \\
  -d '{"model":"<model-name>","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'`}
                />
                <p>
                  Both credential headers work on every proxy entry:{" "}
                  <Code>Authorization: Bearer sk-…</Code> and <Code>x-api-key: sk-…</Code>. If the
                  model list from <Code>GET /v1/models</Code> is empty, no enabled provider lists
                  any models — ask your admin.
                </p>
              </DocItem>

              <DocItem id="troubleshooting" title="Troubleshooting">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Symptom</TableHead>
                      <TableHead>Cause</TableHead>
                      <TableHead>Fix</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">401</TableCell>
                      <TableCell className="align-top">
                        Wrong key or header, or a stale <Code>ANTHROPIC_AUTH_TOKEN</Code> in the
                        environment overriding the configured one.
                      </TableCell>
                      <TableCell className="align-top">
                        Send the gateway <Code>sk-…</Code> key as{" "}
                        <Code>Authorization: Bearer</Code> (or <Code>x-api-key</Code>). Remove
                        conflicting Anthropic variables and restart the client.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        404 — model not found
                      </TableCell>
                      <TableCell className="align-top">
                        The model name is not registered on this gateway.
                      </TableCell>
                      <TableCell className="align-top">
                        Use a name from the console&apos;s Models page (or{" "}
                        <Code>GET /v1/models</Code>); for Claude Code, check the{" "}
                        <Code>ANTHROPIC_DEFAULT_*</Code> variables.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">402</TableCell>
                      <TableCell className="align-top">
                        The account balance has gone below zero.
                      </TableCell>
                      <TableCell className="align-top">
                        Ask an administrator to top up the account. A balance of exactly zero still
                        allows requests — the gateway only blocks once it is negative.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">429</TableCell>
                      <TableCell className="align-top">
                        The key&apos;s rate limit window is exhausted.
                      </TableCell>
                      <TableCell className="align-top">
                        Wait for the window to reset, or raise the key&apos;s QPS limit on the Keys
                        page — despite the name, it is enforced per minute.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        400 mentioning experimental betas
                      </TableCell>
                      <TableCell className="align-top">
                        The client sends beta headers that the upstream does not accept.
                      </TableCell>
                      <TableCell className="align-top">
                        Set <Code>CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1</Code>.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        Connection failure, or 404 / 405 on every path
                      </TableCell>
                      <TableCell className="align-top">
                        Trailing slash on the base URL, a missing <Code>/v1</Code>, or{" "}
                        <Code>/v1</Code> and <Code>/anthropic</Code> swapped.
                      </TableCell>
                      <TableCell className="align-top">
                        Claude Code and the CC Switch Claude tab use{" "}
                        <Code>/anthropic</Code>; Codex, Pi, OpenCode, Cursor and the CC Switch Codex
                        tab use <Code>/v1</Code> (never omit it). No trailing slash.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        400 — tool_calls must be followed by tool messages
                      </TableCell>
                      <TableCell className="align-top">
                        An interrupted agent turn left an unpaired tool call in the replayed
                        history.
                      </TableCell>
                      <TableCell className="align-top">
                        Upgrade the gateway to a build with protocol pairing hygiene — it repairs
                        the history automatically. No client change is needed.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        400 — message threads require an Anthropic-protocol upstream
                      </TableCell>
                      <TableCell className="align-top">
                        The request carries <Code>thread</Code> but the model resolves only to
                        OpenAI-dialect providers.
                      </TableCell>
                      <TableCell className="align-top">
                        Use an Anthropic-dialect provider for this model, or disable message
                        threads in the client.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        Auto mode unavailable
                      </TableCell>
                      <TableCell className="align-top">
                        Server-side auto mode needs an Anthropic-protocol upstream.
                      </TableCell>
                      <TableCell className="align-top">
                        Set <Code>CLAUDE_CODE_AUTO_MODE_SERVER=0</Code>, or configure an
                        Anthropic-dialect provider.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        Pi / OpenCode / Cursor sees no models
                      </TableCell>
                      <TableCell className="align-top">
                        The base URL is missing <Code>/v1</Code>, the API-key environment variable
                        is unset, or the model name does not match the console.
                      </TableCell>
                      <TableCell className="align-top">
                        Check the base URL and env var, then reload the client&apos;s model list.
                        For Pi, reopen <Code>/model</Code>; for OpenCode, run <Code>/models</Code>.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        Magpie provider has no models
                      </TableCell>
                      <TableCell className="align-top">
                        The <Code>models=</Code> list does not match the gateway&apos;s registered
                        model names.
                      </TableCell>
                      <TableCell className="align-top">
                        Re-add the provider with the exact names, or run{" "}
                        <Code>magpie provider models &lt;id&gt;</Code> and expose them.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        Tokimeki passcode rejected
                      </TableCell>
                      <TableCell className="align-top">
                        The command or viewer is missing <Code>TOKIMEKI_PASSCODE</Code>.
                      </TableCell>
                      <TableCell className="align-top">
                        Add the 6-digit passcode to the env block (or enter it in the viewer).
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top font-medium text-foreground">
                        Config changes have no effect
                      </TableCell>
                      <TableCell className="align-top">
                        The client loaded its configuration at startup.
                      </TableCell>
                      <TableCell className="align-top">
                        Restart Claude Code, Codex, Pi, OpenCode, Cursor, or the terminal session.
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </DocItem>

              <DocItem id="api" title="API endpoints">
                <p>
                  The proxy entries are OpenAI-shaped under <Code>/v1</Code> and Anthropic-shaped
                  under <Code>/anthropic</Code>. All of them accept the same gateway key.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Endpoint</TableHead>
                      <TableHead>Protocol</TableHead>
                      <TableHead>Used by</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /v1/chat/completions</Code>
                      </TableCell>
                      <TableCell className="align-top">OpenAI Chat Completions</TableCell>
                      <TableCell className="align-top">
                        Chat apps and the OpenAI SDK (streaming and non-streaming).
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /v1/responses</Code>
                      </TableCell>
                      <TableCell className="align-top">OpenAI Responses</TableCell>
                      <TableCell className="align-top">Codex CLI and the Responses API.</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /v1/messages</Code>
                      </TableCell>
                      <TableCell className="align-top">
                        Anthropic Messages or OpenAI Chat (auto-detected)
                      </TableCell>
                      <TableCell className="align-top">
                        Clients that need one entry for both protocols.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /v1/embeddings</Code>
                      </TableCell>
                      <TableCell className="align-top">OpenAI</TableCell>
                      <TableCell className="align-top">Embeddings for search and RAG.</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>GET /v1/models</Code>
                      </TableCell>
                      <TableCell className="align-top">OpenAI</TableCell>
                      <TableCell className="align-top">
                        The models registered on this gateway.
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell className="align-top">
                        <Code>POST /anthropic/v1/messages</Code>
                      </TableCell>
                      <TableCell className="align-top">Anthropic Messages</TableCell>
                      <TableCell className="align-top">
                        Claude Code and the Anthropic SDK (base URL ends in{" "}
                        <Code>/anthropic</Code>).
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
                <h4 className="pt-2 text-sm font-semibold text-foreground">
                  Protocol passthrough
                </h4>
                <ul className="space-y-2">
                  <li>
                    <Code>anthropic-beta</Code> is forwarded verbatim to Anthropic-dialect upstreams
                    on both the convert and verbatim paths. <Code>anthropic-version</Code> stays
                    pinned by the gateway.
                  </li>
                  <li>
                    On Anthropic-dialect convert paths, <Code>thread</Code> and{" "}
                    <Code>safeguards</Code> are forwarded; non-stream responses return the upstream{" "}
                    <Code>safeguard_results</Code> and real message <Code>id</Code>.
                  </li>
                  <li>
                    On <Code>/v1/responses</Code> and <Code>/v1/chat/completions</Code>, interrupted
                    tool calls are repaired server-side (synthetic tool result; orphan tool outputs
                    are dropped).
                  </li>
                  <li>
                    Paired server-side Responses items (<Code>computer_call</Code> /{" "}
                    <Code>custom_tool_call</Code>) are dropped with a warning on convert paths;
                    verbatim upstreams receive the raw body. The Responses API is stateless:{" "}
                    <Code>previous_response_id</Code> and <Code>conversation</Code> return{" "}
                    <Code>400</Code>.
                  </li>
                  <li>
                    A request carrying <Code>thread</Code> that resolves only to OpenAI-dialect
                    candidates returns <Code>400</Code> (fail-closed); multi-provider pools fall
                    through to an Anthropic-dialect candidate when one exists.
                  </li>
                </ul>
                <p>Every proxy request authenticates with either header:</p>
                <CodeBlock
                  label="Authentication"
                  code={`Authorization: Bearer sk-...
x-api-key: sk-...`}
                />
              </DocItem>
            </DocGroup>
          </div>

          <div className="mt-10 flex flex-wrap items-center gap-3 border-t pt-10">
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              GitHub repository
            </a>
            <a
              href={GITHUB_README_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              Deployment guide (README)
            </a>
          </div>
        </article>
      </div>
    </div>
  );
}
