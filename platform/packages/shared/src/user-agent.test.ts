import { describe, expect, it } from "vitest";
import { UNKNOWN_BROWSER, describeUserAgent } from "./user-agent";

/** Real User-Agent strings, as the browsers send them. */
const FIXTURES: ReadonlyArray<[string, string]> = [
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Chrome on Windows",
  ],
  [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42",
    "Edge on Windows",
  ],
  ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on Windows"],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    "Safari on macOS",
  ],
  [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Chrome on macOS",
  ],
  ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox on macOS"],
  [
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.88 Mobile Safari/537.36",
    "Chrome on Android",
  ],
  [
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    "Samsung Internet on Android",
  ],
  ["Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0", "Firefox on Android"],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    "Safari on iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.6613.98 Mobile/15E148 Safari/604.1",
    "Chrome on iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15",
    "Firefox on iOS",
  ],
  [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/128.0 Mobile/15E148 Safari/605.1.15",
    "Edge on iOS",
  ],
  [
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0",
    "Opera on Linux",
  ],
];

describe("describeUserAgent", () => {
  it.each(FIXTURES)("describes %s", (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });

  it("says Unknown browser for nothing it recognises", () => {
    expect(describeUserAgent(null)).toBe(UNKNOWN_BROWSER);
    expect(describeUserAgent("")).toBe(UNKNOWN_BROWSER);
    expect(describeUserAgent("curl/8.4.0")).toBe(UNKNOWN_BROWSER);
  });

  it("names the system alone when the browser is unknown", () => {
    expect(describeUserAgent("SomeApp/1.0 (Windows NT 10.0)")).toBe("Browser on Windows");
  });
});
