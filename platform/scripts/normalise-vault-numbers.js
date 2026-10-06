/**
 * normalise-vault-numbers.js - the second pass over 0157's backfill
 * (Build docs/39 §3.1).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * 0157 seeds `contact_numbers` from `calls.remote_number_full` for every org on
 * `store_full_number`, inbound calls only. It can only seed a number that
 * ALREADY carries its country code, and it says so: libphonenumber does not
 * exist inside Postgres, `'+9876543210'` would parse as country code 98, and
 * `org_business_profile.country` (0126) is an ISO-2 code, not a calling code -
 * turning one into the other is a 200-row table that has no business living in
 * a migration. So the backfill's `e164 ~ '^\+[1-9][0-9]{6,14}$'` guard rejects
 * every bare ten-digit number, and rejects it SILENTLY.
 *
 * That is the quiet failure §3.1 is about. Those leads do not error; they simply
 * report `no_number` in the first campaign preview, which looks exactly like an
 * empty vault rather than a partial one. This script is the pass that recovers
 * what can be recovered and, just as importantly, PUTS A NUMBER ON WHAT CANNOT -
 * "the dialer works" and "the dialer has anything to dial" are different claims
 * and only the second one depends on this.
 *
 * ── WHY A SCRIPT AND NOT A MIGRATION ───────────────────────────────────────
 *
 * Because it needs libphonenumber, which is the whole point. The same reason
 * scripts/backfill-lead-temperature.js is a script: a rule that is already
 * written and unit-tested in @aura/shared must not be written a second time as
 * a CASE expression, because then there are two definitions that agree only
 * until somebody edits one.
 *
 * ── WHAT IT REUSES, AND WHY NOTHING IS HAND-ROLLED ─────────────────────────
 *
 *   importPhone()           @aura/shared/dist/import-phone. The spreadsheet
 *                           importer's phone-cell reader, which is this exact
 *                           problem: a number with no country picker beside it,
 *                           resolved against the workspace's own country. It
 *                           also already handles the two ways a number arrives
 *                           mangled - an explicit "+971..." that names its own
 *                           country, and digits-only "919876543210" retried as
 *                           "+<digits>" against the org's OWN calling code
 *                           only. A bare foreign number is refused rather than
 *                           guessed at, which is precisely the rule §3.1 sets.
 *   contactNumberMatchKey() @aura/db (packages/db/src/call-lead-link.ts) -
 *                           sha256(phoneMatchDigits(raw)), hex. THE key, not a
 *                           key: `calls.remote_number_key` (0133),
 *                           `leads.contact_number_key` (0146) and
 *                           `contact_numbers.number_key` (0157) are compared
 *                           for equality and nothing else, so a differently
 *                           computed key does not throw - it writes a row that
 *                           nothing will ever match.
 *   splitPhone()            @aura/shared/dist/phone, to record which country
 *                           the resolved number actually belongs to (+1 is the
 *                           US, Canada and the Caribbean).
 *
 * ── THE THREE COUNTS (§3.1.2), AND WHAT SEPARATES THEM ─────────────────────
 *
 * Counted in DISTINCT NUMBERS, not calls - a number rung fifty times is one
 * number, and "how big is the gap" is a question about people, not rows.
 *
 *   seeded            resolved to exactly one E.164 and written to the vault.
 *   still-unparseable we had the org's country and libphonenumber still refused
 *                     it. It is not a valid number in that numbering plan, and
 *                     no further information would change that - junk, an
 *                     extension, a truncated digit. DEAD: nobody can fix it.
 *   ambiguous         it may well be a real number, but there is more than one
 *                     defensible reading and no honest basis to choose. RECOVER-
 *                     ABLE: somebody supplying the missing fact fixes it. Three
 *                     ways in, and all three are reported separately below:
 *                       no_org_country  the org has no row in
 *                                       org_business_profile at all, or its
 *                                       country is not one libphonenumber
 *                                       knows. There is nothing to resolve
 *                                       against. NOT defaulted to IN - a wrong
 *                                       country code produces a number that
 *                                       dials a stranger, and
 *                                       DEFAULT_PHONE_COUNTRY exists for a
 *                                       console field where a human can see and
 *                                       change it, not for a batch job.
 *                       two_readings    the digits are a valid national number
 *                                       for the org's country AND a valid
 *                                       international number read as "+digits",
 *                                       and the two disagree. importPhone would
 *                                       silently prefer the national one; this
 *                                       refuses instead.
 *                       key_conflict    two different spellings share a
 *                                       number_key (the last ten digits) and
 *                                       resolve to different E.164 numbers. The
 *                                       unique index can hold one of them, and
 *                                       choosing by recency would be inferring a
 *                                       country from an arbitrary row.
 *
 * Both non-seeded buckets are LEFT OUT OF THE VAULT ENTIRELY, per §3.1.3.
 * `dialability()` then returns `no_number`, which is the correct and honest
 * answer - a guessed country code is worse than no number at all.
 *
 * ── NOTHING IN THE OUTPUT IS A PHONE NUMBER ────────────────────────────────
 *
 * Every line this prints is a count or a stable reason code. Not a raw number,
 * not an E.164, not a number_key. `importPhone`'s own refusal message quotes
 * the cell it refused, so it is deliberately NOT carried into the report;
 * `checkPhone`'s stable `problem` code is used for the breakdown instead. The
 * one table in this platform that holds a dialable number is read by exactly
 * two API routes (§2.1); a script's stdout, which lands in a terminal
 * scrollback and a deploy log, is not going to be the third.
 *
 * ── SAFE TO POINT AT PRODUCTION, AND SAFE TO RUN TWICE ─────────────────────
 *
 * DRY RUN IS THE DEFAULT. Writing needs `--apply`, spelled out. That is a
 * deliberate departure from scripts/backfill-lead-temperature.js, where no flag
 * means write: this one is normally run for the first time against a live
 * tenant's call history, and the counts - which are the deliverable - are
 * available without writing a byte. verify-rls.js's assertDisposable() makes the
 * same trade in the other direction.
 *
 * Re-runnable: candidates are the inbound calls whose key is NOT already in the
 * vault, so a second run finds nothing left and reports 0 seeded. The INSERT is
 * `ON CONFLICT (org_id, number_key) DO NOTHING` as well, which covers the race
 * with a live handset uploading a call while this runs. Nothing is ever updated
 * and nothing is ever deleted: a basis already in the vault is 0157's or a
 * human's, and this script does not outrank either.
 *
 * ── RUNNING IT ─────────────────────────────────────────────────────────────
 *
 *   pnpm --filter @aura/shared build && pnpm --filter @aura/db build
 *
 *   node scripts/normalise-vault-numbers.js             # dry run, all orgs
 *   node scripts/normalise-vault-numbers.js --apply     # write
 *   node scripts/normalise-vault-numbers.js <org-uuid>  # one tenant
 *
 * Needs DATABASE_URL (admin - the org list and org_business_profile span
 * tenants, so they cannot be read inside an org context) and APP_DATABASE_URL
 * (aura_app - every per-tenant read and the INSERT go through withOrgContext,
 * so RLS is enforced rather than bypassed on the one table that holds a
 * dialable number).
 *
 * Run it and read its output BEFORE P1's acceptance test (§3.1).
 */
