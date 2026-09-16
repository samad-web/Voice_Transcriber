"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Dialog } from "@aura/ui";

export interface EmailRecipient {
  id: string;
  name: string;
  email: string | null;
}

/**
 * The bulk "Email" action: the selected rows' addresses, ready to paste.
 *
 * ── WHY THIS DOES NOT SEND ─────────────────────────────────────────────────
 *
 * Track A safety rule 3: nothing the platform does on its own sends a message,
 * and a bulk send is the most automated send there is. So the console only
 * gathers the addresses already on screen and copies them; a person pastes
 * them into their own mail app and presses send there, reading what they send.
 * The per-contact "Send email" on the record, which goes through the
 * mailbox connection with its own checks, is unchanged.
 *
 * Addresses are de-duplicated (two deals can share a contact), and rows with
 * no address are named rather than silently dropped, so "12 selected, 9
 * copied" is explained on screen.
 */
export function EmailListDialog({
  open,
  recipients,
  onClose,
}: {
  open: boolean;
  recipients: EmailRecipient[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const seen = new Set<string>();
  const withEmail: EmailRecipient[] = [];
  const without: EmailRecipient[] = [];
  for (const r of recipients) {
    const email = r.email?.trim();
    if (!email) {
      without.push(r);
      continue;
    }
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    withEmail.push({ ...r, email });
  }
  const text = withEmail.map((r) => r.email).join(", ");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard permission refused (an insecure origin, a locked-down
      // browser): the addresses are selectable in the box below instead.
      setCopied(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        setCopied(false);
        onClose();
      }}
      title={`${withEmail.length} email address${withEmail.length === 1 ? "" : "es"}`}
      description="Nothing is sent from here. Copy the addresses into your own mail app - put them in BCC so recipients don't see each other."
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" onClick={() => void copy()} disabled={withEmail.length === 0}>
            {copied ? <Check aria-hidden="true" className="h-4 w-4" /> : <Copy aria-hidden="true" className="h-4 w-4" />}
            {copied ? "Copied" : "Copy addresses"}
          </Button>
        </>
      }
    >
      {withEmail.length > 0 ? (
        <textarea
          readOnly
          value={text}
          rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))}
          aria-label="Email addresses"
          onFocus={(e) => e.currentTarget.select()}
          className="w-full resize-none rounded-sm border border-border-strong bg-bg-subtle px-3 py-2 font-mono text-xs text-text"
        />
      ) : (
        <p className="text-sm text-text-muted">None of the selected records has an email address.</p>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Addresses copied" : ""}
      </span>
      {without.length > 0 ? (
        <div className="mt-3">
          <p className="text-xs font-medium text-text-muted">
            No address on {without.length} record{without.length === 1 ? "" : "s"}:
          </p>
          <p className="mt-1 text-xs break-words text-text-subtle">{without.map((r) => r.name).join(", ")}</p>
        </div>
      ) : null}
    </Dialog>
  );
}
