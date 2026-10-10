# The export engine

The asynchronous export surface specified in `Build docs/35_DATA_EXPORT_ENGINE.md`, migrations
**0148** (the job tables) and **0188** (the person scope). All paths are under `/v1`; `main.ts` adds
that prefix at bootstrap.

This controller decides who may export what, writes the job, alerts the owners and hands out a
download. It never reads an exported row — `apps/worker/src/pipeline/export.ts` does that, and
keeping the two apart is what stops a large tenant timing out a request.

Every route carries `AdminKeyGuard → TenantGuard → OwnerScopeGuard`. The grid grant is read per
dataset inside `allowedDatasets` rather than by a `@RequireCrmPermission`, because that decorator
takes one static object type and this route's object list comes from the request — a bulk export
spans nine of them. The grant is still read from the database for the asserted identity, never from
a header.

| Route | Notes |
| --- | --- |
| `GET /exports/datasets` | What this caller may export, and why each omission was omitted |
| `GET /exports/people` | Whose work this caller may export, the datasets a person export can produce, and the ones it cannot (0188) |
| `POST /exports` | 202 with a job id. A field that does not belong to the scope is **rejected, not ignored** |
| `GET /exports` | History. Own jobs; an owner sees everyone's |
| `GET /exports/:id` | One job and its files. `canDownload` is ownership, not visibility |
| `GET /exports/:id/download` | 302 to a freshly signed 5-minute URL. Requester only, and never an operator |
| `DELETE /exports/:id` | Cancels a queued or running job; a `ready` one has its object deleted and is marked `expired` |

Five gates run per dataset, in order: module (`organizations.enabled_modules`), feature (0093), grid
(`role_permissions`, action `export`), row scope (persona INTERSECT grid) and sensitivity
(`recordings:export`). A `view` or `person` export that fails any of them is a 403; a `section` or
`bulk` export drops the dataset and says so in the response.

**What the worker will actually render today** is a single-dataset `view` or `person` job. `section`
and `bulk` enqueue successfully and then fail permanently at render — multi-dataset archives are doc
35's E3 and are not built.

---

## Exporting one person's work (0188)

`scope: "person"` with `subjectTelecallerId` exports one named person's work, **subject to the
requester's own permissions**. The subject narrows the rows; it never widens them. A dataset the
requester may not export at all is refused before the subject is even considered.

It is shaped like a `view` export rather than like `bulk`: one dataset, and **filters are kept**.
That is deliberate — the reason somebody wants one person's file is almost always a review period,
so "their calls last month" is the request, not "their calls ever". Multi-dataset archives remain
doc 35's unbuilt E3.

**Today that means `leads` and `calls`.** Seven datasets are per-person in the registry (those two
plus `deals`, `tasks`, `attendance`, `call_transcripts` and `lead_stage_transitions`), but only the
ones in `RENDERABLE_EXPORT_DATASETS` have a query builder in the worker. The picker offers the
intersection, so it never hands somebody a job that would fail at render — and when a query builder
lands, that dataset becomes person-exportable with no further change here.

### Who can export whom

| Caller | May name as the subject |
| --- | --- |
| Owner persona — including a membership whose `owner_role` is NULL, which **is** the owner persona | anyone in the workspace with an active telecaller identity |
| Manager | everyone in their branch of the organization chart (`reporting_lines`, 0177), walked recursively, their own records included |
| Manager who holds **no seat** in the chart | themselves only |
| Telecaller, sales, marketing | themselves only — the drawer labels the option "My own work" |
| Operator or a bare admin key | anyone, but an operator can never download the artifact; the download route refuses an operator outright |

Two things that look like faults and are not:

- **Only active `telecallers` rows appear in the picker.** Somebody who holds a seat in the chart but
  was never linked to a handset has no phone-side records to export, so they are absent — correctly.
- **A manager with no seat sees only themselves.** The chart is optional and plenty of tenants never
  fill it in; reading "no seats" as "no restriction" would hand every unmapped manager the whole
  floor. If a manager says a name is missing from the picker, check the org chart before checking
  permissions.

