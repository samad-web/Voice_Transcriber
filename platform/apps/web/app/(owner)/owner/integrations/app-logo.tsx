import type { IntegrationSpec } from "@aura/shared";

const SIZE = {
  sm: "h-10 w-10 rounded-lg text-sm",
  lg: "h-12 w-12 rounded-xl text-base",
} as const;

/**
 * An app's mark: the vendor's own logo when the catalogue ships one, else a
 * neutral monogram tile (doc 28 §7.4).
 *
 * Logos are committed under `public/apps/` and served from here - never
 * hot-linked from a vendor CDN (privacy, and the CSP), never recoloured (the
 * WhatsApp and Meta brand rules forbid it). The monogram is grey on purpose:
 * colour in this console means call state, and a green "W" would read as a
 * status.
 *
 * A raw path, so the basePath is added by hand here - `next/image` and
 * `next/link` would do it themselves, a bare <img> does not.
 */
export function AppLogo({ spec, size = "sm" }: { spec: Pick<IntegrationSpec, "label" | "logo">; size?: keyof typeof SIZE }) {
  if (spec.logo) {
    return (
      <img
        src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${spec.logo}`}
        alt=""
        aria-hidden="true"
        className={`${SIZE[size]} shrink-0 border border-border bg-surface object-contain p-1.5`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`${SIZE[size]} inline-flex shrink-0 items-center justify-center border border-border bg-surface-hover font-semibold text-text`}
    >
      {spec.label.trim().charAt(0).toUpperCase()}
    </span>
  );
}
