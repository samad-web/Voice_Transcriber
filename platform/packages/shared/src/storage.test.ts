import { describe, expect, it } from "vitest";
import {
  bytesToGb,
  daysUntilQuota,
  formatBytes,
  gbToBytes,
  storageAlertLevel,
  storagePercent,
  storageUsedBytes,
  type StorageSummary,
} from "./storage";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function summary(over: Partial<StorageSummary> = {}): StorageSummary {
  return {
    recordingBytes: 0,
    recordingCount: 0,
    dbBytesEstimate: null,
    quotaBytes: null,
    computedAt: "2026-09-21T00:00:00.000Z",
    retentionDays: 90,
    ...over,
  };
}

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [-5, "0 B"],
    [Number.NaN, "0 B"],
    [1023, "1023 B"],
    [1024, "1 KB"],
    [1.5 * MB, "1.5 MB"],
    [740 * MB, "740 MB"],
    [3.2 * GB, "3.2 GB"],
    [10 * GB, "10 GB"],
    // Rounds before choosing precision: never "10.0 GB".
    [9.96 * GB, "10 GB"],
  ])("formats %d as %s", (n, text) => {
    expect(formatBytes(n)).toBe(text);
  });

  it("says GB, never GiB", () => {
    expect(formatBytes(5 * GB)).not.toMatch(/iB/);
  });
});

describe("the quota input and the meter share one factor", () => {
  it("round-trips 10 GB exactly", () => {
    expect(gbToBytes(10)).toBe(10 * GB);
    expect(formatBytes(gbToBytes(10))).toBe("10 GB");
    expect(bytesToGb(10 * GB)).toBe(10);
  });
});

describe("storageUsedBytes / storagePercent", () => {
  it("adds the database estimate only when there is one", () => {
    expect(storageUsedBytes(summary({ recordingBytes: 5 }))).toBe(5);
    expect(storageUsedBytes(summary({ recordingBytes: 5, dbBytesEstimate: 7 }))).toBe(12);
  });

  it("is null without a quota", () => {
    expect(storagePercent(summary({ recordingBytes: GB }))).toBeNull();
  });

  it("does not clamp above 100 - the operator needs to see 130 %", () => {
    expect(storagePercent(summary({ recordingBytes: 13 * GB, quotaBytes: 10 * GB }))).toBeCloseTo(130);
  });

  it("is a plain percentage under the quota", () => {
    expect(storagePercent(summary({ recordingBytes: 5 * GB, quotaBytes: 10 * GB }))).toBe(50);
  });
});

describe("storageAlertLevel", () => {
  it("fires at 80 and at 100, and nowhere else", () => {
    expect(storageAlertLevel(null)).toBeNull();
    expect(storageAlertLevel(79.9)).toBeNull();
    expect(storageAlertLevel(80)).toBe(80);
    expect(storageAlertLevel(99)).toBe(80);
    expect(storageAlertLevel(100)).toBe(100);
    expect(storageAlertLevel(250)).toBe(100);
  });
});

describe("daysUntilQuota", () => {
  it("projects from 30-day growth", () => {
    // 6 GB left, growing 3 GB a month -> 60 days.
    expect(daysUntilQuota(summary({ recordingBytes: 4 * GB, quotaBytes: 10 * GB }), 3 * GB)).toBe(60);
  });

  it("says nothing past 120 days, without a quota, or without growth", () => {
    expect(daysUntilQuota(summary({ recordingBytes: GB, quotaBytes: 100 * GB }), GB)).toBeNull();
    expect(daysUntilQuota(summary({ recordingBytes: GB }), GB)).toBeNull();
    expect(daysUntilQuota(summary({ recordingBytes: GB, quotaBytes: 10 * GB }), 0)).toBeNull();
  });

  it("is zero once the quota is already reached", () => {
    expect(daysUntilQuota(summary({ recordingBytes: 11 * GB, quotaBytes: 10 * GB }), GB)).toBe(0);
  });
});
