/**
 * Join class names, dropping falsy entries.
 *
 * Deliberately NOT `clsx`/`tailwind-merge`: this kit has no runtime dependency
 * beyond React, and adding one to every page of a production console to save
 * eight lines is a bad trade. The consequence is that a caller's `className`
 * does not *replace* a conflicting base class, it only comes later in the
 * string — which for Tailwind means specificity ties are broken by the order
 * the classes appear in the generated stylesheet, not by argument order. Every
 * component here therefore puts the caller's `className` last AND keeps its own
 * base classes free of the properties callers most often override (spacing,
 * width, colour on layout wrappers).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
