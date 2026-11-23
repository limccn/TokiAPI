// Web viewer display negotiation: resolve the host's fixed logical grid from the
// relay's welcome/presence `clients[]` echo.
import { describe, expect, it } from "vitest";
import {
  computeFixedLayout,
  resolveHostFixed,
} from "../app/modules/tokimeki/viewer/display";

describe("resolveHostFixed", () => {
  it("returns null for legacy or malformed client lists", () => {
    expect(resolveHostFixed(undefined)).toBeNull();
    expect(resolveHostFixed(null)).toBeNull();
    expect(resolveHostFixed({})).toBeNull();
    expect(resolveHostFixed([])).toBeNull();
    expect(resolveHostFixed([{ role: "host" }])).toBeNull();
    expect(resolveHostFixed([{ role: "host", capabilities: {} }])).toBeNull();
  });

  it("reads display.fixed from the host entry", () => {
    expect(
      resolveHostFixed([
        { role: "viewer", capabilities: { display: { modes: ["viewport"] } } },
        { role: "host", capabilities: { display: { modes: ["fixed-grid"], fixed: { cols: 120, rows: 40 } } } },
      ]),
    ).toEqual({ cols: 120, rows: 40 });
  });

  it("prefers the host entry over an earlier fallback", () => {
    expect(
      resolveHostFixed([
        { role: "observer", capabilities: { display: { fixed: { cols: 80, rows: 24 } } } },
        { role: "host", capabilities: { display: { fixed: { cols: 120, rows: 40 } } } },
      ]),
    ).toEqual({ cols: 120, rows: 40 });
  });

  it("falls back to any client with display.fixed when role is missing", () => {
    expect(
      resolveHostFixed([{ capabilities: { display: { fixed: { cols: 100, rows: 30 } } } }]),
    ).toEqual({ cols: 100, rows: 30 });
  });

  it("ignores invalid fixed sizes", () => {
    expect(
      resolveHostFixed([
        { role: "host", capabilities: { display: { fixed: { cols: 0, rows: 40 } } } },
        { role: "viewer", capabilities: { display: { fixed: { cols: "120", rows: 40 } } } },
      ]),
    ).toBeNull();
  });
});

describe("computeFixedLayout", () => {
  it("never upscales a grid that already fits", () => {
    expect(computeFixedLayout(1200, 800, 840, 600)).toEqual({ scale: 1 });
  });

  it("shrinks uniformly to fit the limiting axis", () => {
    expect(computeFixedLayout(600, 400, 840, 600)).toEqual({
      scale: 400 / 600,
    });
  });

  it("does not enlarge a very small grid", () => {
    expect(computeFixedLayout(1000, 1000, 100, 100)).toEqual({ scale: 1 });
  });

  it("returns null for unusable dimensions", () => {
    expect(computeFixedLayout(0, 400, 840, 600)).toBeNull();
    expect(computeFixedLayout(600, 0, 840, 600)).toBeNull();
    expect(computeFixedLayout(600, 400, 0, 600)).toBeNull();
    expect(computeFixedLayout(Number.NaN, 400, 840, 600)).toBeNull();
  });
});
