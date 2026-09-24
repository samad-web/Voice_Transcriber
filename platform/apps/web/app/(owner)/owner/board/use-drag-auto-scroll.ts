"use client";

import { useEffect, type RefObject } from "react";

/**
 * How close to an edge, in px, the pointer must be before the board starts to
 * scroll. Wide enough to hit without aiming - a column is 18rem, so this is
 * roughly a third of the outermost one - and narrow enough that dropping on
 * that column does not fight a scroll.
 */
export const EDGE_ZONE_PX = 96;

/** Top speed in px per second, reached at (or past) the very edge. */
export const MAX_SPEED_PX_S = 1400;

/**
 * If no `dragover` has arrived for this long, the pointer has left the window
 * (browsers stop firing it there), so scrolling stops rather than running the
 * board to its end on its own.
 */
const STALE_POINTER_MS = 250;

/**
 * Signed horizontal scroll speed, in px per second, for a pointer at
 * `pointerX` over a scroller spanning `left`..`right`. Negative scrolls left.
 *
 * Zero in the middle; ramps up with the SQUARE of how deep the pointer is in
 * the edge zone, so the first few pixels creep (easy to line up a drop on the
 * outermost column) and holding at the very edge travels fast. A pointer past
 * the edge - over the sidebar, or off the right of the board - counts as fully
 * in the zone: that is where somebody pushing a card "further" ends up.
 *
 * Pure, so the curve is tested without a DOM (use-drag-auto-scroll.test.ts).
 */
export function edgeScrollSpeed(
  pointerX: number,
  left: number,
  right: number,
  zone = EDGE_ZONE_PX,
  maxSpeed = MAX_SPEED_PX_S,
): number {
  // A scroller narrower than two zones would have them overlap; shrink the
  // zone so the middle still exists and the two edges cannot cancel out.
  const z = Math.max(1, Math.min(zone, (right - left) / 3));
  const intoLeft = left + z - pointerX;
  const intoRight = pointerX - (right - z);
  const depth = intoLeft > 0 ? intoLeft : intoRight > 0 ? intoRight : 0;
  if (depth <= 0) return 0;
  const t = Math.min(1, depth / z);
  const speed = maxSpeed * t * t;
  return intoLeft > 0 ? -speed : speed;
}

/**
 * Scroll `scrollerRef` sideways while a card is dragged near its left or right
 * edge.
 *
 * WHY THIS EXISTS. The board uses the browser's own HTML5 drag-and-drop (see
 * kanban-board.tsx), and browsers only auto-scroll the WINDOW during a drag,
 * never an `overflow-x-auto` element inside it. So with more stages than fit
 * the screen, a card could not be dropped on a column that started off-screen:
 * the board sat still however hard it was pushed against the edge.
 *
 * HOW. `dragover` fires continuously while dragging - including when the
 * pointer is held still - and carries the pointer position. A document-level
 * listener records it, so the pointer is tracked even past the scroller's own
 * edges (over the sidebar), where the scroller receives no events. A single
 * requestAnimationFrame loop reads the latest position each frame and moves
 * `scrollLeft` by speed x elapsed time, which keeps the motion smooth and the
 * same speed on a 60Hz and a 120Hz screen. Nothing is scrolled from inside the
 * event handler itself: `dragover` arrives in bursts, and scrolling on it
 * directly stutters.
 *
 * Only while `active` (a card is being dragged), and fully torn down after, so
 * an idle board runs no loop and holds no listeners.
 */
export function useDragAutoScroll(scrollerRef: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let pointer: { x: number; y: number; at: number } | null = null;
    let frame = 0;
    let last = 0;
    // scrollLeft is rounded by some browsers, so sub-pixel steps at low speed
    // would be lost every frame and the board would never start moving.
    let carry = 0;

    const onDragOver = (e: DragEvent) => {
      pointer = { x: e.clientX, y: e.clientY, at: performance.now() };
    };
    const stop = () => {
      pointer = null;
    };

    const tick = (now: number) => {
      const dt = last ? Math.min(64, now - last) : 0; // cap: a backgrounded tab resumes without a leap
      last = now;
      if (pointer && now - pointer.at < STALE_POINTER_MS) {
        const rect = scroller.getBoundingClientRect();
        // Only when the pointer is level with the board - dragging past the
        // page header or the footer is not a request to scroll sideways.
        const level = pointer.y >= rect.top && pointer.y <= rect.bottom;
        const speed = level ? edgeScrollSpeed(pointer.x, rect.left, rect.right) : 0;
        if (speed !== 0 && dt > 0) {
          carry += (speed * dt) / 1000;
          const whole = Math.trunc(carry);
          if (whole !== 0) {
            scroller.scrollLeft += whole;
            carry -= whole;
          }
        } else {
          carry = 0;
        }
      }
      frame = requestAnimationFrame(tick);
    };

    document.addEventListener("dragover", onDragOver);
    document.addEventListener("drop", stop);
    document.addEventListener("dragend", stop);
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("drop", stop);
      document.removeEventListener("dragend", stop);
    };
  }, [scrollerRef, active]);
}