/**
 * A built dependency that is not optional, with the build command in the error.
 *
 * Both of these are `dist` - @aura/shared is CommonJS and nothing here is
 * compiled, so a stale or absent build is the likeliest way this script fails,
 * and "Cannot find module" is not the message that tells you what to do about
 * it (scripts/backfill-lead-temperature.js does the same).
 */
function need(specifier, buildCommand) {
  try {
    return require(specifier);
  } catch (err) {
    console.error(`cannot load ${specifier}\nRun: ${buildCommand}\n\n${err.message}`);
    process.exit(1);
  }
}

const { withOrgContext, getAdminPool, closeAllPools, contactNumberMatchKey } = need(
  // Resolved from platform/scripts/, same as every sibling here
  // (backfill-lead-temperature.js, backfill-leads.js, reprocess-backlog.js).
  "../packages/db/dist/index.js",
  "pnpm --filter @aura/db build",
);
// Resolved by PATH, not by bare specifier, and per SUBMODULE rather than
// through the barrel. Two separate reasons, both of which bit during the move
// of this file from packages/db/scripts/ to here:
//
//   * `platform/` is not a workspace package, so it has no node_modules link to
//     @aura/shared and a bare "@aura/shared/..." does not resolve from here.
//     backfill-lead-temperature.js builds its path with __dirname for the same
//     reason, and this follows it.
//   * neither `./phone` nor `./import-phone` is re-exported from
//     packages/shared/src/index.ts - deliberately, since both pull in
//     libphonenumber - so the barrel does not have these functions at all.
//     They have to be required from their own dist files.
const sharedDist = (name) =>
  require("node:path").join(__dirname, `../packages/shared/dist/${name}.js`);

