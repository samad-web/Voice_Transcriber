/**
 * WHO IN THIS API CAN SEE A PHONE NUMBER?
 *
 * ── WHY A GREP IS THE RIGHT TOOL HERE, UNUSUALLY ────────────────────────────
 *
 * Everywhere else in this suite a grep over source is the WRONG instrument -
 * `guard-mounting.spec.ts` and `permissions-inventory.spec.ts` both open with
 * the reason: a decorator inside a comment satisfies a grep, and a grep cannot
 * see class-vs-handler inheritance. Those suites are asking "is this rule
 * enforced", and only metadata answers that.
 *
 * This one is asking a different question: "has a THIRD file started handling
 * callable phone numbers". There is no decorator and no metadata for that -
 * the risk is an ordinary `SELECT e164` added to a list endpoint by somebody
 * who needed one number and shipped a thousand. For that question the text IS
 * the evidence, and §2.1 asks for exactly this: a spec that greps the API
 * source for `e164` and pins the file list, so a third reader has to be a
 * deliberate, reviewed change to this assertion rather than a line in a
 * statement nobody re-read.
 *
 * The technique - pin a set, make both directions fail - is
 * `permissions-inventory.spec.ts`'s. A file that gains `e164` and is not
 * listed fails; a listed file that no longer mentions it fails too, so the
 * list cannot rot into a blanket permission.
 *
 * ── WHAT IS ACTUALLY BEING PROTECTED ───────────────────────────────────────
 *
 * `contact_numbers.e164` (migration 0157) - the vault, the only place a
 * dialable customer number lives, and the thing 0006 removed from this schema
 * on purpose. The second assertion below pins that column's readers
 * separately and much more tightly than the word `e164`, because the word also
 * occurs in two places that have nothing to do with the vault and predate it
 * by years:
 *
 *  - `marketing.funnel_submissions.phone_e164` (0020) - Aura's OWN funnel,
 *    single-tenant, the enquiries on sirahdigital's own landing page. Not
 *    tenant data and not in the vault's table.
 *  - `@aura/shared/dist/phone`'s `E164Phone` type and the helpers that produce
 *    it, used by every console phone field. Producing an E.164 from something
 *    a person just typed is not disclosing one that was stored.
 *
 * Conflating those with the vault would make this assertion so noisy that the
 * next person deletes it, so both are listed with the reason they are
 * admissible rather than filtered out silently.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(__dirname, "..", "..");

/** `/e164/i` - the column, the type and the helpers, however they are spelled. */
const E164 = /e164/i;

/** `contact_numbers`, the vault table itself. */
const VAULT_TABLE = /contact_numbers/;

/**
 * EVERY file in apps/api/src that may mention `e164`, and why.
 *
 * Adding a line here is the reviewed change §2.1 asks for. Before you add
 * one, the question to answer is not "does this compile" - it is "does this
 * file serve a stored customer number to anybody, and if so, is the
 * disclosure audited".
 */
