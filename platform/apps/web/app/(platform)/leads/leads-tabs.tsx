"use client";

import { useState } from "react";
import type { FunnelCriteria } from "@aura/shared";
import type { Lead, MessageTemplate } from "./actions";
import { LeadsTable } from "./leads-table";
import { MessageTemplates } from "./message-templates";
import { CriteriaEditor } from "./criteria-editor";

/**
 * Three views of the same funnel: the people, what we say to them, and who
 * counts as a lead.
 *
 * A tab rather than a separate page in the sidebar. They belong together — an
 * operator about to press Reject is exactly the person who should be able to
 * check the wording of a rejection first — and a nav item nobody looks for is a
 * feature nobody finds.
 *
 * Client-side switching over payloads all fetched on the server. The templates
 * are five short rows; a round trip to reveal them would be slower than
 * fetching them up front and buys nothing.
 *
 * ── EVERY PANEL STAYS MOUNTED ──────────────────────────────────────────────
 *
 * `hidden`, not a conditional render. This started as
 * `tab === "criteria" ? <CriteriaEditor/> : …`, which UNMOUNTS the editor the
 * moment you leave the tab and takes its unsaved state with it.
 *
 * CriteriaEditor deliberately holds edits locally until Save is pressed — a
 * half-built rule must never briefly become the live definition of a qualified
 * lead. Combined with an unmount, that meant switching tabs silently discarded
 * the change, and coming back showed the server's value again. Reported on
 * 2026-08-10 as "the qualification toggle turns itself back on": it was never
 * off, the edit was thrown away, and nothing said so.
 *
 * Keeping them mounted costs one hidden subtree of already-fetched data and
 * removes a class of bug where any editor added here later loses work the same
 * way.
 */
export function LeadsTabs({
  leads,
  leadsError,
  templates,
  templatesError,
  criteria,
  criteriaUpdatedAt,
  criteriaUpdatedBy,
  criteriaError,
}: {
  leads: Lead[];
  leadsError?: string;
  templates: MessageTemplate[];
  templatesError?: string;
  criteria: FunnelCriteria;
  criteriaUpdatedAt?: string;
  criteriaUpdatedBy?: string | null;
  criteriaError?: string;
}) {
  const [tab, setTab] = useState<TabId>("leads");
  const [criteriaDirty, setCriteriaDirty] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Funnel" className="flex gap-1 border-b border-border">
        <Tab id="leads" current={tab} onSelect={setTab}>
          Leads{leads.length > 0 ? ` (${leads.length})` : ""}
        </Tab>
        <Tab id="whatsapp" current={tab} onSelect={setTab}>
          Messages
        </Tab>
        {/* Third, and last, because it is the one an operator visits least and
            the one with the widest blast radius: editing it changes how every
            future enquiry is sorted.

            The label reports the SAVED state, not the edited one, so it cannot
            claim the funnel has stopped filtering while that change is still
            sitting unsaved in the panel. The dot says there is a change; the
            word says what is actually running. */}
        <Tab id="criteria" current={tab} onSelect={setTab}>
          Qualification{criteria.enabled ? "" : " (off)"}
          {criteriaDirty ? (
            <span className="ml-1.5 text-accent" title="Unsaved changes" aria-label="unsaved changes">
              •
            </span>
          ) : null}
        </Tab>
      </div>

      <div role="tabpanel" hidden={tab !== "leads"}>
        {leadsError ? (
          <ErrorCard title="Could not load leads" message={leadsError}>
            If the API is running, this usually means migrations 0020 and 0021 have not been
            applied to the database it is pointed at.
          </ErrorCard>
        ) : (
          <LeadsTable initial={leads} />
        )}
      </div>

      <div role="tabpanel" hidden={tab !== "whatsapp"}>
        {templatesError ? (
          <ErrorCard title="Could not load the messages" message={templatesError}>
            The messages still send — the worker falls back to the wording built into the release
            when this table is unreachable. Only editing is unavailable.
          </ErrorCard>
        ) : (
          <MessageTemplates initial={templates} />
        )}
      </div>

      <div role="tabpanel" hidden={tab !== "criteria"}>
        <CriteriaEditor
          initial={criteria}
          updatedAt={criteriaUpdatedAt}
          updatedBy={criteriaUpdatedBy}
          loadError={criteriaError}
          onDirtyChange={setCriteriaDirty}
        />
      </div>
    </div>
  );
}

type TabId = "leads" | "whatsapp" | "criteria";

function Tab({
  id,
  current,
  onSelect,
  children,
}: {
  id: TabId;
  current: string;
  onSelect: (id: TabId) => void;
  children: React.ReactNode;
}) {
  const active = current === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={
        // -1px bottom margin so the active tab's underline sits ON the
        // container's border rather than above it.
        "-mb-px h-10 rounded-t-md border-b-2 px-4 text-sm font-medium transition-colors " +
        (active
          ? "border-accent text-text"
          : "border-transparent text-text-muted hover:text-text")
      }
    >
      {children}
    </button>
  );
}

function ErrorCard({
  title,
  message,
  children,
}: {
  title: string;
  message: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger/5 p-4 text-sm text-danger-text"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-1">{message}</p>
      <p className="mt-2 text-xs text-text-muted">{children}</p>
    </div>
  );
}
