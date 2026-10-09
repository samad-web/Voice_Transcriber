import { ORG_CHART_DEFAULTS, coversDate } from "./org-chart";

/**
 * The org chart's TREE maths - cycle detection, as-of resolution, layout, span
 * of control (Build docs/org-chart-build-plan.md §4.3, §5.1, §11).
 *
 * ── WHY THIS IS A SEPARATE FILE FROM `org-chart.ts` ────────────────────────
 *
 * Three callers need three different halves. The API needs `wouldCycle` and
 * `subtreeOf` on every write and must never pay for layout maths. The browser
 * needs `layoutTree` sixty times a second while somebody drags and has no use
 * for an input schema. The PDF exporter needs the layout and nothing else -
 * and it runs in the API, which is the reason the layout is here at all rather
 * than in a React component: §5.2 requires the PNG and the PDF to be "of the
 * current view", and two layout implementations would produce two different
 * charts and no way to tell which was wrong.
 *
 * So: ONE layout function, no DOM, no measurement, no dependency. Everything
 * here is pure, takes flat rows, and is unit-tested against fixtures.
 *
 * ── FLAT ROWS IN, NEVER NESTED JSON ────────────────────────────────────────
 *
 * §2: "Tree storage: flat rows with `parent` links, never nested JSON." The
 * functions here honour that at the boundary too - they accept flat arrays and
 * build their own indices. Nothing in this module ever asks the database for a
 * nested shape, which is what keeps `GET /org-chart` a single flat query under
 * §12's 300 KB budget for 500 nodes.
 */

// ───────────────────────────────────────────────────────────────────────────
// The shapes the maths needs — deliberately smaller than a row
// ───────────────────────────────────────────────────────────────────────────

/**
 * A reporting line as the algorithms see it.
 *
 * Structurally typed and minimal, so a database row, an API payload and a test
 * fixture all satisfy it without conversion. `type` is here because §9 routes
 * escalation up SOLID lines only, and a cycle check that counted dotted lines
 * would refuse a perfectly legal second reporting line.
 */
export interface LineLike {
  positionId: string;
  managerPositionId: string;
  type: "solid" | "dotted";
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

export interface NodeLike {
  id: string;
  title: string;
  sortOrder?: number | null;
  level?: number | null;
}

/** position id -> its solid manager's id, for one date. */
export type ParentMap = ReadonlyMap<string, string>;
/** manager id -> its direct reports' ids, in render order. */
export type ChildMap = ReadonlyMap<string, string[]>;

// ───────────────────────────────────────────────────────────────────────────
// §4.3 — the integrity rules, as pure functions
// ───────────────────────────────────────────────────────────────────────────

/**
 * The solid parent of every position, on `asOf`.
 *
 * ── THE "EXACTLY ONE SOLID MANAGER" RULE, AND WHAT THIS DOES WITH A SECOND ──
 *
 * §4.3 requires exactly one solid manager per position at any date. The API
 * enforces that on write (`solidLineConflict` below is what it asks). This
 * function is a READER, and a reader that throws on bad data is a chart that
 * cannot be used to FIND the bad data - which is precisely when somebody needs
 * it. So it takes the LAST line by `effectiveFrom` and the duplicate is
 * reported by `integrityProblems`, not by refusing to draw.
 *
 * That is the deliberate asymmetry in this module: writes are strict, reads
 * are total.
 */
export function parentMapAsOf(lines: readonly LineLike[], asOf: string): ParentMap {
  const best = new Map<string, { parent: string; from: string }>();
  for (const line of lines) {
    if (line.type !== "solid") continue;
    if (!coversDate(asOf, line.effectiveFrom, line.effectiveTo)) continue;
    const from = line.effectiveFrom ?? "";
    const held = best.get(line.positionId);
    if (!held || from >= held.from) best.set(line.positionId, { parent: line.managerPositionId, from });
  }
  const out = new Map<string, string>();
  for (const [id, { parent }] of best) out.set(id, parent);
  return out;
}

/** The dotted lines live on `asOf`, grouped by the position that reports. */
export function dottedLinesAsOf(
  lines: readonly LineLike[],
  asOf: string,
): ReadonlyMap<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of lines) {
    if (line.type !== "dotted") continue;
    if (!coversDate(asOf, line.effectiveFrom, line.effectiveTo)) continue;
    const held = out.get(line.positionId) ?? [];
    if (!held.includes(line.managerPositionId)) held.push(line.managerPositionId);
    out.set(line.positionId, held);
  }
  return out;
}

