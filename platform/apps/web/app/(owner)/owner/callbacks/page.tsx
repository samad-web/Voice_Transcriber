import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PhoneCall } from "lucide-react";
import { Card, EmptyState } from "@aura/ui";
import { CALLBACK_SECTION_LABELS, type CallbackSection } from "@aura/shared";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry } from "@/lib/owner-context";
import { CallbackList } from "./callback-list";

export const metadata: Metadata = { title: "Call-backs" };

/**
 * §10A.3's TO-CALL LIST.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE PAGE IS HIDDEN, NOT GREYED OUT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §3A.4's UI row: "Agent sections are HIDDEN, not greyed out (except an
 * owner-only 'locked, upgrade' state)."
 *
 * Three different absences, three different renders, and the distinction
 * matters because they are three different conversations:
 *
 *   no `call_intel` module   -> `notFound()`. The nav hides it too, and the
 *                               tenant has not bought the disclosure. An
 *                               upgrade prompt belongs on the owner's own
 *                               settings page, not on a telecaller's list.
 *   the gate is off for ME   -> a short, honest panel. NOT a 404: a telecaller
 *                               whose owner has not switched them on should
 *                               learn that from the page rather than from a
 *                               broken link, and the owner's name for the
 *                               setting is on it so they know who to ask.
 *   on, but nothing to call  -> the empty state, which is the good outcome.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THE SECTIONS COME FROM THE API
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `callbackSection` in @aura/shared decides which of Overdue / Due now / Later
 * today / Later an item is in, against `now` and the org's grace period. The
 * API applies it so the list on screen and the list the escalation sweep acts
 * on are the same list - computing it again here, against the browser's clock
 * and a different idea of the grace period, is how a telecaller sees "Due now"
 * for something the server already considers missed.
 */

interface MyListResponse {
  timeZone: string;
  sections: Record<CallbackSection, CallbackRow[]>;
  snoozeOptionsMinutes: number[];
}

export interface CallbackRow {
  id: string;
  lead_id: string | null;
  lead_name: string | null;
  contact_name: string | null;
  contact_phone_last3: string | null;
  type: string;
  committed: boolean;
  requested_text: string | null;
  condition_text: string | null;
  due_at: string;
  window_start: string | null;
  window_end: string | null;
  requested_due_at: string | null;
  moved_reason: string | null;
  needs_confirmation: boolean;
  priority_score: number;
  priority_reason: { factor: string; points: number }[] | null;
  status: string;
  attempts: number;
  max_attempts: number;
  notes: string | null;
  source_call_id: string | null;
  temperature: string | null;
  section: CallbackSection;
}

const ORDER: readonly CallbackSection[] = ["overdue", "due_now", "today", "later"];

export default async function CallbacksPage() {
  const owner = await getOwner();
  // The module, not the feature. The nav hides this page without it and the
  // API 403s every route - this is the third gate, so a bookmark reaches a 404
  // rather than a page that half-renders.
  if (!owner?.membership.enabledModules.includes("call_intel")) notFound();

  const result = await ownerTry<MyListResponse>("/v1/callbacks/my-list");

  if (!result.ok) {
    // A 403 with `feature_disabled` is not a failure - it is the assistant
    // being off for this person, which §3A.4 asks to be stated rather than
    // shown as an error.
    if (result.status === 403) {
      return (
        <>
          <PageHeader title="Call-backs" context="Conversations" />
          <Card>
            <div className="p-6">
              <h2 className="text-base font-semibold">
                The call assistant is not switched on for you
              </h2>
              <p className="mt-2 max-w-prose text-sm text-text-muted">
                When it is, anything a customer asks for on a call — &ldquo;ring me at
                five&rdquo;, &ldquo;call me tomorrow evening&rdquo; — lands here at the time
                they asked for, with a reminder. Ask whoever runs this workspace to turn it
                on for you.
              </p>
            </div>
          </Card>
        </>
      );
    }
    return (
      <>
        <PageHeader title="Call-backs" context="Conversations" />
        <LoadFailure failure={result} what="your call-backs" />
      </>
    );
  }

  const data = result.data;
  const total = ORDER.reduce((sum, key) => sum + (data.sections[key]?.length ?? 0), 0);

  return (
    <>
      <PageHeader
        title="Call-backs"
        context="Conversations"
        description="Everyone you have promised to ring back, at the time they asked for."
      />

      {total === 0 ? (
        <Card>
          <EmptyState
            icon={<PhoneCall aria-hidden />}
            title="Nobody is waiting for a call"
            description="When a customer asks to be rung back, the assistant puts them here at the time they asked for — and reminds you when it arrives."
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-6">
          {ORDER.map((section) => {
            const items = data.sections[section] ?? [];
            if (items.length === 0) return null;
            return (
              <section key={section} aria-labelledby={`cb-${section}`}>
                <h2
                  id={`cb-${section}`}
                  className="mb-2 flex items-center gap-2 text-sm font-semibold"
                >
                  {CALLBACK_SECTION_LABELS[section]}
                  <span className="text-[var(--muted-foreground)]">({items.length})</span>
                </h2>
                <CallbackList
                  items={items}
                  section={section}
                  timeZone={data.timeZone}
                  snoozeOptionsMinutes={data.snoozeOptionsMinutes}
                />
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
