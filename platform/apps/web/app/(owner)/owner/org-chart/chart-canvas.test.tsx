/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartCanvas } from "./chart-canvas";
import type { ChartNode } from "./types";

/**
 * The chart canvas's node states and keyboard navigation
 * (Build docs/org-chart-build-plan.md §15: "component tests for the node (all
 * states: filled, vacant, on leave, collapsed with count), keyboard
 * navigation, search auto-expand").
 *
 * ── WHY A DOM, AND WHAT IT IS ACTUALLY FOR ─────────────────────────────────
 *
 * Everything the canvas computes - where a node goes, which are collapsed,
 * which to reveal for a search - is in `@aura/shared` and tested there against
 * fixtures, with no DOM. What is left here is the part only a DOM can answer:
 * that the node renders the right SHAPE for each state, that the accessible
 * label carries §5.4's four facts, that the count badge is a real button, and
 * that an arrow key moves focus to the seat a reader would expect.
 *
 * `prefers-reduced-motion`, pan and zoom are deliberately not tested here: the
 * first is a CSS media query jsdom does not evaluate, and the other two are
 * pointer-capture gestures whose jsdom simulation would be testing the
 * simulation. They are checked by hand.
 */

const NODES: ChartNode[] = [
  node({ id: "ceo", title: "Chief Executive", holderName: "Asha Rao" }),
  node({ id: "sales", title: "Head of Sales", holderName: "Ravi Sharma", subtitle: "Commercial" }),
  node({ id: "ops", title: "Head of Operations", holderName: null, status: "vacant" }),
  node({ id: "rep1", title: "Sales Rep A", holderName: "Priya Nair", presence: "on_leave" }),
  node({ id: "rep2", title: "Sales Rep B", holderName: "Imran Qureshi", presence: "probation" }),
];

const SOLID = [
  { positionId: "sales", managerPositionId: "ceo" },
  { positionId: "ops", managerPositionId: "ceo" },
  { positionId: "rep1", managerPositionId: "sales" },
  { positionId: "rep2", managerPositionId: "sales" },
];

function node(over: {
  id: string;
  title: string;
  holderName: string | null;
  subtitle?: string | null;
  status?: ChartNode["status"];
  presence?: ChartNode["presence"];
}): ChartNode {
  return {
    id: over.id,
    title: over.title,
    sortOrder: 0,
    level: null,
    departmentId: null,
    departmentName: null,
    departmentColorTag: null,
    teamId: null,
    teamName: null,
    colorTag: null,
    status: over.status ?? "filled",
    subtitle: over.subtitle ?? null,
    holder: over.holderName
      ? {
          userId: `u-${over.id}`,
          name: over.holderName,
          email: `${over.id}@example.test`,
          startDate: "2026-01-01",
          tenureMonths: 9,
        }
      : null,
    acting: [],
    presence: over.presence ?? (over.holderName ? "active" : "vacant"),
  };
}

let host: HTMLDivElement;
let root: Root;

function render(props: Partial<React.ComponentProps<typeof ChartCanvas>> = {}) {
  act(() => {
    root.render(
      <ChartCanvas
        nodes={NODES}
        solidLines={SOLID}
        dottedLines={[]}
        collapsed={new Set()}
        onToggleCollapse={() => {}}
        selectedId={null}
        onSelect={() => {}}
        matches={new Set()}
        pathIds={new Set()}
        orientation="vertical"
        showDotted
        canMove={false}
        onRequestMove={() => {}}
        exportToken={0}
        exportFileName="chart.png"
        {...props}
      />,
    );
  });
}

const nodeFor = (id: string) => host.querySelector<SVGGElement>(`[data-position-id="${id}"]`);
const labelFor = (id: string) => nodeFor(id)?.getAttribute("aria-label") ?? "";