const { importPhone } = need(sharedDist("import-phone"), "pnpm --filter @aura/shared build");
const { checkPhone, isPhoneCountry, splitPhone } = need(
  sharedDist("phone"),
  "pnpm --filter @aura/shared build",
);

// A stale build resolves but comes back without the function, which would
// otherwise surface as "fn is not a function" deep inside a per-org loop.
for (const [name, fn] of Object.entries({ importPhone, checkPhone, isPhoneCountry, splitPhone })) {
  if (typeof fn !== "function") {
    console.error(`@aura/shared has no ${name} - is the build stale?\nRun: pnpm --filter @aura/shared build`);
    process.exit(1);
  }
}

const USAGE = `normalise-vault-numbers - recover the numbers 0157's backfill could not normalise

  node scripts/normalise-vault-numbers.js [<org-uuid>] [--apply] [--dry-run]

  (no flag)   dry run: report the three counts, write nothing. THE DEFAULT.
  --apply     write the numbers that resolved into contact_numbers
  <org-uuid>  one tenant instead of every org on store_full_number
`;

/** Rows inserted per statement. Keeps the round trips to Seoul proportional to numbers, not calls. */
const INSERT_CHUNK = 500;

/** Outcomes, which are also the three counts §3.1 asks for. */
const SEED = "seeded";
const UNPARSEABLE = "unparseable";
const AMBIGUOUS = "ambiguous";

/**
 * Every org that 0011's switch is on for, with the country to resolve against.
 *
 * LEFT JOIN, not JOIN: an org with no business profile must appear here and be
 * REPORTED as ambiguous, not vanish from the run. "This tenant has 900 numbers
 * nobody can resolve because nobody set their country" is the single most
 * actionable line this script can print, and an inner join would delete it.
 *
 * `store_full_number` alone, with no status predicate - 0157's backfill filters
 * on exactly that and this is its second pass. The vault's gate is 0011's
 * switch; subsetting it here would seed a different set of orgs from the
 * migration and make the two impossible to reconcile.
 */
const SELECT_ORGS = `
  SELECT o.id, o.name, p.country
    FROM organizations o
    LEFT JOIN org_business_profile p ON p.org_id = o.id
   WHERE o.store_full_number
     AND ($1::uuid IS NULL OR o.id = $1::uuid)
   ORDER BY o.created_at`;

/**
 * The inbound numbers that are not in the vault yet - the rows 0157's
 * `e164 ~ '^\+[1-9][0-9]{6,14}$'` guard rejected.
 *
 * `direction = 'incoming'`, and that literal is the whole point of the
 * predicate. `calls.direction` has been CHECK (direction IN ('incoming',
 * 'outgoing')) since 0001_init - doc 39's own §3 warns that an earlier draft
 * wrote 'in', which would have matched zero rows and been indistinguishable
 * from a tenant with no inbound calls. And inbound is not an arbitrary filter:
 * they rang us, which is what makes `customer_initiated` true. An outbound call
 * proves nothing about consent.
 *
 * The key expression in the NOT EXISTS is COALESCE(remote_number_key, <0157's
 * CASE>), byte-for-byte what 0157 used, so "already in the vault" means the same
 * thing to both. It is a PRE-FILTER only: the authoritative key is recomputed
 * with contactNumberMatchKey() in JS and checked against the vault again before
 * anything is written, because the SQL fallback and the TypeScript helper could
 * in principle disagree on a junk value (SQL's ltrim branch does not re-check
 * the minimum length afterwards; `phoneMatchDigits` does). A row kept with
 * `sql_key IS NULL` is kept on purpose - it is junk, and junk still has to be
 * counted.
 *
 * DISTINCT ON (sql_key, remote_number_full) collapses the fifty calls from one
 * number down to one row per distinct spelling - which is the unit the counts
 * are in, and which is also what makes `key_conflict` detectable at all: one
 * row per key would have thrown away the second spelling that disagrees.
 *
 * Runs inside withOrgContext, so RLS scopes both `calls` and `contact_numbers`
 * to this tenant. `cn.org_id = $1` is written out anyway: the unique index is
 * (org_id, number_key), and a dedupe check that silently matched another
 * tenant's row would skip a number with no trace.
 */
