// /docs — 公开产品文档（10-23-marketing-home-docs）。
// 受众：Agent 工具使用者（Claude Code / Codex CLI / CC Switch），不假设读者了解网关协议。
// 内容依据：research/agent-client-setup.md（外部资料 + 本仓库源码契约）。单页、一层目录。
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
import { GITHUB_README_URL, GITHUB_URL } from "@/lib/site-links";

const TOC = [
  { id: "overview", label: "Overview" },
  { id: "features", label: "Features" },
  { id: "start", label: "Start here" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex-cli", label: "Codex CLI" },
  { id: "cc-switch", label: "CC Switch" },
  { id: "models", label: "Models" },
  { id: "troubleshooting", label: "Troubleshooting" },
  { id: "api", label: "API" },
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

interface DocSectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

function DocSection({ id, title, children }: DocSectionProps) {
  return (
    <section id={id} className="scroll-mt-24 border-t pt-10">
      <h2 className="text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-5 sm:px-6">
      <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-12">
        {/* 一层目录：桌面 sticky 左栏，移动端顶部横向换行 */}
        <nav aria-label="On this page" className="pt-6 lg:sticky lg:top-20 lg:self-start lg:pt-10">
          <ul className="flex flex-wrap gap-x-4 gap-y-2 border-b pb-4 text-sm lg:flex-col lg:gap-y-1 lg:border-b-0 lg:pb-0">
            {TOC.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className="text-muted-foreground transition-colors hover:text-brand"
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <article className="min-w-0 max-w-3xl pb-16 pt-10">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Documentation</h1>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            Point Claude Code, Codex CLI or any OpenAI / Anthropic SDK at your own TokiAPI
            gateway. Three steps, one key.
          </p>

          <div className="mt-10 space-y-10">
            <DocSection id="overview" title="What is TokiAPI">
              <p>
                TokiAPI is a self-hosted AI API gateway. It puts one OpenAI-compatible endpoint in
                front of many model providers — both OpenAI-compatible upstreams and
                Anthropic-native ones — so a single key, a single base URL and a single bill cover
                everything.
              </p>
              <p>
                It runs entirely on Cloudflare (Workers, D1, KV, Queues). There is no external
                service to operate, and your data — keys, balances, request logs — stays in your
                own account.
              </p>
            </DocSection>

            <DocSection id="features" title="What you get">
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
            </DocSection>

            <DocSection id="start" title="Start here">
              <h3 className="text-sm font-semibold text-foreground">What you need</h3>
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
                  <span className="font-medium text-foreground">Connect your client</span> — pick
                  Claude Code, Codex CLI or CC Switch below, paste the configuration block, and
                  restart the client.
                </li>
              </ol>
            </DocSection>

            <DocSection id="claude-code" title="Claude Code">
              <p>
                Claude Code speaks the Anthropic Messages protocol. Point its base URL at{" "}
                <Code>https://&lt;your-gateway&gt;/anthropic</Code> and authenticate with a gateway
                key — Claude Code appends <Code>/v1/messages</Code> itself.
              </p>
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

              <h3 className="pt-2 text-sm font-semibold text-foreground">
                Or use shell environment variables
              </h3>
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

              <h3 className="pt-2 text-sm font-semibold text-foreground">Model variables</h3>
              <ul className="space-y-2">
                <li>
                  <Code>ANTHROPIC_MODEL</Code> — the model used for new sessions.
                </li>
                <li>
                  <Code>ANTHROPIC_DEFAULT_OPUS_MODEL</Code>, <Code>ANTHROPIC_DEFAULT_SONNET_MODEL</Code>{" "}
                  and <Code>ANTHROPIC_DEFAULT_HAIKU_MODEL</Code> — what Claude Code sends when it
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
                  gateway prefers the Bearer token, so keep only <Code>AUTH_TOKEN</Code> to avoid a
                  stale value winning.
                </li>
              </ul>

              <h3 className="pt-2 text-sm font-semibold text-foreground">Verify</h3>
              <p>
                Run <Code>claude</Code>, then <Code>/status</Code> and check the{" "}
                <em className="italic text-foreground">Anthropic base URL</em> line. A request that
                fails with <Code>400</Code> and mentions experimental betas is fixed by setting{" "}
                <Code>CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1</Code>.
              </p>
            </DocSection>

            <DocSection id="codex-cli" title="Codex CLI">
              <p>
                Codex speaks the OpenAI Responses API. Add a provider to{" "}
                <Code>~/.codex/config.toml</Code> (Windows:{" "}
                <Code>%USERPROFILE%\.codex\config.toml</Code>):
              </p>
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
              <p>
                The key comes from an environment variable, never from the TOML file itself:
              </p>
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
            </DocSection>

            <DocSection id="cc-switch" title="CC Switch">
              <p>
                CC Switch stores and switches client configurations. It has two tabs, and both point
                at the same gateway.
              </p>

              <h3 className="text-sm font-semibold text-foreground">Claude Code tab</h3>
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

              <h3 className="pt-2 text-sm font-semibold text-foreground">Codex tab</h3>
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
                  OpenAI-compatible endpoint. For that, point the provider at your gateway root URL
                  (no <Code>/anthropic</Code>), choose{" "}
                  <Code>OpenAI Responses API (requires routing)</Code> and enable Local routing. You
                  do not need this for normal use — this gateway has a native Anthropic entry.
                </p>
              </details>
            </DocSection>

            <DocSection id="models" title="Models & verification">
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
                <Code>https://&lt;your-gateway&gt;/anthropic</Code> plus <Code>/v1/messages</Code>{" "}
                is the full path:
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
                model list from <Code>GET /v1/models</Code> is empty, no enabled provider lists any
                models — ask your admin.
              </p>
            </DocSection>

            <DocSection id="troubleshooting" title="Troubleshooting">
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
                      Use a name from the console&apos;s Models page (or <Code>GET /v1/models</Code>
                      ); for Claude Code, check the <Code>ANTHROPIC_DEFAULT_*</Code> variables.
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
                      <Code>/anthropic</Code>; Codex and the CC Switch Codex tab use{" "}
                      <Code>/v1</Code> (never omit it). No trailing slash.
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
                      Restart Claude Code, Codex, or the terminal session.
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </DocSection>

            <DocSection id="api" title="API endpoints">
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
                      Claude Code and the Anthropic SDK (base URL ends in <Code>/anthropic</Code>).
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
              <p>Every proxy request authenticates with either header:</p>
              <CodeBlock
                label="Authentication"
                code={`Authorization: Bearer sk-...
x-api-key: sk-...`}
              />
            </DocSection>
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
