"use client";

import { useState, type Dispatch, type SetStateAction } from "react";

/**
 * Local state seeded from a server prop that FOLLOWS the server afterwards.
 *
 * The console updates itself by `router.refresh()` whenever anything changes
 * (components/realtime-provider.tsx): server components re-render and hand
 * their client children fresh props. A plain `useState(initial)` ignores those
 * - it seeds once - so the component keeps showing what it loaded with while
 * the page around it moves on. This re-seeds whenever a new value arrives.
 *
 * `hold` pauses following while the person has something unsaved (a dirty
 * form, an optimistic move in flight). The newest server value is remembered
 * and applied the moment `hold` goes false, so nothing arriving meanwhile is
 * lost - it just doesn't land under somebody's hands.
 *
 * Adjusted during render rather than in an effect (React's "storing
 * information from previous renders" pattern), so there is no frame showing
 * the stale value first.
 */
export function useServerState<T>(
  server: T,
  hold = false,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState(server);
  const [seen, setSeen] = useState(server);

  if (server !== seen && !hold) {
    setSeen(server);
    setValue(server);
  }

  return [value, setValue];
}

/**
 * A form field seeded from the server that follows it UNTIL the person edits it.
 *
 * Untouched, the field tracks the server: a colleague's save, a webhook marking
 * an invoice paid, a setting changed in another tab all show up. Once edited,
 * it keeps what the person typed - their unsaved work is never overwritten -
 * and rejoins the server when the two agree again (after they save, or if they
 * type the value back). Each field decides for itself, so one edited box does
 * not freeze the rest of the form.
 *
 * Compares by identity, so `server` must be a primitive or a value that is
 * stable between renders (a prop passed straight through). A value rebuilt on
 * every render - `x ?? []`, `new Set(...)`, an object literal - would look
 * "changed" every time and re-render forever.
 */
export function useDraftState<T>(server: T): [T, Dispatch<SetStateAction<T>>] {
  const [draft, setDraft] = useState(server);
  const [base, setBase] = useState(server);

  if (!Object.is(server, base) && (Object.is(draft, base) || Object.is(draft, server))) {
    setBase(server);
    if (!Object.is(draft, server)) setDraft(server);
  }

  return [draft, setDraft];
}
