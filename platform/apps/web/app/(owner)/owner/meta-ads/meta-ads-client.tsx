"use client";

import { useState, useTransition } from "react";
import { Button } from "@aura/ui";
import { startOAuthRedirect } from "../lib/oauth-redirect";
import { startMetaConnectAction } from "./actions";

/**
 * Connect Meta (Facebook) Lead Ads - one button, one full-page redirect.
 *
 * There is no GET /meta/connections list endpoint yet, so this page can't
 * render a connection-status list the way connections-manager.tsx does. It
 * only offers the button; the OAuth callback (GET /meta/oauth/callback) is
 * handled entirely server-side by the API - Meta redirects the browser
 * straight there, not back into this Next.js app - so there is no return leg
 * to build here.
 */
export function MetaAdsConnect() {
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [pending, startTransition] = useTransition();

  const connect = () => {
    setError(null);
    startTransition(async () => {
      const result = await startMetaConnectAction();
      if (result.notConfigured) {
        setNotConfigured(true);
        return;
      }
      const failure = startOAuthRedirect(result, "Could not start Facebook sign-in");
      if (failure) setError(failure);
    });
  };

  if (notConfigured) {
    return (
      <p className="rounded-md border border-border bg-surface-hover p-3 text-sm text-text-muted">
        Meta Lead Ads isn&rsquo;t configured yet - ask your platform admin to set it up.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}
      <Button type="button" loading={pending} onClick={connect}>
        Connect Facebook Page
      </Button>
    </div>
  );
}
