"use client";

import { useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * `?focus=<id>` - open one record's drawer from a link (global search, a
 * notification, a contact's deal list).
 *
 * Shared by the kanban board and the deals table so the two views of the same
 * data answer a deep link the same way:
 *   - a record already on screen opens immediately;
 *   - otherwise `load` fetches it (a board column or a table page only holds
 *     some of the records), and nothing opens if it is gone or out of scope;
 *   - closing strips `focus` from the URL, keeping every other parameter, so a
 *     later re-render cannot reopen a drawer somebody just closed.
 *
 * Keyed on the id alone - a refresh of the loaded records must not re-fire it.
 */
export function useFocusParam<T>({
  findLoaded,
  load,
  open,
}: {
  findLoaded: (id: string) => T | null;
  load?: (id: string) => Promise<T | null>;
  open: (record: T) => void;
}): { clearFocus: () => void } {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const focusId = params.get("focus");

  useEffect(() => {
    if (!focusId) return;
    const loaded = findLoaded(focusId);
    if (loaded) {
      open(loaded);
      return;
    }
    if (!load) return;
    let cancelled = false;
    void load(focusId).then((record) => {
      if (!cancelled && record) open(record);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately only the id - see the note above.
  }, [focusId]);

  const clearFocus = () => {
    if (!focusId) return;
    const next = new URLSearchParams(params.toString());
    next.delete("focus");
    router.replace(`${pathname}${next.toString() ? `?${next}` : ""}`, { scroll: false });
  };

  return { clearFocus };
}