/**
 * Children of every manager, in the order the chart draws them.
 *
 * `sortOrder` then `title` then `id`. All three, because the first two tie: a
 * tenant who never sets `sort_order` leaves every sibling at 0, and two
 * managers both called "Team Lead" would then swap places between two renders
 * of the same data - which makes a screenshot test flap and, worse, makes a
 * chart somebody is reading rearrange itself when they reload it. `id` is the
 * final tiebreak because it is the only value guaranteed distinct.
 */
export function childMapOf(nodes: readonly NodeLike[], parents: ParentMap): ChildMap {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    const parent = parents.get(node.id);
    if (parent === undefined || !byId.has(parent)) continue;
    const held = out.get(parent) ?? [];
    held.push(node.id);
    out.set(parent, held);
  }
  for (const [parent, children] of out) {
    children.sort((a, b) => {
      const x = byId.get(a);
      const y = byId.get(b);
      const xo = x?.sortOrder ?? 0;
      const yo = y?.sortOrder ?? 0;
      if (xo !== yo) return xo - yo;
      const byTitle = (x?.title ?? "").localeCompare(y?.title ?? "");
      if (byTitle !== 0) return byTitle;
      return a.localeCompare(b);
    });
    out.set(parent, children);
  }
  return out;
}

/**
 * The positions with no solid manager - the roots.
 *
 * PLURAL, and the type says so. §4.3 allows one root, and the API refuses to
 * create a second; but a tree read back mid-reorganization, or one whose root
 * line expired yesterday, legitimately has two for a moment. A function typed
 * to return a single root would have to throw or pick, and both are worse than
 * telling the caller the truth - the chart renders both and
 * `integrityProblems` says so out loud.
 *
 * A position whose manager is not in `nodes` counts as a root too. That is how
 * a MANAGER-scoped read works: hand this the subtree a manager may see, and
 * their own seat becomes the root without the caller having to special-case it.
 */
export function rootsOf(nodes: readonly NodeLike[], parents: ParentMap): string[] {
  const byId = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => {
      const parent = parents.get(n.id);
      return parent === undefined || !byId.has(parent);
    })
    .map((n) => n.id);
}

/**
 * Would making `managerId` the parent of `positionId` create a cycle?
 *
 * §4.3's first MUST. Walks UP from the proposed manager: if the walk reaches
 * `positionId`, the position is already an ancestor of its proposed parent and
 * the move would detach the whole branch from the tree into a ring - which
 * renders as nothing at all, because a ring has no root.
 *
 * Self-parenting counts, and is checked first: it is the cycle people actually
 * create, usually by dropping a node onto itself.
 *
 * The visited set is not an optimization. Called on data that ALREADY contains
 * a cycle - which is the state this function exists to keep out, and which a
 * direct database edit can still produce - the walk would otherwise never
 * terminate, and the request would hang rather than fail.
 */
export function wouldCycle(parents: ParentMap, positionId: string, managerId: string): boolean {
  if (positionId === managerId) return true;
  const seen = new Set<string>([managerId]);
  let at: string | undefined = parents.get(managerId);
  while (at !== undefined) {
    if (at === positionId) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    at = parents.get(at);
  }
  return false;
}

/**
 * `positionId` and everything below it, breadth-first.
 *
 * §4.3: "Moves of a branch move the whole subtree". The caller needs the set
 * to answer two questions - which seats a move carries with it, and whether a
 * delete would orphan anybody - and both want the node itself included, so it
 * is first in the result.
 */
export function subtreeOf(children: ChildMap, positionId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [positionId];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (seen.has(at)) continue;
    seen.add(at);
    out.push(at);
    for (const child of children.get(at) ?? []) queue.push(child);
  }
  return out;
}