const SELECT_CANDIDATES = `
  WITH inbound AS (
    SELECT c.id,
           c.started_at,
           c.remote_number_full,
           c.remote_number_key,
           regexp_replace(c.remote_number_full, '\\D', '', 'g') AS digits
      FROM calls c
     WHERE c.direction = 'incoming'
       AND c.remote_number_full IS NOT NULL
  ),
  keyed AS (
    SELECT i.*,
           COALESCE(
             i.remote_number_key,
             CASE WHEN length(i.digits) >= 10
                    THEN encode(sha256(convert_to(right(i.digits, 10), 'UTF8')), 'hex')
                  WHEN length(i.digits) >= 6
                    THEN encode(sha256(convert_to(ltrim(i.digits, '0'), 'UTF8')), 'hex')
             END) AS sql_key
      FROM inbound i
  )
  SELECT DISTINCT ON (k.sql_key, k.remote_number_full)
         k.id AS call_id,
         k.started_at,
         k.remote_number_full,
         k.remote_number_key,
         k.sql_key
    FROM keyed k
   WHERE k.sql_key IS NULL
      OR NOT EXISTS (
           SELECT 1 FROM contact_numbers cn
            WHERE cn.org_id = $1::uuid AND cn.number_key = k.sql_key)
   ORDER BY k.sql_key, k.remote_number_full, k.started_at DESC`;

/**
 * `consent_evidence` in the shape 0157's backfill writes it, plus what is true
 * of these rows and not of those: which country the number was resolved
 * against, and that a script did it rather than the migration.
 *
 * Frozen, never re-derived (0157's comment on the column). If the tenant later
 * changes their country in org_business_profile, this row still records the
 * country that produced the E.164 sitting beside it - which is the only way to
 * audit a resolved number at all.
 */
const INSERT_NUMBERS = `
  INSERT INTO contact_numbers
    (org_id, number_key, e164, country, source, consent_basis, consent_evidence, consent_at)
  SELECT $1::uuid, t.number_key, t.e164, t.country, 'call', 'customer_initiated',
         t.evidence::jsonb, t.consent_at
    FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
      AS t(number_key, e164, country, evidence, consent_at)
  ON CONFLICT (org_id, number_key) DO NOTHING`;

/**
 * The second reading of a digits-only number: what importPhone would have tried
 * had the national read failed.
 *
 * importPhone runs this retry ONLY after the plain national read fails, so a
 * value that is valid both ways comes back as the national one with no sign
 * that the other reading existed. Asking the same question here is what turns
 * that silent preference into the `two_readings` count.
 *
 * A number that already states its own country ("+..." or "00...") has exactly
 * one reading and is skipped. The 8-15 digit window is importPhone's own.
 */
function secondReading(raw, country) {
  const text = String(raw ?? "").trim();
  if (/^(\+|00[1-9])/.test(text)) return null;
  if (!/^[\d\s().-]+$/u.test(text)) return null;
  const digits = text.replace(/\D+/gu, "");
  if (digits.length < 8 || digits.length > 15) return null;
  const retry = checkPhone(`+${digits}`, country);
  return retry.ok && !retry.empty ? retry.e164 : null;
}

/**
 * One stored number, classified. PURE - no database, no clock - so the
 * classification can be exercised with fabricated input.
 *
 * `country` is the org's ISO-2 code, or null when it has none.
 */
