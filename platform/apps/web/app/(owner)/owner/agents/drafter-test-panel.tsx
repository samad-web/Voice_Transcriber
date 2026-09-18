"use client";

import { useState } from "react";
import { AgentDefinition } from "@aura/shared";
import { Button, Label, Select } from "@aura/ui";
import {
  callSampleLabel,
  definitionFrom,
  type EditorState,
  issueMessages,
} from "@/lib/agent-studio";
import {
  type CallSample,
  type ConversationSample,
  type DraftOutcome,
  loadCallSamplesAction,
  loadConversationSamplesAction,
  testDrafterAction,
} from "./actions";

type Source = "call" | "conversation";

function conversationLabel(c: ConversationSample): string {
  const who = c.peer_label?.trim() || (c.peer_last3 ? `…${c.peer_last3}` : "Unknown number");
  const when = new Date(c.last_inbound_at).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${who} · ${when}`;
}

/**
 * Draft one reply with what is on the screen, for a real call or thread.
 *
 * The draft is shown exactly as the team would receive it in the composer,
 * because tone and length are what the owner is tuning and a summary of the
 * draft would hide both.
 */
export function DrafterTestPanel({ state }: { state: EditorState }) {
  const [source, setSource] = useState<Source>("call");
  const [calls, setCalls] = useState<CallSample[] | null>(null);
  const [conversations, setConversations] = useState<ConversationSample[] | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<"loading" | "running" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DraftOutcome | null>(null);

  const options = source === "call" ? calls : conversations;

  const load = async (next: Source) => {
    setSource(next);
    setResult(null);
    setError(null);
    const already = next === "call" ? calls : conversations;
    if (already) {
      setPick(already[0]?.id ?? "");
      return;
    }
    setBusy("loading");
    if (next === "call") {
      const res = await loadCallSamplesAction();
      setBusy(null);
      if (res.error) return setError(res.error);
      setCalls(res.calls ?? []);
      setPick(res.calls?.[0]?.id ?? "");
    } else {
      const res = await loadConversationSamplesAction();
      setBusy(null);
      if (res.error) return setError(res.error);
      setConversations(res.conversations ?? []);
      setPick(res.conversations?.[0]?.id ?? "");
    }
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
    const res = await testDrafterAction(
      source === "call" ? { definition, callId: pick } : { definition, conversationId: pick },
    );
    setBusy(null);
    if (res.error) return setError(res.error);
    setResult(res.result ?? null);
  };

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Draft a reply for"
      >
        <Button
          type="button"
          size="sm"
          variant={options !== null && source === "call" ? "primary" : "secondary"}
          disabled={busy !== null}
          onClick={() => void load("call")}
        >
          A recent call
        </Button>
        <Button
          type="button"
          size="sm"
          variant={options !== null && source === "conversation" ? "primary" : "secondary"}
          disabled={busy !== null}
          onClick={() => void load("conversation")}
        >
          A WhatsApp conversation
        </Button>
        {busy === "loading" ? <span className="text-xs text-text-muted">Loading…</span> : null}
      </div>

      {options === null ? null : options.length === 0 ? (
        <p className="text-sm text-text-muted">
          {source === "call" ? "No transcribed calls yet." : "No WhatsApp conversations yet."}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="test-draft-source">{source === "call" ? "Call" : "Conversation"}</Label>
            <Select id="test-draft-source" value={pick} onChange={(e) => setPick(e.target.value)}>
              {source === "call"
                ? (calls ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {callSampleLabel(c)}
                    </option>
                  ))
                : (conversations ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {conversationLabel(c)}
                    </option>
                  ))}
            </Select>
          </div>
          <Button type="button" onClick={() => void run()} disabled={busy !== null || !pick}>
            {busy === "running" ? "Writing…" : "Draft a reply"}
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
        <div className="space-y-2" aria-live="polite">
          <p className="whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-3 text-sm leading-relaxed text-text">
            {result.reply}
          </p>
          <p className="text-xs text-text-subtle">
            Nothing was saved and nothing was sent. Drafting sends the call transcript or
            conversation to the AI provider, and uses AI credits.
          </p>
        </div>
      ) : null}
    </div>
  );
}
