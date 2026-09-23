/**
 * "Chrome on Windows" from a raw User-Agent header (doc 27 §5.4).
 *
 * In-repo and deliberately small rather than a UA-parsing dependency: the Login
 * activity page needs a browser and an OS family so a person can recognise
 * their own laptop, not a device database. The raw string is stored in full
 * (to 512 characters), so nothing is lost by describing it coarsely here.
 *
 * ORDER MATTERS. Every Chromium browser also says "Chrome" and "Safari", and
 * Chrome on iOS says "Safari" but not "Chrome" - so the specific brands are
 * tested before the generic engines, and Safari last of all.
 */

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  // iPadOS 13+ claims to be a Mac; there is no reliable way to tell from the
  // header alone, and "Safari on macOS" for an iPad is the honest mistake.
  [/\biPhone\b|\biPad\b|\biPod\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

export const UNKNOWN_BROWSER = "Unknown browser";

export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return UNKNOWN_BROWSER;
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? null;
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? null;
  if (browser && system) return `${browser} on ${system}`;
  if (browser) return browser;
  if (system) return `Browser on ${system}`;
  return UNKNOWN_BROWSER;
}
