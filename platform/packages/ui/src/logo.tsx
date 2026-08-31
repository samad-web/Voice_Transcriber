import Image from "next/image";

/**
 * The Aura mark. Every consuming app serves the same artwork from its own
 * `/public/logo.png` — the component is shared so replacing the file is the
 * only step needed to change the mark everywhere, in both the console and
 * marketing.
 *
 * `next/image` rather than a bare `<img>`: the source is a large PNG, and
 * without optimisation every visitor downloads all of it to render a small
 * mark. Next serves a resized WebP per breakpoint instead.
 *
 * The artwork is transparent-background and reads on both the light and dark
 * grounds, so it needs no per-theme variant.
 */
export function Logo({
  size = 36,
  priority = false,
}: {
  size?: number;
  /** Set true for above-the-fold marks (hero, header) to avoid a pop-in. */
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
export function Wordmark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <Logo size={size} />
      <span
        className="text-[1.35rem] leading-none font-extrabold text-text"
        style={{ letterSpacing: "-0.045em" }}
      >
        Aura
      </span>
    </span>
  );
}
