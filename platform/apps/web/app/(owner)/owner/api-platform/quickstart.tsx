"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, MonoLabel, Select, StatusChip } from "@aura/ui";

/**
 * §8.1's first-run checklist, and §14's five-minute quickstart.
 *
 * ── THE STATE IS COMPUTED, NOT STORED ───────────────────────────────────────
 *
 * Each step's tick comes from what has actually arrived - a key exists, an
 * event exists, KPIs are chosen - rather than from a stored "step 3 complete"
 * flag. A flag would go stale the moment somebody revoked their key or reset
 * their test data, and a checklist that lies about where you are is worse than
 * no checklist.
 *
 * ── THE SNIPPETS NAME THE KEY'S PREFIX, NEVER THE KEY ───────────────────────
 *
 * A key is shown exactly once, at creation, and only its sha256 is stored - so
 * there is nothing here to paste in for them even if we wanted to. The samples
 * use a placeholder and the dropdown says which key's prefix to look for, which
 * is the most this page can honestly do.
 */
export function Quickstart({
  hasKey,
  hasEvents,
  hasKpis,
  keys,
  baseUrl,
}: {
  hasKey: boolean;
  hasEvents: boolean;
  hasKpis: boolean;
  keys: { id: string; name: string; prefix: string; env: string; scopes: string[] }[];
  /**
   * The API's origin as the INTERNET reaches it, from `publicApiOrigin()` on
   * the server. Passed in rather than read here: this is a client component,
   * so reading it at render would give the console's own origin on the client
   * and something else during SSR - a hydration mismatch in the one string the
   * reader is about to paste into a terminal.
   */
  baseUrl: string;
}) {
  const [language, setLanguage] = useState<"curl" | "node" | "python">("curl");
  const [copied, setCopied] = useState<string | null>(null);
  const samples = samplesFor(baseUrl);

  const steps = [
    { label: "Create an API key", done: hasKey, href: "/owner/integrations" },
    { label: "Send a telecaller", done: hasEvents, href: null },
    { label: "Send a call", done: hasEvents, href: null },
    { label: "Choose your KPIs", done: hasKpis, href: "/owner/settings/performance" },
    { label: "See your dashboard", done: hasKpis && hasEvents, href: "/owner/kpi" },
  ];

  /**
   * Deliberately NOT async.
   *
   * An async handler passed straight to an attribute hands React a Promise it
   * does not await, so a rejection becomes an unhandled one - and the
   * clipboard API rejects routinely, in a private window or wherever site
   * permissions are locked down. The `void` keeps the floating promise
   * explicit and the `catch` keeps it from going anywhere.
   *
   * A clipboard that refuses is not worth a banner either: the snippet is on
   * screen and selectable.
   */
  function copy(name: string, text: string): void {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(name);
        window.setTimeout(() => setCopied(null), 1500);
      })
      .catch(() => setCopied(null));
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <MonoLabel>Get your first number on the board</MonoLabel>
          <p className="mt-1 text-sm text-text-muted">
            Five steps. The whole thing takes about five minutes.
          </p>
        </div>
        <Select
          value={language}
          onChange={(e) => setLanguage(e.target.value as typeof language)}
          className="w-32"
          aria-label="Sample language"
        >
          <option value="curl">cURL</option>
          <option value="node">JavaScript</option>
          <option value="python">Python</option>
        </Select>
      </div>

      <ol className="mt-4 space-y-1.5">
        {steps.map((step, i) => (
          <li key={step.label} className="flex items-center gap-2 text-sm">
            <span className="w-5 shrink-0 text-xs tabular-nums text-text-muted">{i + 1}</span>
            {step.done ? (
              <StatusChip tone="muted">Done</StatusChip>
            ) : (
              <StatusChip tone="outline">To do</StatusChip>
            )}
            {step.href ? (
              <Link href={step.href} className="text-text underline-offset-2 hover:underline">
                {step.label}
              </Link>
            ) : (
              <span className="text-text">{step.label}</span>
            )}
          </li>
        ))}
      </ol>

      {keys.length > 0 ? (
        <p className="mt-3 text-xs text-text-muted">
          Use the key whose prefix is{" "}
          {keys.map((k, i) => (
            <span key={k.id}>
              {i > 0 ? ", " : ""}
              <code className="rounded bg-surface-hover px-1 py-0.5">{k.prefix}…</code>
              <span> ({k.env})</span>
            </span>
          ))}
          . The full key was shown once when it was created — if it is lost, revoke it and make
          another.
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        <Snippet
          title="1 · Tell us who your telecallers are"
          code={samples[language].telecaller}
          onCopy={(text) => copy("telecaller", text)}
          copied={copied === "telecaller"}
        />
        <Snippet
          title="2 · Send a call"
          code={samples[language].call}
          onCopy={(text) => copy("call", text)}
          copied={copied === "call"}
        />
        <Snippet
          title="3 · Send a conversion when one closes"
          code={samples[language].conversion}
          onCopy={(text) => copy("conversion", text)}
          copied={copied === "conversion"}
        />
      </div>

      <div className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs text-text-muted">
        <p>
          <strong className="font-medium text-text">Batches.</strong> Up to 500 items per request.
          One bad row never fails the rest — the response says what happened to each, with the
          field that was wrong.
        </p>
        <p>
          <strong className="font-medium text-text">Retries.</strong> Send an{" "}
          <code>Idempotency-Key</code> header and a replay cannot duplicate anything. Sending the
          same <code>external_id</code> twice updates one record rather than making two, so a
          correction is just another push.
        </p>
        <p>
          <strong className="font-medium text-text">Late data is fine.</strong> A call from
          yesterday, a disposition added an hour later, a payment that names a conversion we have
          not been sent yet — all accepted, and the figures for the affected days are recomputed.
        </p>
        <p>
          <strong className="font-medium text-text">Timestamps need an offset.</strong>{" "}
          <code>2026-10-10T10:12:03+05:30</code>, not <code>2026-10-10T10:12:03</code>. Without one
          we would have to guess a timezone, and the guess would put your late shift on the wrong
          day.
        </p>
      </div>
    </Card>
  );
}

