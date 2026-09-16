"use client";

import { useState, useTransition } from "react";
import { Facebook } from "lucide-react";
import { Button, ErrorBanner, MonoLabel, RowHint, StatusChip, useToast } from "@aura/ui";
import { completeEmbeddedSignupAction, type EmbeddedSignupConfig } from "./actions";

/**
 * WhatsApp Embedded Signup - "Connect with Facebook", in the client's own
 * console.
 *
 * ── WHAT ACTUALLY HAPPENS ───────────────────────────────────────────────────
 *
 * 1. This loads Meta's JS SDK and calls `FB.login()` with Wasi's app id and
 *    login-configuration id. The person signs into Facebook, picks the Business
 *    portfolio and the WhatsApp number they want, in Meta's own popup.
 * 2. Meta hands back a one-time authorization `code` through the callback, and
 *    - separately - posts the `waba_id` and `phone_number_id` over
 *    `postMessage`. Both halves are needed and they arrive by different routes.
 * 3. Those three go to Aura's API, which forwards them to Wasi. Wasi exchanges
 *    the code for a long-lived token using its own Meta app secret, subscribes
 *    to the WABA and registers the number.
 *
 * Aura never holds a Meta token, and this file never sees one: the `code` is a
 * single-use grant that is worthless without the app secret, which lives on
 * Wasi. That is the same boundary the server-side Wasi client keeps, and the
 * reason the app id and config id below are safe to render into a page.
 *
 * ── WHY THE postMessage LISTENER IS ATTACHED FIRST ──────────────────────────
 *
 * Meta posts the account details when the popup finishes, which can be BEFORE
 * the `FB.login` callback runs. A listener registered after the login call
 * returns would miss it on a fast connection and time out - and the person
 * would be told the connection failed after successfully completing it, with
 * their number already half-connected on Meta's side.
 *
 * ── ORIGIN CHECK ON EVERY MESSAGE ───────────────────────────────────────────
 *
 * `postMessage` delivers to the window from anywhere. Anything not from a
 * facebook.com origin is dropped without parsing - an embedded ad frame or a
 * browser extension posting a lookalike payload must not be able to hand this
 * page a `waba_id` of its choosing.
 */

const SDK_SRC = "https://connect.facebook.net/en_US/sdk.js";
/** Meta's Graph version this flow is written against. */
const GRAPH_VERSION = "v20.0";

interface FbLoginResponse {
  authResponse?: { code?: string } | null;
}

interface FbSdk {
  init: (options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }) => void;
  login: (
    cb: (response: FbLoginResponse) => void,
    options: Record<string, unknown>,
  ) => void;
}

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

/**
 * Meta fires a DIFFERENT completion event for the Coexistence path - where the
 * business keeps using the WhatsApp Business app on their phone and Meta syncs
 * history across, instead of migrating the number off it.
 *
 * Which event fired is the only reliable signal for which path was taken;
 * nothing in the returned ids distinguishes them. It matters because Wasi must
 * NOT run register-with-PIN on a coexistence number - that number is live on
 * somebody's handset right now.
 */
const FINISH_EVENTS: Record<string, boolean> = {
  FINISH: false,
  FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: true,
};

function loadSdk(appId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve();
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, autoLogAppEvents: true, xfbml: true, version: GRAPH_VERSION });
      resolve();
    };
    if (!document.querySelector("script[data-aura-fb-sdk]")) {
      const script = document.createElement("script");
      script.src = SDK_SRC;
      script.async = true;
      script.dataset.auraFbSdk = "true";
      script.onerror = () => reject(new Error("Could not load Facebook. Check your connection or any ad blocker."));
      document.head.appendChild(script);
    }
    // A blocked or slow SDK must fail with a sentence somebody can act on
    // rather than leaving the button spinning forever. Ad blockers block this
    // script by name, which is by far the commonest cause.
    setTimeout(
      () => reject(new Error("Facebook did not load in time. An ad blocker or privacy extension is the usual cause.")),
      10000,
    );
  });
}

/** The shape Meta posts back over `postMessage` during Embedded Signup. */
interface SignupMessage {
  type?: string;
  event?: string;
  data?: Record<string, string>;
}

interface SignupDetails {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  viaCoexistence: boolean;
}

