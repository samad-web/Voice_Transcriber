import { describe, expect, it } from "vitest";
import { clientIpFrom } from "./client-ip";

const h = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });

describe("clientIpFrom", () => {
  it("takes the right-most hop - the one the proxy itself appended", () => {
    // A client that sent its own X-Forwarded-For: nginx appends the real peer.
    expect(clientIpFrom(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });

  it("ignores a client-supplied X-Real-IP entirely", () => {
    // Caddy passes X-Real-IP through untouched, so it is never read.
    expect(clientIpFrom(h({ "x-real-ip": "6.6.6.6", "x-forwarded-for": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "x-real-ip": "6.6.6.6" }))).toBeNull();
  });

  it("unwraps an IPv4-mapped IPv6 address and keeps real IPv6", () => {
    expect(clientIpFrom(h({ "x-forwarded-for": "::ffff:203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIpFrom(h({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
  });

  it("returns null for nothing, or for something that is not an address", () => {
    expect(clientIpFrom(h({}))).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": " , " }))).toBeNull();
    expect(clientIpFrom(h({ "x-forwarded-for": "1.2.3.4, <script>" }))).toBeNull();
  });
});
