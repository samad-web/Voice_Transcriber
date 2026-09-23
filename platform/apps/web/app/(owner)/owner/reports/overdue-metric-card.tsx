"use client";

import { useEffect, useState } from "react";
import { useOrgTimeZone } from "@/components/org-time";
import { addDays, workspaceToday } from "@/lib/next-actions";
import { overdueTasksHref } from "@/lib/report-dashboard";
import { fetchTasksAction } from "../crm-actions";
import { MetricCard } from "./metric-card";

/**
 * Overdue follow-ups, counted in the BROWSER.
 *
 * The card opens `/owner/tasks?due=overdue`, and that list decides "overdue"
 * with the WORKSPACE's date (lib/next-actions.ts, Build docs/30) - the same
 * today the API's org_reporting_today() counts with. This card uses the same
 * workspaceToday(), so the card and the list it opens cannot disagree by a
 * day's tasks. Same query, same "today", same number.
 */
export function OverdueMetricCard() {
  const zone = useOrgTimeZone();
  const [state, setState] = useState<{ total: number } | "loading" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    const today = workspaceToday(zone);
    void fetchTasksAction({ status: "open", dueTo: addDays(today, -1), limit: 1 }).then((result) => {
      if (cancelled) return;
      setState(result.error ? "unavailable" : { total: result.total ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [zone]);

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
