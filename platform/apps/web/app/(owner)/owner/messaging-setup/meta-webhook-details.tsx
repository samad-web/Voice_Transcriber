"use client";

import { useEffect, useState } from "react";
import { Button, useToast } from "@aura/ui";

/**
 * What a Meta channel's owner pastes into the Meta app dashboard: the callback
 * URL and the verify token Meta checks it with once (messaging-webhook
 * .controller.ts answers that check). Drawn on the channel's card on the
 * Messaging page, and in the Integrations store's check step - the same two
 * values in the same words in both.
 *
 * The origin is read after mount: the server has no window, and rendering an
 * empty origin on the server and a real one on the client is a hydration
 * mismatch. Same origin the Wasi block uses - the API answers /v1 on the
 * console's own host.
 */
export function MetaWebhookDetails({ path, verifyToken }: { path: string; verifyToken: string | null }) {
  const [origin, setOrigin] = useState("");
  const toast = useToast();
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}${path}`;

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} copied`);
    } catch {
      // Clipboard refused (an insecure origin, a denied permission): the text
      // is on screen and selectable, which is the fallback.
    }
  };

  return (
    <div className="mt-3 space-y-2 rounded-md border border-border bg-surface-hover p-3 text-xs">
      <p className="font-medium text-text">For Meta&rsquo;s webhook setup</p>
      <div>
        <p className="text-text-muted">Callback URL</p>
        <p className="mt-0.5 font-mono break-all text-text">{origin ? url : path}</p>
      </div>
      {verifyToken ? (
        <div>
          <p className="text-text-muted">Verify token</p>
          <p className="mt-0.5 font-mono break-all text-text">{verifyToken}</p>
        </div>
      ) : null}
      <p className="text-text-muted">
        In your Meta app, open Webhooks for this product, paste both, and subscribe to the messages
        field. Meta calls the URL once with the token to check the endpoint is yours.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy(url, "Callback URL")} disabled={!origin}>
          Copy URL
        </Button>
        {verifyToken ? (
          <Button type="button" variant="secondary" size="sm" onClick={() => void copy(verifyToken, "Verify token")}>
            Copy token
          </Button>
        ) : null}
      </div>
    </div>
  );
}
