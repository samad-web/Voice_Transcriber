import Image from "next/image";

/**
 * The Aura mark. Every consuming app serves the same artwork from its own
 * `/public/logo.png` - the component is shared so replacing the file is the
 * only step needed to change the mark everywhere, in both the console and
 * marketing.
 *
 * `next/image` rather than a bare `<img>`: the source is a large PNG, and
 * without optimisation every visitor downloads all of it to render a small
 * mark. Next serves a resized WebP per breakpoint instead.
 *
 * The artwork is transparent-background and reads on both the light and dark
 * grounds, so it needs no per-theme variant.
 *
 * ── WHY THE SRC IS BUILT AND NOT THE LITERAL "/logo.png" ────────────────────
 *
 * The console is mounted under a base path (/admin, see apps/web/next.config.ts)
 * and the marketing site is not. `next/image` handles those two halves
 * inconsistently: it DOES prefix the optimizer endpoint it points the browser at
 * (/admin/_next/image), and it does NOT prefix the `url` parameter it puts
 * inside. The optimizer then fetches that url back off this same server, where
 * the public file lives at /admin/logo.png - so it asks for /logo.png, gets a
 * 404, and answers 400 "The requested resource isn't a valid image". The mark
 * renders broken while the file it wants is sitting right there, reachable, one
 * prefix away.
 *
 * So the prefix goes on the src. `NEXT_PUBLIC_BASE_PATH` is empty for
 * marketing, which leaves "/logo.png" exactly as it was, and is baked in per
 * app at build time - the same value next.config.ts reads for `basePath`, so
 * the two cannot disagree.
 *
 * ── WHY A TENANT MARK IS A BARE <img> ───────────────────────────────────────
 *
 * `src` overrides the artwork with one org's own logo (migration 0065's
 * `branding.logoUrl`). That path deliberately does NOT go through next/image:
 * the URL is arbitrary and tenant-supplied, and next/image refuses any remote
 * host not listed in `images.remotePatterns` at BUILD time - which an owner
 * typing a URL into the branding form cannot add. Optimising it is not worth
 * making the feature impossible, and the branding form's own preview already
 * renders the same URL the same way for the same reason.
 */
export function Logo({
  size = 36,
  priority = false,
  src,
  alt,
}: {
  size?: number;
  /** Set true for above-the-fold marks (hero, header) to avoid a pop-in. */
  priority?: boolean;
  /** One org's own mark (`branding.logoUrl`). Falls back to the Aura artwork. */
  src?: string | null;
  /**
   * Only set this where the mark is the ONLY thing naming the org. Both console
   * rails render the org name in text beside it, so there the mark stays
   * decorative and this stays unset - announcing the company twice is worse
   * than not announcing it at all.
   */
  alt?: string;
}) {
  const decorative = !alt;

  if (src) {
    return (
      // Bare <img>: a tenant-supplied host cannot be allowlisted at build time,
      // so next/image would refuse it outright. See the note above.
      <img
        src={src}
        alt={alt ?? ""}
        width={size}
        height={size}
        aria-hidden={decorative ? "true" : undefined}
        style={{ width: size, height: size, objectFit: "contain" }}
      />
    );
  }

  return (
    <Image
      src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/logo.png`}
      alt={alt ?? ""}
      width={size}
      height={size}
      priority={priority}
      aria-hidden={decorative ? "true" : undefined}
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
