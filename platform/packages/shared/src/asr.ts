import { z } from "zod";

/**
 * Transcription settings that belong to the CUSTOMER, not to the deployment -
 * what language this instance's calls are in, what script the transcript comes
 * back in, and the proper nouns the analyser must spell correctly.
 *
 * ── WHY THIS MOVED INTO @aura/shared ──────────────────────────────────────
 *
 * There were two copies: the accepted codes in `tenancy.controller.ts` (which
 * backs the zod enum and mirrors migration 0016's CHECK), and the human labels
 * in the operator console's `asr-settings.tsx`. They had already drifted - the
 * API accepted 24 languages and the console offered 18, so six of them
 * (Kashmiri, Sindhi, Santali, Manipuri, Bodo, Dogri) were selectable by nobody
 * even though the database would have taken them.
 *
 * Adding a third copy for the client console would have made that worse, so
 * the list lives here once and all three read it. Migration 0016's CHECK
 * constraint is the fourth copy and cannot import TypeScript - it still has to
 * be changed by hand, which is why that is said twice: once there, once here.
 */

/** Sarvam's BCP-47 set, plus the sentinel that forces auto-detect. */
export const ASR_LANGUAGES = [
  "unknown", "en-IN", "hi-IN", "bn-IN", "kn-IN", "ml-IN", "mr-IN", "od-IN",
  "pa-IN", "ta-IN", "te-IN", "gu-IN", "as-IN", "ur-IN", "ne-IN", "kok-IN",
  "ks-IN", "sd-IN", "sa-IN", "sat-IN", "mni-IN", "brx-IN", "mai-IN", "doi-IN",
] as const;

export const AsrLanguage = z.enum(ASR_LANGUAGES);
export type AsrLanguage = z.infer<typeof AsrLanguage>;

/**
 * What a person picking one of these actually sees.
 *
 * `unknown` is deliberately worded as a capability rather than an absence:
 * "Auto-detect" is a real choice with a real failure mode (0016's header
 * records a Tamil call mislabelled as Spanish, losing the whole transcript),
 * not a blank.
 */
export const ASR_LANGUAGE_LABELS: Record<AsrLanguage, string> = {
  "unknown": "Auto-detect",
  "ta-IN": "Tamil",
  "kn-IN": "Kannada",
  "te-IN": "Telugu",
  "ml-IN": "Malayalam",
  "hi-IN": "Hindi",
  "en-IN": "English",
  "mr-IN": "Marathi",
  "bn-IN": "Bengali",
  "gu-IN": "Gujarati",
  "pa-IN": "Punjabi",
  "od-IN": "Odia",
  "ur-IN": "Urdu",
  "as-IN": "Assamese",
  "ne-IN": "Nepali",
  "kok-IN": "Konkani",
  "sa-IN": "Sanskrit",
  "mai-IN": "Maithili",
  "ks-IN": "Kashmiri",
  "sd-IN": "Sindhi",
  "sat-IN": "Santali",
  "mni-IN": "Manipuri",
  "brx-IN": "Bodo",
  "doi-IN": "Dogri",
};

/**
 * Auto-detect first, then the rest alphabetically by LABEL rather than by code.
 * A dropdown of two dozen languages is scanned by name - ordering it by BCP-47
 * code puts Assamese under "as" between Punjabi and Urdu, which is only
 * sensible to somebody who already knows the code.
 */
export function asrLanguageOptions(): Array<{ code: AsrLanguage; label: string }> {
  const rest = ASR_LANGUAGES.filter((c) => c !== "unknown")
    .map((code) => ({ code, label: ASR_LANGUAGE_LABELS[code] }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [{ code: "unknown" as const, label: ASR_LANGUAGE_LABELS.unknown }, ...rest];
}

/** Saaras output formats the API accepts (migration 0016). */
export const ASR_MODES = ["transcribe", "translate", "verbatim", "translit", "codemix"] as const;
export const AsrMode = z.enum(ASR_MODES);
export type AsrMode = z.infer<typeof AsrMode>;

/**
 * The formats a console actually OFFERS, with the wording customers read.
 *
 * Deliberately a subset of `ASR_MODES`: `translit` is accepted by the API and
 * by 0016's CHECK, but no console has ever offered it and nobody here has
 * confirmed what Saaras returns for it. Putting a guess in front of a paying
 * customer - who would then have every call transcribed that way - is worse
 * than leaving one option out. Add it when someone has actually run a call
 * through it and can write the sentence truthfully.
 */
export const ASR_MODE_OPTIONS: Array<{ code: AsrMode; label: string; blurb: string }> = [
  {
    code: "transcribe",
    label: "Native script",
    blurb:
      "Everything in the spoken language's own script. English names spoken mid-sentence get transliterated - “RD Interlock” becomes “ஆர்டி இன்டர்லாக”.",
  },
  {
    code: "codemix",
    label: "Mixed script",
    blurb:
      "English words stay in English, the rest stays in its native script. Keeps brand names, product names and numbers readable. Best choice for most sales floors.",
  },
  {
    code: "translate",
    label: "English",
    blurb:
      "The whole call translated to English. Easiest to read for staff who don't speak the language, but you lose the customer's actual words.",
  },
  {
    code: "verbatim",
    label: "Verbatim",
    blurb:
      "Word for word, keeping filler words and spoken-out numbers. Useful for disputes, noisier for everything else.",
  },
];

/** The default when an instance has never chosen - matches the column default. */
export const ASR_MODE_DEFAULT: AsrMode = "transcribe";

/**
 * One vocabulary term. Matches `PolicyBody.vocabulary`'s element rules in
 * tenancy.controller.ts exactly, so the console refuses what the API would
 * refuse rather than round-tripping to find out.
 */
export const VocabularyTerm = z.string().trim().min(1).max(120);

/** The whole list. 200 is the API's cap. */
export const VOCABULARY_MAX = 200;
export const Vocabulary = z.array(VocabularyTerm).max(VOCABULARY_MAX);

/**
 * Normalise a list of terms for saving: trimmed, blanks dropped, de-duplicated
 * case-insensitively but KEEPING the first spelling seen.
 *
 * Case is preserved rather than folded because the whole point of the list is
 * spelling - "RD Interlock" is the answer and "rd interlock" is not, so the
 * casing a person typed is the data, not noise. Two entries differing only by
 * case are still a duplicate though: they would send the analyser contradictory
 * instructions about the same word.
 */
export function normaliseVocabulary(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out.slice(0, VOCABULARY_MAX);
}