/**
 * The chain of command above a position, nearest manager first.
 *
 * §5.2's "path highlight" and §6.2's escalation both read this. Solid lines
 * only - see `LineLike.type`. Cycle-safe for the reason `wouldCycle` is.
 */
export function ancestorsOf(parents: ParentMap, positionId: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([positionId]);
  let at = parents.get(positionId);
  while (at !== undefined && !seen.has(at)) {
    out.push(at);
    seen.add(at);
    at = parents.get(at);
  }
  return out;
}

/** Depth from the root: a root is 0. */
export function depthMapOf(nodes: readonly NodeLike[], parents: ParentMap): Map<string, number> {
  const depths = new Map<string, number>();
  const resolve = (id: string, guard: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const parent = parents.get(id);
    // A cycle gets depth 0 rather than an exception: see `rootsOf`.
    if (parent === undefined || guard.has(id)) {
      depths.set(id, 0);
      return 0;
    }
    guard.add(id);
    const depth = resolve(parent, guard) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) resolve(node.id, new Set());
  return depths;
}

/**
 * Who must approve for `positionId`, walking up the solid line.
 *
 * §9: "alerts route up the actual reporting line (telecaller -> manager ->
 * owner)". `nominated` short-circuits it - §6.2's authority table may name a
 * specific approving position, and a named approver outranks the chain because
 * somebody chose it deliberately.
 *
 * Returns every ancestor rather than only the first, because §9's other
 * requirement is that a VACANT routing target raises "reroute needed" - which
 * needs the next candidate up, and the one after that.
 */
export function escalationChain(
  parents: ParentMap,
  positionId: string,
  nominated?: string | null,
): string[] {
  const chain = ancestorsOf(parents, positionId);
  if (!nominated) return chain;
  // A nominated approver that is also an ancestor is moved to the front rather
  // than duplicated; one that is NOT an ancestor (a finance controller off to
  // the side, say) is prepended and the chain is kept as the fallback.
  return [nominated, ...chain.filter((id) => id !== nominated)];
}

// ───────────────────────────────────────────────────────────────────────────
// §11 — analytics that must reconcile with the rows they came from
// ───────────────────────────────────────────────────────────────────────────

export interface SpanFlag {
  positionId: string;
  directReports: number;
  flag: "too_wide" | "too_narrow";
}

/**
 * §11/§14: managers with more than 12 or fewer than 2 direct reports.
 *
 * A LEAF is not flagged, and that is the rule worth stating: a telecaller with
 * no reports has a span of zero, which is correct and uninteresting. "Fewer
 * than 2" is a statement about MANAGERS - a manager with one report is usually
 * a layer that exists for a title rather than for the work, which is exactly
 * what §11 wants flagged. So the check runs over positions with at least one
 * report.
 */
export function spanOfControlFlags(
  children: ChildMap,
  limits: { max?: number; min?: number } = {},
): SpanFlag[] {
  const max = limits.max ?? ORG_CHART_DEFAULTS.spanOfControlMax;
  const min = limits.min ?? ORG_CHART_DEFAULTS.spanOfControlMin;
  const out: SpanFlag[] = [];
  for (const [positionId, reports] of children) {
    const count = reports.length;
    if (count === 0) continue;
    if (count > max) out.push({ positionId, directReports: count, flag: "too_wide" });
    else if (count < min) out.push({ positionId, directReports: count, flag: "too_narrow" });
  }
  return out.sort((a, b) => b.directReports - a.directReports || a.positionId.localeCompare(b.positionId));
}

export type IntegrityProblem =
  | { kind: "no_manager"; positionId: string }
  | { kind: "multiple_solid_managers"; positionId: string; managerIds: string[] }
  | { kind: "cycle"; positionIds: string[] }
  | { kind: "multiple_roots"; positionIds: string[] };

