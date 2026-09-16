"use client";

import { useState, useTransition } from "react";
import { ShieldX } from "lucide-react";
import { BrutalButton, Card, ConsolePanel, MonoLabel, useAlert, useConfirm } from "@aura/ui";
import { monoInputClass as inputClass } from "@/lib/form";
import { triggerErasureAction, type ErasureReceipt } from "./actions";

export function ErasureTool({ orgId }: { orgId: string }) {
  const [callId, setCallId] = useState("");
  const [receipt, setReceipt] = useState<ErasureReceipt | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();

  const trigger = async () => {
    const ok = await confirm({
      title: "Permanently erase this call?",
      body: "Cascading erasure purges the call, its audio, transcript, AI output and extracted facts. This cannot be undone and there is no backup to restore from.",
      confirmLabel: "Erase permanently",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      setReceipt(null);
      const result = await triggerErasureAction(orgId, callId.trim());
      // A failure is an event; the RECEIPT is an artefact. Only the first goes
      // in a popup - the signed receipt below is the audit record for an
      // irreversible destruction, and it stays on screen to be copied.
      if (result.error) {
        await alert({ title: "Erasure did not run", body: result.error, tone: "danger" });
        return;
      }
      setReceipt(result);
    });
  };

  const receiptLines =
    receipt
      ? [
          `status      : ${receipt.status ?? "erased"}`,
          `call_id     : ${receipt.callId ?? callId}`,
          `erased_utc  : ${receipt.erasedAtUtc ?? "-"}`,
          "purged      :",
          ...(receipt.purged ?? []).map((p) => `  - ${p}`),
          `receipt_hash: ${receipt.receiptHash ?? "-"}`,
          `signature   : ${receipt.signature ?? "-"}`,
        ]
      : [];

  return (
    <Card elevated className="space-y-4 border-red-600">
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
        onClick={() => void trigger()}
      >
        <ShieldX className="h-4 w-4" />
        {pending ? "PURGING…" : "TRIGGER CASCADING ERASURE"}
      </BrutalButton>

      {receipt ? (
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
