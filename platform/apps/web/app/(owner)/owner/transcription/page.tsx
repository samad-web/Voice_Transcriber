import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { TranscriptionClient } from "./transcription-client";

export const metadata: Metadata = { title: "Transcription - Aura" };

/** The slice of `GET /v1/org` this page reads. Snake_case, straight from the row. */
interface OrgTranscription {
  asr_language: string | null;
  asr_mode: string | null;
  vocabulary: string[] | null;
  transcription_enabled: boolean | null;
}

/**
 * The customer's own transcription settings.
 *
 * The vocabulary is the reason this page exists on the client side at all: the
 * provider cannot know that this tenant sells "RD Interlock Bricks" in Cheyyur,
 * and the list goes stale the week after onboarding. Everything downstream that
 * a customer actually reads - call summaries, extracted fields, the lead title
 * on a board card - spells names out of this list, so a stale glossary is
 * visible in the product rather than buried in a config table.
 *
 * ── THE REDIRECT IS NOT THE BOUNDARY, AND HERE THAT IS UNUSUAL ────────────
 *
 * On most owner pages the API refuses a persona the nav never offered the page
 * to. Not this one: `PATCH /v1/org/policy` is gated on `principal.role`, which
 * is the literal "platform_admin" for every admin-key caller - i.e. for every
 * owner-console request, whoever is signed in. The persona check that actually
 * holds is the one inside `updateTranscriptionAction`; this redirect only saves
 * a telecaller from a page of controls that would refuse them on save. See
 * that action's header before moving either check.
 */
export default async function TranscriptionPage() {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const org = await ownerGet<OrgTranscription>("/v1/org");

  return (
    <>
      <PageHeader title="Transcription" context="Settings" />

      {!org ? (
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      ) : (
        <>
          {org.transcription_enabled === false ? (
            // Worth saying outright rather than letting somebody tune a
            // glossary that nothing will read. The switch is the provider's
            // (migration 0014), so the fix is a conversation, not a control.
            <Card className="space-y-2">
              <MonoLabel>Transcription is off for this instance</MonoLabel>
              <p className="text-sm leading-relaxed text-text-muted">
                Calls are still recorded and stored, but they are not transcribed
                or analysed, so nothing below takes effect yet. Ask your provider
                to turn transcription on.
              </p>
            </Card>
          ) : null}

          <TranscriptionClient
            asrLanguage={org.asr_language}
            asrMode={org.asr_mode}
            vocabulary={org.vocabulary ?? []}
            // Managers read the page; only an Owner or Manager may save, and
            // both are already the only personas that reach it. Passed
            // explicitly anyway so the component never has to infer it.
            canEdit={role === "owner" || role === "manager"}
          />
        </>
      )}
    </>
  );
}
