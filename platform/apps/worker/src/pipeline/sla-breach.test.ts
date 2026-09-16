import { describe, expect, it } from "vitest";

import { formatSla } from "./sla-breach";

describe("formatSla", () => {
  it("names the SLA the way a person would say it", () => {
    expect(formatSla(5)).toBe("5 minutes");
    expect(formatSla(1)).toBe("1 minute");
    expect(formatSla(60)).toBe("1 hour");
    expect(formatSla(90)).toBe("1 h 30 min");
    expect(formatSla(1440)).toBe("24 hours");
  });
});
