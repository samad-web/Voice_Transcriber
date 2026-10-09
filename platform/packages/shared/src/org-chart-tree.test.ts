import { describe, expect, it } from "vitest";

import {
  type LineLike,
  type NodeLike,
  ancestorsOf,
  childMapOf,
  defaultCollapsed,
  depthMapOf,
  dottedLinesAsOf,
  escalationChain,
  integrityProblems,
  layoutTree,
  parentMapAsOf,
  pathsToReveal,
  rootsOf,
  spanOfControlFlags,
  subtreeOf,
  wouldCycle,
} from "./org-chart-tree";

/**
 * §15's fixture: three levels, a vacancy, a dotted line, an acting assignment
 * and a past reorganization. The structure half lives here; the assignment and
 * contract halves are in the API's fixtures, where there is a database to put
 * them in.
 *
 *            ceo
 *        ┌────┴────┐
 *      sales      ops
 *     ┌──┴──┐       │
 *   rep1  rep2    support   (support also reports dotted to sales)
 *
 * `rep2` MOVED from ops to sales on 2026-04-01, which is what makes the
 * as-of tests meaningful: before that date the tree is a different shape.
 */
const NODES: NodeLike[] = [
  { id: "ceo", title: "Chief Executive" },
  { id: "sales", title: "Head of Sales", sortOrder: 1 },
  { id: "ops", title: "Head of Operations", sortOrder: 2 },
  { id: "rep1", title: "Sales Rep A", sortOrder: 1 },
  { id: "rep2", title: "Sales Rep B", sortOrder: 2 },
  { id: "support", title: "Support Lead" },
];

