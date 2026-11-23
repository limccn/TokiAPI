// Host display capability parsing for the web viewer.
//
// Pure data/logic with no DOM or WebSocket dependency so it can be unit-tested
// in the Workers test pool and reused by the client.
export interface DisplayFixedSize {
  readonly cols: number;
  readonly rows: number;
}

export interface DisplayInfo {
  /**
   * Host declared a session-level fixed logical grid (`display.fixed`). In this
   * mode the host ignores viewer resizes, so the viewer must render exactly this
   * many cols/rows and scale the grid into its own viewport.
   */
  readonly fixed: DisplayFixedSize | null;
}

interface WireClient {
  readonly role?: unknown;
  readonly capabilities?: {
    readonly display?: {
      readonly fixed?: unknown;
    };
  };
}

function isFixedSize(value: unknown): value is DisplayFixedSize {
  if (typeof value !== "object" || value === null) return false;
  const cols = (value as { cols?: unknown }).cols;
  const rows = (value as { rows?: unknown }).rows;
  return typeof cols === "number" && typeof rows === "number" && cols >= 1 && rows >= 1;
}

/**
 * Resolve the host's fixed logical grid from a relay `clients[]` array
 * (`welcome.clients` / `presence.clients`). Prefers a client with
 * `role === "host"`; falls back to any client advertising `display.fixed` so a
 * relay that omits role still works. Returns null for legacy sessions.
 */
export interface FixedLayout {
  /** Uniform scale applied to the fixed grid (never above 1). */
  readonly scale: number;
}

/**
 * Fit a fixed logical grid into the available viewport without changing the
 * grid: shrink uniformly when needed and never upscale. Centering is done by
 * the viewport's flex layout, so only the scale is returned.
 * Returns null when any dimension is unusable (e.g. a hidden container).
 */
export function computeFixedLayout(
  availWidth: number,
  availHeight: number,
  gridWidth: number,
  gridHeight: number,
): FixedLayout | null {
  if (
    !Number.isFinite(availWidth) ||
    !Number.isFinite(availHeight) ||
    !Number.isFinite(gridWidth) ||
    !Number.isFinite(gridHeight) ||
    availWidth <= 0 ||
    availHeight <= 0 ||
    gridWidth <= 0 ||
    gridHeight <= 0
  ) {
    return null;
  }
  return {
    scale: Math.min(availWidth / gridWidth, availHeight / gridHeight, 1),
  };
}

export function resolveHostFixed(clients: unknown): DisplayFixedSize | null {
  if (!Array.isArray(clients)) return null;
  let fallback: DisplayFixedSize | null = null;
  for (const entry of clients) {
    if (typeof entry !== "object" || entry === null) continue;
    const client = entry as WireClient;
    const fixed = client.capabilities?.display?.fixed;
    if (!isFixedSize(fixed)) continue;
    if (client.role === "host") return { cols: fixed.cols, rows: fixed.rows };
    if (fallback === null) fallback = { cols: fixed.cols, rows: fixed.rows };
  }
  return fallback;
}