function Snippet({
  title,
  code,
  onCopy,
  copied,
}: {
  title: string;
  code: string;
  onCopy: (text: string) => void;
  copied: boolean;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-text">{title}</p>
        <button
          type="button"
          onClick={() => onCopy(code)}
          className="text-xs text-accent-text underline-offset-2 hover:underline"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-surface-hover p-2 text-xs leading-relaxed text-text">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * The host the literals below are written against, swapped for the
 * deployment's real one by `samplesFor`.
 *
 * It is a single token rather than an interpolation per line for the reason
 * the note below gives: one substitution leaves a snippet that still reads as
 * the thing you are about to run.
 */
const SAMPLE_HOST = "https://app.aura.example";

/**
 * Every sample rewritten against the origin the internet actually reaches
 * this deployment on (`publicApiOrigin()`).
 *
 * These used to ship with `app.aura.example` in them. An integrator's first
 * act on this page is to copy a snippet and run it, and that one resolves
 * nowhere - so the quickstart's own first step failed, and it failed with a
 * DNS error that says nothing about what went wrong.
 */
export function samplesFor(baseUrl: string): Record<string, Record<string, string>> {
  const host = baseUrl.replace(/\/+$/u, "");
  return Object.fromEntries(
    Object.entries(SAMPLES).map(([lang, group]) => [
      lang,
      Object.fromEntries(
        Object.entries(group).map(([step, code]) => [step, code.split(SAMPLE_HOST).join(host)]),
      ),
    ]),
  );
}

/**
 * The samples, in the three languages §14 asks for.
 *
 * Literal strings rather than built from a template, because an integrator
 * copies these and runs them, and a snippet assembled from four interpolations
 * is a snippet nobody can read to check what it does before pasting their
 * credential into it.
 */
const SAMPLES: Record<"curl" | "node" | "python", Record<string, string>> = {
  curl: {
    telecaller: `curl -X PUT https://app.aura.example/v1/ingest/telecallers/tc_102 \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Priya Sharma","team_external_id":"team-delhi"}'`,
    call: `curl -X POST https://app.aura.example/v1/ingest/calls \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: batch-2026-10-10-001" \\
  -d '{"calls":[{
        "external_id":"call_8841",
        "telecaller_external_id":"tc_102",
        "direction":"outbound",
        "started_at":"2026-10-10T10:12:03+05:30",
        "connected":true,
        "duration_sec":184,
        "talk_time_sec":160,
        "disposition":"interested",
        "lead_ref":"L-5521"
      }]}'`,
    conversion: `curl -X POST https://app.aura.example/v1/ingest/conversions \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"conversions":[{
        "external_id":"conv_3320",
        "telecaller_external_id":"tc_102",
        "lead_ref":"L-5521",
        "closed_at":"2026-10-10T15:40:00+05:30",
        "value_minor":1500000,
        "currency":"INR"
      }]}'`,
  },
  node: {
    telecaller: `const base = "https://app.aura.example/v1/ingest";
const headers = {
  Authorization: \`Bearer \${process.env.AURA_KEY}\`,
  "Content-Type": "application/json",
};

await fetch(\`\${base}/telecallers/tc_102\`, {
  method: "PUT",
  headers,
  body: JSON.stringify({ name: "Priya Sharma", team_external_id: "team-delhi" }),
});`,
    call: `const res = await fetch(\`\${base}/calls\`, {
  method: "POST",
  headers: { ...headers, "Idempotency-Key": "batch-2026-10-10-001" },
  body: JSON.stringify({
    calls: [{
      external_id: "call_8841",
      telecaller_external_id: "tc_102",
      direction: "outbound",
      started_at: "2026-10-10T10:12:03+05:30",
      connected: true,
      duration_sec: 184,
      talk_time_sec: 160,
      disposition: "interested",
      lead_ref: "L-5521",
    }],
  }),
});

// Per-item results: one bad row never fails the others.
const { accepted, rejected, results } = await res.json();
for (const item of results.filter((r) => r.status === "rejected")) {
  console.error(item.external_id, item.error.message, item.error.field_errors);
}`,
    conversion: `await fetch(\`\${base}/conversions\`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    conversions: [{
      external_id: "conv_3320",
      telecaller_external_id: "tc_102",
      lead_ref: "L-5521",
      closed_at: "2026-10-10T15:40:00+05:30",
      value_minor: 1500000,
      currency: "INR",
    }],
  }),
});`,
  },
  python: {
    telecaller: `import os, requests

BASE = "https://app.aura.example/v1/ingest"
HEADERS = {"Authorization": f"Bearer {os.environ['AURA_KEY']}"}

requests.put(
    f"{BASE}/telecallers/tc_102",
    headers=HEADERS,
    json={"name": "Priya Sharma", "team_external_id": "team-delhi"},
).raise_for_status()`,
    call: `res = requests.post(
    f"{BASE}/calls",
    headers={**HEADERS, "Idempotency-Key": "batch-2026-10-10-001"},
    json={"calls": [{
        "external_id": "call_8841",
        "telecaller_external_id": "tc_102",
        "direction": "outbound",
        "started_at": "2026-10-10T10:12:03+05:30",
        "connected": True,
        "duration_sec": 184,
        "talk_time_sec": 160,
        "disposition": "interested",
        "lead_ref": "L-5521",
    }]},
)
res.raise_for_status()

# Per-item results: one bad row never fails the others.
for item in res.json()["results"]:
    if item["status"] == "rejected":
        print(item["external_id"], item["error"]["message"])`,
    conversion: `requests.post(
    f"{BASE}/conversions",
    headers=HEADERS,
    json={"conversions": [{
        "external_id": "conv_3320",
        "telecaller_external_id": "tc_102",
        "lead_ref": "L-5521",
        "closed_at": "2026-10-10T15:40:00+05:30",
        "value_minor": 1500000,
        "currency": "INR",
    }]},
).raise_for_status()`,
  },
};
