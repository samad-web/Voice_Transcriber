import { describe, expect, it } from "vitest";
import { EDGE_ZONE_PX, MAX_SPEED_PX_S, edgeScrollSpeed } from "./use-drag-auto-scroll";

/**
 * The speed curve behind the board's drag auto-scroll. The requestAnimationFrame
 * loop around it is a few lines of plumbing; this is the part that decides how
 * the board feels, and it is pure.
 */
describe("edgeScrollSpeed", () => {
  // A 1000px-wide board starting 200px from the left of the viewport.
  const L = 200;
  const R = 1200;

  it("does nothing in the middle of the board", () => {
    expect(edgeScrollSpeed(700, L, R)).toBe(0);
    expect(edgeScrollSpeed(L + EDGE_ZONE_PX, L, R)).toBe(0);
    expect(edgeScrollSpeed(R - EDGE_ZONE_PX, L, R)).toBe(0);
  });

  it("scrolls left near the left edge and right near the right edge", () => {
    expect(edgeScrollSpeed(L + 10, L, R)).toBeLessThan(0);
    expect(edgeScrollSpeed(R - 10, L, R)).toBeGreaterThan(0);
  });

  it("speeds up the closer the pointer gets to the edge", () => {
    const far = edgeScrollSpeed(R - 80, L, R);
    const near = edgeScrollSpeed(R - 20, L, R);
    const edge = edgeScrollSpeed(R, L, R);
    expect(far).toBeGreaterThan(0);
    expect(near).toBeGreaterThan(far);
    expect(edge).toBe(MAX_SPEED_PX_S);
  });

  it("creeps at the start of the zone, so a drop on the outer column is easy", () => {
    // A tenth of the way in moves at 1% of top speed (the curve is squared).
    expect(edgeScrollSpeed(R - EDGE_ZONE_PX * 0.9, L, R)).toBeCloseTo(MAX_SPEED_PX_S * 0.01, 5);
  });

  it("treats a pointer past the edge as fully in the zone", () => {
    // Over the sidebar, or off the right of the board - where a push ends up.
    expect(edgeScrollSpeed(L - 150, L, R)).toBe(-MAX_SPEED_PX_S);
    expect(edgeScrollSpeed(R + 150, L, R)).toBe(MAX_SPEED_PX_S);
  });

  it("keeps a middle on a narrow board, so the two edges never overlap", () => {
    // 150px wide: zones shrink to 50px each rather than covering everything.
    expect(edgeScrollSpeed(75, 0, 150)).toBe(0);
    expect(edgeScrollSpeed(5, 0, 150)).toBeLessThan(0);
    expect(edgeScrollSpeed(145, 0, 150)).toBeGreaterThan(0);
  });
});
