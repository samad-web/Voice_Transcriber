import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { blankNonCode } from "@/lib/test-support/source-scan";

/**
 * THE COLOUR RULE, ENFORCED.
 *
 * The rule (packages/ui/src/state.tsx) is that colour in this console encodes
 * STATE - missed, answered, outgoing, error - and nothing else. Everything
 * else is grey.
 *
 * A rule like that survives exactly as long as somebody remembers it, and it
 * is not the kind of thing review catches: `bg-emerald-500` on a "Connected"
 * badge looks like an improvement in a diff, reads as obviously correct to
 * whoever wrote it, and is only wrong in aggregate. The cost is that the
 * twentieth green thing on the screen makes the one green thing that MEANT
 * something stop meaning it, and nobody notices the day that happens. So it is
 * a test.
 *
 * ── WHAT IS IN SCOPE, AND WHY IT IS NOT EVERYTHING ──────────────────────────
 *
 * Zero tolerance across the CUSTOMER console (`app/(owner)`), the shared
 * components, and the kit. That is the dashboard this rule was written for and
 * it is now clean.
 *
 * The OPERATOR console (`app/(platform)`, plus `login` and `docs`) is a
 * different situation and is held to a weaker rule on purpose. Those pages are
 * the un-migrated half of the design-system v2 rollout - theme.css's own
 * header describes them ("~50 files on Tailwind's stock palette until the
 * slice-2 migration lands") and globals.css names a developer migrating them
 * concurrently. Repainting them here would be a large diff on pages nobody
 * asked about, landing in the middle of somebody else's migration.
 *
 * What they get instead is a RATCHET: the exact files already carrying stock
 * colours are listed below, and any file not on that list must be clean. A
 * page being migrated drops off the list; a new page cannot join it. The list
 * is meant to shrink and the test fails if a name on it is fixed and not
 * removed, so it cannot quietly become fiction.
 */

const WEB_ROOT = join(__dirname, "..");

/** Tailwind's stock ramps. Anything with a numeric shade is not a token. */
const STOCK_PALETTE =
  /\b(?:bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|divide|accent|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|\d{3})\b/;

/**
 * A background AND a matching foreground from the same STATE ramp: a chip.
 *
 * Only the four reserved hues. `accent` is the interaction colour - links, the
 * focus ring, a step badge - and banning it here would ban half the kit for no
 * gain; `warning` and `info` are not state hues in this system.
 *
 * `outgoing` joined the list when it stopped being `accent`. That split was
 * forced by white-labelling: the accent is replaced wholesale by a tenant's own
 * hex, and a customer whose brand colour was red would otherwise have had red
 * meaning both "we rang them" and "nobody picked up". The state ramp is now
 * separate and unbrandable, so it belongs here with the other three.
 *
 * The rule being enforced is "do not re-implement the state chip without its
 * glyph", not "never name a colour".
 */
const HAND_ROLLED_CHIP = /\bbg-(danger|success|orange|outgoing)-subtle\b[^"'`]*\btext-\1-text\b/;

const GRADIENT = /var\(--brand-gradient\)/;

/** Where the rule is absolute. */
const STRICT = [join("app", "(owner)"), "components", join("packages", "ui", "src")];

/**
 * `app/(platform)`, `app/login` and `app/docs` files still on the stock
 * palette, from the pre-v2 design system. MEANT TO SHRINK - delete a line when
 * its page is migrated. Nothing may be added.
 */
const LEGACY_STOCK_PALETTE: string[] = [
  // Arrived with the operator-console work on this branch and never went
  // through the palette pass. Operator-only, so no customer sees it - which is
  // why it is backlog rather than a blocker.
  //
  // The 14 files that used to live here (operators-manager, agent-sandbox,
  // agent-studio, enrollment-credentials, instance-form, asr-settings,
  // erasure-tool, key-generator, owner-accounts, policy-form, leads/page,
  // search-explorer, slots/page, usage/page) were migrated to the semantic
  // token set in one pass and struck off - see console-colour-rule memory.
];

/** The same ratchet for hand-rolled state chips outside the strict scope. */
const LEGACY_CHIPS = [
  "app/(platform)/calls/calls-explorer.tsx",
  "app/(platform)/crm/integration-card.tsx",
  "app/(platform)/instances/[id]/instance-tabs.tsx",
  "app/login/login-form.tsx",
];

/**
 * Files that may spend colour directly, permanently.
 *
 *  - the print stylesheet renders to PAPER, where the token layer (and dark
 *    mode with it) does not exist and a fixed hex is the correct answer;
 *  - state.tsx and error-banner.tsx ARE the definition of the state chip;
 *  - this test names the class strings it is looking for.
 */
const EXEMPT = [
  "app/(owner)/owner/reports/builder/[id]/print/printable-report.tsx",
  "packages/ui/src/state.tsx",
  "packages/ui/src/error-banner.tsx",
  "app/console-palette.test.ts",
];

/** Where the brand gradient is still correct: permanent chrome, never beside data. */
const GRADIENT_CHROME = [
  "components/sidebar.tsx",
  "components/mobile-nav.tsx",
  // The owner rail both of the above render - the same active-item fill, moved
  // into one file so the two breakpoints cannot drift apart.
  "components/owner-rail-nav.tsx",
  "components/page-header.tsx",
  // A loading placeholder carries no meaning and is replaced within a second;
  // there is no data on screen for it to be confused with.
  "components/skeletons.tsx",
  // The header hairline, `fixed` above the sidebar AND the content column so it
  // is edge to edge of the viewport - used to be inline in sidebar.tsx and
  // mobile-nav.tsx (both above), moved here so it can span both at once.
  "app/(owner)/layout.tsx",
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // `.next` is build output and `node_modules` is other people's code;
    // scanning either would fail this suite on markup nobody here wrote.
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (extname(entry.name) === ".tsx") out.push(full);
  }
  return out;
}

