# Changelog

All notable changes to TokiAPI are documented here. Format: Keep a Changelog; dates are UTC+8 release days.

## v0.1.1 — 2026-11-23

### Tokimeki integration (three-task batch)

- **`/tokimeki` hub redesigned as a 3-step wizard** — install (with skip-next-time cookie),
  host/attach step, and command step. Signed-in users get collapsible advanced options:
  session rename/regenerate, 6-digit passcode, window-size presets, browser access,
  viewer/listener mode, and share-link TTL presets (1h/8h/24h/7d). Anonymous flow unchanged
  (server-side anon TTL).
- **Multi-line shell scripts** — generated host/attach commands now set each `TOKIMEKI_*`
  variable on its own line (`export` / `$env:` / `set`) with the `tokimeki …` command on the
  last line, fixing pwsh/powershell/cmd parsing failures and silent argument swallowing in
  cmd. Config-mode (`TOKIMEKI_CONFIG` v2 envelope) uses per-shell quote-safe assignment.
- **`tokimeki-config.json` download** — step 3 offers the v2 `TOKIMEKI_CONFIG` envelope as a
  file download; the CLI accepts it as JSON input (passcode / window size included when set).
- **Attach step split into two methods** — link redemption (single Link input) above a
  divider, manual Session + Token below; unified mono font and example placeholders across
  the three manual inputs.
- **Share message copy** — "Copy share message" in Session details copies an English
  join note with the invite link, session name, and token.
- **Collapsible state indicators** — every option collapsible shows a ▼/▲ triangle.
- **Console pages redesigned as card lists** — `/tokimeki/sessions` and `/tokimeki/tokens`
  replace tables with mobile-first cards; dialogs use the wizard's segment/switch/command-block
  controls. Shared Switch resized to 44×24 (WCAG 2.5.8 pointer target).
- **Web viewer** — fixed-window (`display.fixed`) scaling, tab-scoped passcode memory, mobile
  control pad (2×6 portrait / 1×12 landscape) with latched modifiers, soft-keyboard toggle with
  buffered composer, fit-screen toggle for portrait horizontal scrolling, English-only mobile
  terminal UI; TUI/reflow e2e cases added.

### Fixed

- Signing in from the hub now returns to `/tokimeki` (redirect state) instead of the dashboard.
- Cross-flow result leak: generating attach no longer shows the previous host result card.
- Command block restyled per `/keys` CopyBlock: icon-only copy floating top-right, single-line
  horizontal scroll (removes tall wrapped blocks).
- Attach passcode is validated per shell safety only (relay accepts arbitrary values), not the
  6-digit shape.

### Internal

- Staging deployment updated (`cf-ai-gateway-staging`); production deployed via the
  `wrangler.prod.jsonc` fork through `scripts/deploy.mjs`.
- Local Playwright audits (wizard + console, 3 viewports, anon/signed-in) and staging/production
  live e2e smoke (20/20) recorded per task in `.trellis/tasks/archive/2026-11/`.
