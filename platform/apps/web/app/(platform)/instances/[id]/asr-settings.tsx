"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { useRouter } from "next/navigation";
import { Languages, Plus, X } from "lucide-react";
import {
  ASR_MODE_OPTIONS as MODES,
  ASR_MODE_DEFAULT,
  asrLanguageOptions,
} from "@aura/shared";
import { BrutalButton, Card, MonoLabel, Select, StatusChip, useAlert, useToast } from "@aura/ui";
import { setAsrSettingsAction } from "./actions";

/**
 * Per-instance transcription settings: what language this customer's calls are
 * in, what script the transcript comes back in, and the names the analyser must
 * spell correctly.
 *
 * These are properties of the CUSTOMER, not of the deployment, which is why
 * they live here rather than in an env var - one instance is a Tamil brick
 * factory, the next is a Kannada clinic.
 */
/** Auto-detect first, then alphabetical by label - see asrLanguageOptions. */
const LANGUAGES = asrLanguageOptions();

export function AsrSettings({
  orgId,
  asrLanguage,
  asrMode,
  vocabulary,
}: {
  orgId: string;
  asrLanguage: string | null;
  asrMode: string | null;
  vocabulary: string[];
}) {
  const router = useRouter();
  const [language, setLanguage] = useDraftState(asrLanguage ?? "unknown");
  const [mode, setMode] = useDraftState(asrMode ?? ASR_MODE_DEFAULT);
  const [terms, setTerms] = useState<string[]>(vocabulary ?? []);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const dirty =
    language !== (asrLanguage ?? "unknown") ||
    mode !== (asrMode ?? ASR_MODE_DEFAULT) ||
    terms.join("\u0000") !== (vocabulary ?? []).join("\u0000");

  const addTerm = () => {
    const t = draft.trim();
    // Case-insensitive dedup: "RD Interlock" and "rd interlock" are one term,
    // and the glossary is about spelling, so the first form entered wins.
    if (!t || terms.some((x) => x.toLowerCase() === t.toLowerCase())) {
      setDraft("");
      return;
    }
    setTerms([...terms, t]);
    setDraft("");
  };

  const save = () => {
    startTransition(async () => {
      const res = await setAsrSettingsAction({
        orgId,
        asrLanguage: language === "unknown" ? null : language,
        asrMode: mode,
        vocabulary: terms,
      });
      if (res.error) {
        await alert({
          title: "Couldn't save the transcription settings",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast("Transcription settings saved - they apply to new calls and reprocesses.");
      router.refresh();
    });
  };

  const activeMode = MODES.find((m) => m.code === mode);

  return (
    <Card elevated className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4" />
          <MonoLabel>Transcription settings</MonoLabel>
        </div>
        {dirty ? <StatusChip tone="danger">Unsaved</StatusChip> : null}
      </div>

      {/* Language */}
      <div className="space-y-1.5">
        <MonoLabel>Language spoken</MonoLabel>
        <Select
          aria-label="Language spoken"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>
              {l.label}
              {l.code === "unknown" ? "" : ` (${l.code})`}
            </option>
          ))}
        </Select>
        <p className="text-[11px] text-text-muted font-sans leading-relaxed">
          {language === "unknown"
            ? "The recogniser guesses per call. It gets this wrong occasionally - a Tamil call has been transcribed as Spanish - and when it does, the whole transcript is lost. Name the language if you know it."
            : "Every call from this instance is transcribed as this language, instead of the recogniser guessing."}
        </p>
      </div>

      {/* Output mode */}
      <div className="space-y-1.5">
        <MonoLabel>Transcript style</MonoLabel>
        <Select aria-label="Transcript style" value={mode} onChange={(e) => setMode(e.target.value)}>
          {MODES.map((m) => (
            <option key={m.code} value={m.code}>
              {m.label}
            </option>
          ))}
        </Select>
        {activeMode ? (
          <p className="text-[11px] text-text-muted font-sans leading-relaxed">
            {activeMode.blurb}
          </p>
        ) : null}
      </div>

      {/* Vocabulary */}
      <div className="space-y-2">
        <MonoLabel>Names &amp; terms</MonoLabel>
        <p className="text-[11px] text-text-muted font-sans leading-relaxed">
          Your business name, products, places and people - spelled the way you
          want them to appear. The analyser is told these, so summaries and
          extracted fields use the right spelling even when the recogniser
          mishears them.
        </p>
        <div className="flex gap-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTerm();
              }
            }}
            placeholder="RD Interlock"
            className="flex-1 border-2 border-border-strong bg-surface p-2 text-xs font-sans"
          />
          <BrutalButton variant="secondary" onClick={addTerm} disabled={!draft.trim()}>
            <Plus className="h-4 w-4" />
            ADD
          </BrutalButton>
        </div>
        {terms.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {terms.map((t) => (
              <span
                key={t}
                className="inline-flex items-center gap-1.5 border-2 border-border-strong bg-surface px-2 py-1 text-[11px] font-sans font-bold"
              >
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => setTerms(terms.filter((x) => x !== t))}
                  className="text-text-muted hover:text-danger-text"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-[11px] font-mono font-bold uppercase text-text-subtle">
            None yet
          </p>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <BrutalButton onClick={save} disabled={pending || !dirty}>
          {pending ? "SAVING…" : "SAVE SETTINGS"}
        </BrutalButton>
      </div>
    </Card>
  );
}
