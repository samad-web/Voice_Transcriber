import type { RecordTag } from "./types";

/**
 * A record's tags on a list row. Neutral outline chips whatever `tags.color`
 * says: a tag's colour is free text a tenant typed, and the console's hues are
 * reserved for the four call states (@aura/ui state.tsx). Two shown, then "+N",
 * so a heavily-tagged record cannot blow out the row height.
 */
export function TagChips({ tags, max = 2 }: { tags: readonly RecordTag[] | undefined; max?: number }) {
  if (!tags || tags.length === 0) return <span className="text-xs text-text-subtle">-</span>;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1" title={tags.map((t) => t.name).join(", ")}>
      {shown.map((t) => (
        <span
          key={t.id}
          className="inline-flex max-w-[9rem] items-center truncate rounded-full border border-border-strong px-2 py-0.5 text-[11px] text-text-muted"
        >
          {t.name}
        </span>
      ))}
      {rest > 0 ? <span className="px-1 text-[11px] text-text-subtle">+{rest}</span> : null}
    </span>
  );
}
