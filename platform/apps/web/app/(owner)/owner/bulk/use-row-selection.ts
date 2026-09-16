"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Which rows of a list are ticked.
 *
 * Selection is per PAGE of results, deliberately: when the rows on screen
 * change - a filter, a sort, the next page - anything no longer on screen drops
 * out of the selection. A bulk action must only ever touch rows the person can
 * see ticked; "reassign 12" that quietly includes three rows from a page they
 * left is how a bulk action surprises someone.
 */
export function useRowSelection(rowIds: readonly string[]) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const key = rowIds.join(",");

  useEffect(() => {
    const present = new Set(rowIds);
    setSelected((prev) => {
      const kept = [...prev].filter((id) => present.has(id));
      return kept.length === prev.size ? prev : new Set(kept);
    });
    // `key` stands for rowIds' contents; the array's identity changes every render.
  }, [key]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setSelected((prev) => (rowIds.length > 0 && rowIds.every((id) => prev.has(id)) ? new Set() : new Set(rowIds)));
  }, [key]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const ids = useMemo(() => rowIds.filter((id) => selected.has(id)), [rowIds, selected]);

  return { selected, ids, count: ids.length, toggle, toggleAll, clear, allSelected, someSelected };
}