const E164_FILES: Record<string, string> = {
  // ── The vault (migration 0157) ────────────────────────────────────────────
  //
  // The ONE console route that discloses a stored number. Writes an audit_log
  // row inside the same transaction as the read, serves one key at a time, and
  // is gated on `contact_number:view` - which 0158 withholds from `viewer`.
  "modules/suppression/numbers.controller.ts": "GET /numbers/:numberKey/reveal - the one console reader",
  // The one writer. Takes `e164` as input and never returns it: the promoting
  // upsert's result is `{ stored }` and a reason, by design.
  "modules/suppression/vault.service.ts": "the promoting upsert - writes the column, never reads it back",
  // Transient only. A sheet's cell is normalised to E.164 so it can be KEYED
  // (sha256 of the last ten digits); the E.164 is discarded in the same
  // expression and `dnc_entries` stores the digest. A suppression list that
  // stored numbers would defeat the vault.
  "modules/suppression/dnc-import.service.ts": "normalises a sheet cell only in order to key it",

  // ── The form builder (migration 0161, doc 39 §16) ─────────────────────────
  //
  // A WRITER, not a reader, and the distinction is the whole reason this entry
  // needs a sentence rather than a line. A hosted form receives a phone number
  // from the person it belongs to, normalises it through `importPhone`, and
  // hands it to `upsertContactNumber` with `consent_basis = 'consent_given'`
  // and the consent text as rendered. It is the single largest SOURCE of
  // dialable numbers in the product.
  //
  // What a future reviewer must re-check: the number goes IN and never comes
  // back out. The submit route answers a thank-you page or a validation
  // message, never the stored value, and the form definition it echoes is the
  // tenant's own. If this file ever selects `e164`, that is a new disclosure
  // and it belongs in §2.1's count - which is routes, not files, and is still
  // exactly two.
  "modules/web-forms/web-form-submission.service.ts":
    "normalises a submitted number and vaults it - writes, never serves",
  "modules/web-forms/web-form-submission.service.spec.ts": "fixtures for that write",

  // ── This module's own suites ──────────────────────────────────────────────
  "modules/suppression/vault.service.spec.ts": "fixtures for the upsert",
  "modules/suppression/suppression.controller.spec.ts": "asserts the reveal route's behaviour",
  "modules/suppression/e164-disclosure.spec.ts": "this file, which has to name what it pins",

  // ── The dialer (migration 0159, doc 39 §8) ────────────────────────────────
  //
  // THE SECOND ROUTE §2.1 PERMITS, and the reason this list has two entries
  // rather than one. `GET /devices/me/dialer/next` claims one queue item under
  // a 120-second lease and serves the number the handset is about to ring.
  //
  // What makes it admissible, and what a future reviewer has to re-check if
  // any of it changes: ONE record per request with no batch form; served to a
  // DEVICE holding a 15-minute signed token for a handset an admin can
  // deactivate, never to a browser; and only after `dialability()` has run
  // against a snapshot read in the SAME statement as the claim - so a paused
  // campaign, a closed calling window or a DNC entry added five minutes ago
  // all stop the number leaving. §9's prefetch of twenty numbers is NOT
  // implemented and must not be added here without its own decision.
  "modules/dialer/device-dialer.controller.ts":
    "GET /devices/me/dialer/next - the handset's claim, one number per lease (doc 39 §2.1's second route)",
  "modules/dialer/device-dialer.controller.spec.ts":
    "pins the claim statement, its lease and the §5 re-check before the number is served",

  // ── NOT a reader: the partner portal's vault WRITE (0162/0163, doc 39 §18) ─
  //
  // A channel partner types a prospect's number into the portal form and the
  // submission path normalises it so the vault can be keyed and written. It is
  // the same shape as `import.controller.ts` below - input a person just
  // supplied, normalised in order to be stored - and it reads NOTHING back:
  // `upsertContactNumber` answers `{ stored }` and a reason, and
  // `partner_submissions` keeps the partner's own `lead_phone` rather than
  // re-reading the column.
  //
  // What a future reviewer must re-check if this line survives a change to
  // that file: nothing in the portal may SELECT `e164`. Migration 0163's
  // `partner_wall` is what makes that structural - `contact_numbers` is one of
  // the walled tables, so a partner-context transaction cannot read it at all -
  // and the five portal screens deliberately show the partner only the number
  // they themselves submitted.
  "modules/partners/partners.service.ts":
    "normalises a partner's submitted number in order to key and store it - writes, never reads",

  // ── NOT the vault: Aura's own marketing funnel (migration 0020) ───────────
  //
  // `marketing.funnel_submissions.phone_e164`. Single-tenant - these are
  // enquiries on Aura's own landing page, not any customer's customers - and
  // reached only by the cross-tenant operator routes in CROSS_TENANT. A
  // different schema, a different table, a different audience.
  "modules/leads/leads.controller.ts": "marketing.funnel_submissions.phone_e164 - Aura's own funnel, not the vault",
  "modules/leads/slots.controller.ts": "the same funnel column, for a booked slot's enquirer",

  // ── NOT a reader: the finance matcher's identity rule (0172-0176, §8) ─────
  //
  // §8's rule 2 matches a payment to a customer by "phone or email plus exact
  // amount". The gateway hands us the PAYER's phone; the matcher compares it
  // against the numbers we hold, inside an `EXISTS (SELECT 1 FROM
  // contact_numbers cn WHERE cn.contact_id = d.contact_id AND cn.e164 = $n)`.
  //
  // It is the `dialer.service.ts` shape, not the reveal route's: the column is
  // on the right-hand side of a comparison and never in a select list, so
  // nothing about it reaches a response. The number flowing INTO the
  // comparison came from the gateway with the payment, not from the vault.
  //
  // It is also the reason it has to be `contact_numbers` rather than
  // `contacts.phone`: a customer paying from their second number would never
  // match, and the vault is the only place every number a contact has lives.
  //
  // What a future reviewer must re-check if this line survives a change to
  // that file: `MATCH_CONFIDENCE.identity_amount` must stay a comparison. The
  // moment the matcher SELECTS `e164` - to show a person which number paid, say
  // - that is a third disclosure and §2.1's count of two has to be reopened.
  // The unmatched queue deliberately shows the deal and the customer NAME.
  "modules/finance/matcher.ts":
    "§8 rule 2 compares a gateway-supplied payer number against the vault inside an EXISTS - never selects it",

  // ── NOT a stored number: the shared phone helpers ─────────────────────────
  //
  // `E164Phone` is a branded string type and these two PRODUCE one from input
  // a person or a CSV just supplied. Normalising what somebody typed is not
  // disclosing what was stored, and both predate the vault.
  "common/console-phone.ts": "the E164Phone type - normalises console input, reads nothing",
  "modules/import/import.controller.ts": "normalises a CSV phone cell for contacts (hashed, never stored whole)",
  "modules/import/import.controller.spec.ts": "the importer's own suite",
};

