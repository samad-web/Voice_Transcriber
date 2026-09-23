"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import type { IntakeField } from "@aura/shared";
import { parseSpreadsheetId } from "@aura/shared";
import { Button, Card, Input, Label, MonoLabel, Select, StatusChip, useAlert } from "@aura/ui";
import {
  createLeadSourceAction,
  listSheetAccountsAction,
  previewSheetAction,
  updateLeadSourceAction,
  type SheetPreview,
} from "./actions";
import type { LeadSourceRow } from "./page";

/**
 * The fields a column can mean.
 *
 * A deliberately short list, and not every `IntakeField`. `recordingUrl`,
 * `direction` and the UTM fields exist for telephony and ad payloads, and
 * offering nineteen options for a spreadsheet with four columns turns a
 * thirty-second job into a reading exercise. What is missing is reachable by
 * leaving the column unmapped - it still lands on the lead's facts.
 */
const FIELDS: { value: IntakeField | ""; label: string }[] = [
  { value: "", label: "Ignore this column" },
  { value: "name", label: "Name" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "company", label: "Company" },
  { value: "notes", label: "What they want" },
  { value: "value", label: "Budget / value" },
  { value: "occurredAt", label: "Date added" },
  { value: "externalId", label: "Their own reference" },
];

/** Headings a person would have used for each field, lowercased. */
const GUESSES: Partial<Record<IntakeField, string[]>> = {
  name: ["name", "full name", "customer name", "contact name", "client", "customer"],
  phone: ["phone", "mobile", "mobile no", "contact", "contact no", "number", "whatsapp"],
  email: ["email", "email id", "mail", "e-mail"],
  company: ["company", "firm", "organisation", "organization", "business"],
  notes: ["notes", "remarks", "requirement", "enquiry", "message", "comments"],
  value: ["value", "budget", "amount", "deal value"],
  occurredAt: ["date", "created", "added on", "enquiry date", "timestamp"],
};

/**
 * Pre-fill the mapping from the headers themselves.
 *
 * Not cleverness for its own sake: the alternative is nine dropdowns all
 * reading "Ignore this column", which is a form somebody abandons. The guesses
 * are conservative and every one of them is visible and changeable before
 * anything is saved - a wrong guess costs a click, and a missing guess costs
 * the same click it would have cost anyway.
 */
function guessMapping(headers: string[]): Record<string, IntakeField> {
  const mapping: Record<string, IntakeField> = {};
  const taken = new Set<IntakeField>();
  for (const header of headers) {
    const key = header.trim().toLowerCase();
    if (!key) continue;
    for (const [field, candidates] of Object.entries(GUESSES) as [IntakeField, string[]][]) {
      // One column per field: two columns both guessed as `phone` would make
      // the second silently redundant, and the person would not know which was
      // being read.
      if (taken.has(field)) continue;
      if (candidates.includes(key)) {
        mapping[header] = field;
        taken.add(field);
        break;
      }
    }
  }
  return mapping;
}

/**
 * Connect a Google Sheet as a lead source (migration 0096).
 *
 * ── WHY THIS IS ITS OWN PANEL ───────────────────────────────────────────────
 *
 * Every other channel on this page is created by naming it: the endpoint URL
 * is the whole configuration, and the field map ships with the provider. A
 * sheet has neither. Its shape is whatever the customer typed at the top of
 * their own columns, so setting one up means looking inside it first - which
 * is a different interaction from "pick a channel and press Create", and
 * folding it into that dialog would have made the dialog answer to two
 * different jobs.
 */
