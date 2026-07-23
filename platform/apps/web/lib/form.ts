/**
 * Shared form control classes. These were duplicated verbatim across ten page
 * components; hoisting them means the responsive rules below are applied once.
 *
 * Two rules matter on small screens:
 *  - `text-base sm:text-sm` — iOS Safari force-zooms the page when focusing a
 *    control whose font-size is under 16px, which leaves the layout scrolled
 *    sideways with no way back. Full size on phones, the compact size from
 *    `sm` up where the design intends it.
 *  - `min-w-0` — an <input>'s intrinsic min-width (~170px) otherwise stops it
 *    shrinking inside a flex row, overflowing the card on a narrow viewport.
 */
const BASE = "w-full min-w-0 p-2.5 border-2 border-black bg-neutral-50 rounded-none text-black focus:outline-none";

export const inputClass = `${BASE} text-base sm:text-sm font-sans`;

/** Same control, monospaced — used for ids, tokens and typed confirmations. */
export const monoInputClass = `${BASE} text-base sm:text-sm font-mono`;

/** Select/dropdown: the design uses the smaller uppercase label styling. */
export const selectClass = `${BASE} text-base sm:text-xs font-bold uppercase`;
