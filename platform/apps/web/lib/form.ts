import { CONTROL_CHROME } from "@aura/ui";

/**
 * Shared form control classes. These were duplicated verbatim across ten page
 * components; hoisting them means the responsive rules below are applied once.
 *
 * Two rules matter on small screens:
 *  - `text-base sm:text-sm` - iOS Safari force-zooms the page when focusing a
 *    control whose font-size is under 16px, which leaves the layout scrolled
 *    sideways with no way back. Full size on phones, the compact size from
 *    `sm` up where the design intends it.
 *  - `min-w-0` - an <input>'s intrinsic min-width (~170px) otherwise stops it
 *    shrinking inside a flex row, overflowing the card on a narrow viewport.
 *
 * `CONTROL_CHROME` (the same border/fill/text tokens `Input`/`Select` use),
 * not the old hardcoded `border-2 border-black bg-neutral-50 text-black`: that
 * literal was invisible to `app/console-palette.test.ts` (it only scans
 * `.tsx`), so every one of this helper's nine consumers rendered black-on-grey
 * regardless of theme. No `focus:outline-none` either - the previous value
 * silently beat the global `:focus-visible` ring (Tailwind's utilities layer
 * outranks theme.css's `@layer base`), dropping the keyboard focus ring on
 * every field that used it; `Input`/`Select` never set it, for the same
 * reason.
 */
const BASE = `w-full min-w-0 p-2.5 ${CONTROL_CHROME}`;

export const inputClass = `${BASE} text-base sm:text-sm font-sans`;

/** Same control, monospaced - used for ids, tokens and typed confirmations. */
export const monoInputClass = `${BASE} text-base sm:text-sm font-mono`;

/*
 * `selectClass` was here. Every dropdown in the console now renders through
 * @aura/ui's `Select`, so there is no longer a second answer to "what does a
 * dropdown look like" - which is the whole reason it is gone rather than
 * deprecated. Do not reintroduce it: a `<select>` styled by a class string in
 * this file is invisible to `app/console-palette.test.ts`, which scans only
 * .tsx under app/, components/ and packages/ui/src. That blind spot is how
 * `bg-neutral-50` reached eleven files without the ratchet ever seeing it.
 *
 * For a dense table row, `Select` takes `size="sm"` - that is what the two
 * hand-rolled `text-[10px]` pickers in the team grid became.
 */
