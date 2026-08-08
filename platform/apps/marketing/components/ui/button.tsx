import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * Link-shaped button. Every CTA on this site navigates — there is not a single
 * onClick on a content page — so the primitive is an anchor, not a `<button>`,
 * and the whole marketing surface works with zero client JavaScript.
 *
 * Variants follow doc 16 §2.1: primary (accent fill) · secondary (border) ·
 * ghost. `danger` has no meaning on a marketing page and is not implemented.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium " +
  "transition-colors duration-150 ease-out " +
  // Never removed. Doc 16 §1.5 — with no heavy borders in this system, the
  // focus ring is the only affordance a keyboard user gets.
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const VARIANTS: Record<ButtonVariant, string> = {
  // --color-accent-fg, the kit's name for a label sitting on an accent FILL.
  // #FFFFFF on #2563EB = 5.17:1 light; #0A0A0A on #3B82F6 = 5.19:1 dark.
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  // --color-border-strong, not --color-border: the boundary is this control's
  // only affordance, so it needs 3:1 (3.23:1 light, 3.52:1 dark on surface).
  // The decorative --color-border measures 1.26:1 and would fail WCAG 1.4.11.
  secondary:
    "border border-border-strong bg-surface text-text hover:bg-surface-hover",
  ghost: "text-accent hover:text-accent-hover hover:bg-accent-subtle",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-11 px-5 text-base",
  lg: "h-12 px-6 text-lg",
};

function classes(variant: ButtonVariant, size: ButtonSize, className?: string) {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
  size = "md",
  className,
  external,
  ...rest
}: {
  href: string;
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  /** Opens in a new tab with the noopener/noreferrer pair. */
  external?: boolean;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className">) {
  const cls = classes(variant, size, className);

  // Fragment and off-site links bypass the router: `next/link` gives a fragment
  // no benefit and cannot prefetch another origin.
  if (external || href.startsWith("http") || href.startsWith("#")) {
    return (
      <a
        href={href}
        className={cls}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        {...rest}
      >
        {children}
      </a>
    );
  }

  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

/** A text link inside prose. Underlined by default — colour alone is not a
 *  sufficient affordance for a link in running text (WCAG 1.4.1). */
export function TextLink({
  href,
  children,
  external,
  className,
}: {
  href: string;
  children: React.ReactNode;
  external?: boolean;
  className?: string;
}) {
  const cls = cn(
    "text-accent underline underline-offset-4 decoration-1",
    "hover:text-accent-hover transition-colors duration-150 ease-out",
    className,
  );

  if (external || href.startsWith("http") || href.startsWith("#")) {
    return (
      <a
        href={href}
        className={cls}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}
