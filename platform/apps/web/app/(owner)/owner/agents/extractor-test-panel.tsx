"use client";

import { useState } from "react";
import { AgentDefinition } from "@aura/shared";
import { Button, Label, Select, StatusChip } from "@aura/ui";
import {
  callSampleLabel,
  definitionFrom,
  type EditorState,
  formatTestValue,
  issueMessages,
  mintKeys,
} from "@/lib/agent-studio";
import {
  type CallSample,
  type ExtractorTestOutcome,
  loadCallSamplesAction,
  testExtractorAction,
} from "./actions";

/**
 * Run what is on the screen - saved or not - against one real call.
 *
 * The question an owner has is not "what does v3 extract" but "if I save this,
 * would yesterday's enquiry from Ravi have become a lead?". So the run takes
 * the unsaved definition, and the answer ends in that yes or no, with the
 * reason in the owner's own detail names.
 *
 * Calls load on demand rather than with the page: most visits to the editor are
 * edits, not tests, and the list is a database round trip away.
 */
export function ExtractorTestPanel({ state }: { state: EditorState }) {
  const [calls, setCalls] = useState<CallSample[] | null>(null);
  const [callId, setCallId] = useState("");
  const [busy, setBusy] = useState<"loading" | "running" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExtractorTestOutcome | null>(null);

  const load = async () => {
    setBusy("loading");
    setError(null);
    const res = await loadCallSamplesAction();
    setBusy(null);
    if (res.error) return setError(res.error);
    setCalls(res.calls ?? []);
    setCallId(res.calls?.[0]?.id ?? "");
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
    const res = await testExtractorAction({ definition, callId });
    setBusy(null);
    if (res.error) return setError(res.error);
    setResult(res.result ?? null);
  };

  const keyOf = mintKeys(state.fields);
  const rows = state.fields.map((f) => {
    const key = keyOf.get(f.uid)!;
    return { uid: f.uid, name: f.name.trim() || key, key };
  });
  const nameOf = new Map(rows.map((r) => [r.key, r.name]));
  // qualifyLead's reasons name keys; the owner named details.
  const readable = (text: string) =>
    text.replace(/\b[a-z][a-z0-9_]*\b/g, (word) => nameOf.get(word) ?? word);

  return (
    <div className="space-y-4">
      {calls === null ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void load()}
            disabled={busy !== null}
          >
            {busy === "loading" ? "Loading calls…" : "Choose a recent call"}
          </Button>
          <span className="text-xs text-text-muted">
            Only calls that have a transcript are listed.
          </span>
        </div>
      ) : calls.length === 0 ? (
        <p className="text-sm text-text-muted">
          No transcribed calls yet. Once your team&apos;s phones have uploaded a few, you can test
          against them here.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="test-call">Call</Label>
            <Select id="test-call" value={callId} onChange={(e) => setCallId(e.target.value)}>
              {calls.map((c) => (
                <option key={c.id} value={c.id}>
                  {callSampleLabel(c)}
                </option>
              ))}
            </Select>
          </div>
          <Button type="button" onClick={() => void run()} disabled={busy !== null || !callId}>
            {busy === "running" ? "Reading the call…" : "Run test"}
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
            {result.lead.qualified ? (
              <StatusChip tone="solid">Would become a lead</StatusChip>
            ) : (
              <StatusChip tone="outline">Would not become a lead</StatusChip>
            )}
            {result.validationStatus === "failed" ? (
              <StatusChip tone="danger">Answer did not fit the details</StatusChip>
            ) : null}
            <span className="text-xs text-text-subtle">
              {result.lead.filled} of {rows.length} details found
            </span>
          </div>
          {!result.lead.qualified ? (
            <p className="text-sm text-text-muted">Why: {readable(result.lead.reason)}.</p>
          ) : null}

          <dl className="divide-y divide-border rounded-md border border-border">
            {rows.map((row) => {
              const value = formatTestValue(result.output[row.key]);
              return (
                <div
                  key={row.uid}
                  className="grid grid-cols-1 gap-1 px-3 py-2 sm:grid-cols-[14rem_1fr]"
                >
                  <dt className="text-sm text-text-muted">{row.name}</dt>
                  <dd className={value === null ? "text-sm text-text-subtle" : "text-sm text-text"}>
                    {value ?? "Not mentioned"}
                  </dd>
                </div>
              );
            })}
          </dl>

          {result.validationErrors.length > 0 ? (
            <p className="text-xs text-text-muted">
              The AI&apos;s answer broke these rules even after a retry:{" "}
              {readable(result.validationErrors.join("; "))}. A detail described more precisely
              usually fixes it.
            </p>
          ) : null}
          <p className="text-xs text-text-subtle">
            Nothing was saved. Test runs use AI credits and count towards your usage.
          </p>
        </div>
      ) : null}
    </div>
  );
}
