"use client";

import { useEffect, useState } from "react";
import { addDays, localToday } from "@/lib/next-actions";
import { overdueTasksHref } from "@/lib/report-dashboard";
import { fetchTasksAction } from "../crm-actions";
import { MetricCard } from "./metric-card";

/**
 * Overdue follow-ups, counted in the BROWSER.
 *
 * The card opens `/owner/tasks?due=overdue`, and that list decides "overdue"
 * with the viewer's own date (lib/next-actions.ts). Counting it on the server
 * would use the server's midnight instead, and for the first hours of a day in
 * India the card and the list it opens would disagree by a whole day's tasks.
 * Same query, same "today", same number.
 */
export function OverdueMetricCard() {
  const [state, setState] = useState<{ total: number } | "loading" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    const today = localToday();
    void fetchTasksAction({ status: "open", dueTo: addDays(today, -1), limit: 1 }).then((result) => {
      if (cancelled) return;
      setState(result.error ? "unavailable" : { total: result.total ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <MetricCard
      label="Overdue follow-ups"
      scope="now"
      value={state === "loading" ? "…" : state === "unavailable" ? "-" : String(state.total)}
      hint={
        state === "loading"
          ? "Counting…"
          : state !== "unavailable" && state.total === 0
            ? "Nothing is past its due date."
            : "Open tasks past their due date."
      }
      href={state === "loading" ? null : overdueTasksHref()}
      unavailable={state === "unavailable"}
    />
  );
}
