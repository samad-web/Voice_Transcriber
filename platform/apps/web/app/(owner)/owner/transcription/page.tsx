import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Card, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerTry, requireFeature } from "@/lib/owner-context";
import { TranscriptionClient } from "./transcription-client";

export const metadata: Metadata = { title: "Transcripts" };

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
 * ── THE REDIRECT IS NOT THE BOUNDARY ──────────────────────────────────────
 *
 * The API is: since doc 31 §2 X8, `PATCH /v1/org/policy` resolves the
 * persona from memberships and takes only the three transcription fields
 * from a console person. This redirect only saves a telecaller from a page of
 * controls that would refuse them on save; `updateTranscriptionAction` repeats
 * the check so the refusal is a sentence rather than a 403.
 */
export default async function TranscriptionPage() {
  // Off means off, not merely hidden - see requireFeature.
  await requireFeature("/owner/transcription");
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const orgResult = await ownerTry<OrgTranscription>("/v1/org");

  return (
    <>
      <PageHeader title="Transcripts" context="Settings" />

      {!orgResult.ok ? (
        <LoadFailure what="transcription settings" failure={orgResult} />
      ) : (
        <>
          {orgResult.data.transcription_enabled === false ? (
            // Worth saying outright rather than letting somebody tune a
            // glossary that nothing will read. The switch is the provider's
            // (migration 0014), so the fix is a conversation, not a control.
            <Card className="space-y-2">
              <MonoLabel>Transcription is off for this instance</MonoLabel>
              <p className="text-sm leading-relaxed text-text-muted">
                Calls are still recorded and stored, but they are not transcribed or analysed, so
                nothing below takes effect yet. Ask your provider to turn transcription on.
              </p>
            </Card>
          ) : null}

          <TranscriptionClient
            asrLanguage={orgResult.data.asr_language}
            asrMode={orgResult.data.asr_mode}
            vocabulary={orgResult.data.vocabulary ?? []}
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
