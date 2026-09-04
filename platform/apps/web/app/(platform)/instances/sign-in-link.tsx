"use client";

import { useEffect, useState } from "react";
import { Copy, LogIn } from "lucide-react";
import { BrutalButton, Card, MonoLabel, useAlert, useToast } from "@aura/ui";

/**
 * The one address a customer signs in at: `<this origin>/login`.
 *
 * DELIBERATELY WITHOUT THE BASE PATH. In production the console is mounted at
 * /admin, because it shares aura.sirahagents.com with the marketing site - but
 * that prefix is an accident of hosting, not something to put in front of a
 * client, so nginx carves `/login` out of the marketing root and proxies it to
 * the console's own /admin/login (`location = /login` in
 * docker/nginx-aura.conf). Printing `${basePath}/login` here would show an
 * operator an address that works but reads like a back office.
 *
 * The pairing is the thing to protect: THIS URL IS ONLY REAL BECAUSE OF THAT
 * NGINX BLOCK. Deploy the console behind a base path without it and this card
 * hands out a 404. Local development needs nothing - `pnpm dev` serves the
 * console at the root, where /login is the actual route.
 *
 * The origin comes from `window.location` rather than an env var: the console
 * already knows where it is, and a separate "console URL" setting would be one
 * more place for the same fact to drift. It is deferred to an effect because
 * the server render has no `window` and a guess would mismatch on hydration -
 * so callers must handle the `null` first paint.
 */
export function useSignInUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(`${window.location.origin}/login`);
  }, []);

  return url;
}

/** The URL in a copyable box plus its copy button. No card, no heading. */
export function SignInLink() {
  const url = useSignInUrl();
  const alert = useAlert();
  const toast = useToast();

  return (
    <>
      <div className="bg-neutral-50 border-2 border-black p-2.5 font-mono text-xs break-all">
        {url ?? "Loading…"}
      </div>

      <BrutalButton
        variant="secondary"
        className="w-full"
        disabled={!url}
        // Sync, not `async` - same reasoning as PasswordReveal in
        // owner-accounts.tsx: React discards the return value, so an async
        // handler turns a rejected clipboard write into an unhandled rejection.
        onClick={() => {
          if (!url) return;
          void navigator.clipboard
            .writeText(url)
            .then(() => toast("Copied"))
            .catch(() =>
              alert({
                title: "Couldn't copy the sign-in link",
                body: "Select the address above and copy it by hand.",
                tone: "danger",
              }),
            );
        }}
      >
        <Copy className="h-4 w-4" />
        COPY SIGN-IN LINK
      </BrutalButton>
    </>
  );
}

/**
 * The same link as a standalone card for the Instances list.
 *
 * It sits next to the list rather than inside one instance because the address
 * is the console's, not any one tenant's: every customer signs in here and the
 * instance is resolved from the account. Until now the link only appeared on an
 * instance page once CRM was switched on (crm-module-toggle.tsx), so an
 * operator onboarding a calls-only customer had to know it by heart.
 *
 * There is deliberately no self-serve sign-up URL to hand out: an account is
 * created for a customer under Owner accounts on the instance, which both makes
 * the login and grants access to that one tenant. A public sign-up form would
 * have no tenant to attach the new account to.
 */
export function SignInLinkCard() {
  return (
    <Card elevated className="space-y-2.5">
      <div className="flex items-center gap-2">
        <LogIn className="h-4 w-4" />
        <MonoLabel>Client sign-in link</MonoLabel>
      </div>

      <p className="text-xs text-neutral-500 font-sans font-medium leading-relaxed">
        Send this to any customer. They sign in with the email and password created for them under{" "}
        <strong>Owner accounts</strong> on their instance - there is no public sign-up, and the
        instance is resolved from the account, so nobody can reach another client&rsquo;s data.
      </p>

      <SignInLink />
    </Card>
  );
}