function resolveNumber({ raw, storedKey, country }) {
  const numberKey = contactNumberMatchKey(raw);

  // Fewer than six digits after stripping punctuation: "n/a", "-", an
  // extension. phoneMatchDigits' own floor, and the same floor crm-ingest and
  // the importer use - a short digit string that became a dedupe key would
  // merge every future junk row onto one contact.
  if (!numberKey) return { outcome: UNPARSEABLE, reason: "too_few_digits" };

  // The hazard the whole §3.1 pass exists to avoid, caught rather than written:
  // if our key disagrees with the key `calls` already stores for this very row,
  // one of the two is wrong and the vault row would join to nothing. Report it;
  // do not pick a winner.
  if (storedKey && storedKey !== numberKey) {
    return { outcome: AMBIGUOUS, reason: "key_disagrees", numberKey };
  }

  if (!country) return { outcome: AMBIGUOUS, reason: "no_org_country", numberKey };

  const read = importPhone(raw, country);
  if (!read.ok || !read.e164) {
    // The stable PhoneProblem code, never importPhone's message - the message
    // quotes the number it refused.
    const problem = read.ok ? "empty" : (checkPhone(raw, country).problem ?? "invalid");
    return { outcome: UNPARSEABLE, reason: problem, numberKey };
  }

  const other = secondReading(raw, country);
  if (other && other !== read.e164) {
    return { outcome: AMBIGUOUS, reason: "two_readings", numberKey };
  }

  return {
    outcome: SEED,
    numberKey,
    e164: read.e164,
    // Which country the number turns out to belong to, which is not always the
    // one we resolved against: +1 is the US, Canada and the Caribbean.
    country: splitPhone(read.e164, country).country,
  };
}

/**
 * Every candidate row for one org, folded into one decision per number_key.
 *
 * Rows arrive most-recent-first, so the first SEED for a key is the freshest
 * call - matching 0157's `DISTINCT ON ... ORDER BY started_at DESC`, and for
 * the same reason: `consent_at` means "when they last rang us", and the
 * freshest contact is the strongest thing to be able to assert.
 *
 * A key with two SEED rows that resolved DIFFERENTLY is `key_conflict` and
 * seeds nothing. 0157 takes the most recent in that situation, but there the
 * competing rows each stated their own country explicitly; here the country is
 * inferred, so most-recent-wins would be inferring a country from whichever row
 * happened to be newer.
 */
function foldByKey(rows) {
  const decided = new Map();
  let junk = 0;
  const reasons = { [UNPARSEABLE]: new Map(), [AMBIGUOUS]: new Map() };

  const bump = (bucket, reason) =>
    reasons[bucket].set(reason, (reasons[bucket].get(reason) ?? 0) + 1);

  for (const row of rows) {
    const resolved = row.resolved;

    // No key at all, so it cannot be grouped - and does not need to be: the
    // SELECT already returned one row per distinct spelling.
    if (!resolved.numberKey) {
      junk += 1;
      bump(UNPARSEABLE, resolved.reason);
      continue;
    }

    const seen = decided.get(resolved.numberKey);
    if (!seen) {
      decided.set(resolved.numberKey, { ...resolved, row });
      continue;
    }

    // A conflict is STICKY. Without this, a third spelling that happens to
    // resolve would overwrite the conflict two earlier ones established and the
    // key would be seeded after all - from whichever reading came last, which
    // is exactly the arbitrary choice this refuses to make.
    if (seen.reason === "key_conflict") continue;

    // Already settled on a number for this key: agreeing is a duplicate
    // spelling of the same person; disagreeing is a conflict we refuse.
    if (seen.outcome === SEED) {
      if (resolved.outcome === SEED && resolved.e164 !== seen.e164) {
        decided.set(resolved.numberKey, { outcome: AMBIGUOUS, reason: "key_conflict" });
      }
      continue;
    }

    // A later row that DOES resolve rescues a key an earlier row could not read.
    if (resolved.outcome === SEED) decided.set(resolved.numberKey, { ...resolved, row });
    else if (seen.outcome === UNPARSEABLE && resolved.outcome === AMBIGUOUS) {
      decided.set(resolved.numberKey, { ...resolved, row });
    }
  }

  const seeds = [];
  const counts = { [SEED]: 0, [UNPARSEABLE]: junk, [AMBIGUOUS]: 0 };
  for (const decision of decided.values()) {
    counts[decision.outcome] += 1;
    if (decision.outcome === SEED) seeds.push(decision);
    else bump(decision.outcome, decision.reason);
  }
  return { seeds, counts, reasons };
}