beforeEach(() => {
  // Same line field-validation.test.tsx opens with: without it React warns on
  // every `act()` and the suite's output is unreadable.
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  // jsdom gives every element a zero-sized box, so `fit()` computes a zoom of
  // 0 from clientWidth/clientHeight. Stubbing the frame's size keeps the
  // transform finite - the layout itself comes from the shared function and is
  // unaffected either way.
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { value: 1200, configurable: true });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { value: 800, configurable: true });
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the node, in each state", () => {
  it("draws every position as a focusable treeitem", () => {
    render();
    const items = host.querySelectorAll("[role='treeitem']");
    expect(items).toHaveLength(NODES.length);
    for (const item of items) expect(item.getAttribute("tabindex")).toBe("0");
    expect(host.querySelector("[role='tree']")).toBeTruthy();
  });

  it("puts name, position, status and report count in the accessible label (§5.4)", () => {
    render();
    const label = labelFor("sales");
    expect(label).toContain("Ravi Sharma");
    expect(label).toContain("Head of Sales");
    expect(label).toContain("Filled");
    expect(label).toContain("2 direct reports");
  });

  it("says 'no reports' rather than staying silent on a leaf", () => {
    // The fact that tells somebody they have reached the bottom. The visible
    // badge is absent at zero, so the label is the only place it can be.
    render();
    expect(labelFor("rep1")).toContain("0 direct reports");
  });

  it("names a vacant seat as vacant and draws it dashed, not just grey", () => {
    // §3.4: colour is never the only signal. A greyscale print or a
    // colour-blind reader has to be able to tell a vacancy apart.
    render();
    expect(labelFor("ops")).toContain("Vacant");
    const card = nodeFor("ops")?.querySelector("rect[stroke-dasharray]");
    expect(card).toBeTruthy();
  });

  it("shows a plus rather than initials on a vacant seat", () => {
    render();
    const text = [...(nodeFor("ops")?.querySelectorAll("text") ?? [])].map((t) => t.textContent);
    expect(text).toContain("+");
    expect(text).toContain("Vacant");
  });

  it("carries the holder's initials on a filled seat", () => {
    render();
    const text = [...(nodeFor("sales")?.querySelectorAll("text") ?? [])].map((t) => t.textContent);
    // First and last word - RS, never RK. The family name is what a colleague
    // scanning a chart recognises.
    expect(text).toContain("RS");
  });

  it("reports on-leave and probation in the label, not by colour alone", () => {
    render();
    expect(labelFor("rep1")).toContain("On leave");
    expect(labelFor("rep2")).toContain("On probation");
  });

  it("marks a collapsed node as collapsed and keeps its real count", () => {
    render({ collapsed: new Set(["sales"]) });
    const sales = nodeFor("sales");
    expect(sales?.getAttribute("aria-expanded")).toBe("false");
    expect(labelFor("sales")).toContain("2 direct reports");
    expect(labelFor("sales")).toContain("reports hidden");
    // The hidden subtree is not drawn at all - which is what makes collapsing
    // the answer to a large tree rather than a cosmetic fold.
    expect(nodeFor("rep1")).toBeNull();
    expect(nodeFor("rep2")).toBeNull();
  });

  it("gives a leaf no aria-expanded at all", () => {
    // `aria-expanded="false"` on something with nothing to expand tells a
    // screen-reader user there is hidden content when there is none.
    render();
    expect(nodeFor("rep1")?.hasAttribute("aria-expanded")).toBe(false);
  });

  it("offers the count badge as a button that says what it does", () => {
    render();
    const badge = nodeFor("sales")?.querySelector("[role='button']");
    expect(badge?.getAttribute("aria-label")).toBe("Hide the 2 positions under Head of Sales");
    render({ collapsed: new Set(["sales"]) });
    expect(nodeFor("sales")?.querySelector("[role='button']")?.getAttribute("aria-label")).toBe(
      "Show 2 positions under Head of Sales",
    );
  });

  it("gives a node with reports the highlight ring and a leaf none (§3)", () => {
    render();
    /**
     * Identified by its accent stroke rather than by counting circles - which
     * the first version of this did, and which counted the collapse badge's
     * circle too. A count is the wrong assertion for "is this specific
     * decoration present": it changes whenever anything else on the node does.
     */
    const ring = (id: string) =>
      [...(nodeFor(id)?.querySelectorAll("circle") ?? [])].filter(
        (c) => c.getAttribute("stroke") === "var(--color-accent)" && c.getAttribute("fill") === "none",
      );
    expect(ring("sales")).toHaveLength(1);
    expect(ring("rep1")).toHaveLength(0);
  });

  it("marks the selected node and its chain of command", () => {
    render({ selectedId: "rep1", pathIds: new Set(["rep1", "sales", "ceo"]) });
    expect(nodeFor("rep1")?.getAttribute("aria-selected")).toBe("true");
    expect(nodeFor("ops")?.getAttribute("aria-selected")).toBe("false");
    // The path is drawn on the EDGES, so the accent-stroked connectors are the
    // evidence - two of them, ceo→sales and sales→rep1.
    const accented = [...host.querySelectorAll("path")].filter(
      (p) => p.getAttribute("stroke") === "var(--color-accent)",
    );
    expect(accented).toHaveLength(2);
  });

  it("uses tokens for every fill and stroke, never a literal (§3)", () => {
    render();
    const painted = [...host.querySelectorAll<SVGElement>("rect, circle, path, text")];
    expect(painted.length).toBeGreaterThan(10);
    for (const element of painted) {
      for (const attribute of ["fill", "stroke"]) {
        const value = element.getAttribute(attribute);
        if (!value || value === "none" || value === "transparent") continue;
        // The one permitted non-token: a dashed vacancy outline falls back to
        // `transparent`, handled above. Everything else must be a var().
        expect([attribute, value]).toEqual([attribute, expect.stringContaining("var(--")]);
      }
    }
  });
});

