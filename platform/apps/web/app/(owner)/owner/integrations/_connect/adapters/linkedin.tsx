"use client";

import { useEffect, useState } from "react";
import { CONNECT_ERRORS } from "@aura/shared";
import { Button, Radio, RadioGroup } from "@aura/ui";
import { startLinkedInConnectAction } from "../../../lead-sources/actions";
import { startOAuthRedirect } from "../../../lib/oauth-redirect";
import { linkedinAccountsAction, linkedinChooseAccountAction, type LinkedInAdAccount } from "../../actions";
import { StepActions, StepHeading, StepLoading } from "../step-heading";
import type { StepProps } from "../types";

/**
 * LinkedIn Lead Gen Forms: sign in, then choose the ad account.
 *
 * The API had the choose route all along (`/linkedin/connections/:id/account`)
 * and nothing in the console called it: the callback left a `pending:` row,
 * rendered JSON, and the Lead sources page said "pick an ad account" with no
 * way to. This is that missing step.
 */
export function LinkedInAuth({ fail }: StepProps) {
  const [busy, setBusy] = useState(false);

  const begin = async () => {
    setBusy(true);
    const result = await startLinkedInConnectAction();
    if ("notConfigured" in result) {
      fail(CONNECT_ERRORS.not_configured);
      setBusy(false);
      return;
    }
    const error = startOAuthRedirect(
      { authorizeUrl: result.data?.authorizeUrl, error: result.error },
      "Could not start the LinkedIn sign-in.",
    );
    if (error) {
      fail(error);
      setBusy(false);
    }
  };

  return (
    <>
      <StepHeading title="Sign in to LinkedIn">
        Sign in with a LinkedIn account that can see the ad account running your Lead Gen Forms. You&apos;ll
        choose the ad account when you come back.
      </StepHeading>
      <StepActions>
        <Button type="button" loading={busy} onClick={() => void begin()}>
          Continue to LinkedIn
        </Button>
      </StepActions>
    </>
  );
}

export function LinkedInChoose({ params, next, goTo, fail }: StepProps) {
  const connectionId = params.pending;
  const [accounts, setAccounts] = useState<LinkedInAdAccount[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!connectionId) {
      setProblem("That sign-in could not be found.");
      return;
    }
    let live = true;
    void linkedinAccountsAction(connectionId).then((result) => {
      if (!live) return;
      if (!result.data) {
        setProblem(result.error ?? "LinkedIn did not list your ad accounts.");
        return;
      }
      setAccounts(result.data.accounts);
      if (result.data.accounts.length === 1) setChosen(result.data.accounts[0]!.urn);
    });
    return () => {
      live = false;
    };
  }, [connectionId]);

  if (problem || (accounts && accounts.length === 0)) {
    return (
      <>
        <StepHeading title={problem ? "LinkedIn did not answer" : "No ad accounts on that login"}>
          {problem ?? CONNECT_ERRORS.no_accounts} Sign in again with the account that runs your Lead Gen
          Forms.
        </StepHeading>
        <StepActions>
          <Button type="button" onClick={() => goTo("auth", { pending: null })}>
            Sign in again
          </Button>
        </StepActions>
      </>
    );
  }

  if (!accounts) return <StepLoading label="Loading your ad accounts" />;

  const save = async () => {
    const account = accounts.find((a) => a.urn === chosen);
    if (!account || !connectionId) return;
    setBusy(true);
    const result = await linkedinChooseAccountAction(connectionId, account);
    setBusy(false);
    if (!result.data) {
      fail(result.error ?? "That ad account could not be saved.");
      return;
    }
    next({ pending: null });
  };

  return (
    <>
      <StepHeading title="Choose the ad account">
        Aura reads new Lead Gen Form responses from this account every few minutes.
      </StepHeading>
      <div className="mt-4">
        <RadioGroup legend="Ad account">
          {accounts.map((account) => (
            <Radio
              key={account.urn}
              name="linkedin-account"
              value={account.urn}
              checked={chosen === account.urn}
              onChange={() => setChosen(account.urn)}
              label={account.name ?? account.urn}
              description={account.name ? account.urn : undefined}
            />
          ))}
        </RadioGroup>
      </div>
      <StepActions>
        <Button type="button" loading={busy} disabled={!chosen} onClick={() => void save()}>
          Use this account
        </Button>
      </StepActions>
    </>
  );
}