export function SheetsPanel({
  sources,
  onConnected,
}: {
  sources: LeadSourceRow[];
  /** Called with the new source's id - the Integrations store's connect step moves on with it. */
  onConnected?: (sourceId: string) => void;
}) {
  const existing = sources.filter((s) => s.kind === "sheets");
  const [accounts, setAccounts] = useState<{ id: string; account_email: string }[]>([]);
  const [accountId, setAccountId] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [tab, setTab] = useState("");
  const [preview, setPreview] = useState<SheetPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, IntakeField>>({});
  const [importExisting, setImportExisting] = useState(false);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  useEffect(() => {
    void listSheetAccountsAction().then((r) => {
      setAccounts(r.accounts);
      setAccountId((id) => id || (r.accounts[0]?.id ?? ""));
    });
  }, []);

  const look = (nextTab?: string) => {
    startTransition(async () => {
      const result = await previewSheetAction({
        connectedAccountId: accountId,
        spreadsheetUrl: url.trim(),
        sheetName: nextTab ?? tab ?? undefined,
      });
      if (result.error || !result.preview) {
        await alert({
          title: "Couldn't open that sheet",
          body: result.error ?? "No answer from Google.",
          tone: "danger",
        });
        return;
      }
      setPreview(result.preview);
      setTab(nextTab ?? result.preview.tabs[0] ?? "");
      setMapping(guessMapping(result.preview.headers));
      setName((n) => n || result.preview!.title || "Google Sheet");
    });
  };

  const save = () => {
    const mapped = Object.entries(mapping).filter(([, field]) => field);
    if (mapped.length === 0) {
      void alert({
        title: "Nothing is mapped yet",
        body: "Tell Aura which column holds the phone number or the name, at least.",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      const result = await createLeadSourceAction({
        kind: "sheets",
        name: name.trim() || "Google Sheet",
        provider: "google",
        config: {
          spreadsheetId: preview!.spreadsheetId,
          spreadsheetUrl: url.trim(),
          sheetName: tab || undefined,
          connectedAccountId: accountId,
          columnMapping: Object.fromEntries(mapped),
          headerRow: 1,
          importExisting,
        },
      });
      if (result.error) {
        await alert({ title: "Couldn't connect the sheet", body: result.error, tone: "danger" });
        return;
      }
      setPreview(null);
      setUrl("");
      setName("");
      setMapping({});
      if (result.data) onConnected?.(result.data.id);
    });
  };

  if (accounts.length === 0) {
    return (
      <Card className="space-y-2">
        <MonoLabel>Google Sheet</MonoLabel>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          Aura can read new rows out of one of your own spreadsheets and turn each one into a lead.
          It needs a Google account with permission to open the sheet —{" "}
          {/* next/link, not a bare <a>: a raw href skips the /admin basePath
              and 404s in production. Into the store's Google flow, which
              brings the person back here when they press Done. */}
          <Link
            href={`/owner/integrations/google_workspace/connect?from=${encodeURIComponent("/owner/lead-sources")}`}
            className="underline underline-offset-2"
          >
            connect your Google account
          </Link>
          , then come back.
        </p>
        <p className="max-w-prose text-xs text-text-muted">
          {/* Said plainly, because it is the confusing case: an account
              connected for Gmail before this existed genuinely cannot read
              sheets, and only reconnecting can add that. */}
          If you already have Google connected for mail or calendar, reconnect it — the permission
          to read spreadsheets is granted separately.
        </p>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <MonoLabel>Google Sheet</MonoLabel>
        {existing.length > 0 ? (
          <span className="text-xs text-text-muted">
            {existing.length} connected · {existing.filter((s) => s.status === "active").length}{" "}
            active
          </span>
        ) : null}
      </div>

      {existing.length > 0 ? (
        <ul className="space-y-1.5">
          {existing.map((source) => (
            <li
              key={source.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2.5"
            >
              <span className="min-w-0">
                <span className="text-sm text-text">{source.name}</span>
                <span className="ml-2 text-xs text-text-muted">
                  {Number(source.lead_count ?? 0).toLocaleString()} leads
                  {source.last_error ? ` · ${source.last_error}` : ""}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <StatusChip tone={source.status === "active" ? "solid" : "outline"}>
                  {source.status}
                </StatusChip>
                {source.status === "paused" ? (
                  // The one action worth having here. A sheet pauses itself
                  // when its columns change, and the fix is to check the
                  // mapping and start it again - which has to be possible
                  // without deleting and re-adding the source, or the lead
                  // history goes with it.
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await updateLeadSourceAction(source.id, { status: "active" });
                        if (r.error) {
                          await alert({
                            title: "Couldn't resume it",
                            body: r.error,
                            tone: "danger",
                          });
                        }
                      })
                    }
                  >
                    Resume
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {!preview ? (
        <div className="space-y-3">
          <p className="max-w-prose text-sm leading-relaxed text-text-muted">
            Paste the link to a spreadsheet. Aura reads it — never writes to it — and turns each new
            row into a lead on your board.
          </p>
          {accounts.length > 1 ? (
            <div className="max-w-sm">
              <Label htmlFor="sheet-account">Read it as</Label>
              <Select
                id="sheet-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.account_email}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/…"
              className="min-w-0 flex-1"
              aria-label="Spreadsheet link"
            />
            <Button
              type="button"
              disabled={pending || !parseSpreadsheetId(url)}
              onClick={() => look()}
            >
              Look inside
            </Button>
          </div>
          {url.trim() && !parseSpreadsheetId(url) ? (
            <p className="text-xs text-danger-text">
              That does not look like a Google Sheets link — copy the address from the browser bar.
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="sheet-name">Call this source</Label>
              <Input id="sheet-name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="sheet-tab">Tab</Label>
              <Select
                id="sheet-tab"
                value={tab}
                onChange={(e) => {
                  setTab(e.target.value);
                  look(e.target.value);
                }}
              >
                {preview.tabs.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium tracking-wide text-text-muted uppercase">
              What each column means
            </p>
            <div className="space-y-1.5">
              {preview.headers.map((header, i) => (
                <div key={`${header}-${i}`} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-[9rem] text-sm text-text">{header}</span>
                  {/* The first value under the heading. "Column C is called
                      Contact" is ambiguous; "and its first value is
                      priya@example.com" is not. */}
                  <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                    {preview.sampleRows[0]?.[i] ?? "—"}
                  </span>
                  <Select
                    aria-label={`What ${header} means`}
                    value={mapping[header] ?? ""}
                    onChange={(e) =>
                      setMapping((prev) => {
                        const next = { ...prev };
                        if (e.target.value) next[header] = e.target.value as IntakeField;
                        else delete next[header];
                        return next;
                      })
                    }
                    className="w-48"
                  >
                    {FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </div>

          <label className="flex max-w-prose items-start gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={importExisting}
              onChange={(e) => setImportExisting(e.target.checked)}
              className="mt-1"
            />
            <span>
              Also import the rows already in this sheet.{" "}
              <span className="text-text">
                Leave this off unless you mean it — every existing row becomes a new lead, dated
                today.
              </span>{" "}
              With it off, Aura starts watching from the bottom and only new rows arrive.
            </span>
          </label>

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button type="button" onClick={save} disabled={pending}>
              Connect this sheet
            </Button>
            <Button type="button" variant="ghost" onClick={() => setPreview(null)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
