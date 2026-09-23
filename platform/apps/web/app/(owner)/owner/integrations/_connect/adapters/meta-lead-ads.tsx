"use client";

import { useEffect, useState } from "react";
import { CONNECT_ERRORS } from "@aura/shared";
import { Button, Checkbox } from "@aura/ui";
import { NewSourceForm } from "../../../lead-sources/lead-sources-client";
import { McpConnect } from "../../../meta-ads/mcp-connect";
import { startMetaConnectAction } from "../../../meta-ads/actions";
import { startOAuthRedirect } from "../../../lib/oauth-redirect";
import { metaChoosePagesAction, metaPendingAction, type PendingPage } from "../../actions";
import { StepActions, StepHeading, StepLoading } from "../step-heading";
import type { StepProps } from "../types";

/**
 * Facebook & Instagram Lead Ads: sign in to Facebook, then CHOOSE the Pages.
 *
 * The callback used to take `pages[0]` and render JSON on the API's own
 * domain. Somebody running ads on their second Page connected their first,
 * saw "connected", and got no leads. Now the callback parks the Pages it was
 * given (0131) and 302s here; this step shows their names, and the person
 * ticks the ones that run lead ads.
 */
export function MetaLeadsAuth({ data, fail, goTo }: StepProps) {
  const [busy, setBusy] = useState(false);
  const [relay, setRelay] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    const result = await startMetaConnectAction();
    if (result.notConfigured) {
      fail(CONNECT_ERRORS.not_configured);
      setBusy(false);
      return;
    }
    const error = startOAuthRedirect(result, "Could not start the Facebook sign-in.");
    if (error) {
      fail(error);
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeading title="Sign in to Facebook">
        Sign in with the Facebook account that manages the Page running your lead ads. You&apos;ll choose
        which Pages send leads when you come back.
      </StepHeading>
      <StepActions>
        <Button type="button" loading={busy} onClick={() => void begin()}>
          Continue to Facebook
        </Button>
      </StepActions>

      {/* The alternate route (doc 28 §7.2): some agencies expose Meta leads
          through an MCP server instead of handing over a Facebook login. */}
      <details className="group mt-6 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium text-text marker:text-text-subtle">
          Or connect through an MCP server
        </summary>
        <div className="mt-3 space-y-3">
          <McpConnect initial={null} />
          <Button type="button" variant="secondary" onClick={() => goTo("done")}>
            I&apos;ve connected the server - finish
          </Button>
        </div>
      </details>

      {/* The third: a tool that already receives your lead-ad submissions
          (a relay, an agency's automation) forwards them to an Aura address.
          The same lead-source form the Lead sources page used for it. */}
      <details className="group mt-3 border-t border-border pt-4">
        <summary className="cursor-pointer text-sm font-medium text-text marker:text-text-subtle">
          Or have another tool forward them by webhook
        </summary>
        <div className="mt-3 space-y-3">
          {relay ? (
            <>
              <p className="text-sm text-text-muted">Point your tool&apos;s webhook at this address:</p>
              <p className="rounded-md border border-border bg-bg-subtle p-3 font-mono text-xs break-all text-text">
                {relay}
              </p>
              <Button type="button" variant="secondary" onClick={() => goTo("done")}>
                Finish
              </Button>
            </>
          ) : (
            <NewSourceForm
              bare
              channels={data.channels ?? []}
              origin={data.intakeOrigin ?? ""}
              kinds={["meta_ads"]}
              onDone={() => undefined}
              onCreated={(created) => setRelay(created.url ?? "")}
            />
          )}
        </div>
      </details>
    </>
  );
}

export function MetaLeadsChoose({ params, next, goTo, fail }: StepProps) {
  const pendingId = params.pending;
  const [pages, setPages] = useState<PendingPage[] | null>(null);
  const [gone, setGone] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pendingId) {
      setGone(true);
      return;
    }
    let live = true;
    void metaPendingAction(pendingId).then((result) => {
      if (!live) return;
      if (!result.data) {
        setGone(true);
        return;
      }
      setPages(result.data.pages);
      // Everything not already connected starts ticked: a person who owns one
      // Page should be able to press one button.
      setChosen(new Set(result.data.pages.filter((p) => !p.connected).map((p) => p.pageId)));
    });
    return () => {
      live = false;
    };
  }, [pendingId]);

  if (gone) {
    return (
      <>
        <StepHeading title="That sign-in has expired">
          Pages are held for fifteen minutes after you sign in, and only for the person who signed in.
          Sign in to Facebook again to pick them.
        </StepHeading>
        <StepActions>
          <Button type="button" onClick={() => goTo("auth", { pending: null })}>
            Sign in again
          </Button>
        </StepActions>
      </>
    );
  }

  if (!pages) return <StepLoading label="Loading your Pages" />;

  const toggle = (id: string, on: boolean) => {
    const nextSet = new Set(chosen);
    if (on) nextSet.add(id);
    else nextSet.delete(id);
    setChosen(nextSet);
  };

  const save = async () => {
    setBusy(true);
    const result = await metaChoosePagesAction(pendingId!, [...chosen]);
    setBusy(false);
    if (!result.data) {
      fail(result.error ?? "Those Pages could not be connected.");
      return;
    }
    next({ pending: null });
  };

  return (
    <>
      <StepHeading title="Choose your Pages">
        Leads from the forms on the Pages you tick arrive on the board. Aura only subscribes each Page to
        lead notifications - it posts nothing and changes nothing on Facebook.
      </StepHeading>
      <fieldset className="mt-4 space-y-2">
        <legend className="sr-only">Facebook Pages</legend>
        {pages.map((page) => (
          <Checkbox
            key={page.pageId}
            label={page.name}
            description={page.connected ? "Already sending leads to this workspace" : undefined}
            checked={page.connected || chosen.has(page.pageId)}
            disabled={page.connected}
            onChange={(e) => toggle(page.pageId, e.target.checked)}
          />
        ))}
      </fieldset>
      <StepActions>
        <Button type="button" loading={busy} disabled={chosen.size === 0} onClick={() => void save()}>
          {chosen.size <= 1 ? "Connect this Page" : `Connect ${chosen.size} Pages`}
        </Button>
      </StepActions>
    </>
  );
}