/**
 * The vault table's readers and writers. Much tighter than the list above -
 * nothing outside this module may name `contact_numbers` at all, because
 * reaching it from anywhere else is how the number ends up in an export, a
 * report dataset or the MCP server. 0157's header rejects
 * `contacts.phone_full` for precisely that reason.
 */
const VAULT_FILES: Record<string, string> = {
  "modules/suppression/numbers.controller.ts": "reads one row by key, and audits the disclosure",
  "modules/suppression/vault.service.ts": "the promoting upsert - the only writer",
  "modules/suppression/vault.service.spec.ts": "pins the upsert statement and its ordering",
  "modules/suppression/e164-disclosure.spec.ts": "this file, which has to name what it pins",

  // ── The dialer (migration 0159) ───────────────────────────────────────────
  //
  // Note that this list is LONGER than the one above by one file, and the
  // extra entry is the point of keeping two lists. `dialer.service.ts` joins
  // the vault to read `consent_basis` - WHY we may ring somebody - over
  // thousands of records at a time for the campaign preview, and never selects
  // the number column. That is a legitimate vault read and emphatically not a
  // disclosure; collapsing the two lists would either forbid it or license a
  // preview to hold six thousand phone numbers.
  "modules/dialer/dialer.service.ts":
    "the candidate query joins the vault for consent_basis only - counts, never numbers",
  "modules/dialer/device-dialer.controller.ts":
    "the claim statement reads one row's number for the handset about to dial it",
  "modules/dialer/device-dialer.controller.spec.ts":
    "pins that statement, including that it reads the vault inside the claim rather than after it",

  // ── The finance matcher (0172-0176, §8) ───────────────────────────────────
  //
  // In this list for the same reason `dialer.service.ts` is, and it is worth
  // the two lists staying apart to say so: it JOINS the vault to answer "is
  // this payer one of ours" and selects nothing from it. A legitimate vault
  // read, emphatically not a disclosure - collapsing the lists would either
  // forbid it or license the matcher to serve numbers.
  "modules/finance/matcher.ts":
    "joins the vault inside an EXISTS to identify a payer - compares one number, selects none",
};

/** Every `.ts` file under apps/api/src, as a posix path relative to src. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(relative(SRC, full).split(sep).join("/"));
    }
  };
  walk(SRC);
  return out.sort();
}

function matching(pattern: RegExp): string[] {
  return sourceFiles().filter((file) => pattern.test(readFileSync(join(SRC, file), "utf8")));
}

describe("who may serve a phone number (doc 39 §2.1)", () => {
  it("walks a source tree it actually found", () => {
    // The failure this guards: a path mistake makes every assertion below
    // vacuously true, and a spec that pins an empty set pins nothing.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("modules/suppression/numbers.controller.ts");
  });

  it("pins every file that mentions `e164`, in both directions", () => {
    // Both directions. A new file with `e164` and no entry here is the
    // regression; an entry whose file no longer mentions it is a stale
    // permission, which is how a pinned set becomes a blanket one.
    expect(matching(E164)).toEqual(Object.keys(E164_FILES).sort());
  });

  it("keeps the vault table inside its own module", () => {
    expect(matching(VAULT_TABLE)).toEqual(Object.keys(VAULT_FILES).sort());
  });

  it("has exactly TWO controllers that read a stored number", () => {
    // §2.1 counts ROUTES, not files, and it permits exactly two: the console's
    // audited single-key reveal, and the handset's queue claim.
    //
    // This said ONE until the dialer landed (P1, migration 0159), and the
    // assertion existing is what made somebody say the second one out loud
    // rather than let it arrive as a line in a SELECT. TWO is the ceiling the
    // plan sets. A third entry here is not a test to update - it is a design
    // decision that needs §2.1 reopened, because every fence around this
    // column (its own table, its own grants, an audit row per reveal, one
    // record per request) was built on the number of readers being countable.
    const controllers = matching(E164).filter(
      (file) => file.endsWith(".controller.ts") && VAULT_TABLE.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(controllers).toEqual([
      "modules/dialer/device-dialer.controller.ts",
      "modules/suppression/numbers.controller.ts",
    ]);
  });

  it("gives every pinned file a reason, not just a name", () => {
    // A path with an empty string beside it is a file somebody added to make
    // the test pass. The reason is the review.
    for (const [file, why] of Object.entries({ ...E164_FILES, ...VAULT_FILES })) {
      expect([file, why.length > 20]).toEqual([file, true]);
    }
  });
});
