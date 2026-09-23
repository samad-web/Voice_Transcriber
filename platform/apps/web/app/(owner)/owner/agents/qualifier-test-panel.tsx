"use client";

import { useState } from "react";
import { AgentDefinition, formatDayMonth, formatTime } from "@aura/shared";
import { Button, Label, Select, StatusChip } from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import {
  definitionFrom,
  type EditorState,
  formatTestValue,
  issueMessages,
  mintKeys,
} from "@/lib/agent-studio";
import {
  type ConversationSample,
  loadConversationSamplesAction,
  type QualifierTestOutcome,
  testQualifierAction,
} from "./actions";

const DISPOSITION_LABELS: Record<string, string> = {
  prospect: "A real enquiry",
  existing_customer: "An existing customer",
  support: "A support request",
  vendor: "A supplier or courier",
  personal: "A personal message",
  wrong_number: "A wrong number",
  spam: "Spam",
  unclear: "Too little to tell",
};

const BAND_TONE = { hot: "solid", warm: "muted", cold: "outline", junk: "outline" } as const;

function conversationLabel(c: ConversationSample, zone: string): string {
  const who = c.peer_label?.trim() || (c.peer_last3 ? `…${c.peer_last3}` : "Unknown number");
  // Workspace clock (Build docs/30), not the viewer's browser.
  const when = `${formatDayMonth(c.last_inbound_at, zone)}, ${formatTime(c.last_inbound_at, zone)}`;
  return [
    who,
    when,
    `${c.message_count} message${c.message_count === 1 ? "" : "s"}`,
    c.matched ? "already a contact" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Judge one real WhatsApp thread with what is on the screen.
 *
 * The verdict is shown the way the review queue will show it - kind of thread,
 * score band, reason - because that is what the owner is tuning. A personal
 * thread comes back with its reason reduced to its category and no details:
 * the same redaction the queue gets, applied before the answer leaves the API.
 */
export function QualifierTestPanel({ state }: { state: EditorState }) {
  const [conversations, setConversations] = useState<ConversationSample[] | null>(null);
  const [conversationId, setConversationId] = useState("");
  const [busy, setBusy] = useState<"loading" | "running" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<QualifierTestOutcome | null>(null);
  const zone = useOrgTimeZone();

  const load = async () => {
    setBusy("loading");
    setError(null);
    const res = await loadConversationSamplesAction();
    setBusy(null);
    if (res.error) return setError(res.error);
    setConversations(res.conversations ?? []);
    setConversationId(res.conversations?.[0]?.id ?? "");
  };

  const run = async () => {
    const definition = definitionFrom(state);
    const parsed = AgentDefinition.safeParse({
      ...definition,
      name: definition.name.trim() || "Untitled",
    });
    if (!parsed.success) {
      setResult(null);
      return setError(`Fix these first: ${issueMessages(parsed.error.issues, state).join(" ")}`);
    }
    setBusy("running");
    setError(null);
    setResult(null);
    const res = await testQualifierAction({ definition, conversationId });
    setBusy(null);
    if (res.error) return setError(res.error);
    setResult(res.result ?? null);
  };

  const keyOf = mintKeys(state.fields);
  const rows = state.fields.map((f) => ({
    uid: f.uid,
    key: keyOf.get(f.uid)!,
    name: f.name.trim() || keyOf.get(f.uid)!,
  }));

  return (
    <div className="space-y-4">
      {conversations === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            {busy === "loading" ? "Loading conversations…" : "Choose a WhatsApp conversation"}
          </Button>
        </div>
      ) : conversations.length === 0 ? (
        <p className="text-sm text-text-muted">No WhatsApp conversations yet.</p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="test-conversation">Conversation</Label>
            <Select
              id="test-conversation"
              value={conversationId}
              onChange={(e) => setConversationId(e.target.value)}
            >
              {conversations.map((c) => (
                <option key={c.id} value={c.id}>
                  {conversationLabel(c, zone)}
                </option>
              ))}
            </Select>
          </div>
          <Button
            type="button"
            onClick={() => void run()}
            disabled={busy !== null || !conversationId}
          >
            {busy === "running" ? "Reading the conversation…" : "Run test"}
          </Button>
        </div>
      )}

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text"
        >
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-3" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text">
              {DISPOSITION_LABELS[result.verdict.disposition] ?? result.verdict.disposition}
            </span>
            <StatusChip tone={BAND_TONE[result.band] ?? "outline"}>
              {result.band} · {result.verdict.score}
            </StatusChip>
          </div>
          {result.verdict.rationale ? (
            <p className="text-sm text-text-muted">{result.verdict.rationale}</p>
          ) : null}
          {result.provider !== "gemini" ? (
            <p className="text-xs text-text-muted">
              Read by keywords only - no language model is configured, so your guidance and details
              were not used.
            </p>
          ) : null}

          {rows.length > 0 ? (
            <dl className="divide-y divide-border rounded-md border border-border">
              {rows.map((row) => {
                const value = formatTestValue(result.details[row.key]);
                return (
                  <div
                    key={row.uid}
                    className="grid grid-cols-1 gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]"
                  >
                    <dt className="text-sm text-text-muted">{row.name}</dt>
                    <dd
                      className={value === null ? "text-sm text-text-subtle" : "text-sm text-text"}
                    >
                      {value ?? "Not stated"}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ) : null}
          <p className="text-xs text-text-subtle">
            Nothing was saved and nothing was sent. Test runs use AI credits and count towards your
            usage.
          </p>
        </div>
      ) : null}
    </div>
  );
}
