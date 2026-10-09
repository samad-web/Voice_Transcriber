"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  Button,
  ErrorBanner,
  FormField,
  Input,
  Select,
  StatusChip,
  useToast,
} from "@aura/ui";
import {
  CONTRACT_DOC_TYPE_LABELS,
  CONTRACT_STATUS_LABELS,
  COMP_STRUCTURE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from "@aura/shared";
import { InlineListSkeleton } from "@/components/skeletons";
import { TEXTAREA_CLASS } from "../lead-drawer";
import {
  contractAccessLogAction,
  createContractAction,
  documentUrlAction,
  fetchContractAction,
  fetchContractDetailAction,
  startDocumentUploadAction,
  updateContractAction,
} from "./actions";
import type {
  ContractAccessEntry,
  ContractDocumentView,
  ContractView,
  ProfilePayload,
} from "./types";

/**
 * §6.3's Contract tab, as a WRITE surface
 * (Build docs/org-chart-build-plan.md §6.3, milestone M7).
 *
 * ── WHO SEES THIS AT ALL ───────────────────────────────────────────────────
 *
 * Only a reader holding `employment_contract:view` - the drawer decides
 * whether to render the tab, and the API refuses every route here anyway. A
 * telecaller does not get a greyed-out tab: they get no tab, because a greyed
 * one would tell them a contract exists and that somebody decided they may not
 * see it, which is information they were not given.
 *
 * ── THE TWO KINDS OF "YOU MAY NOT SEE THIS" ────────────────────────────────
 *
 * `redactContract` DELETES the compensation figure for a reader who may see
 * the terms but not the amounts, rather than nulling it. So:
 *
 *   · key absent  -> a locked row saying the figure is not shown to this role
 *   · key null    -> an empty field, because no fixed pay is recorded
 *
 * An editor that treated those alike would either offer somebody a field they
 * cannot save or imply a salary of nothing. `amountVisible` below is the one
 * line that keeps them apart.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * No delete, for a contract or for a document version. §6.5's timeline and any
 * dispute about what was signed both need the row to survive, so a contract is
 * ENDED (a status) and a superseded document stays downloadable forever.
 * `ENFORCED_PERMISSIONS` has no `employment_contract:delete` to match.
 */

export interface ContractEditorProps {
  profile: ProfilePayload;
  /** `employment_contract:edit` - resolved server-side by the page. */
  canEdit: boolean;
  /** §5.2: no writes while looking at a past or future chart. */
  readOnly: boolean;
}

export function ContractEditor({ profile, canEdit, readOnly }: ContractEditorProps) {
  const [contract, setContract] = useState<ContractView | null | "loading">("loading");
  const [documents, setDocuments] = useState<ContractDocumentView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const toast = useToast();

  const holder = profile.holder;

  /**
   * TWO reads, not one.
   *
   * `fetchContractAction` finds WHICH contract is the person's live one (the
   * list is ordered by status, and 0178 allows one active per person). Only
   * then can the detail route be asked for it by id - and that is the read the
   * API records in `document_access_log`, because opening somebody's file is a
   * different act from seeing their employment type on a directory row.
   *
   * A `useCallback` rather than a function in the body: it is both the effect's
   * work and what every write calls afterwards, and two copies of this
   * sequence would be two chances for the summary and the detail to disagree
   * about which contract is on screen.
   */
  const load = useCallback(async (): Promise<void> => {
    if (!holder) {
      setContract(null);
      setDocuments([]);
      return;
    }
    const summary = await fetchContractAction(holder.userId);
    const found = summary.data?.contract ?? null;
    if (!found) {
      setContract(null);
      setDocuments([]);
      return;
    }
    const detail = await fetchContractDetailAction(found.id);
    if (detail.error) {
      // The summary is enough to render the terms; only the documents are
      // lost, and failing the whole tab for them would hide what did load.
      setContract(found);
      setDocuments([]);
      return;
    }
    setContract(detail.data?.contract ?? found);
    setDocuments(detail.data?.documents ?? []);
  }, [holder]);

  useEffect(() => {
    setContract("loading");
    void load();
  }, [load]);

  if (!holder) {
    return (
      <p className="text-sm text-text-muted">
        Nobody holds this position, so there is no contract to show. A contract belongs to a
        person, not to a seat - assign somebody first.
      </p>
    );
  }

  if (contract === "loading") return <InlineListSkeleton rows={4} />;

  return (
    <div className="space-y-5">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {contract === null ? (
        <NoContract
          holder={holder}
          positionId={profile.position.id}
          canEdit={canEdit && !readOnly}
          onCreated={async () => {
            toast("Contract created as a draft.");
            await load();
          }}
          onFail={setError}
        />
      ) : editing ? (
        <ContractForm
          contract={contract}
          onCancel={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            toast("Contract saved.");
            await load();
          }}
          onFail={setError}
        />
      ) : (
        <ContractSummary
          contract={contract}
          canEdit={canEdit && !readOnly}
          onEdit={() => setEditing(true)}
        />
      )}

      {contract ? (
        <Documents
          contractId={contract.id}
          documents={documents}
          canEdit={canEdit && !readOnly}
          onChanged={load}
          onFail={setError}
          toast={toast}
        />
      ) : null}

      {contract ? <AccessLog contractId={contract.id} /> : null}
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Read
// ───────────────────────────────────────────────────────────────────────────

function ContractSummary({
  contract,
  canEdit,
  onEdit,
}: {
  contract: ContractView;
  canEdit: boolean;
  onEdit: () => void;
}) {
  const amountVisible = "compFixedNum" in contract;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <StatusChip tone={contract.status === "expiring" ? "danger" : "muted"}>
          {CONTRACT_STATUS_LABELS[contract.status]}
        </StatusChip>
        {canEdit ? (
          <Button variant="secondary" onClick={onEdit}>
            Edit
          </Button>
        ) : null}
      </div>

      <dl className="space-y-2 text-sm">
        <Row label="Employment type">
          {EMPLOYMENT_TYPE_LABELS[contract.employmentType as keyof typeof EMPLOYMENT_TYPE_LABELS] ??
            contract.employmentType}
        </Row>
        <Row label="Started">{contract.startDate}</Row>
        <Row label="Ends">{contract.endDate ?? "No end date"}</Row>
        {contract.probationEndDate ? (
          <Row label="Probation ends">{contract.probationEndDate}</Row>
        ) : null}
        {contract.renewalDate ? <Row label="Up for renewal">{contract.renewalDate}</Row> : null}
        <Row label="Notice period">
          {contract.noticePeriodDays === null ? "—" : `${contract.noticePeriodDays} days`}
        </Row>
        <Row label="Pay structure">
          {contract.compStructure
            ? (COMP_STRUCTURE_LABELS[
                contract.compStructure as keyof typeof COMP_STRUCTURE_LABELS
              ] ?? contract.compStructure)
            : "—"}
        </Row>
        <Row label="Fixed pay">
          {!amountVisible ? (
            // The locked row the permission split needs: there IS a figure and
            // this reader may not see it. A blank would say the opposite.
            <span className="text-text-muted">Not shown to your role</span>
          ) : contract.compFixedNum === null || contract.compFixedNum === undefined ? (
            "—"
          ) : (
            `${contract.compCurrency ?? ""} ${contract.compFixedNum.toLocaleString()}`
          )}
        </Row>
        {"notes" in contract && contract.notes ? (
          <Row label="Notes">{contract.notes}</Row>
        ) : null}
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border pb-2 last:border-0">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="max-w-[60%] text-right text-text">{children}</dd>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Write
// ───────────────────────────────────────────────────────────────────────────

function NoContract({
  holder,
  positionId,
  canEdit,
  onCreated,
  onFail,
}: {
  holder: NonNullable<ProfilePayload["holder"]>;
  positionId: string;
  canEdit: boolean;
  onCreated: () => Promise<void>;
  onFail: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  const [employmentType, setEmploymentType] = useState("full_time");
  const [startDate, setStartDate] = useState(holder.startDate);

  if (!canEdit) {
    return (
      <p className="text-sm text-text-muted">
        No contract is on file for {holder.name ?? holder.email}.
      </p>
    );
  }

  return (
    <section className="space-y-3">
      <p className="text-sm text-text-muted">
        No contract is on file for {holder.name ?? holder.email}. Recording one is what makes the
        expiry and probation reminders possible.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Employment type" name="newContractType">
          <Select
            value={employmentType}
            onChange={(event) => setEmploymentType(event.target.value)}
          >
            {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField
          label="Started"
          name="newContractStart"
          hint="Pre-filled from when they took the position."
        >
          <Input
            type="date"
            value={startDate}
            onChange={(event) => setStartDate(event.target.value)}
          />
        </FormField>
      </div>
      {/*
        Created as a DRAFT, not active, and the button says so. 0178 allows one
        ACTIVE contract per person, so creating this straight to active would
        collide with an existing one somewhere else in the business and the
        person would see a 409 they did not cause. A draft never collides, and
        the edit form promotes it in one press.
      */}
      <Button
        disabled={pending || !startDate}
        onClick={() =>
          start(async () => {
            const result = await createContractAction({
              userId: holder.userId,
              positionId,
              employmentType,
              startDate,
            });
            if (result.error) onFail(result.error);
            else await onCreated();
          })
        }
      >
        Create a draft contract
      </Button>
    </section>
  );
}

function ContractForm({
  contract,
  onCancel,
  onSaved,
  onFail,
}: {
  contract: ContractView;
  onCancel: () => void;
  onSaved: () => Promise<void>;
  onFail: (message: string) => void;
}) {
  const [pending, start] = useTransition();
  const amountVisible = "compFixedNum" in contract;

  const [form, setForm] = useState({
    employmentType: contract.employmentType,
    status: contract.storedStatus,
    startDate: contract.startDate,
    endDate: contract.endDate ?? "",
    renewalDate: contract.renewalDate ?? "",
    probationEndDate: contract.probationEndDate ?? "",
    noticePeriodDays: contract.noticePeriodDays === null ? "" : String(contract.noticePeriodDays),
    compStructure: contract.compStructure ?? "",
    compFixedNum:
      contract.compFixedNum === null || contract.compFixedNum === undefined
        ? ""
        : String(contract.compFixedNum),
    compCurrency: contract.compCurrency ?? "INR",
    notes: ("notes" in contract ? contract.notes : "") ?? "",
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = () =>
    start(async () => {
      /**
       * Only the fields that CHANGED are sent.
       *
       * `UpdateContractInput` is hand-built with every field optional, and the
       * API's `UPDATE` sets only what arrives - so sending the whole form
       * would rewrite columns nobody touched. That matters most for the one
       * this reader may not see: a `terms`-level editor must not be able to
       * blank somebody's salary by saving a form that never showed it.
       */
      const patch: Record<string, unknown> = {};
      const changed = <K extends keyof typeof form>(key: K, original: string) =>
        form[key] !== original;

      if (changed("employmentType", contract.employmentType)) {
        patch.employmentType = form.employmentType;
      }
      if (changed("status", contract.storedStatus)) patch.status = form.status;
      if (changed("startDate", contract.startDate)) patch.startDate = form.startDate;
      if (changed("endDate", contract.endDate ?? "")) patch.endDate = form.endDate || null;
      if (changed("renewalDate", contract.renewalDate ?? "")) {
        patch.renewalDate = form.renewalDate || null;
      }
      if (changed("probationEndDate", contract.probationEndDate ?? "")) {
        patch.probationEndDate = form.probationEndDate || null;
      }
      if (
        changed(
          "noticePeriodDays",
          contract.noticePeriodDays === null ? "" : String(contract.noticePeriodDays),
        )
      ) {
        patch.noticePeriodDays = form.noticePeriodDays === "" ? null : Number(form.noticePeriodDays);
      }
      if (changed("compStructure", contract.compStructure ?? "")) {
        patch.compStructure = form.compStructure || null;
      }
      if (amountVisible) {
        const original =
          contract.compFixedNum === null || contract.compFixedNum === undefined
            ? ""
            : String(contract.compFixedNum);
        if (changed("compFixedNum", original)) {
          patch.compFixedNum = form.compFixedNum === "" ? null : Number(form.compFixedNum);
          // An amount needs its currency, which the API and the database both
          // insist on - sending one without the other is a 400 or a 23514.
          if (form.compFixedNum !== "") patch.compCurrency = form.compCurrency;
        }
      }
      if (changed("notes", ("notes" in contract ? contract.notes : "") ?? "")) {
        patch.notes = form.notes || null;
      }

      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }

      const result = await updateContractAction(contract.id, patch);
      if (result.error) onFail(result.error);
      else await onSaved();
    });

  return (
    <section className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Employment type" name="contractType">
          <Select
            value={form.employmentType}
            onChange={(event) => set("employmentType", event.target.value)}
          >
            {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FormField>

        {/*
          Three statuses, not four. `expiring` is DERIVED from the end date and
          §14's first offset, so offering it would let somebody assert a state
          that recomputes itself on the next read - the API refuses it and the
          database CHECK refuses it too.
        */}
        <FormField
          label="Status"
          name="contractStatus"
          hint="&ldquo;Expiring&rdquo; is worked out from the end date - it is not something to set."
        >
          <Select
            value={form.status}
            onChange={(event) => set("status", event.target.value as typeof form.status)}
          >
            <option value="draft">{CONTRACT_STATUS_LABELS.draft}</option>
            <option value="active">{CONTRACT_STATUS_LABELS.active}</option>
            <option value="ended">{CONTRACT_STATUS_LABELS.ended}</option>
          </Select>
        </FormField>

        <FormField label="Started" name="contractStart">
          <Input
            type="date"
            value={form.startDate}
            onChange={(event) => set("startDate", event.target.value)}
          />
        </FormField>
        <FormField
          label="Ends"
          name="contractEnd"
          hint="Leave blank for an open-ended contract. Reminders go out 60, 30 and 7 days before."
        >
          <Input
            type="date"
            value={form.endDate}
            onChange={(event) => set("endDate", event.target.value)}
          />
        </FormField>
        <FormField
          label="Probation ends"
          name="contractProbation"
          hint="Reminders 14 and 3 days before, so a decision gets recorded."
        >
          <Input
            type="date"
            value={form.probationEndDate}
            onChange={(event) => set("probationEndDate", event.target.value)}
          />
        </FormField>
        <FormField label="Up for renewal" name="contractRenewal">
          <Input
            type="date"
            value={form.renewalDate}
            onChange={(event) => set("renewalDate", event.target.value)}
          />
        </FormField>
        <FormField label="Notice period (days)" name="contractNotice">
          <Input
            inputMode="numeric"
            value={form.noticePeriodDays}
            onChange={(event) => set("noticePeriodDays", event.target.value)}
          />
        </FormField>
        <FormField label="Pay structure" name="contractComp">
          <Select
            value={form.compStructure}
            onChange={(event) => set("compStructure", event.target.value)}
          >
            <option value="">Not recorded</option>
            {Object.entries(COMP_STRUCTURE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </FormField>

        {amountVisible ? (
          <>
            <FormField label="Fixed pay" name="contractAmount">
              <Input
                inputMode="decimal"
                value={form.compFixedNum}
                onChange={(event) => set("compFixedNum", event.target.value)}
              />
            </FormField>
            <FormField label="Currency" name="contractCurrency">
              <Input
                value={form.compCurrency}
                maxLength={3}
                onChange={(event) => set("compCurrency", event.target.value.toUpperCase())}
              />
            </FormField>
          </>
        ) : (
          <div className="sm:col-span-2 rounded-md border border-border bg-bg-subtle px-3 py-2">
            <p className="text-xs text-text-muted">
              The pay figure is not shown to your role, so it is left untouched by anything you
              save here.
            </p>
          </div>
        )}
      </div>

      <FormField label="Notes" name="contractNotes">
        <textarea
          className={TEXTAREA_CLASS}
          rows={2}
          maxLength={2000}
          value={form.notes}
          onChange={(event) => set("notes", event.target.value)}
        />
      </FormField>

      <div className="flex gap-2">
        <Button onClick={save} disabled={pending}>
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// §6.3's documents, with version history
// ───────────────────────────────────────────────────────────────────────────

/** Mirrors the API's allowlist, so a refusal happens before a round trip. */
const ACCEPTED = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const MAX_BYTES = 25 * 1024 * 1024;

function Documents({
  contractId,
  documents,
  canEdit,
  onChanged,
  onFail,
  toast,
}: {
  contractId: string;
  documents: ContractDocumentView[];
  canEdit: boolean;
  onChanged: () => Promise<void>;
  onFail: (message: string) => void;
  toast: (message: string) => void;
}) {
  const [docType, setDocType] = useState("contract");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const open = async (documentId: string) => {
    const result = await documentUrlAction(documentId);
    if (result.error || !result.data) {
      onFail(result.error ?? "That document could not be opened.");
      return;
    }
    // A new tab rather than a navigation: the signed URL is good for five
    // minutes and going back to a dead one would show an S3 error page where
    // the drawer used to be.
    window.open(result.data.url, "_blank", "noopener,noreferrer");
  };

  const upload = async (file: File) => {
    if (!ACCEPTED.includes(file.type)) {
      onFail("Upload a PDF, an image or a Word document. Other file types are not accepted.");
      return;
    }
    if (file.size > MAX_BYTES) {
      onFail("That file is over 25 MB.");
      return;
    }
    setBusy(true);
    try {
      const started = await startDocumentUploadAction(contractId, {
        docType,
        fileName: file.name,
        contentType: file.type,
        bytes: file.size,
      });
      if (started.error || !started.data) {
        onFail(started.error ?? "The upload could not be started.");
        return;
      }

      const put = await fetch(started.data.uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "content-type": file.type },
      });
      if (!put.ok) {
        /**
         * The row already exists at this point - see
         * `startDocumentUploadAction`. Said plainly rather than hidden,
         * because the version number IS now taken and a retry produces the
         * next one, which somebody looking at the list deserves to know.
         */
        onFail(
          "The file did not finish uploading, so that version is empty. Try again - it will be added as a new version.",
        );
        await onChanged();
        return;
      }
      toast(`${file.name} uploaded.`);
      await onChanged();
    } catch {
      onFail("The file could not be uploaded. Check the connection and try again.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /** Newest version of each type first, which is what somebody wants to open. */
  const byType = new Map<string, ContractDocumentView[]>();
  for (const document of documents) {
    byType.set(document.docType, [...(byType.get(document.docType) ?? []), document]);
  }

  return (
    <section className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium text-text">Documents</h3>

      {documents.length === 0 ? (
        <p className="text-sm text-text-muted">Nothing uploaded yet.</p>
      ) : (
        <ul className="space-y-3">
          {[...byType.entries()].map(([type, versions]) => (
            <li key={type}>
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
                {CONTRACT_DOC_TYPE_LABELS[type as keyof typeof CONTRACT_DOC_TYPE_LABELS] ?? type}
              </p>
              <ul className="mt-1 space-y-1">
                {versions.map((version, index) => (
                  <li key={version.id} className="flex items-center justify-between gap-2 text-sm">
                    <button
                      type="button"
                      onClick={() => void open(version.id)}
                      className="truncate text-left text-accent-text underline-offset-2 hover:underline"
                    >
                      {version.fileName}
                    </button>
                    <span className="shrink-0 text-xs text-text-muted">
                      v{version.version}
                      {index === 0 ? " · current" : ""}
                      {" · "}
                      {Math.max(1, Math.round(version.bytes / 1024))} KB
                      {version.signedAt ? ` · signed ${version.signedAt}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="space-y-2 rounded-md border border-border bg-bg-subtle p-3">
          <FormField label="What is this" name="docType">
            <Select value={docType} onChange={(event) => setDocType(event.target.value)}>
              {Object.entries(CONTRACT_DOC_TYPE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </FormField>
          <input
            ref={fileRef}
            type="file"
            disabled={busy}
            accept={ACCEPTED.join(",")}
            aria-label="Choose a file to upload"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
            className="block w-full text-sm text-text file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text hover:file:bg-surface-hover"
          />
          <p className="text-xs text-text-muted">
            {busy
              ? "Uploading…"
              : "Uploading the same kind again adds a version. Nothing is ever replaced - the old one stays downloadable."}
          </p>
        </div>
      ) : null}
    </section>
  );
}

/**
 * §7's MUST: "Log every view and download of a contract document." This is the
 * log, shown to the people who may read the contracts.
 *
 * Collapsed by default. It is the kind of thing somebody opens once, when they
 * have a reason to ask - and leaving it expanded would put a list of
 * colleagues' names at the bottom of a screen whose actual job is above it.
 */
function AccessLog({ contractId }: { contractId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<ContractAccessEntry[] | "loading" | null>(null);

  useEffect(() => {
    if (!open || entries !== null) return;
    setEntries("loading");
    void contractAccessLogAction(contractId).then((result) => {
      setEntries(result.data?.entries ?? []);
    });
  }, [open, entries, contractId]);

  return (
    <section className="border-t border-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {open ? "Hide" : "Show"} who has opened this
      </button>
      {open ? (
        entries === "loading" || entries === null ? (
          <InlineListSkeleton rows={3} />
        ) : entries.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">Nobody has opened it yet.</p>
        ) : (
          <ul className="mt-2 space-y-1">
            {entries.map((entry, index) => (
              <li key={index} className="text-xs text-text-muted">
                {entry.actor_name ?? entry.actor_id} · {labelForAccess(entry.action)} ·{" "}
                {entry.at.slice(0, 16).replace("T", " ")}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

/**
 * `url` is deliberately worded as being HANDED the document rather than as
 * having read it.
 *
 * With a signed URL the two are indistinguishable after the fact - the API
 * mints one and the browser decides whether to render the PDF or save it - so
 * "downloaded" would claim more than the log knows.
 */
function labelForAccess(action: string): string {
  switch (action) {
    case "list":
      return "opened the file";
    case "url":
      return "was given the document";
    case "upload":
      return "uploaded a version";
    default:
      return action;
  }
}