describe("§5.4 keyboard navigation", () => {
  const press = (id: string, key: string) => {
    const element = nodeFor(id);
    act(() => {
      element?.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  };

  it("moves up the chain of command and down into the first report", () => {
    const onSelect = vi.fn();
    render({ onSelect });
    press("rep1", "ArrowUp");
    expect(onSelect).toHaveBeenLastCalledWith("sales");
    press("sales", "ArrowDown");
    expect(onSelect).toHaveBeenLastCalledWith("rep1");
  });

  it("moves between siblings with left and right", () => {
    const onSelect = vi.fn();
    render({ onSelect });
    press("rep1", "ArrowRight");
    expect(onSelect).toHaveBeenLastCalledWith("rep2");
    press("rep2", "ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("rep1");
  });

  it("does nothing at the edges rather than wrapping", () => {
    // Wrapping from the last sibling to the first would move the reader
    // somewhere they did not point at.
    const onSelect = vi.fn();
    render({ onSelect });
    press("ceo", "ArrowUp");
    press("rep2", "ArrowRight");
    press("rep1", "ArrowLeft");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("swaps the axes in the sideways view, so the keys match the screen", () => {
    const onSelect = vi.fn();
    render({ onSelect, orientation: "horizontal" });
    // Left is now "up" the tree, because that is where the parent is drawn.
    press("rep1", "ArrowLeft");
    expect(onSelect).toHaveBeenLastCalledWith("sales");
    press("rep1", "ArrowDown");
    expect(onSelect).toHaveBeenLastCalledWith("rep2");
  });

  it("will not walk into a collapsed subtree", () => {
    const onSelect = vi.fn();
    render({ onSelect, collapsed: new Set(["sales"]) });
    press("sales", "ArrowDown");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens with Enter and toggles with Space", () => {
    const onSelect = vi.fn();
    const onToggleCollapse = vi.fn();
    render({ onSelect, onToggleCollapse });
    press("sales", "Enter");
    expect(onSelect).toHaveBeenCalledWith("sales");
    press("sales", " ");
    expect(onToggleCollapse).toHaveBeenCalledWith("sales");
  });

  it("does not toggle a leaf with Space", () => {
    const onToggleCollapse = vi.fn();
    render({ onToggleCollapse });
    press("rep1", " ");
    expect(onToggleCollapse).not.toHaveBeenCalled();
  });
});

describe("dotted lines (§5.2)", () => {
  const dotted = [{ positionId: "ops", managerPositionId: "sales" }];

  it("draws a dashed edge when asked", () => {
    render({ dottedLines: dotted });
    const dashed = [...host.querySelectorAll("path")].filter((p) =>
      p.getAttribute("stroke-dasharray"),
    );
    expect(dashed).toHaveLength(1);
  });

  it("draws none when the toggle is off", () => {
    render({ dottedLines: dotted, showDotted: false });
    const dashed = [...host.querySelectorAll("path")].filter((p) =>
      p.getAttribute("stroke-dasharray"),
    );
    expect(dashed).toHaveLength(0);
  });

  it("draws none into a collapsed subtree, so no line ends in mid-air", () => {
    render({
      dottedLines: [{ positionId: "rep1", managerPositionId: "ops" }],
      collapsed: new Set(["sales"]),
    });
    const dashed = [...host.querySelectorAll("path")].filter((p) =>
      p.getAttribute("stroke-dasharray"),
    );
    expect(dashed).toHaveLength(0);
  });
});

describe("§14 drag-and-drop is owner/admin only", () => {
  it("attaches no drag handler when the reader may not move anything", () => {
    const onRequestMove = vi.fn();
    render({ canMove: false, onRequestMove });
    const card = nodeFor("sales")?.querySelector("rect:not([stroke-dasharray])");
    act(() => {
      // A plain Event, because jsdom implements no `PointerEvent` constructor.
      // React attaches its handler to the native `pointerdown` name either
      // way, so this is enough to prove no handler is attached.
      card?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    // Nothing is picked up, so the live region that narrates a drag is absent.
    expect(host.textContent).not.toContain("Drag onto the position");
    expect(onRequestMove).not.toHaveBeenCalled();
  });
});
