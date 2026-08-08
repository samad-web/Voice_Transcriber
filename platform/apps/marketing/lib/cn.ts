/** Join class names, dropping falsy values. Deliberately not `clsx` — this app
 *  ships under a 100 KB JS budget (doc 10 §9) and does not need a dependency
 *  for six lines. No conflict resolution: order your classes correctly. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