/** 1234567 -> "1,234,567". Locale-free, so the output is the same everywhere. */
function fmt(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const apply = args.includes("--apply");
  const only = args.find((a) => !a.startsWith("--")) ?? null;
  const unknown = args.filter((a) => a.startsWith("--") && !["--apply", "--dry-run"].includes(a));
  if (unknown.length > 0) {
    console.error(`unknown flag: ${unknown.join(" ")}\n\n${USAGE}`);
    process.exit(1);
  }
  if (apply && args.includes("--dry-run")) {
    console.error("--apply and --dry-run contradict each other; pick one.");
    process.exit(1);
  }

  const admin = getAdminPool();

  // 0157 may not have been applied yet - these two files landed together. Say
  // so in one line rather than failing per-org with a relation-does-not-exist.
  const { rows: tables } = await admin.query(
    "SELECT to_regclass('public.contact_numbers') IS NOT NULL AS vault",
  );
  if (!tables[0].vault) {
    console.error(
      "contact_numbers does not exist - migration 0157 has not been applied here.\n" +
        "Run: pnpm db:migrate",
    );
    process.exit(1);
  }

  const { rows: orgs } = await admin.query(SELECT_ORGS, [only]);
  if (orgs.length === 0) {
    // An explicit org that is not eligible is a mistake worth an exit code. No
    // eligible orgs AT ALL is the expected state of a deployment where nobody
    // has turned 0011's switch on, and §3 is explicit that false is the
    // default - so that is a notice, not a failure.
    if (only) {
      console.error(`no organization ${only} with store_full_number = true`);
      process.exit(1);
    }
    console.log(
      "No org has store_full_number = true, so the vault is empty by design (doc 39 §3).\n" +
        "Nothing to normalise. 0 seeded, 0 unparseable, 0 ambiguous.",
    );
    return;
  }

  console.log(
    `normalise-vault-numbers ${apply ? "[APPLY]" : "[DRY RUN - nothing will be written]"}` +
      ` - ${orgs.length} org(s) on store_full_number\n`,
  );

  const total = { [SEED]: 0, [UNPARSEABLE]: 0, [AMBIGUOUS]: 0 };
  const totalReasons = { [UNPARSEABLE]: new Map(), [AMBIGUOUS]: new Map() };
  let orgsWithoutCountry = 0;

  for (const org of orgs) {
    // Not defaulted to DEFAULT_PHONE_COUNTRY: see the header. An unknown ISO-2
    // (the column's CHECK is only `^[A-Z]{2}$`, so 'XX' is storable) is the
    // same situation as no row at all.
    const country = isPhoneCountry(org.country) ? org.country : null;
    if (!country) orgsWithoutCountry += 1;

    const result = await withOrgContext(org.id, async (client) => {
      const { rows } = await client.query(SELECT_CANDIDATES, [org.id]);

      // Re-sorted most-recent-first: the SELECT's ORDER BY belongs to its
      // DISTINCT ON, so it comes back ordered by key, not by time.
      rows.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
      for (const row of rows) {
        row.resolved = resolveNumber({
          raw: row.remote_number_full,
          storedKey: row.remote_number_key,
          country,
        });
      }

      const folded = foldByKey(rows);
      const { rows: held } = await client.query(
        "SELECT count(*)::int AS n FROM contact_numbers WHERE org_id = $1::uuid",
        [org.id],
      );

      let written = 0;
      if (apply && folded.seeds.length > 0) {
        for (let i = 0; i < folded.seeds.length; i += INSERT_CHUNK) {
          const chunk = folded.seeds.slice(i, i + INSERT_CHUNK);
          const inserted = await client.query(INSERT_NUMBERS, [
            org.id,
            chunk.map((s) => s.numberKey),
            chunk.map((s) => s.e164),
            chunk.map((s) => s.country),
            chunk.map((s) =>
              JSON.stringify({
                kind: "inbound_call",
                call_id: s.row.call_id,
                call_started_at: new Date(s.row.started_at).toISOString(),
                seeded_by: "normalise-vault-numbers",
                resolved_with_country: country,
              }),
            ),
            chunk.map((s) => new Date(s.row.started_at).toISOString()),
          ]);
          written += inserted.rowCount;
        }
      }
      return { ...folded, held: held[0].n, written };
    });

    // In a dry run the seeded figure is what WOULD be written; under --apply it
    // is what the INSERT actually reported, which is lower if a live upload won
    // the race. Never the candidate count - that would report a success the
    // database did not agree to.
    const seeded = apply ? result.written : result.counts[SEED];
    total[SEED] += seeded;
    total[UNPARSEABLE] += result.counts[UNPARSEABLE];
    total[AMBIGUOUS] += result.counts[AMBIGUOUS];
    for (const bucket of [UNPARSEABLE, AMBIGUOUS]) {
      for (const [reason, n] of result.reasons[bucket]) {
        totalReasons[bucket].set(reason, (totalReasons[bucket].get(reason) ?? 0) + n);
      }
    }

    // The vault total is on every line on purpose: it is what makes "0 seeded"
    // readable as "nothing left to recover" instead of "nothing worked", which
    // is the second run's only honest reading.
    console.log(
      `${org.name} [${country ?? "no country set"}]: ` +
        `${fmt(seeded)} seeded, ${fmt(result.counts[UNPARSEABLE])} unparseable, ` +
        `${fmt(result.counts[AMBIGUOUS])} ambiguous ` +
        `(vault already held ${fmt(result.held)})`,
    );
  }

  const line = (label, n, note) => `  ${label.padEnd(18)}${fmt(n).padStart(9)}   ${note}`;
  console.log(`\n${"-".repeat(78)}`);
  console.log(`${apply ? "RESULT" : "DRY RUN"} - distinct numbers, not calls (doc 39 §3.1):\n`);
  console.log(
    line(
      "seeded",
      total[SEED],
      apply ? "written to contact_numbers" : "would be written to contact_numbers",
    ),
  );
  console.log(
    line("still-unparseable", total[UNPARSEABLE], "not a number in the org's country - left out"),
  );
  console.log(line("ambiguous", total[AMBIGUOUS], "more than one defensible reading - left out"));

  for (const bucket of [UNPARSEABLE, AMBIGUOUS]) {
    if (totalReasons[bucket].size === 0) continue;
    const breakdown = [...totalReasons[bucket]]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ${fmt(n)}`)
      .join(", ");
    console.log(`\n  ${bucket}: ${breakdown}`);
  }

  if (orgsWithoutCountry > 0) {
    console.log(
      `\n  ${orgsWithoutCountry} org(s) have no usable country in org_business_profile (0126).\n` +
        "  Their numbers are counted as ambiguous/no_org_country and NOT guessed at. Set the\n" +
        "  country at /owner/account/time and re-run - they are recoverable, not lost.",
    );
  }

  console.log(
    `\n  Everything outside "seeded" stays out of the vault, so dialability() returns\n` +
      "  no_number for it. That is the correct answer, not a bug to work around (§3.1.3).",
  );
  if (!apply) {
    console.log("\n  Nothing was written. Re-run with --apply to write the seeded numbers.");
  }
  console.log(`${"-".repeat(78)}`);
}

if (require.main === module) {
  main()
    .then(closeAllPools)
    .catch(async (err) => {
      console.error(err);
      await closeAllPools();
      process.exit(1);
    });
}

// Exported for a harness that wants to exercise the classification with
// fabricated input. There is no test runner wired to platform/scripts -
// vitest.config.ts includes `src/**/*.test.ts` only, deliberately, because
// everything else in this package talks to a Postgres that .env points at in
// production - so these are not covered by `pnpm --filter @aura/db test`.
module.exports = { resolveNumber, secondReading, foldByKey, SEED, UNPARSEABLE, AMBIGUOUS };
