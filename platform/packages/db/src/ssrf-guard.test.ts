import { afterEach, describe, expect, it, vi } from "vitest";
import { assertPublicHttpUrl } from "./ssrf-guard";

/**
 * A tenant types this URL into a CRM connector or webhook field, and it is
 * then fetched FROM our own servers — so the one property that matters is
 * that every address an attacker could reach our own network through is
 * refused, while a normal public receiver still goes through. DNS resolution
 * is mocked rather than exercised for real: a test that depends on what a
 * live hostname resolves to today is a test that silently rots.
 */

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("assertPublicHttpUrl", () => {
  it("rejects a malformed URL", async () => {
    await expect(assertPublicHttpUrl("not a url")).rejects.toThrow(/not a valid URL/);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow(/unsupported URL scheme/);
    await expect(assertPublicHttpUrl("ftp://example.com/x")).rejects.toThrow(/unsupported URL scheme/);
  });

  it("rejects the literal hostname localhost", async () => {
    await expect(assertPublicHttpUrl("http://localhost:9000/x")).rejects.toThrow(/localhost/);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private 10/8", "10.1.2.3"],
    ["private 172.16/12", "172.16.5.1"],
    ["private 192.168/16", "192.168.1.1"],
    // The address every cloud provider's instance-metadata service listens on.
    ["link-local / cloud metadata", "169.254.169.254"],
    ["carrier-grade NAT", "100.64.0.1"],
    ["this network", "0.1.2.3"],
    ["multicast", "224.0.0.1"],
  ])("rejects an IPv4 literal in a blocked range (%s: %s)", async (_label, ip) => {
    await expect(assertPublicHttpUrl(`http://${ip}/webhook`)).rejects.toThrow(/private\/internal address/);
  });

  it("accepts a public IPv4 literal", async () => {
    await expect(assertPublicHttpUrl("http://8.8.8.8/webhook")).resolves.toBeUndefined();
  });

  it.each([
    ["loopback", "::1"],
    ["link-local", "fe80::1"],
    ["unique local", "fd12:3456::1"],
  ])("rejects an IPv6 literal in a blocked range (%s: %s)", async (_label, ip) => {
    await expect(assertPublicHttpUrl(`http://[${ip}]/webhook`)).rejects.toThrow(/private\/internal address/);
  });

  it("rejects an IPv4-mapped IPv6 literal pointing at a private address", async () => {
    await expect(assertPublicHttpUrl("http://[::ffff:10.0.0.1]/webhook")).rejects.toThrow(
      /private\/internal address/,
    );
  });

  it("resolves the hostname and rejects when it maps to a private address", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertPublicHttpUrl("http://attacker.example.com/webhook")).rejects.toThrow(
      /resolves to 10\.0\.0\.5/,
    );
  });

  it("resolves the hostname and accepts it when every address is public", async () => {
    lookupMock.mockResolvedValue([
      { address: "203.0.113.10", family: 4 },
      { address: "2001:db8::1", family: 6 },
    ]);
    await expect(assertPublicHttpUrl("https://crm.example.com/webhook")).resolves.toBeUndefined();
  });

  it("rejects when the hostname cannot be resolved at all", async () => {
    lookupMock.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(assertPublicHttpUrl("http://no-such-host.invalid/webhook")).rejects.toThrow(
      /could not resolve host/,
    );
  });
});
