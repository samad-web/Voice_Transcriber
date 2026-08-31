import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * Refuses to let a tenant-configured URL (a CRM connector endpoint, a
 * webhook) point the server at itself or at internal infrastructure —
 * loopback, private ranges, link-local (which includes every cloud
 * provider's 169.254.169.254 metadata endpoint), and carrier-grade NAT.
 *
 * An org admin can type any URL into a "custom CRM" or webhook field, and
 * that request is then made FROM the API/worker host. Without this check,
 * that field is a general-purpose SSRF primitive against our own network.
 *
 * This resolves the hostname and checks the actual address, not just the
 * literal string, so `attacker.example.com` pointed at `10.0.0.5` is caught
 * too. It does not defend against DNS being repointed between this check and
 * the real request (rebinding) — closing that fully would mean pinning the
 * checked IP for the fetch itself, which is a larger change than this pass
 * warrants; this closes the case that matters today, a directly-configured
 * internal address.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`unsupported URL scheme: ${url.protocol}`);
  }

  // `URL#hostname` keeps the brackets around an IPv6 literal ("[::1]") — and
  // `net.isIP` does not recognise the bracketed form, returning 0 as if it
  // were a hostname. Stripped here once so every check below sees the same
  // bare address `net.isIP`/`dns.lookup` expect; a real hostname never has
  // brackets, so this is a no-op for one.
  const hostname = url.hostname.replace(/^\[(.+)\]$/, "$1");
  if (hostname.toLowerCase() === "localhost") {
    throw new Error("refusing to send to localhost");
  }

  const literal = isIP(hostname);
  if (literal === 4) {
    if (isBlockedIpv4(hostname)) {
      throw new Error(`refusing to send to a private/internal address: ${hostname}`);
    }
    return;
  }
  if (literal === 6) {
    if (isBlockedIpv6(hostname)) {
      throw new Error(`refusing to send to a private/internal address: ${hostname}`);
    }
    return;
  }

  // A hostname, not a literal — resolve every address it maps to and check
  // each one, since a DNS record can list several.
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error(`could not resolve host: ${hostname}`);
  }
  for (const { address, family } of addresses) {
    if (family === 4 && isBlockedIpv4(address)) {
      throw new Error(`refusing to send to a private/internal address: ${hostname} resolves to ${address}`);
    }
    if (family === 6 && isBlockedIpv6(address)) {
      throw new Error(`refusing to send to a private/internal address: ${hostname} resolves to ${address}`);
    }
  }
}

const IPV4_BLOCKED_RANGES: Array<{ base: [number, number, number, number]; bits: number }> = [
  { base: [0, 0, 0, 0], bits: 8 }, // "this network"
  { base: [10, 0, 0, 0], bits: 8 }, // private
  { base: [100, 64, 0, 0], bits: 10 }, // carrier-grade NAT
  { base: [127, 0, 0, 0], bits: 8 }, // loopback
  { base: [169, 254, 0, 0], bits: 16 }, // link-local — includes the cloud metadata IP
  { base: [172, 16, 0, 0], bits: 12 }, // private
  { base: [192, 168, 0, 0], bits: 16 }, // private
  { base: [224, 0, 0, 0], bits: 4 }, // multicast
  { base: [240, 0, 0, 0], bits: 4 }, // reserved
];

function ipv4ToInt(octets: readonly number[]): number {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // couldn't parse it — refuse rather than guess
  }
  const asInt = ipv4ToInt(octets);
  return IPV4_BLOCKED_RANGES.some(({ base, bits }) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (asInt & mask) === (ipv4ToInt(base) & mask);
  });
}

function isBlockedIpv6(address: string): boolean {
  const a = address.toLowerCase();
  if (a === "::1" || a === "::") return true; // loopback / unspecified
  if (a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (a.startsWith("fc") || a.startsWith("fd")) return true; // unique local fc00::/7
  if (a.startsWith("::ffff:")) {
    // IPv4-mapped address — judge it by the embedded v4 address.
    const embedded = a.slice("::ffff:".length);
    return isIP(embedded) === 4 ? isBlockedIpv4(embedded) : true;
  }
  return false;
}