const LINES: LineLike[] = [
  { positionId: "sales", managerPositionId: "ceo", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
  { positionId: "ops", managerPositionId: "ceo", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
  { positionId: "rep1", managerPositionId: "sales", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
  // The reorganization: closed on 31 March, reopened under sales on 1 April.
  { positionId: "rep2", managerPositionId: "ops", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: "2026-03-31" },
  { positionId: "rep2", managerPositionId: "sales", type: "solid", effectiveFrom: "2026-04-01", effectiveTo: null },
  { positionId: "support", managerPositionId: "ops", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
  { positionId: "support", managerPositionId: "sales", type: "dotted", effectiveFrom: "2026-02-01", effectiveTo: null },
];

const tree = (asOf: string) => {
  const parents = parentMapAsOf(LINES, asOf);
  return { parents, children: childMapOf(NODES, parents) };
};

describe("parentMapAsOf", () => {
  it("resolves the structure that applied on the date, not the latest one", () => {
    expect(parentMapAsOf(LINES, "2026-02-15").get("rep2")).toBe("ops");
    expect(parentMapAsOf(LINES, "2026-06-15").get("rep2")).toBe("sales");
  });

  it("switches on the effective date itself, not the day after", () => {
    expect(parentMapAsOf(LINES, "2026-03-31").get("rep2")).toBe("ops");
    expect(parentMapAsOf(LINES, "2026-04-01").get("rep2")).toBe("sales");
  });

  it("knows nothing before the chart began", () => {
    expect(parentMapAsOf(LINES, "2025-12-31").size).toBe(0);
  });

  it("ignores dotted lines", () => {
    expect(parentMapAsOf(LINES, "2026-06-15").get("support")).toBe("ops");
  });

  it("takes the latest line rather than throwing when two solid lines overlap", () => {
    // A reader that throws on bad data is a chart that cannot be used to FIND
    // the bad data. `integrityProblems` is what reports it.
    const broken: LineLike[] = [
      ...LINES,
      { positionId: "rep1", managerPositionId: "ops", type: "solid", effectiveFrom: "2026-05-01", effectiveTo: null },
    ];
    expect(parentMapAsOf(broken, "2026-06-01").get("rep1")).toBe("ops");
  });
});

describe("dottedLinesAsOf", () => {
  it("picks up a dotted line once it is effective and never a solid one", () => {
    expect(dottedLinesAsOf(LINES, "2026-01-15").size).toBe(0);
    expect(dottedLinesAsOf(LINES, "2026-06-15").get("support")).toEqual(["sales"]);
  });
});

describe("childMapOf and rootsOf", () => {
  it("finds the single root and orders siblings deterministically", () => {
    const { parents, children } = tree("2026-06-15");
    expect(rootsOf(NODES, parents)).toEqual(["ceo"]);
    expect(children.get("ceo")).toEqual(["sales", "ops"]);
    expect(children.get("sales")).toEqual(["rep1", "rep2"]);
  });

  it("breaks a sortOrder tie by title and then by id, so a reload does not reshuffle", () => {
    const nodes: NodeLike[] = [
      { id: "root", title: "Root" },
      { id: "b", title: "Same Title" },
      { id: "a", title: "Same Title" },
      { id: "c", title: "Another" },
    ];
    const lines: LineLike[] = ["a", "b", "c"].map((id) => ({
      positionId: id,
      managerPositionId: "root",
      type: "solid" as const,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    }));
    const parents = parentMapAsOf(lines, "2026-06-01");
    expect(childMapOf(nodes, parents).get("root")).toEqual(["c", "a", "b"]);
  });

  it("treats a position whose manager is outside the set as a root", () => {
    // This is how a manager-scoped read works: hand it the subtree and the
    // manager's own seat becomes the root with no special case.
    const { parents } = tree("2026-06-15");
    const branch = NODES.filter((n) => ["sales", "rep1", "rep2"].includes(n.id));
    expect(rootsOf(branch, parents)).toEqual(["sales"]);
  });
});

describe("wouldCycle", () => {
  it("refuses a seat as its own manager", () => {
    const { parents } = tree("2026-06-15");
    expect(wouldCycle(parents, "sales", "sales")).toBe(true);
  });

  it("refuses a move under the position's own descendant", () => {
    const { parents } = tree("2026-06-15");
    expect(wouldCycle(parents, "sales", "rep1")).toBe(true);
    expect(wouldCycle(parents, "ceo", "rep2")).toBe(true);
  });

  it("allows a legitimate move", () => {
    const { parents } = tree("2026-06-15");
    expect(wouldCycle(parents, "rep1", "ops")).toBe(false);
    expect(wouldCycle(parents, "support", "sales")).toBe(false);
  });

  it("terminates on data that already contains a ring", () => {
    // Without the visited set this hangs, and the request hangs with it.
    const ring: ParentMapish = new Map([
      ["a", "b"],
      ["b", "c"],
      ["c", "a"],
    ]);
    expect(wouldCycle(ring, "x", "a")).toBe(false);
    expect(wouldCycle(ring, "b", "a")).toBe(true);
  });
});
type ParentMapish = ReadonlyMap<string, string>;

describe("subtreeOf and ancestorsOf", () => {
  it("includes the node itself and everything under it", () => {
    const { children } = tree("2026-06-15");
    expect(subtreeOf(children, "sales").sort()).toEqual(["rep1", "rep2", "sales"]);
    expect(subtreeOf(children, "rep1")).toEqual(["rep1"]);
    expect(subtreeOf(children, "ceo")).toHaveLength(6);
  });

  it("walks the chain of command nearest-first", () => {
    const { parents } = tree("2026-06-15");
    expect(ancestorsOf(parents, "rep2")).toEqual(["sales", "ceo"]);
    expect(ancestorsOf(parents, "ceo")).toEqual([]);
  });

  it("reflects the structure of the date it was asked about", () => {
    expect(ancestorsOf(parentMapAsOf(LINES, "2026-02-15"), "rep2")).toEqual(["ops", "ceo"]);
  });
});

describe("depthMapOf", () => {
  it("counts from zero at the root", () => {
    const { parents } = tree("2026-06-15");
    const depths = depthMapOf(NODES, parents);
    expect(depths.get("ceo")).toBe(0);
    expect(depths.get("sales")).toBe(1);
    expect(depths.get("rep2")).toBe(2);
  });
});

describe("escalationChain", () => {
  it("routes up the solid line", () => {
    const { parents } = tree("2026-06-15");
    expect(escalationChain(parents, "rep1")).toEqual(["sales", "ceo"]);
  });

  it("puts a nominated approver first without dropping the fallback chain", () => {
    const { parents } = tree("2026-06-15");
    expect(escalationChain(parents, "rep1", "ceo")).toEqual(["ceo", "sales"]);
    expect(escalationChain(parents, "rep1", "ops")).toEqual(["ops", "sales", "ceo"]);
  });
});

describe("spanOfControlFlags", () => {
  it("flags a manager with too many reports and one with too few", () => {
    const nodes: NodeLike[] = [{ id: "root", title: "Root" }, { id: "thin", title: "Thin" }];
    const wide: NodeLike[] = [];
    const lines: LineLike[] = [
      { positionId: "thin", managerPositionId: "root", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
    ];
    for (let i = 0; i < 13; i++) {
      wide.push({ id: `w${i}`, title: `W${i}` });
      lines.push({ positionId: `w${i}`, managerPositionId: "thin", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null });
    }
    const all = [...nodes, ...wide];
    const parents = parentMapAsOf(lines, "2026-06-01");
    const flags = spanOfControlFlags(childMapOf(all, parents));
    expect(flags).toEqual([
      { positionId: "thin", directReports: 13, flag: "too_wide" },
      { positionId: "root", directReports: 1, flag: "too_narrow" },
    ]);
  });

  it("never flags a leaf", () => {
    const { children } = tree("2026-06-15");
    const flagged = spanOfControlFlags(children).map((f) => f.positionId);
    expect(flagged).not.toContain("rep1");
    // `ops` has one report after the reorg, which IS a narrow span.
    expect(flagged).toContain("ops");
  });

  it("honours per-org limits", () => {
    const { children } = tree("2026-06-15");
    expect(spanOfControlFlags(children, { min: 1, max: 12 })).toEqual([]);
  });
});

describe("integrityProblems", () => {
  it("is silent on a well-formed tree", () => {
    expect(integrityProblems(NODES, LINES, "2026-06-15")).toEqual([]);
  });

  it("reports two solid managers on one seat", () => {
    const broken: LineLike[] = [
      ...LINES,
      { positionId: "rep1", managerPositionId: "ops", type: "solid", effectiveFrom: "2026-05-01", effectiveTo: null },
    ];
    expect(integrityProblems(NODES, broken, "2026-06-01")).toContainEqual({
      kind: "multiple_solid_managers",
      positionId: "rep1",
      managerIds: ["ops", "sales"],
    });
  });

  it("reports a second parentless seat as multiple roots, not as a fault on one of them", () => {
    const orphan = [...NODES, { id: "stray", title: "Stray" }];
    const problems = integrityProblems(orphan, LINES, "2026-06-15");
    expect(problems).toContainEqual({ kind: "multiple_roots", positionIds: ["ceo", "stray"] });
    expect(problems.filter((p) => p.kind === "no_manager")).toEqual([]);
  });

  it("reports a line pointing at a position that is not there", () => {
    const broken: LineLike[] = [
      ...LINES,
      { positionId: "ghost", managerPositionId: "nobody", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
    ];
    expect(integrityProblems([...NODES, { id: "ghost", title: "Ghost" }], broken, "2026-06-15")).toContainEqual({
      kind: "no_manager",
      positionId: "ghost",
    });
  });

  it("finds a ring and everything hanging below it", () => {
    const nodes: NodeLike[] = [
      { id: "a", title: "A" },
      { id: "b", title: "B" },
      { id: "c", title: "C" },
    ];
    const lines: LineLike[] = [
      { positionId: "a", managerPositionId: "b", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
      { positionId: "b", managerPositionId: "a", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
      { positionId: "c", managerPositionId: "a", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
    ];
    const problems = integrityProblems(nodes, lines, "2026-06-01");
    expect(problems).toContainEqual({ kind: "cycle", positionIds: ["a", "b", "c"] });
  });
});

describe("layoutTree", () => {
  const options = { nodeWidth: 200, nodeHeight: 120, gapX: 40, gapY: 80 };

  it("centres a parent over its children and ranks by depth", () => {
    const { parents, children } = tree("2026-06-15");
    const dotted = dottedLinesAsOf(LINES, "2026-06-15");
    const layout = layoutTree(NODES, parents, children, dotted, options);
    const at = (id: string) => layout.nodes.find((n) => n.id === id);

    const rep1 = at("rep1");
    const rep2 = at("rep2");
    const sales = at("sales");
    expect(sales?.x).toBe(((rep1?.x ?? 0) + (rep2?.x ?? 0)) / 2);
    expect(at("ceo")?.y).toBe(0);
    expect(sales?.y).toBe(200);
    expect(rep1?.y).toBe(400);
  });

  it("leaves no two drawn nodes overlapping", () => {
    const { parents, children } = tree("2026-06-15");
    const layout = layoutTree(NODES, parents, children, new Map(), options);
    const byRank = new Map<number, number[]>();
    for (const node of layout.nodes) {
      byRank.set(node.depth, [...(byRank.get(node.depth) ?? []), node.x]);
    }
    for (const xs of byRank.values()) {
      const sorted = [...xs].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(options.nodeWidth);
      }
    }
  });

  it("reports the direct-report count whether or not the children are drawn", () => {
    const { parents, children } = tree("2026-06-15");
    const collapsed = new Set(["sales"]);
    const layout = layoutTree(NODES, parents, children, new Map(), { ...options, collapsed });
    const sales = layout.nodes.find((n) => n.id === "sales");
    expect(sales?.childCount).toBe(2);
    expect(sales?.hasHiddenChildren).toBe(true);
    // The hidden subtree costs nothing - it is not laid out at all.
    expect(layout.nodes.map((n) => n.id)).not.toContain("rep1");
    expect(layout.edges.some((e) => e.to === "rep1")).toBe(false);
  });

  it("draws a dotted edge only when both ends are on screen", () => {
    const { parents, children } = tree("2026-06-15");
    const dotted = dottedLinesAsOf(LINES, "2026-06-15");
    const open = layoutTree(NODES, parents, children, dotted, options);
    expect(open.edges).toContainEqual({ from: "sales", to: "support", type: "dotted" });

    const closed = layoutTree(NODES, parents, children, dotted, {
      ...options,
      collapsed: new Set(["ops"]),
    });
    expect(closed.edges.some((e) => e.type === "dotted")).toBe(false);
  });

  it("transposes for the horizontal view", () => {
    const { parents, children } = tree("2026-06-15");
    const layout = layoutTree(NODES, parents, children, new Map(), {
      ...options,
      orientation: "horizontal",
    });
    const at = (id: string) => layout.nodes.find((n) => n.id === id);
    expect(at("ceo")?.x).toBe(0);
    expect(at("sales")?.x).toBe(240);
    expect(at("sales")?.y).toBe(((at("rep1")?.y ?? 0) + (at("rep2")?.y ?? 0)) / 2);
  });

  it("still draws a tree that contains a ring, in a row of its own", () => {
    const nodes: NodeLike[] = [
      { id: "root", title: "Root" },
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ];
    const lines: LineLike[] = [
      { positionId: "a", managerPositionId: "b", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
      { positionId: "b", managerPositionId: "a", type: "solid", effectiveFrom: "2026-01-01", effectiveTo: null },
    ];
    const parents = parentMapAsOf(lines, "2026-06-01");
    const layout = layoutTree(nodes, parents, childMapOf(nodes, parents), new Map(), options);
    expect(layout.nodes).toHaveLength(3);
  });

  it("handles a deep chain without blowing the stack", () => {
    // §12 asks for a few hundred nodes; recursion would overflow on a deep
    // chain inside a browser tab.
    const nodes: NodeLike[] = [];
    const lines: LineLike[] = [];
    for (let i = 0; i < 600; i++) {
      nodes.push({ id: `n${i}`, title: `N${i}` });
      if (i > 0) {
        lines.push({
          positionId: `n${i}`,
          managerPositionId: `n${i - 1}`,
          type: "solid",
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
        });
      }
    }
    const parents = parentMapAsOf(lines, "2026-06-01");
    const layout = layoutTree(nodes, parents, childMapOf(nodes, parents), new Map(), options);
    expect(layout.nodes).toHaveLength(600);
    expect(layout.height).toBe(599 * 200 + 120);
  });
});

describe("defaultCollapsed", () => {
  it("does nothing to a small tree", () => {
    const { parents, children } = tree("2026-06-15");
    expect(defaultCollapsed(NODES, parents, children).size).toBe(0);
  });

  it("folds the level-3 seats once the tree is big", () => {
    const nodes: NodeLike[] = [{ id: "root", title: "Root" }];
    const lines: LineLike[] = [];
    const link = (child: string, parent: string) =>
      lines.push({ positionId: child, managerPositionId: parent, type: "solid" as const, effectiveFrom: "2026-01-01", effectiveTo: null });
    // 1 + 4 + 16 + 32 + 32 = 85 nodes, five levels deep.
    for (let a = 0; a < 4; a++) {
      nodes.push({ id: `a${a}`, title: `A${a}` });
      link(`a${a}`, "root");
      for (let b = 0; b < 4; b++) {
        nodes.push({ id: `b${a}_${b}`, title: `B${a}${b}` });
        link(`b${a}_${b}`, `a${a}`);
        for (let c = 0; c < 2; c++) {
          nodes.push({ id: `c${a}_${b}_${c}`, title: `C${a}${b}${c}` });
          link(`c${a}_${b}_${c}`, `b${a}_${b}`);
          nodes.push({ id: `d${a}_${b}_${c}`, title: `D${a}${b}${c}` });
          link(`d${a}_${b}_${c}`, `c${a}_${b}_${c}`);
        }
      }
    }
    const parents = parentMapAsOf(lines, "2026-06-01");
    const children = childMapOf(nodes, parents);
    const collapsed = defaultCollapsed(nodes, parents, children);
    expect(collapsed.size).toBe(32);
    expect([...collapsed].every((id) => id.startsWith("c"))).toBe(true);
    // Levels 0-3 stay visible.
    const layout = layoutTree(nodes, parents, children, new Map(), {
      nodeWidth: 10,
      nodeHeight: 10,
      gapX: 2,
      gapY: 2,
      collapsed,
    });
    expect(Math.max(...layout.nodes.map((n) => n.depth))).toBe(3);
  });
});

describe("pathsToReveal", () => {
  it("expands a match's ancestors and not the match itself", () => {
    const { parents } = tree("2026-06-15");
    const reveal = pathsToReveal(parents, ["rep2"]);
    expect([...reveal].sort()).toEqual(["ceo", "sales"]);
    expect(reveal.has("rep2")).toBe(false);
  });

  it("unions the paths to several matches", () => {
    const { parents } = tree("2026-06-15");
    expect([...pathsToReveal(parents, ["rep1", "support"])].sort()).toEqual(["ceo", "ops", "sales"]);
  });
});
