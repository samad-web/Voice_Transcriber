"use client";

import { useEffect, useState } from "react";
import { Button } from "@aura/ui";

/**
 * What a Wasi channel's owner does in Wasi's admin panel: paste this URL into
 * "CRM Inbound Forwarding", then bring back the secret Wasi shows. Drawn on
 * the channel's card on the Messaging page and in the Integrations store's
 * check step, in the same words.
 *
 * Wasi ONLY. A Meta channel's webhook is entered on the Meta app dashboard
 * (meta-webhook-details.tsx), and a personal number's is registered by Aura
 * at pairing time and needs nothing from anybody - showing this block on
 * either sent people to a panel they have no account for.
 *
 * The origin is read after mount, so the server and the first client render
 * agree (an empty-then-filled origin during render was a hydration mismatch).
 */
export function WasiWebhookDetails({
  path,
  hasForwardSecret,
  onEnterSecret,
}: {
  path: string;
  hasForwardSecret: boolean;
  onEnterSecret: () => void;
}) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-surface-hover p-3 text-xs">
      <p className="font-medium text-text">Webhook URL for Wasi&rsquo;s &ldquo;CRM Inbound Forwarding&rdquo;</p>
      <p className="break-all font-mono text-text-muted">
        {origin}
        {path}
      </p>
      <p className="text-text-muted">
        Paste this into the client&rsquo;s page in Wasi&rsquo;s admin panel (Clients → this client → CRM
        Inbound Forwarding), tick all four events, and save. Wasi will show a secret - paste it here.
      </p>
      <Button variant="secondary" size="sm" onClick={onEnterSecret}>
        {hasForwardSecret ? "Replace forward secret" : "Enter forward secret"}
      </Button>
    </div>
  );
}