/** Repo-relative, forward-slashed - as the allowlists above are written. */
function label(file: string): string {
  const rel = relative(WEB_ROOT, file).split(sep).join("/");
  // The kit resolves as ../../packages/ui/src/... from apps/web.
  return rel.replace(/^\.\.\/\.\.\//, "");
}

const FILES = [
  ...sourceFiles(join(WEB_ROOT, "app")),
  ...sourceFiles(join(WEB_ROOT, "components")),
  ...sourceFiles(join(WEB_ROOT, "..", "..", "packages", "ui", "src")),
];

const inStrictScope = (name: string) =>
  STRICT.some((prefix) => name.startsWith(prefix.split(sep).join("/")));

/**
 * Does this file contain the pattern as CODE?
 *
 * `blankNonCode` erases comments and string literals, but a Tailwind class
 * list only ever LIVES in a string - so the match is run against the raw
 * source, and the blanked copy is used only to tell a real class from one
 * merely discussed in a comment. state.tsx's own header names `text-red-500`,
 * and this is what stops that reading as a violation.
 */
function hits(file: string, pattern: RegExp): string[] {
  const raw = readFileSync(file, "utf8");
  const blankLines = blankNonCode(raw).split("\n");
  return raw.split("\n").flatMap((line, i) => {
    if (!pattern.test(line)) return [];
    if (blankLines[i]?.trim() === "") return [];
    return [`${label(file)}:${i + 1}  ${line.trim()}`];
  });
}

const violators = (pattern: RegExp, filter: (name: string) => boolean) =>
  FILES.filter((f) => {
    const name = label(f);
    return !EXEMPT.includes(name) && filter(name);
  }).flatMap((f) => hits(f, pattern));

/** Just the file names, deduped - what the ratchet lists compare against. */
const violatingFiles = (pattern: RegExp, filter: (name: string) => boolean) => [
  ...new Set(violators(pattern, filter).map((h) => h.split(":")[0]!)),
];

describe("the console's colour rule", () => {
  it("scans a real body of files - a scanner that found nothing would pass silently", () => {
    // The guard on the guard: a `sourceFiles` that quietly returned [] would
    // make every assertion below vacuously true.
    expect(FILES.length).toBeGreaterThan(80);
    expect(FILES.map(label).filter(inStrictScope).length).toBeGreaterThan(40);
  });

  it("spends no stock Tailwind colour in the customer console, the shared components or the kit", () => {
    expect(violators(STOCK_PALETTE, inStrictScope)).toEqual([]);
  });

  it("hand-rolls no state chip there - StateChip, StatusChip and ErrorBanner own that shape", () => {
    expect(violators(HAND_ROLLED_CHIP, inStrictScope)).toEqual([]);
  });

  it("keeps the brand gradient out of the content area", () => {
    // The rail and the page header may carry it: permanent chrome, never
    // adjacent to call data, and it is what makes the console look like the
    // product rather than a table viewer. Inside the content area it is a
    // different thing - the gradient's mid-stop is a blue within a few degrees
    // of `--color-accent`, which now means OUTGOING, so a selected filter pill
    // above a call log was painting "this filter is on" in the same colour as
    // "we rang them".
    const offenders = violators(
      GRADIENT,
      (name) =>
        !GRADIENT_CHROME.includes(name) &&
        // The kit declares the gradient and its primary Button spends it; both
        // are the definition, not a call site.
        !name.startsWith("packages/ui/src"),
    );
    expect(offenders).toEqual([]);
  });

  it("lets no NEW operator-console page join the stock-palette backlog", () => {
    const outside = (name: string) => !inStrictScope(name);
    const unlisted = violatingFiles(STOCK_PALETTE, outside).filter(
      (f) => !LEGACY_STOCK_PALETTE.includes(f),
    );
    expect(unlisted).toEqual([]);
  });

  it("lets no NEW hand-rolled state chip appear outside the strict scope", () => {
    const outside = (name: string) => !inStrictScope(name);
    const unlisted = violatingFiles(HAND_ROLLED_CHIP, outside).filter(
      (f) => !LEGACY_CHIPS.includes(f),
    );
    expect(unlisted).toEqual([]);
  });

  it("keeps the backlog lists honest - a fixed file must be struck off", () => {
    // Without this, the lists rot into a permanent exemption nobody revisits:
    // a page gets migrated, its name stays, and the next page to regress in
    // that file passes silently. Deleting the line is part of migrating it.
    const outside = (name: string) => !inStrictScope(name);
    const stillDirty = new Set(violatingFiles(STOCK_PALETTE, outside));
    expect(LEGACY_STOCK_PALETTE.filter((f) => !stillDirty.has(f))).toEqual([]);

    const stillChipped = new Set(violatingFiles(HAND_ROLLED_CHIP, outside));
    expect(LEGACY_CHIPS.filter((f) => !stillChipped.has(f))).toEqual([]);
  });
});
