import { describe, expect, it } from "vitest";
import {
  buildUpstreamHeaders,
  type UpstreamTarget,
} from "../src/routes/tokimeki/public/ws-headers";

const TARGET: UpstreamTarget = {
  url: "https://relay.example/ws/session",
  sessionJwt: "session-jwt",
  listener: false,
};

describe("buildUpstreamHeaders", () => {
  it("forwards the trusted client IP as x-real-ip", () => {
    const headers = buildUpstreamHeaders(TARGET, null, "203.0.113.10");
    expect(headers.get("x-real-ip")).toBe("203.0.113.10");
    expect(headers.get("x-tokimeki-session")).toBe("session-jwt");
    expect(headers.get("x-tokimeki-passcode")).toBeNull();
  });

  it("omits x-real-ip when the edge did not provide a client IP", () => {
    const headers = buildUpstreamHeaders(TARGET, "passcode", null);
    expect(headers.get("x-real-ip")).toBeNull();
    expect(headers.get("x-tokimeki-passcode")).toBe("passcode");
  });

  it("adds the listener header only for listener targets", () => {
    const listener = buildUpstreamHeaders({ ...TARGET, listener: true }, null, null);
    expect(listener.get("x-tokimeki-listener")).toBe("1");
    expect(buildUpstreamHeaders(TARGET, null, null).get("x-tokimeki-listener")).toBeNull();
  });

  it("never trusts an arbitrary client-supplied x-real-ip", () => {
    // The helper only accepts the explicit trusted clientIp argument; it does
    // not merge a caller-provided header bag. A malicious browser cannot set
    // cf-connecting-ip, so relay counting stays on the real IP.
    const headers = buildUpstreamHeaders(TARGET, null, null);
    expect(headers.get("x-real-ip")).toBeNull();
  });
});
