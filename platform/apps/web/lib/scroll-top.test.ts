import { describe, expect, it } from "vitest";
import { scrollDecision, type ScrollInput } from "./scroll-top";

/**
 * Where a console screen starts.
 *
 * The reported bug was the operator console "anchoring down" when an option is
 * chosen: both consoles render their tab strip in the layout, so a tab change
 * moves only the `children` segment and the App Router scrolls THAT into view
 * rather than the page. The fix forces the top - and the three cases below are
 * the ones a blunt `window.scrollTo(0, 0)` would have broken, which is the
 * whole reason the decision is a function and not a line in an effect.
 */

const at = (over: Partial<ScrollInput> = {}): ScrollInput => ({
  key: "/instances/abc/calls",
  previous: "/instances/abc",
  hash: "",
  viaHistory: false,
  ...over,
});

describe("scrollDecision", () => {
  it("goes to the top when a new page is chosen", () => {
    expect(scrollDecision(at())).toBe("top");
  });

  it("goes to the top on the first paint - a reload or a deep link", () => {
    expect(scrollDecision(at({ previous: null }))).toBe("top");
  });

  it("goes to the top when only the query changes, which is a new list", () => {
    expect(
      scrollDecision(at({ previous: "/owner/leads?status=open", key: "/owner/leads?status=won" })),
    ).toBe("top");
  });

  it("leaves the page alone when nothing moved", () => {
    const key = "/owner/leads?status=open";
    expect(scrollDecision(at({ key, previous: key }))).toBe("leave");
  });

  it("keeps the reader's place on Back and Forward", () => {
    // Landing at the top of a list somebody had scrolled halfway down, after
    // opening one row and pressing Back, is losing their place - not the
    // "choosing an option" this feature is about.
    expect(scrollDecision(at({ viaHistory: true }))).toBe("leave");
  });

  it("honours an anchored link, with or without the #", () => {
    // /instances/<id>/devices#enrollment is linked from two places in the
    // operator console and the section carries scroll-mt to clear the sticky
    // strip. Forcing the top would break every such link silently.
    expect(scrollDecision(at({ hash: "#enrollment" }))).toBe("leave");
    expect(scrollDecision(at({ hash: "enrollment" }))).toBe("leave");
  });

  it("ignores an empty fragment - a bare # is not a destination", () => {
    expect(scrollDecision(at({ hash: "#" }))).toBe("top");
  });

  it("honours an anchor on the first paint too", () => {
    // A pasted anchored URL is the case where the fragment is the ONLY thing
    // the reader asked for.
    expect(scrollDecision(at({ previous: null, hash: "#enrollment" }))).toBe("leave");
  });
});
