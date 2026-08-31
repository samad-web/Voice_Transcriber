import { z } from "zod";

/**
 * Projects - which of the tenant's own offerings a call was about
 * (migration 0073).
 *
 * The catalogue is the tenant's, created at runtime through the console. This
 * module holds the two things both the API and the worker need to agree on:
 * the wire shape, and the detector that turns a transcript into project hits.
 * The detector lives here rather than in the worker so it can be unit-tested
 * without a database and so the API's "preview what this would match" path
 * cannot drift from what the pipeline actually writes.
 */

/** `key` is the stable identifier; `name` is the tenant's to rename freely. */
export const PROJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export const ProjectSource = z.enum(["extraction", "human", "automation", "import"]);
export type ProjectSource = z.infer<typeof ProjectSource>;

export const ProjectInput = z.object({
  name: z.string().min(1).max(120),
  key: z.string().max(64).regex(PROJECT_KEY_PATTERN).optional(),
  description: z.string().max(2000).nullish(),
  color: z.string().max(40).nullish(),
  /**
   * Capped at 32 and 80 chars each. An unbounded alias list is a way to make
   * every call match every project, which reads as "the detector is broken"
   * long before anyone suspects the catalogue.
   */
  aliases: z.array(z.string().min(1).max(80)).max(32).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
export type ProjectInput = z.infer<typeof ProjectInput>;

export const ProjectPatch = ProjectInput.partial()
  .extend({ active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: "nothing to update" });
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  aliases: string[];
  active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/**
 * Derive a key from a display name, for the common case where the console
 * did not ask for one. "3D Website" -> "3d-website".
 *
 * Falls back to "project" for a name with no ASCII alphanumerics at all (a
 * purely Tamil or Devanagari project name is legal and would otherwise
 * produce an empty key that fails the CHECK constraint). Uniqueness is the
 * database's job - the caller retries with a suffix on 23505.
 */
export function deriveProjectKey(name: string): string {
  const key = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/u, "");
  return PROJECT_KEY_PATTERN.test(key) ? key : "project";
}

/**
 * Reduce free text to a comparable token list.
 *
 * Everything that is not an ASCII letter or digit becomes a separator, so
 * "LexDraft," "lex-draft" and "LEXDRAFT!" all reduce to the same tokens. This
 * is deliberately lossy about scripts other than Latin: a Tamil transcript
 * matching a Latin-named project happens through an explicit alias, not
 * through clever normalisation that nobody can predict or debug.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * How many times `term` appears in `haystack` as a whole-token run.
 *
 * Token-sequence containment rather than a regex over the raw string, which
 * gets word boundaries right for free: "aura" must not match "aurora", and
 * "3d website" must match "our 3d website redesign" but not "3d" alone. It
 * also sidesteps having to escape tenant-supplied aliases into a regex, which
 * is where this kind of code usually grows an injection bug.
 */
function countRuns(haystack: string[], term: string[]): number {
  if (term.length === 0 || term.length > haystack.length) return 0;
  let hits = 0;
  for (let i = 0; i <= haystack.length - term.length; i += 1) {
    let match = true;
    for (let j = 0; j < term.length; j += 1) {
      if (haystack[i + j] !== term[j]) {
        match = false;
        break;
      }
    }
    if (match) hits += 1;
  }
  return hits;
}

export interface DetectableProject {
  id: string;
  name: string;
  aliases?: string[] | null;
  sort_order?: number | null;
}

export interface ProjectHit {
  projectId: string;
  /** 0..1, rounded to 3dp so it round-trips numeric(4,3) exactly. */
  confidence: number;
  /** The name or alias that actually matched - shown to explain the label. */
  matchedOn: string;
  hits: number;
}

/**
 * A single-word name is a weaker signal than a multi-word one: "Aura" can
 * plausibly be a person's name, where "analytics agent" essentially cannot.
 * Starting them apart means a call that says "aura" once and "analytics
 * agent" once resolves to the latter, which is the right guess.
 */
const BASE_CONFIDENCE_SINGLE_TOKEN = 0.45;
const BASE_CONFIDENCE_MULTI_TOKEN = 0.6;
/**
 * Each repeat past the first is corroboration. Set EQUAL to the specificity
 * gap above, which fixes the exchange rate between the two signals at
 * "specificity is worth exactly one extra mention".
 *
 * That is the deliberate answer to the case that decided this number: a call
 * naming "3D Website" once and "LexDraft" twice. The multi-token bonus exists
 * to suppress FALSE positives on a word like "Aura" that could be a person's
 * name - it is not a claim that a two-word project matters more. Once a
 * single-token name has been said twice, that ambiguity is settled, and what
 * the call kept returning to is the better guess. The two tie on confidence
 * and the hit-count tiebreak below picks LexDraft.
 */
const REPEAT_BONUS = 0.15;

/**
 * Find every project the text plausibly refers to, strongest first.
 *
 * Deliberately NOT an LLM call. The catalogue is a closed list of names the
 * tenant wrote down, so this is a lookup, not a judgement - and a lookup that
 * runs in microseconds, costs nothing, returns the same answer twice, and can
 * explain itself via `matchedOn`. An extra model round-trip per call would buy
 * fuzziness nobody asked for and a bill that scales with call volume.
 *
 * Returns every match rather than a winner: one call really does cover several
 * projects, which is the whole reason `call_projects` is a join table.
 */
export function detectProjects(text: string, catalogue: DetectableProject[]): ProjectHit[] {
  const haystack = tokenize(text);
  if (haystack.length === 0) return [];

  const found: ProjectHit[] = [];

  for (const project of catalogue) {
    let best: { confidence: number; matchedOn: string; hits: number } | null = null;

    // The name and every alias are tried independently; the strongest wins.
    // A project is not more likely just because it has more aliases, or a
    // tenant who wrote five spellings would outrank one who wrote none.
    for (const term of [project.name, ...(project.aliases ?? [])]) {
      const tokens = tokenize(term);
      const hits = countRuns(haystack, tokens);
      if (hits === 0) continue;

      const base =
        tokens.length > 1 ? BASE_CONFIDENCE_MULTI_TOKEN : BASE_CONFIDENCE_SINGLE_TOKEN;
      const confidence = Math.min(1, base + REPEAT_BONUS * (hits - 1));
      if (!best || confidence > best.confidence) {
        best = { confidence, matchedOn: term, hits };
      }
    }

    if (best) {
      found.push({
        projectId: project.id,
        confidence: Math.round(best.confidence * 1000) / 1000,
        matchedOn: best.matchedOn,
        hits: best.hits,
      });
    }
  }

  // Confidence, then raw hit count, then the tenant's own ordering - a total
  // order, so "the primary project" is never decided by row arrival order.
  const rank = new Map(catalogue.map((p, i) => [p.id, p.sort_order ?? i]));
  return found.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      b.hits - a.hits ||
      (rank.get(a.projectId) ?? 0) - (rank.get(b.projectId) ?? 0),
  );
}

/** The single project a lead gets labelled with - the strongest hit, or none. */
export function primaryProject(hits: ProjectHit[]): ProjectHit | null {
  return hits[0] ?? null;
}
