"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import {
  ASR_MODE_DEFAULT,
  ASR_MODE_OPTIONS,
  asrLanguageOptions,
  VOCABULARY_MAX,
} from "@aura/shared";
import { Button, Card, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { updateTranscriptionAction } from "./actions";

/** Auto-detect first, then alphabetical by label. Sorted once, not per render. */
const LANGUAGES = asrLanguageOptions();

/**
 * The client's own copy of the transcription settings the operator console has
 * always had (`(platform)/instances/[id]/asr-settings.tsx`).
 *
 * WHY THE CUSTOMER GETS THIS AT ALL. The vocabulary is the half nobody else can
 * maintain: the provider does not know that this tenant sells "RD Interlock
 * Bricks" in Cheyyur, and every week the customer adds a product the recogniser
 * has never heard. Routing that through a support request meant the glossary
 * was always out of date, which shows up as misspelled product names in
 * summaries and extracted fields - the visible, quotable output.
 *
 * Both lists come from `@aura/shared` so this screen and the operator's can
 * never offer different options; they had already drifted by six languages
 * before that was consolidated.
 *
 * Deliberately NOT the whole policy surface. Consent, retention, full-number
 * storage and the app lock are on the same API endpoint and are the provider's
 * to set - `actions.ts` builds its own body from three fields precisely so
 * nothing here can reach them.
 */
export function TranscriptionClient({
  asrLanguage,
  asrMode,
  vocabulary,
  canEdit,
}: {
  asrLanguage: string | null;
  asrMode: string | null;
  vocabulary: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [language, setLanguage] = useDraftState(asrLanguage ?? "unknown");
  const [mode, setMode] = useDraftState(asrMode ?? ASR_MODE_DEFAULT);
  const [terms, setTerms] = useState<string[]>(vocabulary ?? []);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // NUL as the join separator, matching the operator component: it is the one
  // character that cannot appear inside a term, so two lists compare equal only
  // when they really are equal - a comma would call ["a,b"] and ["a","b"] the
  // same and leave the Unsaved chip lying.
  const dirty =
    language !== (asrLanguage ?? "unknown") ||
    mode !== (asrMode ?? ASR_MODE_DEFAULT) ||
    terms.join("\u0000") !== (vocabulary ?? []).join("\u0000");

  const addTerm = () => {
    const t = draft.trim();
    // Case-insensitive dedup, first spelling wins: the list exists to fix
    // spelling, so the form somebody typed deliberately is the answer.
    if (!t || terms.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    if (terms.length >= VOCABULARY_MAX) {
      setError(`At most ${VOCABULARY_MAX} terms.`);
      return;
    }
    setTerms([...terms, t]);
    setDraft("");
    setError(null);
  };

  const save = () => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updateTranscriptionAction({
        asrLanguage: language === "unknown" ? null : language,
        asrMode: mode,
        vocabulary: terms,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  const activeMode = ASR_MODE_OPTIONS.find((m) => m.code === mode);

  return (
    <Card elevated className="max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MonoLabel>Transcription settings</MonoLabel>
        {dirty && canEdit ? <StatusChip tone="muted">Unsaved</StatusChip> : null}
      </div>

      <div className="space-y-1.5">
        <MonoLabel>Language spoken</MonoLabel>
        <Select
          aria-label="Language spoken"
          value={language}
          disabled={!canEdit || pending}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
              {l.code === "unknown" ? "" : ` (${l.code})`}
            </option>
          ))}
        </Select>
        <p className="text-xs leading-relaxed text-text-muted">
          {language === "unknown"
            ? "The recogniser guesses per call. It gets this wrong occasionally - a Tamil call has been transcribed as Spanish - and when it does, the whole transcript is lost. Name the language if you know it."
            : "Every call from this instance is transcribed as this language, instead of the recogniser guessing."}
        </p>
      </div>

      <div className="space-y-1.5">
        <MonoLabel>Transcript style</MonoLabel>
        <Select
          aria-label="Transcript style"
          value={mode}
          disabled={!canEdit || pending}
          onChange={(e) => setMode(e.target.value)}
        >
          {ASR_MODE_OPTIONS.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </Select>
        {activeMode ? (
          <p className="text-xs leading-relaxed text-text-muted">{activeMode.blurb}</p>
        ) : null}
      </div>

      <div className="space-y-2">
        <MonoLabel>Names &amp; terms</MonoLabel>
        <p className="text-xs leading-relaxed text-text-muted">
          Your business name, products, places and people - spelled the way you
          want them to appear. The analyser is told these, so summaries and
          extracted fields use the right spelling even when the recogniser
          mishears them.
        </p>

        {canEdit ? (
          <div className="flex gap-2">
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // The field sits inside a Card, not a <form>, but Enter is
                  // still what a person expects to commit a chip - and without
                  // this it would do nothing at all.
                  e.preventDefault();
                  addTerm();
                }
              }}
              placeholder="RD Interlock"
              aria-label="Add a name or term"
              disabled={pending}
              className="flex-1"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={addTerm}
              disabled={!draft.trim() || pending}
            >
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>
        ) : null}

        {terms.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {terms.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface px-2.5 py-1 text-xs text-text"
              >
                {t}
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => setTerms(terms.filter((x) => x !== t))}
                    disabled={pending}
                    aria-label={`Remove ${t}`}
                    className="rounded-sm text-text-muted transition-colors duration-150 ease-out hover:text-text"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ) : (
          <p className="py-2 text-xs text-text-muted">
            No terms yet. Add the ones your callers say most - your company name
            and your top products are the ones worth getting right.
          </p>
        )}

        <p className="text-xs text-text-muted tabular-nums">
          {terms.length} of {VOCABULARY_MAX}
        </p>
      </div>

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <Button type="button" onClick={save} disabled={!dirty || pending}>
            {pending ? "Saving…" : "Save settings"}
          </Button>
          {!pending && saved ? <StatusChip tone="solid">Saved</StatusChip> : null}
          {!pending && error ? (
            <span className="text-xs leading-relaxed text-danger-text">{error}</span>
          ) : null}
        </div>
      ) : (
        <p className="border-t border-border pt-4 text-sm text-text-muted">
          Only an Owner or Manager can change these.
        </p>
      )}
    </Card>
  );
}