/**
 * §10's "missing data" alerts, computed rather than stored.
 *
 * Everything here is a state the WRITE path refuses, so finding one means
 * something bypassed it - a direct SQL edit, a half-applied migration, or a
 * line whose `effective_to` passed and left a seat parentless. That is the
 * reason it is a read-time computation and not a constraint: a constraint
 * would have refused the data at insert and this situation is about data
 * already in the table.
 */
export function integrityProblems(
  nodes: readonly NodeLike[],
  lines: readonly LineLike[],
  asOf: string,
): IntegrityProblem[] {
  const out: IntegrityProblem[] = [];
  const ids = new Set(nodes.map((n) => n.id));

  const solidByPosition = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.type !== "solid") continue;
    if (!coversDate(asOf, line.effectiveFrom, line.effectiveTo)) continue;
    const held = solidByPosition.get(line.positionId) ?? new Set<string>();
    held.add(line.managerPositionId);
    solidByPosition.set(line.positionId, held);
  }
  for (const [positionId, managers] of solidByPosition) {
    if (managers.size > 1) {
      out.push({ kind: "multiple_solid_managers", positionId, managerIds: [...managers].sort() });
    }
  }

  const parents = parentMapAsOf(lines, asOf);
  const roots = rootsOf(nodes, parents);
  if (roots.length > 1) out.push({ kind: "multiple_roots", positionIds: [...roots].sort() });

  /**
   * §10's "position with no manager (non-root)", reported for the case it can
   * actually be told apart from the real root: a solid line that POINTS AT a
   * position which is not in the tree.
   *
   * A second parentless seat is `multiple_roots` and nothing else - with two
   * candidates and no tiebreak, naming one of them "the root" and the other a
   * fault would be a guess, and the guess would be wrong half the time on the
   * one screen somebody opens to fix it.
   */
  for (const [positionId, managerId] of parents) {
    if (!ids.has(managerId)) out.push({ kind: "no_manager", positionId });
  }

  // Anything whose upward walk revisits a seat is in, or hangs below, a ring.
  const inCycle: string[] = [];
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let at = parents.get(node.id);
    while (at !== undefined && ids.has(at)) {
      if (seen.has(at)) {
        inCycle.push(node.id);
        break;
      }
      seen.add(at);
      at = parents.get(at);
    }
  }
  if (inCycle.length > 0) out.push({ kind: "cycle", positionIds: inCycle.sort() });

  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// §5.1 — layout
// ───────────────────────────────────────────────────────────────────────────

export interface LayoutOptions {
  /** Node box, in the same units the caller renders in. */
  nodeWidth: number;
  nodeHeight: number;
  /** Gap between siblings, and between one rank and the next. */
  gapX: number;
  gapY: number;
  /** `vertical` is §3's top-down reference; `horizontal` is §5.2's second view. */
  orientation?: "vertical" | "horizontal";
  /** Ids whose children are hidden. */
  collapsed?: ReadonlySet<string>;
}

export interface PlacedNode {
  id: string;
  x: number;
  y: number;
  depth: number;
  /** Direct reports, whether or not they are currently drawn. */
  childCount: number;
  hasHiddenChildren: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
  type: "solid" | "dotted";
}

export interface Layout {
  nodes: PlacedNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
}

/**
 * A tidy top-down tree layout (§3: "right-angle connector lines ... a clean
 * horizontal bus line above each group of children", "a centered root").
 *
 * ── THE ALGORITHM, AND WHY NOT A LIBRARY ───────────────────────────────────
 *
 * Two passes. Going up, every leaf takes the next free column and every parent
 * takes the midpoint of its children - which is Reingold-Tilford reduced to
 * the case this chart actually has: a tree whose nodes are all the same size,
 * drawn in discrete ranks. The full algorithm's contour-threading exists to
 * pack subtrees of unequal width tightly, and packing tightly is the opposite
 * of what §3 asks for ("generous white space").
 *
 * §5.1 suggests React Flow with dagre or ELK. This repo has neither, `pnpm
 * --filter <app> add` has orphaned `next` in a sibling package here before,
 * and dagre's layered layout solves a harder problem - arbitrary DAGs with
 * variable node sizes - whose extra freedom shows up as a chart that is
 * subtly different every time the data changes. Sixty lines and no dependency
 * also means the PDF exporter can call it server-side, which is what makes
 * §5.2's export "of the current view" literally true. Recorded in
 * ORG_CHART_DECISIONS.md.
 *
 * ── WHAT `collapsed` DOES TO THE MATHS ─────────────────────────────────────
 *
 * A collapsed node is a LEAF for layout purposes - it takes one column and its
 * children are not placed at all. That is what makes collapsing cheap enough
 * to be the answer to §5.1's "default collapse beyond level 3 when there are
 * more than ~50 nodes": the hidden subtree costs nothing, rather than being
 * laid out and then hidden.
 */
