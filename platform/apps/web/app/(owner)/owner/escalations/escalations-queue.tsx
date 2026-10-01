"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isLiveEscalation, type CallEscalationListItem } from "@aura/shared";
import { Card, EmptyState, StatusChip } from "@aura/ui";
import { FilterLink } from "@/components/filter-link";
import { Time } from "@/components/org-time";
import { EscalationDrawer } from "./escalation-drawer";
import {
  ESCALATION_OVERDUE_MS,
  ESCALATION_STATUS_TONE,
  callLength,
  directionLabel,
  holderName,
  reasonLabel,
  statusLabel,
  type EscalationMineFilter,
  type EscalationStatusFilter,
} from "./format";

const STATUS_TABS: { key: EscalationStatusFilter; label: string }[] = [
  { key: "live", label: "Waiting" },
  { key: "resolved", label: "Answered" },
  { key: "all", label: "All" },
];

const MINE_TABS: { key: EscalationMineFilter | null; label: string }[] = [
  { key: null, label: "Everything" },
  { key: "assigned", label: "Assigned to me" },
  { key: "raised", label: "Raised by me" },
];

/** The queue's own URL for a status and a mine filter - no `open`. */
function hrefFor(status: EscalationStatusFilter, mine: EscalationMineFilter | null): string {
  const query = new URLSearchParams();
  if (status !== "live") query.set("status", status);
  if (mine) query.set("mine", mine);
  const qs = query.toString();
  return qs ? `/owner/escalations?${qs}` : "/owner/escalations";
}

function emptyText(status: EscalationStatusFilter, admin: boolean): { title: string; description: string } {
  if (status === "resolved") {
    return { title: "Nothing answered yet", description: "Escalations that have been answered show up here." };
  }
  if (status === "all") {
    return { title: "No escalations yet", description: "When a telecaller escalates a call, it shows up here." };
  }
  return admin
    ? {
        title: "Nothing waiting",
        description: "When a telecaller escalates a call, it lands here for whoever it was sent to.",
      }
    : {
        title: "Nothing waiting",
        description: "To escalate a call, open its lead and press Escalate in Call history - or use the phone app.",
      };
}

/**
 * The escalation queue (0151, Build docs/38): one row per escalation this
 * reader may see, and the drawer that answers it.
 *
 * The rows are server-rendered props: the filters live in the URL (so a
 * filtered view survives a refresh and can be sent on), and the console's
 * live updates re-render the page around this component, so there is no list
 * state here to go stale. The drawer is the exception - it holds fetched
 * state, and follows changes itself.
 *
 * `?open=<id>` opens the drawer on arrival - the bell's link, and the lead
 * drawer's chip. It is stripped on close, or the next refresh would reopen it.
 */
export function EscalationsQueue({
  items,
  counts,
  admin,
  status,
  mine,
  showFilters,
  callLog,
}: {
  items: CallEscalationListItem[];
  counts: { live: number; assignedToMeLive: number } | null;
  /** Owner or manager: sees every escalation in the workspace. */
  admin: boolean;
  status: EscalationStatusFilter;
  mine: EscalationMineFilter | null;
  /** Off while the workspace switch is off - only what is still waiting is listed. */
  showFilters: boolean;
  /** Owner/manager with the call log - the drawer links to it. */
  callLog: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [openId, setOpenId] = useState<string | null>(() => params.get("open"));
  // "Now" only after mount, so the overdue colour cannot differ between the
  // server's render and the browser's - the relative times already re-read it.
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const open = params.get("open");
    if (open) setOpenId(open);
  }, [params]);

  const close = useCallback(() => {
    setOpenId(null);
    if (params.get("open")) {
      const next = new URLSearchParams(params.toString());
      next.delete("open");
      const qs = next.toString();
      router.replace(qs ? `/owner/escalations?${qs}` : "/owner/escalations", { scroll: false });
    }
  }, [params, router]);

  const empty = emptyText(status, admin);

  return (
    <>
      {showFilters ? (
        <div className="space-y-2">
          <div role="group" className="flex flex-wrap gap-1.5" aria-label="Which escalations">
            {STATUS_TABS.map((tab) => (
              <FilterLink key={tab.key} active={status === tab.key} href={hrefFor(tab.key, mine)}>
                {tab.label}
                {tab.key === "live" && counts && counts.live > 0 ? ` · ${counts.live}` : ""}
              </FilterLink>
            ))}
          </div>
          {admin ? null : (
            <div role="group" className="flex flex-wrap gap-1.5" aria-label="Whose escalations">
              {MINE_TABS.map((tab) => (
                <FilterLink key={tab.key ?? "all"} active={mine === tab.key} href={hrefFor(status, tab.key)}>
                  {tab.label}
                  {tab.key === "assigned" && counts && counts.assignedToMeLive > 0
                    ? ` · ${counts.assignedToMeLive} waiting`
                    : ""}
                </FilterLink>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {items.length === 0 ? (
        showFilters ? (
          <EmptyState title={empty.title} description={empty.description} />
        ) : null
      ) : (
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-border">
            {items.map((item) => {
              const live = isLiveEscalation(item.status);
              const overdue =
                live && now !== null && now - new Date(item.createdAt).getTime() > ESCALATION_OVERDUE_MS;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(item.id)}
                    aria-current={openId === item.id ? "true" : undefined}
                    className={`w-full cursor-pointer px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-surface-hover ${
                      openId === item.id ? "bg-surface-hover" : ""
                    }`}
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-semibold text-text">{item.telecallerName}</span>
                      <span className="text-sm text-text-muted">{reasonLabel(item.reason)}</span>
                      <StatusChip tone={ESCALATION_STATUS_TONE[item.status]}>{statusLabel(item.status)}</StatusChip>
                      {/* Orange once it has waited too long - overdue is an
                          error-tone thing in this console, never red. */}
                      <span
                        className={`ml-auto text-xs tabular-nums ${
                          overdue ? "font-semibold text-orange" : "text-text-muted"
                        }`}
                      >
                        <Time iso={item.createdAt} mode="relative" />
                      </span>
                    </div>
                    {item.note ? (
                      <p className="mt-1 line-clamp-2 text-sm break-words text-text">{item.note}</p>
                    ) : null}
                    <p className="mt-1 text-xs text-text-muted">
                      {item.call.customerLabel ?? "Customer not named"} ·{" "}
                      <Time iso={item.call.startedAt} mode="datetime" /> · {directionLabel(item.call.direction)} ·{" "}
                      {callLength(item.call.durationS)}
                    </p>
                    <p className="mt-0.5 text-xs text-text-muted">
                      {item.status === "resolved"
                        ? `Answered by ${item.resolvedByName ?? "someone"}`
                        : item.status === "withdrawn"
                          ? "Withdrawn"
                          : item.status === "acknowledged" && item.acknowledgedByName
                            ? `With ${holderName(item)} · picked up by ${item.acknowledgedByName}`
                            : `With ${holderName(item)}`}
                      {item.canAct ? " · you can answer this" : ""}
                    </p>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {openId ? (
        <EscalationDrawer id={openId} callLog={callLog} onClose={close} onChanged={() => router.refresh()} />
      ) : null}
    </>
  );
}
