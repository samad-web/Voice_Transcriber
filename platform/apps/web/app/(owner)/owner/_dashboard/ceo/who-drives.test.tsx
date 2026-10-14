/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actorPalette } from "./actor-colors";
import { WhoDrives, type DriverCard } from "./who-drives";

/**
 * THE ATTRIBUTION DONUTS CAN BE HOVERED, AND SAY WHAT THEY ARE.
 *
 * ── WHY THIS NEEDS A DOM ────────────────────────────────────────────────────
 *
 * The tooltips are CSS-only - an HTML box shown by `group-hover`, the same
 * contract every other chart on this dashboard keeps so a chart paints
 * complete in the server HTML and never pops in after hydration. There is no
 * state to assert and no handler to call: the only question is whether the
 * markup is THERE, correctly paired with its wedge, and a node-environment
 * test could only re-assert its own mocks.
 *
 * The wedge GEOMETRY is pinned separately in `lib/ceo-dashboard.test.ts`,
 * because a transparent path that is a quarter-turn off looks identical and
 * simply shows the wrong slice's tooltip.
 */

const PALETTE = actorPalette([{ id: "a" }, { id: "b" }]);

const CARD: DriverCard = {
  key: "calls",
  title: "Calls made",
  centre: "341",
  centreUnit: "calls",
  slices: [
    { id: "a", name: "brindha", value: 320, fraction: 0.94 },
    { id: "b", name: "SM-E075F", value: 11, fraction: 0.03 },
    { id: "__unattributed", name: "Unattributed", value: 10, fraction: 0.03, unattributed: true },
  ],
  attributable: true,
  format: (v) => v.toLocaleString(),
  insight: "One person carries the floor.",
};

let host: HTMLDivElement;
let root: Root;

function render(cards: readonly DriverCard[]) {
  act(() => {
    root.render(
      <WhoDrives
        cards={cards}
        palette={PALETTE}
        legend={[
          { id: "a", name: "brindha" },
          { id: "b", name: "SM-E075F" },
        ]}
        clock="30d"
      />,
    );
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("hovering a slice", () => {
  it("gives every slice a wedge and a tooltip", () => {
    render([CARD]);
    // One transparent wedge per slice, over the ring.
    const wedges = host.querySelectorAll('path[fill="transparent"]');
    expect(wedges).toHaveLength(CARD.slices.length);
    // And each one is inside a `group`, which is what `group-hover` needs -
    // the tooltip must be a DESCENDANT of whatever is hovered.
    for (const wedge of wedges) {
      expect(wedge.closest(".group")).not.toBeNull();
    }
  });

  it("names the person and their share, with the raw value under it", () => {
    render([CARD]);
    const groups = [...host.querySelectorAll(".group")].filter((g) =>
      g.querySelector('path[fill="transparent"]'),
    );
    expect(groups).toHaveLength(3);
    const first = groups[0]!.textContent ?? "";
    expect(first).toContain("brindha");
    expect(first).toContain("94%");
    // The raw value answers the follow-up question without a second hover.
    expect(first).toContain("320");
    expect(first).toContain("calls");
  });

  it("explains the Unattributed slice rather than leaving it a mystery grey", () => {
    render([CARD]);
    const text = host.textContent ?? "";
    // The slice that most needs a tooltip: a grey wedge with no name on it
    // reads as a rendering fault, not as a measurement.
    expect(text).toContain("No handset or owner on these");
  });

  it("is hidden until hover, and hidden entirely on a touch screen", () => {
    render([CARD]);
    const tip = host.querySelector(".group span.invisible");
    expect(tip).not.toBeNull();
    const cls = tip!.className;
    // `invisible` LAYS OUT the box; on a phone these are w-max and absolutely
    // positioned, which is how a hidden tooltip once pushed the document wider
    // than the viewport. A coarse pointer cannot hover anyway.
    expect(cls).toContain("pointer-coarse:hidden");
    expect(cls).toContain("group-hover:visible");
    expect(cls).toContain("pointer-events-none");
  });

  it("opens inward at the edges so it never leaves the card", () => {
    render([CARD]);
    const tips = [...host.querySelectorAll("span.invisible")].map((t) => t.className);
    expect(tips.some((c) => c.includes("left-0"))).toBe(true);
    expect(tips.some((c) => c.includes("right-0"))).toBe(true);
  });
});

describe("what the donut still does without hover", () => {
  it("keeps the centre total and the direct-labelled legend", () => {
    // The tooltip is an addition, not a replacement: the donut must never have
    // to be read by colour alone, and a touch reader never sees a tooltip.
    render([CARD]);
    const text = host.textContent ?? "";
    expect(text).toContain("341");
    expect(text).toContain("brindha");
    expect(text).toContain("94%");
  });

  it("still ships the table twin", () => {
    render([CARD]);
    expect(host.querySelector("table")).not.toBeNull();
    expect(host.querySelector("caption")?.textContent).toContain("Calls made");
  });

  it("renders no wedges for a card with nothing in it", () => {
    render([{ ...CARD, slices: [] }]);
    expect(host.querySelectorAll('path[fill="transparent"]')).toHaveLength(0);
    expect(host.textContent).toContain("Nothing in this window");
  });

  it("says so when a measure cannot be attributed at all", () => {
    render([{ ...CARD, attributable: false, slices: [] }]);
    expect(host.textContent).toContain("cannot attribute");
  });
});
