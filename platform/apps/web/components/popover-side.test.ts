import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Popover, type PopoverProps } from "@aura/ui";

/**
 * The kit Popover's `side` (doc 27 §2.1).
 *
 * The account menu's trigger sits at the foot of the sidebar, so its panel has
 * to open UPWARD. That is a prop on the kit rather than classes at the call
 * site because a caller's className does not reliably beat a base class (see
 * control-width.test.ts) - `bottom-full` passed beside a base `mt-2` would be
 * decided by stylesheet order, not intent. Pinned here so the four existing
 * callers, which never pass `side`, keep opening downward.
 */

function panelClasses(props: Partial<PopoverProps>): string[] {
  const html = renderToStaticMarkup(
    createElement(Popover, {
      open: true,
      onDismiss: () => undefined,
      trigger: createElement("button", { type: "button" }, "open"),
      children: createElement("p", null, "panel"),
      ...props,
    }),
  );
  // The panel is the second element with a class: the anchor comes first.
  const all = [...html.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
  const panel = all.find((c) => c.includes("z-50"));
  return panel ? panel.split(/\s+/) : [];
}

describe("Popover side", () => {
  it("opens downward by default, exactly as every existing caller expects", () => {
    const c = panelClasses({});
    expect(c).toContain("mt-2");
    expect(c).not.toContain("bottom-full");
    expect(c).not.toContain("mb-2");
  });

  it("opens upward with side=top", () => {
    const c = panelClasses({ side: "top" });
    expect(c).toContain("bottom-full");
    expect(c).toContain("mb-2");
    expect(c).not.toContain("mt-2");
  });

  it("keeps the chrome and the alignment either way", () => {
    for (const side of ["top", "bottom"] as const) {
      const c = panelClasses({ side, align: "end" });
      expect(c).toEqual(expect.arrayContaining(["absolute", "z-50", "border-border", "bg-surface", "right-0"]));
    }
  });

  it("renders no panel while closed", () => {
    expect(panelClasses({ open: false })).toEqual([]);
  });
});
