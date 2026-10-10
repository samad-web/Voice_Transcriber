# The import centre

One centre for every bulk import, per
`Build docs/indian-business-finance-documents-cycles-import.md` §4: "Org chart
spec: employee and contract imports plug into the same import center. KPI
section: call logs and lead lists come in through the same import flow."

Two controllers on the `import` prefix, declared in that order in
`import.module.ts` so the batch controller's `jobs/:jobId/...` is not shadowed
by the other's bare `:jobId`.

## `ImportController` (0062) — the one-shot flow

Parses, writes and reports in one request. Still what contacts, accounts and
deals use.

| Route | Notes |
| --- | --- |
| `POST /import/preview` | Guessed column mapping for a set of headers |
| `POST /import/run` | Up to 5,000 rows. Own larger body limit — see `import-body-limit.ts` |
| `GET /import/:jobId` | Counts |
| `GET /import/:jobId/errors` | Failed rows. Narrower read gate — see `assertCanViewImportErrors` |
| `GET /import/:jobId/errors.csv` | The same, as a file |

## `ImportBatchController` (0182) — the staged flow

What §3 requires for money: "Finance data wrongly imported is hard to unwind, so
auto-detection should do the work and a person should approve it once."

| Route | Notes |
| --- | --- |
| `POST /import/stage` | Validates into `import_staging_rows`, returns the dry run. **Writes nothing real** |
| `GET /import/jobs/:jobId/staged` | The staged rows, for the preview table. `?status=error` |
| `POST /import/jobs/:jobId/commit` | Applies the valid rows, records what each became |
| `POST /import/jobs/:jobId/rollback` | Undoes the batch. Reason required |
| `DELETE /import/jobs/:jobId` | Discards a staged job that was never applied |
| `GET /import/jobs` | History: files, status, counts, mapping used |
| `GET /import/jobs/:jobId/failed.csv` | Errors and duplicates, with **source-file** row numbers |
| `GET /import/templates` | Saved mappings. `?entity=` |
| `POST /import/templates` | Upsert on `(org, entity, lower(name))` |
| `POST /import/templates/:id/used` | Bumps the usage counter |
| `DELETE /import/templates/:id` | |

## What to know before changing any of it

**The file never reaches this server.** The browser parses — papaparse for CSV,
`packages/shared/src/xlsx-read.ts` for .xlsx — and posts cell values as JSON.
That is 0062's architecture and it answers several of §3's security bullets by
construction: no uploaded file to virus scan, no server-side workbook parser to
exploit, no formula engine in the path. **Nothing from the client is trusted
though** — every amount and date is re-parsed here with the same shared
functions, required fields are re-checked, and the row count is capped.

**`ImportEntity` is pinned against `import_jobs.entity`'s CHECK.** Six values.
0182 restates the CHECK literally rather than widening it dynamically, because
0179 records what happened when `notifications.kind` was widened dynamically and
a parallel session's migration dropped two kinds silently.

**Finance entities need `finance:create`.** Checked inside the handler, not by a
decorator: this controller serves both lead data and money, and a marketing
persona who may load a bought lead list must not be able to post into the ledger.

**Row importers are shared, not duplicated.** `finance-row-importers.ts` calls
`recordFinancePayment` from the finance module — the same function
`POST /finance/payments` calls — so an imported payment gets §8's matching,
§6.2's offline handling, the schedule application and the ledger posting because
it is literally the same code.

**Imported expenses arrive unapproved.** `approved_at` NULL, deliberately: §11's
cost figures count only approved expenses, so an import that approved its own
rows would let anybody with import rights move the owner's margin.

**A rollback can be partial, and that is correct.** An approved expense is left
alone, a reconciled statement line is left alone, a payment is reversed rather
than deleted (§6.3), and a locked period refuses the whole thing. The response
carries `{ undone, kept, problems }` and the console shows all three.

**`detectDateOrder` returning `ambiguous` is an answer, not a failure.** A
column where no day exceeds the 12th cannot be read either way, and
`parseDateCell` returns null rather than guessing. See DECISIONS.md §5.12.
