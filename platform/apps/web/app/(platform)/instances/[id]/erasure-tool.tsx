"use client";

import { useState, useTransition } from "react";
import { ShieldX } from "lucide-react";
import { BrutalButton, Card, ConsolePanel, MonoLabel } from "@aura/ui";
import { triggerErasureAction, type ErasureReceipt } from "./actions";
import { monoInputClass as inputClass } from "@/lib/form";

export function ErasureTool({ orgId }: { orgId: string }) {
  const [callId, setCallId] = useState("");
  const [receipt, setReceipt] = useState<ErasureReceipt | null>(null);
  const [pending, startTransition] = useTransition();

  const trigger = () =>
    startTransition(async () => {
      if (
        !window.confirm(
          "Cascading erasure permanently purges the call, audio, transcript, AI output and facts. Continue?",
        )
      )
        return;
      setReceipt(null);
      setReceipt(await triggerErasureAction(orgId, callId.trim()));
    });

  const receiptLines =
    receipt && !receipt.error
      ? [
          `status      : ${receipt.status ?? "erased"}`,
          `call_id     : ${receipt.callId ?? callId}`,
          `erased_utc  : ${receipt.erasedAtUtc ?? "—"}`,
          "purged      :",
          ...(receipt.purged ?? []).map((p) => `  - ${p}`),
          `receipt_hash: ${receipt.receiptHash ?? "—"}`,
          `signature   : ${receipt.signature ?? "—"}`,
        ]
      : [];

  return (
    <Card shadow className="space-y-4 border-red-600">
      <div className="flex items-center gap-2">
        <ShieldX className="h-4 w-4 text-red-600" />
        <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
          Right-to-Erasure (GDPR Art. 17)
        </h4>
      </div>
      <p className="text-xs text-neutral-500 font-sans font-medium">
        Cascading erasure destroys the call and every downstream artefact, then returns a signed,
        hash-chained receipt for the audit ledger. Scoped to this customer.
      </p>

      <div className="space-y-1.5">
        <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
          Call ID
        </label>
        <input
          className={inputClass}
          placeholder="uuid of the call to erase"
          value={callId}
          onChange={(e) => setCallId(e.target.value)}
        />
      </div>

      <BrutalButton
        variant="destructive"
        shadow
        className="w-full"
        disabled={pending || !callId.trim()}
        onClick={trigger}
      >
        <ShieldX className="h-4 w-4" />
        {pending ? "PURGING…" : "TRIGGER CASCADING ERASURE"}
      </BrutalButton>

      {receipt?.error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {receipt.error}
        </p>
      ) : null}

      {receipt && !receipt.error ? (
        <div className="space-y-1.5">
          <MonoLabel>Signed Erasure Receipt</MonoLabel>
          <ConsolePanel
            tone="danger"
            header="cascading-erasure · signed receipt"
            lines={receiptLines}
            className="max-h-72"
          />
        </div>
      ) : null}
    </Card>
  );
}