export function layoutTree(
  nodes: readonly NodeLike[],
  parents: ParentMap,
  children: ChildMap,
  dotted: ReadonlyMap<string, string[]>,
  options: LayoutOptions,
): Layout {
  const orientation = options.orientation ?? "vertical";
  const collapsed = options.collapsed ?? new Set<string>();
  /**
   * Columns stay UNSCALED until the very end.
   *
   * The first version of this centred a parent over the midpoint of its
   * children's PIXEL coordinates and then ran that through `coordsFor` again,
   * which multiplied an already-scaled value by the column width a second
   * time - so the root of a three-level tree landed 28,800px off screen. One
   * representation, converted exactly once, is the fix.
   */
  const columns = new Map<string, { column: number; depth: number; childCount: number; hasHiddenChildren: boolean }>();
  const edges: LayoutEdge[] = [];
  let nextColumn = 0;

  // Explicit stack rather than recursion: §12 asks for a few hundred nodes,
  // and a 200-deep chain of `place()` frames is a stack overflow in a
  // browser tab rather than a slow render. The two-phase marker is how a
  // post-order traversal is expressed without the call stack.
  const place = (rootId: string) => {
    const stack: { id: string; depth: number; expanded: boolean }[] = [
      { id: rootId, depth: 0, expanded: false },
    ];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const kids = collapsed.has(frame.id) ? [] : (children.get(frame.id) ?? []);
      const allKids = children.get(frame.id) ?? [];

      if (!frame.expanded) {
        if (seen.has(frame.id)) {
          stack.pop();
          continue;
        }
        seen.add(frame.id);
        frame.expanded = true;
        // Pushed in reverse so the first child is processed first and columns
        // run left to right in render order.
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push({ id: kids[i], depth: frame.depth + 1, expanded: false });
        }
        continue;
      }

      stack.pop();
      const drawn = kids.map((id) => columns.get(id)).filter((n): n is { column: number; depth: number; childCount: number; hasHiddenChildren: boolean } => !!n);
      const column =
        drawn.length > 0 ? (drawn[0].column + drawn[drawn.length - 1].column) / 2 : nextColumn++;
      columns.set(frame.id, {
        column,
        depth: frame.depth,
        childCount: allKids.length,
        hasHiddenChildren: allKids.length > 0 && kids.length === 0,
      });
      for (const child of kids) edges.push({ from: frame.id, to: child, type: "solid" });
    }
  };

  for (const rootId of rootsOf(nodes, parents)) place(rootId);

  /**
   * A node not reached above is either HIDDEN behind a collapsed ancestor or
   * stranded in a ring, and the two must not be treated alike.
   *
   * Hidden is the normal case and must stay off the canvas - the first version
   * of this swept every unplaced node into a trailing row, which put a
   * collapsed manager's reports back on screen underneath everything else,
   * defeated the collapse entirely and drew dotted lines into a subtree
   * somebody had just folded away.
   *
   * Stranded IS drawn, in a row of its own, for the reason `parentMapAsOf` is
   * total: the chart is how somebody finds broken data, and a seat that
   * silently vanishes is the one they will never find.
   */
  const hidden = new Set<string>();
  for (const id of collapsed) {
    for (const descendant of subtreeOf(children, id)) {
      if (descendant !== id) hidden.add(descendant);
    }
  }
  const stranded = nodes.filter((n) => !columns.has(n.id) && !hidden.has(n.id));
  if (stranded.length > 0) {
    const depth = Math.max(0, ...[...columns.values()].map((n) => n.depth)) + 1;
    for (const node of stranded) {
      columns.set(node.id, {
        column: nextColumn++,
        depth,
        childCount: (children.get(node.id) ?? []).length,
        hasHiddenChildren: false,
      });
    }
  }

  const placed = new Map<string, PlacedNode>();
  for (const [id, cell] of columns) {
    placed.set(id, {
      id,
      ...coordsFor(cell.column, cell.depth, orientation, options),
      depth: cell.depth,
      childCount: cell.childCount,
      hasHiddenChildren: cell.hasHiddenChildren,
    });
  }

  // §5.2: dotted lines are drawn only when BOTH ends are on screen. A dashed
  // line into a collapsed subtree would end in mid-air, which reads as a
  // rendering fault rather than as hidden information.
  for (const [positionId, managers] of dotted) {
    if (!placed.has(positionId)) continue;
    for (const managerId of managers) {
      if (!placed.has(managerId)) continue;
      edges.push({ from: managerId, to: positionId, type: "dotted" });
    }
  }

  const all = [...placed.values()];
  const width = all.reduce((max, n) => Math.max(max, n.x + options.nodeWidth), 0);
  const height = all.reduce((max, n) => Math.max(max, n.y + options.nodeHeight), 0);
  return { nodes: all.sort((a, b) => a.depth - b.depth || a.x - b.x), edges, width, height };
}

