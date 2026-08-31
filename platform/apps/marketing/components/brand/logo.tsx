import Image from "next/image";

/**
 * The Aura mark - the real artwork, at `public/logo.png`.
 *
 * Every call site goes through this component, so replacing the file is the
 * only step needed to change the mark everywhere.
 *
 * `next/image` rather than a bare `<img>`: the source is a 519 kB PNG, and
 * without optimisation every visitor downloads all of it to render a 32 px
 * header mark on a phone over 4G. Next serves a resized WebP per breakpoint
 * instead. `priority` is set because the mark is in the hero and the header -
 * above the fold on every page - so lazy-loading it would cost a visible pop-in
 * on the first paint.
 *
 * The artwork is transparent-background and reads on both the light and dark
 * grounds, so it needs no per-theme variant.
 */
export function Logo({
  size = 36,
  priority = true,
}: {
  size?: number;
  priority?: boolean;
}) {
  return (
    <Image
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      priority={priority}
      aria-hidden="true"
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}

/** The mark plus the wordmark, as one lockup. */
export function Wordmark({ size = 36 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <Logo size={size} />
      <span className="mk-display text-[1.35rem] leading-none" style={{ letterSpacing: "-0.045em" }}>
        Aura
      </span>
    </span>
  );
}
