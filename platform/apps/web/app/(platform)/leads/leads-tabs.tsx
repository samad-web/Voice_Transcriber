"use client";

import { useState } from "react";
import type { FunnelCriteria } from "@aura/shared";
import type { Lead, MessageTemplate } from "./actions";
import { LeadsTable } from "./leads-table";
import { WhatsAppTemplates } from "./whatsapp-templates";
import { CriteriaEditor } from "./criteria-editor";

/**
 * Two views of the same funnel: the people, and what we say to them.
 *
 * A tab rather than a separate page in the sidebar. The two belong together —
 * an operator about to press Reject is exactly the person who should be able to
 * check the wording of a rejection first — and a nav item nobody looks for is a
 * feature nobody finds.
 *
 * Client-side switching over both payloads, both fetched on the server. The
 * templates are five short rows; a round trip to reveal them would be slower
 * than fetching them up front and buys nothing.
 */
export function LeadsTabs({
  leads,
  leadsError,
  templates,
  templatesError,
  maxLength,
  criteria,
  criteriaUpdatedAt,
  criteriaUpdatedBy,
  criteriaError,
}: {
  leads: Lead[];
  leadsError?: string;
  templates: MessageTemplate[];
  templatesError?: string;
  maxLength: number;
  criteria: FunnelCriteria;
  criteriaUpdatedAt?: string;
  criteriaUpdatedBy?: string | null;
  criteriaError?: string;
}) {
  const [tab, setTab] = useState<TabId>("leads");

  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="Funnel" className="flex gap-1 border-b border-border">
        <Tab id="leads" current={tab} onSelect={setTab}>
          Leads{leads.length > 0 ? ` (${leads.length})` : ""}
        </Tab>
        <Tab id="whatsapp" current={tab} onSelect={setTab}>
          WhatsApp
        </Tab>
        {/* Third, and last, because it is the one an operator visits least and
            the one with the widest blast radius: editing it changes how every
            future enquiry is sorted. */}
        <Tab id="criteria" current={tab} onSelect={setTab}>
          Qualification{criteria.enabled ? "" : " (off)"}
        </Tab>
      </div>

      {tab === "criteria" ? (
        <CriteriaEditor
          initial={criteria}
          updatedAt={criteriaUpdatedAt}
          updatedBy={criteriaUpdatedBy}
          loadError={criteriaError}
        />
      ) : tab === "leads" ? (
        leadsError ? (
          <ErrorCard title="Could not load leads" message={leadsError}>
            If the API is running, this usually means migrations 0020 and 0021 have not been
            applied to the database it is pointed at.
          </ErrorCard>
        ) : (
          <LeadsTable initial={leads} />
        )
      ) : templatesError ? (
        <ErrorCard title="Could not load the messages" message={templatesError}>
          The messages still send — the worker falls back to the wording built into the release
          when this table is unreachable. Only editing is unavailable.
        </ErrorCard>
      ) : (
        <WhatsAppTemplates initial={templates} maxLength={maxLength} />
      )}
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
