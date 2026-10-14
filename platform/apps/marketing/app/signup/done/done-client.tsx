"use client";

import { useEffect, useState } from "react";

/**
 * WHERE THE BUYER WAITS, AND WHY THIS PAGE IS NOT OPTIONAL.
 *
 * The money has left their account. Whatever is on this screen is what they
 * judge the purchase by, and there is - by design - nobody for them to call. So
 * the one thing it must never do is look broken.
 *
 * ── THE RACE THIS PAGE EXISTS TO ABSORB ─────────────────────────────────────
 *
 * Razorpay redirects the buyer here the moment the payment succeeds. The
 * webhook that provisions their workspace is a SEPARATE delivery that may
 * arrive before this page loads, after it, or - if the endpoint is disabled or
 * the payment is one of the kinds that emits no event - not at all. Arriving
 * "too early" is therefore the normal case, not an error, and the page polls
 * rather than asserting anything.
 *
 * When nothing has happened after a while it still does not say "failed". The
 * reconciliation sweep retries every five minutes for seven days, so the true
 * statement is that it is still coming and the link will be emailed. Telling
 * somebody who has just paid that something went wrong, when it has not and
 * when they have no one to ask, converts a recoverable delay into a chargeback.
 */

type State = "awaiting_payment" | "working" | "ready" | "unknown";

export function DoneClient({ claimRef, pending }: { claimRef: string; pending: boolean }) {
  const [state, setState] = useState<State>(pending ? "awaiting_payment" : "working");
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    if (!claimRef || pending) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const res = await fetch(`/v1/signup/${encodeURIComponent(claimRef)}/state`, {
          cache: "no-store",
        });
        const body = await res.json().catch(() => ({}));
        if (!alive) return;
        if (body?.status) setState(body.status as State);
        if (body?.status === "ready") return;
      } catch {
        // Swallowed on purpose: a dropped poll is not news to the buyer, and
        // the next one is two seconds away.
      }
      if (!alive) return;
      setWaited((w) => w + 1);
      // Backs off from 2s to 10s. Fast while the webhook is probably in
      // flight, slow once we are waiting on the five-minute sweep instead.
      // `() => void poll()` rather than `poll`: setTimeout expects a function
      // returning nothing, and handing it an async one returns a promise
      // nobody awaits - which is what the repo's no-misused-promises rule is
      // for. The behaviour is identical; `poll` handles its own failure.
      timer = setTimeout(() => void poll(), waited < 10 ? 2000 : 10000);
    };

    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // `waited` deliberately excluded: including it would restart the poll loop
    // on every tick instead of letting the scheduled timer run. (There is no
    // `eslint-disable` for react-hooks/exhaustive-deps here because the plugin
    // is not in this app's config, and a directive naming a rule that does not
    // exist is itself an error.)
  }, [claimRef, pending]);

  if (pending) {
    return (
      <Panel title="We've got your details.">
        <p>
          Online payment isn&apos;t switched on yet, so we&apos;ll be in touch to finish setting up
          your workspace. Nothing has been charged.
        </p>
      </Panel>
    );
  }

  if (state === "ready") {
    return (
      <Panel title="Your workspace is ready.">
        <p>
          We&apos;ve emailed your sign-in link. Open it and set up how you sign in — then pair your
          first phone from inside the console.
        </p>
        <p className="mt-3 text-sm opacity-70">
          Nothing in the email yet? Check spam first. The link is valid for two weeks.
        </p>
      </Panel>
    );
  }

  if (state === "unknown") {
    return (
      <Panel title="We couldn't find that reference.">
        <p>
          If you&apos;ve paid, your workspace is still being created and the sign-in link will be
          emailed to you. You don&apos;t need to do anything.
        </p>
      </Panel>
    );
  }

  // 'working' and the slow case. Same message, because from where the buyer is
  // sitting they are the same thing.
  return (
    <Panel title="Payment received. Building your workspace…">
      <p>
        This usually takes a few seconds. You can close this page — the sign-in link is emailed
        either way.
      </p>
      {waited > 12 ? (
        <p className="mt-3 text-sm opacity-70">
          Taking longer than usual. It is still coming, and the link will arrive by email. Nothing
          is lost and you have not been charged twice.
        </p>
      ) : null}
    </Panel>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  // `mk-card` rather than a bare `border`: Tailwind's default border colour on
  // a transparent ground was a nearly invisible box on the dark theme, which is
  // the wrong impression to leave on the one page that follows a payment.
  return (
    <div className="mk-card mt-8 p-6 sm:p-7">
      <h2 className="mk-display mk-h2 text-2xl">{title}</h2>
      <div className="mt-3 leading-relaxed">{children}</div>
    </div>
  );
}
