import { cx } from "./cx";

/**
 * Does `className` already set an all-corners radius?
 *
 * Same trap, same fix as Card's OWNS_PADDING (card.tsx): `cx` is a plain join,
 * so a caller's `rounded-full` does not REPLACE the base `rounded-sm`, it only
 * lands later in the string - and Tailwind breaks that tie by position in the
 * generated stylesheet, which for the radius family is ALPHABETICAL:
 * `rounded-3xl, -full, -lg, -md, -none, -sm, -xl`. So the base `rounded-sm`
 * out-ranked `rounded-full`, `rounded-lg` and `rounded-md`, and every pill,
 * avatar circle and input box in every loading screen rendered as a
 * slightly-rounded rectangle. Only `rounded-xl` ever won. Nothing warned:
 * typecheck, lint and build were all clean, the skeleton just did not look
 * like the thing it stands in for.
 *
 * Only an all-corners, unprefixed radius counts. `rounded-t-lg` and friends
 * name a side or corner and are meant to sit ON TOP of the base, and
 * `md:rounded-none` is a responsive override that still needs it below `md`.
 */
const OWNS_RADIUS =
  /(?:^|\s)rounded(?:-(?!(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|ee|es)(?:-|\s|$))\S+)?(?=\s|$)/;

/**
 * Loading placeholder.
 *
 * `aria-hidden` + `role="presentation"`: a skeleton is a picture of content that
 * does not exist yet, and announcing a row of grey boxes is worse than
 * announcing nothing. The *container* is what should carry `aria-busy` while it
 * loads - this component cannot know where that boundary is.
 *
 * `animate-pulse` is flattened by the global `prefers-reduced-motion` rule in
 * theme.css, leaving a static block. That is the correct degradation: the
 * information is "content is coming", and the shape says that without moving.
 *
 * `onFill` is for a skeleton drawn ON a saturated surface - the KPI tile, whose
 * fill is `--color-kpi`. The default `bg-border` is a light grey chosen to read
 * against a white card and is close to invisible on an orange one, so on-fill
 * bars are the tile's own foreground at low alpha instead. It is a prop that
 * SWAPS the base fill rather than a `bg-*` in `className`, for the reason above:
 * two background utilities on one element is a stylesheet-order coin toss.
 *
 * `onPaper` is the same idea for a sheet that is white in BOTH themes - the
 * printed report, whose page is a fixed `bg-white`. `bg-border` is a dark grey in
 * dark mode, which on white paper is heavy black ink rather than a placeholder;
 * a fixed 10% black is light grey on white whichever theme surrounds it.
 */
export function Skeleton({
  className = "",
  onFill = false,
  onPaper = false,
}: {
  className?: string;
  onFill?: boolean;
  onPaper?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      role="presentation"
      className={cx(
        "animate-pulse",
        OWNS_RADIUS.test(className) ? null : "rounded-sm",
        onFill ? "bg-kpi-fg/25" : onPaper ? "bg-black/10" : "bg-border",
        className,
      )}
    />
  );
}

/** A stack of text-line skeletons, last line short, the way a paragraph ends. */
export function SkeletonText({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cx("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
