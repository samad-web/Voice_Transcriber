import { featureEnabled, type OrgFeature } from "./org-features";

/**
 * WHAT IS ALREADY WORKING - the first thing a new client should read.
 *
 * ── THE PROBLEM WITH A CHECKLIST ON ITS OWN ─────────────────────────────────
 *
 * The setup modal (migration 0095) opens with a list of things that are NOT
 * done. That is the right content and the wrong first impression: a client who
 * has just been provisioned, paired a handset and watched it record two calls
 * is greeted by four unticked boxes, and the question the screen answers is
 * "how much work is ahead of me" rather than "what have I got".
 *
 * Leading with what is already running inverts it. The client paid for a thing;
 * the first screen should show them the thing, then what is left.
 *
 * Adapted from DeskcommCRM (MIT, Rafael Melgaco),
 * `app/onboarding/_components/JaEstaPronto.tsx`, whose header makes the case
 * better than this one: people arriving at that wizard had just installed a
 * whole server and were met with a blank form, as if they had done nothing.
 *
 * ── EVERY LINE IS MEASURED. THAT IS THE ONLY RULE HERE ──────────────────────
 *
 * The failure this must not repeat is the one that file also names: a panel
 * that reassures without checking. "Your AI is configured" rendered without
 * looking is the sentence that calms somebody down while their product is
 * silently broken - and it is worse than no panel, because it actively stops
 * them investigating.
 *
 * So there is no line here that is not backed by a fact from the database, and
 * a fact that is FALSE does not become an encouraging sentence - it becomes
 * nothing at all. This panel never lists a problem; the checklist below it is
 * where unfinished things live, and saying them twice in two voices is how a
 * screen stops being read.
 */

/** Measured facts. Every field is read from a row, never assumed. */
export interface ReadinessFacts {
  /** Handsets currently enrolled and active. */
  deviceCount: number;
  /** Calls recorded so far. The proof the product is doing its job. */
  callCount: number;
  /** Calls with a transcript. Zero with transcription on is NOT reported - see below. */
  transcriptCount: number;
  /** The org-level switch (`organizations.transcription_enabled`). */
  transcriptionEnabled: boolean;
  /** Leads on the board, however they arrived. */
  leadCount: number;
  /** Provisioning, for the "what you were sold" line. */
  modules: readonly string[];
  features: readonly string[];
}

export interface ReadinessLine {
  /** Stable key for React, and for a test to name a line without matching prose. */
  id: string;
  /** One short sentence, present tense. */
  text: string;
}

/**
 * The lines worth showing, in the order a person cares about them.
 *
 * Returns an empty array for a tenant where nothing is running yet, and the
 * console renders nothing at all rather than an empty heading - a brand-new
 * org genuinely has nothing to report, and a "What's already running" box with
 * no rows in it is a worse start than no box.
 */
export function readinessLines(facts: ReadinessFacts): ReadinessLine[] {
  const lines: ReadinessLine[] = [];

  if (facts.deviceCount > 0) {
    lines.push({
      id: "handsets",
      text:
        facts.deviceCount === 1
          ? "One handset is paired and recording"
          : `${facts.deviceCount} handsets are paired and recording`,
    });
  }

  if (facts.callCount > 0) {
    lines.push({
      id: "calls",
      text:
        facts.callCount === 1
          ? "1 call captured so far"
          : `${facts.callCount.toLocaleString("en-IN")} calls captured so far`,
    });
  }

  // Only when transcripts EXIST. The switch being on proves nothing - a
  // tenant with transcription enabled and zero transcripts has a pipeline
  // problem, and "Transcription is on" is exactly the reassuring sentence
  // that would stop them looking into it.
  if (facts.transcriptionEnabled && facts.transcriptCount > 0) {
    lines.push({
      id: "transcripts",
      text:
        facts.transcriptCount === 1
          ? "1 call transcribed and searchable"
          : `${facts.transcriptCount.toLocaleString("en-IN")} calls transcribed and searchable`,
    });
  }

  if (facts.leadCount > 0) {
    lines.push({
      id: "leads",
      text:
        facts.leadCount === 1
          ? "1 lead on your board"
          : `${facts.leadCount.toLocaleString("en-IN")} leads on your board`,
    });
  }

  // Provisioning, last, and only when they were sold something beyond core
  // Aura. This is the one line not about activity - it answers "what do I
  // have" rather than "what has happened", which is the question a client
  // on day one is actually asking.
  const extras = EXTRAS.filter((e) => featureEnabled(e.feature, facts.modules, facts.features));
  if (extras.length > 0) {
    lines.push({
      id: "included",
      text: `Included on your plan: ${joinWords(extras.map((e) => e.label))}`,
    });
  }

  return lines;
}

const EXTRAS: Array<{ feature: OrgFeature; label: string }> = [
  { feature: "inbox", label: "the shared inbox" },
  { feature: "messaging_setup", label: "WhatsApp" },
  { feature: "lead_sources", label: "web and email lead capture" },
  { feature: "meta_ads", label: "Facebook lead ads" },
  { feature: "invoices", label: "quotations and invoices" },
];

/** "a, b and c" - an Oxford-comma-free list, because it reads inside a sentence. */
function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}
