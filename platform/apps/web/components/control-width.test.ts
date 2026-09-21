import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Input, Select } from "@aura/ui";
import { CONTROL_BASE, OWNS_WIDTH, splitWidth } from "../../../packages/ui/src/control-styles";

/**
 * A `w-*` passed to Input or Select actually takes effect.
 *
 * Both used to carry `w-full` in a shared base, so `<Input className="w-48" />`
 * rendered `class="w-full ... w-48"` - and Tailwind emits `w-48` BEFORE `w-full`
 * in the stylesheet, so the base won and the control stayed full width. Eleven
 * call sites across both consoles asked for a fixed width and silently did not
 * get one; the call-quality row of fields stacked one per line because of it.
 * It fails silently by construction (no type error, no lint, no warning), which
 * is why it is pinned here.
 */

const html = (el: ReactElement) => renderToStaticMarkup(el);
const classes = (markup: string, tag: string): string[] => {
  const m = new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`).exec(markup);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
};

describe("Input width", () => {
  it("is full width by default", () => {
    expect(classes(html(createElement(Input, {})), "input")).toContain("w-full");
  });

  it.each(["w-48", "w-auto", "w-[12rem]", "w-24 font-mono"])(
    "drops its base w-full when the caller passes %s",
    (cls) => {
      const c = classes(html(createElement(Input, { className: cls })), "input");
      expect(c).not.toContain("w-full");
      expect(c).toContain(cls.split(" ")[0]);
      // still a control: the chrome (border, radius, colours) is untouched
      expect(c).toContain("border-border-strong");
      expect(c).toContain("rounded-sm");
    },
  );

  it.each(["min-w-0 flex-1", "max-w-xs", "sm:w-48", "md:w-64"])(
    "keeps w-full under %s, which sit ON TOP of it and already worked",
    (cls) => {
      expect(classes(html(createElement(Input, { className: cls })), "input")).toContain("w-full");
    },
  );

  it("does not double up an explicit w-full", () => {
    const c = classes(html(createElement(Input, { className: "w-full" })), "input");
    expect(c.filter((t) => t === "w-full")).toHaveLength(1);
  });
});

describe("Select width", () => {
  it("is a bare relative wrapper around a full-width select by default", () => {
    const out = html(createElement(Select, { children: "x" }));
    expect(classes(out, "div")).toEqual(["relative"]);
    expect(classes(out, "select")).toContain("w-full");
  });

  it.each(["w-56", "w-auto", "w-28"])(
    "puts %s on the WRAPPER and leaves the select filling it",
    (w) => {
      const out = html(createElement(Select, { className: w, children: "x" }));
      // The wrapper is what the chevron is positioned against. Narrowing only
      // the select would leave the chevron stranded at the far right.
      expect(classes(out, "div")).toEqual(["relative", w]);
      expect(classes(out, "select")).toContain("w-full");
      expect(classes(out, "select")).not.toContain(w);
      expect(out).toContain("<svg"); // chevron still inside the wrapper
    },
  );

  it("moves a responsive width too, and leaves every other class on the select", () => {
    const out = html(
      createElement(Select, { className: "sm:w-64 w-28 text-xs min-w-[9rem]", children: "x" }),
    );
    expect(classes(out, "div")).toEqual(["relative", "sm:w-64", "w-28"]);
    const select = classes(out, "select");
    expect(select).toContain("text-xs");
    expect(select).toContain("min-w-[9rem]");
    expect(select).not.toContain("w-28");
    expect(select).not.toContain("sm:w-64");
  });

  it("leaves min-w and max-w on the select, as before", () => {
    const out = html(createElement(Select, { className: "min-w-[10rem]", children: "x" }));
    expect(classes(out, "div")).toEqual(["relative"]);
    expect(classes(out, "select")).toContain("min-w-[10rem]");
  });
});

describe("the helpers", () => {
  it("OWNS_WIDTH only matches an unprefixed width", () => {
    for (const yes of ["w-48", "a w-auto b", "w-[12rem] x"])
      expect(OWNS_WIDTH.test(yes), yes).toBe(true);
    for (const no of ["", "min-w-0", "max-w-xs", "sm:w-48", "flex-1", "show-w-x"]) {
      expect(OWNS_WIDTH.test(no), no).toBe(false);
    }
  });

  it("splitWidth partitions without losing or inventing a class", () => {
    const { width, rest } = splitWidth("w-28  text-xs sm:w-64 min-w-0");
    expect(width).toBe("w-28 sm:w-64");
    expect(rest).toBe("text-xs min-w-0");
    expect(splitWidth("")).toEqual({ width: "", rest: "" });
  });

  it("CONTROL_BASE is byte-for-byte what it was - hand-rolled controls mirror it by hand", () => {
    expect(CONTROL_BASE).toBe(
      "w-full rounded-sm border border-border-strong bg-surface text-text " +
        "transition-colors duration-150 ease-out " +
        "placeholder:text-text-muted " +
        "hover:border-text-subtle " +
        "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle",
    );
  });
});
