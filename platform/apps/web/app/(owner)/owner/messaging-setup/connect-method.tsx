"use client";

import { useState } from "react";
import { Card, MonoLabel, Radio, RadioGroup } from "@aura/ui";
import { EmbeddedSignup } from "./embedded-signup";
import { MessagingSetup } from "./messaging-setup-client";
import type { EmbeddedSignupConfig, MessagingChannel } from "./actions";

/**
 * THE QUESTION, ASKED BEFORE ANYTHING IS SHOWN.
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * The page used to stack both routes on top of each other: a "Connect with
 * Facebook" panel, then three paragraphs about Hub API keys, then a form
 * demanding a host URL, a client id and a key. An owner who had never heard of
 * a Business Solution Provider read all of it looking for the part that applied
 * to them, and the page's own copy admitted the problem by explaining which
 * task was "the rarer, more technical" one.
 *
 * A person cannot choose between two options they cannot tell apart. So the
 * page asks first, in words describing how they ALREADY use the number - which
 * is a fact they have - rather than which integration they want, which is a
 * decision they have no basis for.
 *
 * Adapted from DeskcommCRM (MIT, Rafael Melgaco),
 * `app/onboarding/connect-whatsapp/_client.tsx`, where the same screen was
 * rebuilt for the same reason: it used to start a connection on mount, so an
 * owner with a proper Meta account was silently put down the wrong path before
 * clicking anything, and found out later on a different screen.
 *
 * ── THE ANSWER IS NOT PERSISTED, AND THAT IS THE POINT ──────────────────────
 *
 * It lives in `useState` and is never written anywhere. Persisting the choice
 * would make picking one an action with consequences, and an owner who picks
 * wrong would be stuck on a path they cannot leave. Here choosing is free,
 * "Choose a different way" is always on screen, and nothing at all happens
 * until they act inside a branch. While the question is unanswered this
 * component has no side effect of any kind - no fetch, no channel row, no
 * credential prompt.
 */

type Method = "facebook" | "credentials";

export function ConnectMethod({
  channels,
  signup,
}: {
  channels: MessagingChannel[];
  signup: EmbeddedSignupConfig;
}) {
  const [method, setMethod] = useState<Method | null>(null);

  /*
   * A tenant that already has a channel is not being asked to connect one -
   * they are here to check on, fix or add to what exists. Making them answer a
   * "how do you use this number" question on every visit to a settings page
   * would be the kind of wizard that never lets go.
   */
  if (channels.length > 0) {
    return (
      <div className="space-y-4">
        <EmbeddedSignup config={signup} />
        <MessagingSetup initial={channels} />
      </div>
    );
  }

  if (method === null) {
    return (
      <Card>
        {/*
          The kit's RadioGroup, not a hand-rolled fieldset. It is what attaches
          the question to the answers for a screen reader - without a legend the
          options are announced as "1 of 2" with no indication of what is being
          asked - and using it here keeps this screen from becoming a second
          dialect of a control the console already has.
        */}
        <RadioGroup
          legend="How do you use this WhatsApp number today?"
          hint="There is more than one kind of WhatsApp business account and they connect in different ways. If you have not heard of the second one, it is the first."
        >
          <Radio
            name="connect-method"
            value="facebook"
            checked={false}
            onChange={() => setMethod("facebook")}
            data-testid="connect-method-facebook"
            label="I manage it through Facebook"
            description="You - or your marketing agency - administer the number from Facebook Business Manager. You sign in with Facebook and pick the number; nothing to copy or paste."
          />
          <Radio
            name="connect-method"
            value="credentials"
            checked={false}
            onChange={() => setMethod("credentials")}
            data-testid="connect-method-credentials"
            label="Someone set it up for me and gave me keys"
            description="Your provider ran the setup and handed you a host URL, a client id and an API key. Have those in front of you."
          />
        </RadioGroup>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={() => setMethod(null)}
        className="text-sm text-text-muted underline underline-offset-4 hover:text-text"
      >
        ← Choose a different way
      </button>

      {method === "facebook" ? (
        <>
          <EmbeddedSignup config={signup} />
          {/*
            Shown INSIDE this branch rather than as a page-level warning,
            because it is only true of this route. The cost of getting it wrong
            is a person hunting a Facebook problem that does not exist.
          */}
          {!signup.ready ? (
            <Card>
              <MonoLabel>Not available on this workspace yet</MonoLabel>
              <p className="mt-2 max-w-2xl text-sm text-text-muted">
                Signing in with Facebook needs your provider account linked here first, and it is
                not linked yet. The other route works now and nothing is lost by using it - you can
                switch later without disconnecting the number.
              </p>
              <button
                type="button"
                onClick={() => setMethod("credentials")}
                className="mt-3 text-sm font-semibold text-text underline underline-offset-4"
              >
                Use the keys my provider gave me
              </button>
            </Card>
          ) : null}
        </>
      ) : (
        <>
          <Card>
            <MonoLabel>What you will need</MonoLabel>
            <p className="mt-2 max-w-2xl text-sm text-text-muted">
              Three values from your provider&rsquo;s admin panel: the host URL, the client id and
              the API key. There is a fourth - a forward secret - that only appears after the
              channel is saved here, so leave this page open.
            </p>
          </Card>
          <MessagingSetup initial={channels} />
        </>
      )}
    </div>
  );
}