The download is restricted to the person who **requested** the job, not to the subject and not to the
owners. A right-of-access request answered with a file therefore has to be run by whoever will hand
it over.

### The three refusals, and what each means

**1. `<Dataset> is not held by any one person, so it cannot be exported per person.` (400)**

A property of the dataset, not of the caller. Contacts, products, invoices and the audit log have no
column saying whose row it is, so a person export of one would add no predicate at all and produce
the whole tenant in a file bearing one person's name. Nobody gets this file at any permission level,
and raising a grant will not change it — the answer is to export the view instead.
`GET /exports/people` lists these datasets in `notPerPerson` with this exact sentence, and the drawer
hides the option for them, so a human in the console should never see it.

**2. `that person is not in your branch of the organization chart` (403)**

The caller may not see the subject. For a non-manager the wording is `you may export only your own
work`. Either way the fix is in the organization chart or the persona, not in the export engine.
Two near neighbours with different answers:

- `that person is not an active member of this workspace` (**404**) — the id is not an active
  telecaller: a stale picker, or an identity since deactivated or deleted. The 404 comes before the
  403 deliberately, so a stale row is distinguishable from a permission problem.
- `you are not linked to a telecaller identity, so there is no work to export - ask an owner to link
  you on the Team page` (**403**) — a provisioning gap rather than a permission decision. The person
  has never been linked to a handset, and answering "not permitted" would send them to the wrong
  person.

**3. `the person who requested this export may no longer see that person's work` (job `failed`)**

The enqueue passed and the **render** refused. Between the two, a reporting line changed, the
subject's seat ended, the requester was demoted, or the identity was deleted. The subject is
re-authorized before the first row is read (doc 35 §4.2), and this refusal is permanent — it is never
retried, because the second attempt reaches the same answer. It is the engine declining to hand over
a file somebody has since been denied, not a bug. Correct the chart and re-run; the Re-run button
re-authorizes at enqueue, so a request that is still wrong fails immediately at the API rather than
minutes later in the worker.

### The per-subject rate limit

**Two person exports per subject per hour** (`EXPORT_LIMITS.personJobsPerHourPerSubject`), counting
every requester's jobs in every status except `cancelled`. Over the limit:
`this person's data has already been exported in the last hour` (400).

It is keyed on the **subject**, not the requester, because the thing worth limiting is how often one
employee's file is produced. The visible consequence is that a manager can be refused because a
different manager of the same person just ran one — that is the answer to the support question, not a
fault. It is a platform constant like retention, not an org setting.

What is holding the hour:

```sql
SELECT created_at, requested_by_user_id, datasets, status
  FROM export_jobs
 WHERE scope = 'person' AND subject_telecaller_id = $1
   AND created_at > now() - interval '1 hour'
 ORDER BY created_at DESC;
```

### What is on the record afterwards

- **Every person export rings the owners immediately**, minus the requester. One wording gap to know
  about: the notification body still reads "The whole workspace" for a `person` job. The export was
  not wider than one person — the job row, the audit row and the exports centre line are all correct.
- **The exports centre line reads `Priya — Calls`**, from `subject_label`, which is frozen at
  enqueue. A rename six weeks later does not rewrite it, and the line still reads correctly after the
  identity is deleted.
- **"Everything anybody exported about this person"** is one index scan (`export_jobs_subject`):

  ```sql
  SELECT created_at, requested_by_user_id, datasets, subject_label, status
    FROM export_jobs
   WHERE org_id = $1 AND subject_telecaller_id = $2
   ORDER BY created_at DESC;
  ```

  Deleting the telecaller identity cascades those job rows away, so the durable answer to "who
  exported my data" is `audit_log`: `action = 'export.created'`, `target_type = 'export_job'`, with
  `subjectTelecallerId` and `subjectLabel` in `meta`.
- **The file itself lives seven days** (`EXPORT_RETENTION_DAYS`). The purge deletes the object and
  marks the job `expired`; the row and the audit trail stay.