function coordsFor(
  column: number,
  depth: number,
  orientation: "vertical" | "horizontal",
  options: LayoutOptions,
): { x: number; y: number } {
  const across = column * (sizeAcross(orientation, options) + gapAcross(orientation, options));
  const along = depth * (sizeAlong(orientation, options) + gapAlong(orientation, options));
  return orientation === "vertical" ? { x: across, y: along } : { x: along, y: across };
}

const sizeAcross = (o: "vertical" | "horizontal", opt: LayoutOptions) =>
  o === "vertical" ? opt.nodeWidth : opt.nodeHeight;
const sizeAlong = (o: "vertical" | "horizontal", opt: LayoutOptions) =>
  o === "vertical" ? opt.nodeHeight : opt.nodeWidth;
const gapAcross = (o: "vertical" | "horizontal", opt: LayoutOptions) =>
  o === "vertical" ? opt.gapX : opt.gapY;
const gapAlong = (o: "vertical" | "horizontal", opt: LayoutOptions) =>
  o === "vertical" ? opt.gapY : opt.gapX;

/**
 * §5.1/§14: which nodes start collapsed.
 *
 * Collapse every seat AT the threshold depth, so levels 0..N are visible and
 * N+1 is folded behind a count badge. Only once the tree is bigger than
 * `overNodes` - a 20-person company collapsed to three levels is a chart
 * that hides a third of a business somebody could have seen at a glance.
 */
export function defaultCollapsed(
  nodes: readonly NodeLike[],
  parents: ParentMap,
  children: ChildMap,
  limits: { beyondLevel?: number; overNodes?: number } = {},
): Set<string> {
  const beyond = limits.beyondLevel ?? ORG_CHART_DEFAULTS.collapseBeyondLevel;
  const over = limits.overNodes ?? ORG_CHART_DEFAULTS.collapseOverNodes;
  if (nodes.length <= over) return new Set();
  const depths = depthMapOf(nodes, parents);
  const out = new Set<string>();
  for (const node of nodes) {
    if ((depths.get(node.id) ?? 0) !== beyond) continue;
    if ((children.get(node.id) ?? []).length === 0) continue;
    out.add(node.id);
  }
  return out;
}

/**
 * The ids that must be EXPANDED for every node in `targets` to be visible.
 *
 * §5.2's search: "highlight matches, auto-expand the path to them". The path
 * is the match's ancestors - a match itself stays collapsed if it was, because
 * expanding it would dump its whole subtree on somebody who searched for the
 * node, not for its reports.
 */
export function pathsToReveal(parents: ParentMap, targets: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const target of targets) for (const id of ancestorsOf(parents, target)) out.add(id);
  return out;
}
