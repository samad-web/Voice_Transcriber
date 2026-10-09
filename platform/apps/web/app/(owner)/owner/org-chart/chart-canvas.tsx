"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  HOLDER_PRESENCE_LABELS,
  POSITION_STATUS_LABELS,
  avatarToneFor,
  childMapOf,
  initialsOf,
  layoutTree,
  parentMapAsOf,
  type AvatarTone,
} from "@aura/shared";
import type { ChartEdge, ChartNode } from "./types";

/**
 * The chart canvas (Build docs/org-chart-build-plan.md §3, §5.1, §5.2, §5.4).
 *
 * ── WHY THIS IS SVG AND NOT HTML BOXES ─────────────────────────────────────
 *
 * The obvious build is absolutely-positioned divs with an SVG layer behind for
 * the connectors - it would make the nodes ordinary Tailwind components. It is
 * SVG throughout instead, for one reason that outweighs that: §5.2 requires a
 * PNG export "of the current view", and an SVG tree serialises to a canvas in
 * about fifteen lines with no dependency, where an HTML tree needs
 * `html-to-image` or similar. `pnpm --filter apps/web add` has orphaned `next`
 * in a sibling package in this repo before, so a new front-end dependency is
 * not a small decision.
 *
 * §3's "use design tokens, never literals" survives the choice: SVG
 * presentation attributes accept `var(--color-surface)`, so every fill and
 * stroke below is a token and dark mode works through the same stylesheet as
 * the rest of the console. The one place that needs care is the export, where
 * a detached SVG has no stylesheet to resolve the variables against - see
 * `exportPng`, which reads the computed values and inlines them.
 *
 * ── WHAT IS NOT DRAWN HERE ─────────────────────────────────────────────────
 *
 * No layout maths. `layoutTree` lives in `@aura/shared` and the PDF exporter
 * calls the same function with the same node size, which is what makes the
 * three renderings of this chart agree. Nothing in this file decides where a
 * node goes.
 */

// §3's node: a circular avatar, a dark rounded name pill beneath it, then the
// job position and a one-line subtitle. The numbers are SVG user units, which
// are CSS pixels at zoom 1.
const NODE_W = 196;
const NODE_H = 116;
const GAP_X = 26;
const GAP_Y = 62;
const AVATAR_R = 21;
const AVATAR_CY = 28;
const PAD = 48;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.4;

/** Tone -> the token pair the kit already defines for labels. */
const TONE_FILL: Record<AvatarTone, string> = {
  violet: "var(--color-label-violet)",
  plum: "var(--color-label-plum)",
  teal: "var(--color-label-teal)",
  steel: "var(--color-label-steel)",
};
const TONE_TEXT: Record<AvatarTone, string> = {
  violet: "var(--color-label-violet-text)",
  plum: "var(--color-label-plum-text)",
  teal: "var(--color-label-teal-text)",
  steel: "var(--color-label-steel-text)",
};

/**
 * §3's status dot, by presence.
 *
 * `on_leave` is the KPI orange rather than the danger red, deliberately. The
 * console-wide rule is that red means MISSED and never "error" - and somebody
 * being on leave is neither. Orange is the attention tier.
 */
const PRESENCE_FILL: Record<string, string> = {
  active: "var(--color-success)",
  on_leave: "var(--color-orange)",
  probation: "var(--color-info)",
  vacant: "var(--color-text-subtle)",
};

export interface ChartCanvasProps {
  nodes: ChartNode[];
  solidLines: ChartEdge[];
  dottedLines: ChartEdge[];
  collapsed: Set<string>;
  onToggleCollapse: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Ids to draw as search hits (§5.2). */
  matches: Set<string>;
  /** Ids on the selected node's chain of command (§5.2's path highlight). */
  pathIds: Set<string>;
  orientation: "vertical" | "horizontal";
  showDotted: boolean;
  /** Drag-and-drop is owner/admin only (§14), and never in the past (§5.2). */
  canMove: boolean;
  onRequestMove: (positionId: string, newManagerPositionId: string) => void;
  /** Bumped by the parent to trigger a PNG download. */
  exportToken: number;
  exportFileName: string;
}

