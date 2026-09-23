import { describe, expect, it } from "vitest";
import { pageHref, pageState, pageWindow, parsePageInput } from "./pagination";

describe("pageWindow", () => {
  it("lists every page when there are seven or fewer", () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageWindow(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the first, the last and the current page's neighbours past that", () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pageWindow(5, 20)).toEqual([1, "gap", 4, 5, 6, "gap", 20]);
    expect(pageWindow(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
    expect(pageWindow(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
    expect(pageWindow(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });

  it("is always seven slots wide once it truncates, so the buttons never shift under the pointer", () => {
    for (let pages = 8; pages <= 40; pages++) {
      for (let at = 1; at <= pages; at++) {
        const slots = pageWindow(at, pages);
        expect(slots).toHaveLength(7);
        // The current page is always on screen, as are both ends.
        expect(slots).toContain(at);
        expect(slots[0]).toBe(1);
        expect(slots[6]).toBe(pages);
      }
    }
  });

  it("never offers a gap that hides nothing", () => {
    for (let pages = 8; pages <= 40; pages++) {
      for (let at = 1; at <= pages; at++) {
        const slots = pageWindow(at, pages);
        slots.forEach((slot, i) => {
          if (slot !== "gap") return;
          const before = slots[i - 1] as number;
          const after = slots[i + 1] as number;
          expect(after - before).toBeGreaterThan(1);
        });
      }
    }
  });

  it("clamps a page outside the range instead of inventing pages", () => {
    expect(pageWindow(0, 3)).toEqual([1, 2, 3]);
    expect(pageWindow(99, 10)).toEqual([1, "gap", 6, 7, 8, 9, 10]);
  });
});

describe("pageState", () => {
  it("says which rows are showing", () => {
    expect(pageState(134, 50, 0)).toEqual({ pages: 3, current: 1, first: 1, last: 50 });
    expect(pageState(134, 50, 100)).toEqual({ pages: 3, current: 3, first: 101, last: 134 });
  });

  it("has one page, showing nothing, when the list is empty", () => {
    expect(pageState(0, 50, 0)).toEqual({ pages: 1, current: 1, first: 0, last: 0 });
  });

  it("does not report a page past the end for a stale offset", () => {
    expect(pageState(34, 50, 500).current).toBe(1);
  });
});

describe("parsePageInput", () => {
  it("reads a page number and keeps it in range", () => {
    expect(parsePageInput("4", 9)).toBe(4);
    expect(parsePageInput(" 12 ", 9)).toBe(9);
    expect(parsePageInput("0", 9)).toBe(1);
    expect(parsePageInput("-3", 9)).toBe(1);
  });

  it("is null for something that is not a number", () => {
    expect(parsePageInput("", 9)).toBeNull();
    expect(parsePageInput("next", 9)).toBeNull();
  });
});

describe("pageHref", () => {
  it("keeps the list's other parameters and sets the offset", () => {
    expect(pageHref("/owner/calls", "state=failed&period=last7", 3, 50)).toBe(
      "/owner/calls?state=failed&period=last7&offset=100",
    );
  });

  it("gives page 1 a single address, with no offset at all", () => {
    expect(pageHref("/owner/calls", "offset=100&sort=oldest", 1, 50)).toBe("/owner/calls?sort=oldest");
    expect(pageHref("/owner/calls", "offset=50", 1, 50)).toBe("/owner/calls");
  });
});
