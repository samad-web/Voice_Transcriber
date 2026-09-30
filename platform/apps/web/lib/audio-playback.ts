/**
 * One recording plays at a time, console-wide.
 *
 * ── WHY A MODULE, NOT A CONTEXT ─────────────────────────────────────────────
 *
 * The call log renders 50 rows, each with its own player. "Pausing the other
 * one" is a side effect on a DOM node, not shared render state: no row's markup
 * depends on whether a DIFFERENT row is playing. A React context would put
 * every row in one subscriber set and re-render all 50 on each play/pause -
 * paying a full table render for something one `pause()` call does.
 *
 * So the holder lives here, in module scope, and the only thing that ever reads
 * it is `claimPlayback`. A row's own play/pause state stays local to that row.
 *
 * ── WHY IT COVERS THE DRAWER TOO ────────────────────────────────────────────
 *
 * The inline row players are not the only `<audio>` in the console: opening a
 * call's drawer gives you a second, full-size one. Two recordings talking over
 * each other is the same bug whichever pair of elements does it, so both
 * drawers claim through here as well. That is the whole reason this is not a
 * private detail of the inline player component.
 *
 * ── THE ORDERING THAT MATTERS ───────────────────────────────────────────────
 *
 * `holder` is reassigned BEFORE the outgoing element is paused. `pause()`
 * dispatches a `pause` event synchronously, and the element's own handler calls
 * `releasePlayback(itself)` - which, if the holder were still pointing at it,
 * would clear the slot we are in the middle of filling and leave the new player
 * unregistered. Then the next row to start would pause nothing.
 */

/** All the registry needs of a media element - so a test can pass a stub. */
export interface PausableMedia {
  pause(): void;
}

let holder: PausableMedia | null = null;

/**
 * Take the console's single playback slot, pausing whoever held it.
 *
 * Called from the `play` event rather than from the click handler on purpose:
 * playback also starts without a click (autoplay after a lazy src arrives, a
 * browser's own media keys), and the event is the one place every route to
 * "this element is now making sound" passes through.
 */
export function claimPlayback(next: PausableMedia): void {
  if (holder === next) return;
  const previous = holder;
  holder = next;
  previous?.pause();
}

/**
 * Give up the slot, if this element still holds it.
 *
 * The conditional is not defensive noise - it is what makes pausing safe. When
 * A hands over to B, A's `pause` event fires after the slot already says B, and
 * an unconditional clear here would drop B on the floor.
 */
export function releasePlayback(media: PausableMedia): void {
  if (holder === media) holder = null;
}

/** Exported for the tests; nothing in the console reads the slot directly. */
export function playbackHolder(): PausableMedia | null {
  return holder;
}