export function ChartCanvas({
  nodes,
  solidLines,
  dottedLines,
  collapsed,
  onToggleCollapse,
  selectedId,
  onSelect,
  matches,
  pathIds,
  orientation,
  showDotted,
  canMove,
  onRequestMove,
  exportToken,
  exportFileName,
}: ChartCanvasProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ x: PAD, y: PAD, k: 1 });
  const [dragging, setDragging] = useState<{ id: string; x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const panRef = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  /**
   * The edges, as the shared layout wants them.
   *
   * `layoutTree` takes `LineLike[]` with effective dates; the payload has
   * already resolved them for `asOf`, so the dates are left out and every row
   * is live. Resolving twice would be the chance for the browser and the API
   * to disagree about which structure is current.
   */
  const layout = useMemo(() => {
    const lines = [
      ...solidLines.map((e) => ({
        positionId: e.positionId,
        managerPositionId: e.managerPositionId,
        type: "solid" as const,
      })),
      ...(showDotted
        ? dottedLines.map((e) => ({
            positionId: e.positionId,
            managerPositionId: e.managerPositionId,
            type: "dotted" as const,
          }))
        : []),
    ];
    const parents = parentMapAsOf(lines, "9999-12-31");
    const children = childMapOf(nodes, parents);
    const dotted = new Map<string, string[]>();
    if (showDotted) {
      for (const edge of dottedLines) {
        const held = dotted.get(edge.positionId) ?? [];
        held.push(edge.managerPositionId);
        dotted.set(edge.positionId, held);
      }
    }
    return {
      ...layoutTree(nodes, parents, children, dotted, {
        nodeWidth: NODE_W,
        nodeHeight: NODE_H,
        gapX: GAP_X,
        gapY: GAP_Y,
        orientation,
        collapsed,
      }),
      children,
    };
  }, [nodes, solidLines, dottedLines, collapsed, orientation, showDotted]);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const placed = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const contentW = layout.width + PAD * 2;
  const contentH = layout.height + PAD * 2;

  /** §5.2's "fit to screen". */
  const fit = useCallback(() => {
    const frame = frameRef.current;
    if (!frame || contentW === 0 || contentH === 0) return;
    const k = Math.min(
      1,
      Math.max(MIN_ZOOM, Math.min(frame.clientWidth / contentW, frame.clientHeight / contentH)),
    );
    setView({
      x: (frame.clientWidth - layout.width * k) / 2,
      y: Math.max(PAD * k, (frame.clientHeight - layout.height * k) / 2),
      k,
    });
  }, [contentW, contentH, layout.width, layout.height]);

  // Fit once the first layout exists, and again if the tree's SIZE changes -
  // not on every layout change, which would yank the view out from under
  // somebody who had just panned to look at a branch and then collapsed it.
  const sizeKey = `${nodes.length}:${orientation}`;
  const lastSizeKey = useRef<string>("");
  useEffect(() => {
    if (lastSizeKey.current === sizeKey) return;
    lastSizeKey.current = sizeKey;
    fit();
  }, [sizeKey, fit]);

  /** Keep the selected node on screen when search or a deep link jumps to it. */
  useEffect(() => {
    if (!selectedId) return;
    const node = placed.get(selectedId);
    const frame = frameRef.current;
    if (!node || !frame) return;
    const screenX = node.x * view.k + view.x;
    const screenY = node.y * view.k + view.y;
    const visible =
      screenX > 0 &&
      screenY > 0 &&
      screenX + NODE_W * view.k < frame.clientWidth &&
      screenY + NODE_H * view.k < frame.clientHeight;
    if (visible) return;
    setView((v) => ({
      ...v,
      x: frame.clientWidth / 2 - (node.x + NODE_W / 2) * v.k,
      y: frame.clientHeight / 2 - (node.y + NODE_H / 2) * v.k,
    }));
    // `view` is read but deliberately not a dependency: including it would
    // re-centre on every pan, which would make the canvas impossible to drag.
  }, [selectedId, placed]);

  // ── Pan and zoom ─────────────────────────────────────────────────────────

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    if (dragging) return;
    panRef.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (dragging) {
      setDragging((d) => (d ? { ...d, x: event.clientX, y: event.clientY } : d));
      return;
    }
    const pan = panRef.current;
    if (!pan) return;
    setView((v) => ({ ...v, x: pan.vx + (event.clientX - pan.x), y: pan.vy + (event.clientY - pan.y) }));
  };

  const onPointerUp = () => {
    panRef.current = null;
    if (dragging) {
      if (dropTarget && dropTarget !== dragging.id) onRequestMove(dragging.id, dropTarget);
      setDragging(null);
      setDropTarget(null);
    }
  };

  /**
   * Wheel to zoom, anchored on the pointer.
   *
   * `passive: false` and a manual listener, because React's `onWheel` is
   * registered passively and `preventDefault` inside it is ignored - so the
   * page would scroll behind the chart while the chart zoomed.
   */
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey && Math.abs(event.deltaY) < 2) return;
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      setView((v) => {
        const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
        // Keep the point under the cursor fixed: the only zoom that does not
        // feel like the chart jumping away from what you were looking at.
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    frame.addEventListener("wheel", onWheel, { passive: false });
    return () => frame.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (factor: number) =>
    setView((v) => {
      const frame = frameRef.current;
      const cx = (frame?.clientWidth ?? 0) / 2;
      const cy = (frame?.clientHeight ?? 0) / 2;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });

  // ── §5.4 keyboard navigation ─────────────────────────────────────────────

  /**
   * Arrow keys move along the tree, Enter opens, Space toggles.
   *
   * Up/down walk the chain of command; left/right walk the siblings. In the
   * horizontal view the pairs swap, so the keys always match what the reader
   * SEES rather than what the data calls a parent - a left arrow that moved
   * "up" in a left-to-right tree would be the wrong direction on screen.
   */
  const onKeyDown = (event: React.KeyboardEvent, id: string) => {
    const node = byId.get(id);
    if (!node) return;
    const parentOf = (child: string) =>
      solidLines.find((e) => e.positionId === child)?.managerPositionId ?? null;
    /**
     * A node's drawn siblings. A ROOT has none - its "siblings" would be the
     * other roots, and a well-formed chart has one, so left/right simply does
     * nothing there rather than jumping to an unrelated branch.
     */
    const siblingsOf = (child: string) => {
      const parent = parentOf(child);
      if (!parent) return [];
      return (layout.children.get(parent) ?? []).filter((sid) => placed.has(sid));
    };

    const toParent = () => parentOf(id);
    const toChild = () => (collapsed.has(id) ? null : (layout.children.get(id) ?? [])[0] ?? null);
    const toSibling = (delta: number) => {
      const siblings = siblingsOf(id);
      const index = siblings.indexOf(id);
      if (index < 0) return null;
      return siblings[index + delta] ?? null;
    };

    const vertical = orientation === "vertical";
    let next: string | null = null;
    switch (event.key) {
      case "ArrowUp":
        next = vertical ? toParent() : toSibling(-1);
        break;
      case "ArrowDown":
        next = vertical ? toChild() : toSibling(1);
        break;
      case "ArrowLeft":
        next = vertical ? toSibling(-1) : toParent();
        break;
      case "ArrowRight":
        next = vertical ? toSibling(1) : toChild();
        break;
      case "Enter":
        event.preventDefault();
        onSelect(id);
        return;
      case " ":
      case "Spacebar":
        event.preventDefault();
        if ((layout.children.get(id) ?? []).length > 0) onToggleCollapse(id);
        return;
      default:
        return;
    }
    if (!next) return;
    event.preventDefault();
    onSelect(next);
    // Move the real focus, so a screen reader announces the node arrived at.
    const el = svgRef.current?.querySelector<SVGGElement>(`[data-position-id="${next}"]`);
    el?.focus();
  };

  // ── §5.2's PNG export ────────────────────────────────────────────────────

  useEffect(() => {
    if (exportToken === 0) return;
    void exportPng(svgRef.current, contentW, contentH, exportFileName);
  }, [exportToken, contentW, contentH, exportFileName]);

  if (nodes.length === 0) return null;

  return (
    <div className="relative">
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex flex-col gap-1">
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-md border border-border bg-surface shadow-sm">
          <button
            type="button"
            onClick={() => zoomBy(1.2)}
            aria-label="Zoom in"
            className="px-2 py-1 text-sm text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => zoomBy(1 / 1.2)}
            aria-label="Zoom out"
            className="border-t border-border px-2 py-1 text-sm text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            −
          </button>
          <button
            type="button"
            onClick={fit}
            aria-label="Fit the whole chart on screen"
            className="border-t border-border px-2 py-1 text-[10px] uppercase tracking-wide text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            Fit
          </button>
        </div>
        <p className="pointer-events-none rounded bg-surface/80 px-1 text-right text-[10px] text-text-subtle">
          {Math.round(view.k * 100)}%
        </p>
      </div>

      <div
        ref={frameRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="h-[min(72vh,760px)] w-full touch-none overflow-hidden rounded-lg border border-border bg-bg-subtle"
        style={{ cursor: dragging ? "grabbing" : panRef.current ? "grabbing" : "grab" }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          role="tree"
          aria-label="Organization chart"
          /**
           * `prefers-reduced-motion` is respected by having NO transition on
           * the transform at all when it is set. A tree that eases into place
           * on every pan is motion somebody asked not to see, and §3 asks for
           * the app's existing conventions rather than a new one.
           */
          className="block motion-safe:transition-[transform] motion-safe:duration-0"
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {/* Connectors first, so a node's fill covers the line arriving at it. */}
            <g fill="none" strokeLinejoin="round">
              {layout.edges.map((edge) => {
                const from = placed.get(edge.from);
                const to = placed.get(edge.to);
                if (!from || !to) return null;
                return (
                  <path
                    key={`${edge.from}-${edge.to}-${edge.type}`}
                    d={connectorPath(from, to, orientation)}
                    stroke={
                      pathIds.has(edge.to) && pathIds.has(edge.from)
                        ? "var(--color-accent)"
                        : "var(--color-border-strong)"
                    }
                    strokeWidth={pathIds.has(edge.to) && pathIds.has(edge.from) ? 2 : 1}
                    strokeDasharray={edge.type === "dotted" ? "4 4" : undefined}
                    opacity={edge.type === "dotted" ? 0.75 : 1}
                  />
                );
              })}
            </g>

            {layout.nodes.map((spot) => {
              const node = byId.get(spot.id);
              if (!node) return null;
              return (
                <PositionNodeShape
                  key={spot.id}
                  node={node}
                  x={spot.x}
                  y={spot.y}
                  childCount={spot.childCount}
                  isCollapsed={collapsed.has(spot.id)}
                  isSelected={selectedId === spot.id}
                  isMatch={matches.has(spot.id)}
                  onPath={pathIds.has(spot.id)}
                  isDropTarget={dropTarget === spot.id}
                  isDragging={dragging?.id === spot.id}
                  canMove={canMove}
                  onOpen={() => onSelect(spot.id)}
                  onToggle={() => onToggleCollapse(spot.id)}
                  onKeyDown={(e) => onKeyDown(e, spot.id)}
                  onDragStart={(e) => {
                    if (!canMove) return;
                    e.stopPropagation();
                    panRef.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
                    setDragging({ id: spot.id, x: e.clientX, y: e.clientY });
                  }}
                  onDragEnter={() => {
                    if (dragging && dragging.id !== spot.id) setDropTarget(spot.id);
                  }}
                  onDragLeave={() => {
                    setDropTarget((current) => (current === spot.id ? null : current));
                  }}
                />
              );
            })}
          </g>
        </svg>
      </div>

      {/* `aria-live`, so a keyboard or screen-reader user is told what a drag
          is currently over rather than having to infer it from a border. */}
      {dragging ? (
        <p aria-live="polite" className="mt-2 text-xs text-text-muted">
          {dropTarget
            ? `Drop on ${byId.get(dropTarget)?.title ?? "this position"} to make it the new manager.`
            : "Drag onto the position this should report to."}
        </p>
      ) : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// One node
// ───────────────────────────────────────────────────────────────────────────

interface NodeShapeProps {
  node: ChartNode;
  x: number;
  y: number;
  childCount: number;
  isCollapsed: boolean;
  isSelected: boolean;
  isMatch: boolean;
  onPath: boolean;
  isDropTarget: boolean;
  isDragging: boolean;
  canMove: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onDragStart: (event: React.PointerEvent) => void;
  onDragEnter: () => void;
  onDragLeave: () => void;
}

function PositionNodeShape({
  node,
  x,
  y,
  childCount,
  isCollapsed,
  isSelected,
  isMatch,
  onPath,
  isDropTarget,
  isDragging,
  canMove,
  onOpen,
  onToggle,
  onKeyDown,
  onDragStart,
  onDragEnter,
  onDragLeave,
}: NodeShapeProps) {
  const vacant = node.status === "vacant";
  const tone = avatarToneFor(node.departmentName ?? node.title);
  const name = node.holder?.name ?? node.holder?.email ?? null;

  /**
   * §5.4: "Screen-reader labels containing name, position, status and report
   * count."
   *
   * One sentence, in that order, because a reader arriving on a node by arrow
   * key hears this and nothing else. The report count is included even when it
   * is zero-and-absent from the visible badge, since "no reports" is the fact
   * that tells somebody they have reached a leaf.
   */
  const label = [
    name ?? "Vacant",
    node.title,
    node.subtitle,
    POSITION_STATUS_LABELS[node.status],
    node.holder ? HOLDER_PRESENCE_LABELS[node.presence] : null,
    childCount === 1 ? "1 direct report" : `${childCount} direct reports`,
    isCollapsed ? "reports hidden" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <g
      data-position-id={node.id}
      transform={`translate(${x} ${y})`}
      role="treeitem"
      aria-selected={isSelected}
      aria-expanded={childCount > 0 ? !isCollapsed : undefined}
      aria-label={label}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerEnter={onDragEnter}
      onPointerLeave={onDragLeave}
      opacity={isDragging ? 0.45 : 1}
      className="cursor-pointer outline-none [&:focus-visible>.node-ring]:opacity-100"
    >
      {/* The focus ring, from the tokens (§5.4). A separate rect so it can sit
          outside the card's own border without changing its geometry. */}
      <rect
        className="node-ring opacity-0 transition-opacity"
        x={-3}
        y={-3}
        width={NODE_W + 6}
        height={NODE_H + 6}
        rx={12}
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth={2}
      />

      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={vacant ? "var(--color-bg-subtle)" : "var(--color-surface)"}
        stroke={
          isDropTarget
            ? "var(--color-accent)"
            : isSelected || onPath
              ? "var(--color-accent)"
              : isMatch
                ? "var(--color-orange)"
                : "var(--color-border)"
        }
        strokeWidth={isDropTarget || isSelected ? 2 : isMatch ? 2 : 1}
        /* §3: a vacant seat is a DASHED outline, which survives a greyscale
           print and does not rely on colour alone (§3.4). */
        strokeDasharray={vacant && !isDropTarget && !isSelected ? "5 4" : undefined}
        onPointerDown={canMove ? onDragStart : undefined}
        onClick={onOpen}
      />

      {/* §3's highlight ring on any node with direct reports. */}
      {childCount > 0 ? (
        <circle
          cx={NODE_W / 2}
          cy={AVATAR_CY}
          r={AVATAR_R + 4}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          opacity={0.45}
        />
      ) : null}

      <circle
        cx={NODE_W / 2}
        cy={AVATAR_CY}
        r={AVATAR_R}
        fill={vacant ? "var(--color-bg-subtle)" : TONE_FILL[tone]}
        stroke={vacant ? "var(--color-border-strong)" : "transparent"}
        strokeDasharray={vacant ? "4 3" : undefined}
      />
      {/* §14: initials on a token-coloured background, never a silhouette. A
          vacant seat shows a plus instead, which is also its action. */}
      <text
        x={NODE_W / 2}
        y={AVATAR_CY + 5}
        textAnchor="middle"
        fontSize={vacant ? 18 : 14}
        fontWeight={600}
        fill={vacant ? "var(--color-text-subtle)" : TONE_TEXT[tone]}
        className="select-none"
        onClick={onOpen}
      >
        {vacant ? "+" : initialsOf(name)}
      </text>

      {/* §3's status dot, with a text cue in the aria label above so colour is
          never the only signal (§3.4). */}
      <circle
        cx={NODE_W / 2 + AVATAR_R - 2}
        cy={AVATAR_CY + AVATAR_R - 6}
        r={5}
        fill={PRESENCE_FILL[node.presence] ?? "var(--color-text-subtle)"}
        stroke="var(--color-surface)"
        strokeWidth={1.5}
      />

      {/* §3's dark rounded name pill. */}
      <rect
        x={14}
        y={AVATAR_CY + AVATAR_R + 6}
        width={NODE_W - 28}
        height={21}
        rx={10.5}
        fill={vacant ? "transparent" : "var(--color-text)"}
        stroke={vacant ? "var(--color-border-strong)" : "transparent"}
        strokeDasharray={vacant ? "4 3" : undefined}
        onClick={onOpen}
      />
      <text
        x={NODE_W / 2}
        y={AVATAR_CY + AVATAR_R + 20.5}
        textAnchor="middle"
        fontSize={11.5}
        fontWeight={600}
        fill={vacant ? "var(--color-text-muted)" : "var(--color-bg)"}
        className="select-none"
        onClick={onOpen}
      >
        {truncate(name ?? "Vacant", 24)}
      </text>

      <text
        x={NODE_W / 2}
        y={AVATAR_CY + AVATAR_R + 40}
        textAnchor="middle"
        fontSize={11}
        fill="var(--color-text)"
        className="select-none"
        onClick={onOpen}
      >
        {truncate(node.title, 26)}
      </text>
      {node.subtitle ? (
        <text
          x={NODE_W / 2}
          y={AVATAR_CY + AVATAR_R + 54}
          textAnchor="middle"
          fontSize={9.5}
          fill="var(--color-text-muted)"
          className="select-none"
          onClick={onOpen}
        >
          {truncate(node.subtitle, 30)}
        </text>
      ) : null}

      {node.acting.length > 0 ? (
        <text
          x={NODE_W - 10}
          y={14}
          textAnchor="end"
          fontSize={8.5}
          fontWeight={600}
          fill="var(--color-info-text)"
          className="select-none"
        >
          ACTING
        </text>
      ) : null}

      {/* §3/§5.2: the count badge doubles as the expand/collapse toggle. */}
      {childCount > 0 ? (
        <g
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          role="button"
          aria-label={
            isCollapsed
              ? `Show ${childCount} position${childCount === 1 ? "" : "s"} under ${node.title}`
              : `Hide the ${childCount} position${childCount === 1 ? "" : "s"} under ${node.title}`
          }
          className="cursor-pointer"
        >
          <circle
            cx={NODE_W / 2}
            cy={NODE_H}
            r={11}
            fill="var(--color-surface)"
            stroke={isCollapsed ? "var(--color-accent)" : "var(--color-border-strong)"}
            strokeWidth={isCollapsed ? 2 : 1}
          />
          <text
            x={NODE_W / 2}
            y={NODE_H + 4}
            textAnchor="middle"
            fontSize={10}
            fontWeight={600}
            fill={isCollapsed ? "var(--color-accent-text)" : "var(--color-text-muted)"}
            className="select-none"
          >
            {childCount}
          </text>
        </g>
      ) : null}
    </g>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Geometry and export
// ───────────────────────────────────────────────────────────────────────────

/**
 * §3's right-angle connector with a horizontal bus above each group of
 * children: out of the parent, along the bus, into the child.
 *
 * The bus sits at the MIDPOINT of the gap, so every child of one parent shares
 * the same horizontal run and the group reads as one bracket rather than as a
 * set of unrelated elbows.
 */
function connectorPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  orientation: "vertical" | "horizontal",
): string {
  if (orientation === "vertical") {
    const sx = from.x + NODE_W / 2;
    const sy = from.y + NODE_H;
    const ex = to.x + NODE_W / 2;
    const ey = to.y;
    const bus = sy + GAP_Y / 2;
    return `M ${sx} ${sy} L ${sx} ${bus} L ${ex} ${bus} L ${ex} ${ey}`;
  }
  const sx = from.x + NODE_W;
  const sy = from.y + NODE_H / 2;
  const ex = to.x;
  const ey = to.y + NODE_H / 2;
  const bus = sx + GAP_X / 2;
  return `M ${sx} ${sy} L ${bus} ${sy} L ${bus} ${ey} L ${ex} ${ey}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * §5.2's PNG export, with no dependency.
 *
 * ── THE ONE HARD PART: TOKENS DO NOT SURVIVE SERIALISATION ─────────────────
 *
 * Every fill above is `var(--color-…)`, which resolves against the document's
 * stylesheet. A serialised SVG loaded into an `Image` has no document, so
 * every one of those variables would resolve to nothing and the export would
 * be a blank rectangle with black text.
 *
 * So the variables are read off the live element with `getComputedStyle` and
 * substituted into the serialised copy. That keeps §3's rule intact for the
 * thing people actually look at - the screen - while still producing a correct
 * file, and it means the export follows light or dark mode exactly as the
 * reader has it.
 *
 * The clone is also re-framed to the FULL chart rather than the visible
 * viewport: a person who has panned to the middle of a large tree means "give
 * me this chart", not "give me this rectangle of it". What they collapsed IS
 * respected, because the clone is of the current layout.
 */
async function exportPng(
  svg: SVGSVGElement | null,
  width: number,
  height: number,
  fileName: string,
): Promise<void> {
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const computed = getComputedStyle(svg);

  const resolve = (value: string): string =>
    value.replace(/var\((--[a-z0-9-]+)\)/gi, (_match, name: string) => {
      const resolved = computed.getPropertyValue(name).trim();
      // A token that resolves to nothing would silently become an invalid
      // attribute, which some renderers treat as black. `transparent` is the
      // honest fallback for a fill we could not read.
      return resolved || "transparent";
    });

  for (const element of clone.querySelectorAll<SVGElement>("*")) {
    for (const attribute of ["fill", "stroke"]) {
      const value = element.getAttribute(attribute);
      if (value?.includes("var(")) element.setAttribute(attribute, resolve(value));
    }
  }

  // Drop the pan/zoom so the file contains the whole chart at 1:1.
  const root = clone.querySelector("g");
  root?.setAttribute("transform", `translate(${PAD} ${PAD})`);
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");

  // The page background, so a dark-mode export is not transparent-on-white.
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", computed.getPropertyValue("--color-bg").trim() || "#ffffff");
  clone.insertBefore(background, clone.firstChild);

  const markup = new XMLSerializer().serializeToString(clone);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));

  try {
    const image = new Image();
    image.decoding = "sync";
    await new Promise<void>((resolve2, reject) => {
      image.onload = () => resolve2();
      image.onerror = () => reject(new Error("The chart image could not be prepared."));
      image.src = url;
    });

    // 2x, so the file is legible when somebody pastes it into a document.
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(scale, scale);
    context.drawImage(image, 0, 0);

    const blob = await new Promise<Blob | null>((resolve2) => canvas.toBlob(resolve2, "image/png"));
    if (!blob) return;
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(href);
  } finally {
    URL.revokeObjectURL(url);
  }
}
