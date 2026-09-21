"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Checkbox } from "@aura/ui";
import type { CallInsightsWindow } from "@aura/shared";
import { filenameFromDisposition, insightsPdfHref } from "@/lib/call-insights";

/**
 * "Download PDF" - one click, a file in Downloads.
 *
 * A button that fetches rather than a plain `<a href>`, for two reasons. The
 * report takes a second or two to build, and a bare link gives no sign that
 * anything is happening, so it gets clicked three times. And a link that fails
 * NAVIGATES - to a page of raw JSON - where this says what went wrong in a
 * sentence and leaves the reader where they were.
 *
 * The bytes still come from a server route (insights/export), so the API's
 * credential never reaches the browser; this only decides what to do with the
 * response.
 */
export function PdfDownload({ window: range }: { window: CallInsightsWindow }) {
  const [includeCalls, setIncludeCalls] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const res = await fetch(insightsPdfHref(range, includeCalls), { cache: "no-store" });
      if (!res.ok) {
        setError(await explain(res));
        return;
      }
      const blob = await res.blob();
      const filename = filenameFromDisposition(res.headers.get("content-disposition"));
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked after the click has been handed to the browser, not before -
      // revoking synchronously cancels the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setSaved(filename);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <div className="flex flex-wrap items-center gap-3">
        <Checkbox
          label="Include individual calls"
          checked={includeCalls}
          onChange={(e) => setIncludeCalls(e.target.checked)}
          disabled={busy}
        />
        <Button type="button" variant="secondary" size="sm" loading={busy} onClick={() => void download()}>
          <Download aria-hidden="true" className="h-4 w-4" />
          {busy ? "Preparing PDF…" : "Download PDF"}
        </Button>
      </div>
      {/* One polite region for both outcomes, so a screen reader hears the
          result of the click without the page moving focus. */}
      <p aria-live="polite" className="min-h-4 text-xs">
        {error ? (
          <span role="alert" className="text-orange-text">
            {error}
          </span>
        ) : saved ? (
          <span className="text-text-muted">Saved {saved}</span>
        ) : !includeCalls ? (
          <span className="text-text-muted">Names and call summaries will be left out.</span>
        ) : null}
      </p>
    </div>
  );
}

async function explain(res: Response): Promise<string> {
  if (res.status === 401) return "Your session has ended. Sign in again, then download.";
  if (res.status === 403) return "Your account cannot export call insights. Ask the account owner.";
  if (res.status === 404) return "Call insights are not switched on for this workspace.";
  let detail = "";
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const message = body.error ?? body.message;
    detail = typeof message === "string" ? message : "";
  } catch {
    detail = "";
  }
  if (res.status === 400) return detail ? `That range cannot be reported: ${detail}.` : "That range cannot be reported.";
  return "The report could not be built just now. Try again in a minute.";
}