async function runEmbeddedSignup(appId: string, configId: string): Promise<SignupDetails> {
  await loadSdk(appId);

  // A holder object rather than a bare `let`. TypeScript's control-flow
  // analysis does not follow assignments made inside a listener closure, so a
  // `let posted = null` stays narrowed to `null` at every later read and every
  // property access on it is an error. A property on an object is re-read
  // rather than narrowed, which is exactly the behaviour this needs.
  const inbox: { message: SignupMessage | null } = { message: null };
  const onMessage = (event: MessageEvent) => {
    // Origin first, always - see the header.
    if (!event.origin) return;
    let host: string;
    try {
      host = new URL(event.origin).hostname;
    } catch {
      // An opaque origin ("null") is not a URL. Not ours either way.
      return;
    }
    if (!/(^|\.)facebook\.com$/.test(host)) return;
    try {
      inbox.message = JSON.parse(event.data as string) as SignupMessage;
    } catch {
      /* not ours - Meta posts other, non-JSON messages through this channel */
    }
  };
  window.addEventListener("message", onMessage);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      window.FB?.login(
        (response) => {
          const value = response?.authResponse?.code;
          if (!value) return reject(new Error("The WhatsApp connection was not completed."));
          resolve(value);
        },
        {
          config_id: configId,
          response_type: "code",
          override_default_response_type: true,
          // `featureType` opts the flow into offering Coexistence. Leaving it
          // empty would force every business down the migration path, which
          // takes the number off the WhatsApp Business app on their phone -
          // fine for some, unacceptable for a shop that runs on it.
          extras: {
            setup: {},
            featureType: "whatsapp_business_app_onboarding",
            sessionInfoVersion: "3",
          },
        },
      );
    });

    // The account details arrive on their own schedule. Poll briefly rather
    // than racing a second promise, so a message that landed before `login`
    // resolved is already sitting in `posted`.
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const message = inbox.message;
      if (message?.type === "WA_EMBEDDED_SIGNUP") {
        if (message.event && message.event in FINISH_EVENTS && message.data) {
          return {
            code,
            wabaId: message.data.waba_id,
            phoneNumberId: message.data.phone_number_id,
            viaCoexistence: FINISH_EVENTS[message.event]!,
          };
        }
        if (message.event === "CANCEL") throw new Error("Signup was cancelled in the Facebook window.");
        if (message.event === "ERROR") {
          throw new Error(`Facebook reported an error: ${message.data?.error_message ?? "unknown error"}`);
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(
      "Facebook signed you in but did not send the WhatsApp account details. Please try again.",
    );
  } finally {
    window.removeEventListener("message", onMessage);
  }
}

export function EmbeddedSignup({ config }: { config: EmbeddedSignupConfig }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const toast = useToast();

  if (!config.providerIsWasi) {
    return (
      <div className="rounded-md border border-border bg-bg-subtle p-4">
        <MonoLabel>WhatsApp is not provisioned</MonoLabel>
        <RowHint kind="blocked">
          No WhatsApp provider has been set for this workspace, so there is nothing to connect yet.
          Ask your provider to switch it on.
        </RowHint>
      </div>
    );
  }

  if (config.connected) {
    return (
      <div className="rounded-md border border-border bg-bg-subtle p-4">
        <div className="flex flex-wrap items-center gap-2">
          <MonoLabel>WhatsApp connected</MonoLabel>
          <StatusChip tone="solid">{config.connectedNumber ?? "Connected"}</StatusChip>
        </div>
        <RowHint kind="action">
          Messages to this number arrive in your Inbox. To move to a different number, disconnect it
          in WhatsApp Manager first - Meta only allows one Business account per number.
        </RowHint>
      </div>
    );
  }

  const connect = () => {
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        const details = await runEmbeddedSignup(config.appId!, config.configId!);
        startTransition(() => {});
        const res = await completeEmbeddedSignupAction(details);
        if (res.error) {
          setError(res.error);
          return;
        }
        toast("WhatsApp connected");
      } catch (err) {
        // Everything thrown above is already written for the person reading
        // it - cancelled, blocked, timed out and Meta's own error are each
        // distinguished on the way up rather than collapsed here.
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="space-y-3 rounded-md border border-border bg-bg-subtle p-4">
      <MonoLabel>Connect WhatsApp</MonoLabel>
      <p className="text-sm text-text-muted">
        Sign in with the Facebook account that manages your business, and choose the WhatsApp number
        you want to use. You will need to be an admin of the Business portfolio that owns it.
      </p>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <Button
        type="button"
        loading={busy}
        disabled={!config.ready}
        onClick={connect}
      >
        <Facebook aria-hidden="true" className="h-4 w-4" />
        Connect with Facebook
      </Button>

      {/* Each precondition names who fixes it. "Not available" would be true
          and useless: three different people own these three failures. */}
      {!config.metaConfigured ? (
        <RowHint kind="blocked">
          This deployment has no Meta app configured, so the Facebook window cannot open. Your
          provider sets WASI_META_APP_ID and WASI_META_CONFIG_ID.
        </RowHint>
      ) : !config.hasHubCredentials ? (
        <RowHint kind="blocked">
          Your Wasi account is not linked yet. The Hub API key and client id below have to be saved
          first - they are what authorises the connection on your behalf.
        </RowHint>
      ) : (
        <RowHint kind="action">
          Nothing is sent to your customers by connecting. It authorises Aura to send and receive on
          this number, and shows you the messages that arrive.
        </RowHint>
      )}
    </div>
  );
}
