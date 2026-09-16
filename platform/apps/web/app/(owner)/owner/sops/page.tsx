import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { SopStep } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { SopEditor } from "./sop-editor";

export const metadata: Metadata = { title: "Call procedure" };

interface SopRow {
  id: string;
  version: number;
  name: string;
  steps: SopStep[];
  is_active: boolean;
  updated_at: string;
}

interface SopsResponse {
  sops: SopRow[];
  maxSteps: number;
  defaultSteps: SopStep[];
}

/**
 * The tenant's call procedure - the steps every call is scored against.
 *
 * ── THE REDIRECT IS NOT THE SECURITY BOUNDARY ───────────────────────────────
 *
 * Every route behind this page carries `@RequireOwnerRole("owner", "manager")`,
 * read from `memberships` rather than from anything this tier sends. The
 * redirect below only spares a telecaller who follows a stale link a page of
 * empty cards - remove it and they still cannot read or write a single row.
 * Same reasoning as the team page next door.
 */
export default async function SopsPage() {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("sops");

  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const data = await ownerGet<SopsResponse>("/v1/owner/sops");
  const sops = data?.sops ?? [];
  const active = sops.find((s) => s.is_active) ?? null;

  return (
    <>
      <PageHeader title="Call procedure" context="Team" />

      <Card className="space-y-2">
        <MonoLabel>What this does</MonoLabel>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          Each step below is checked against every recorded call, and the result is shown on the
          call with the exact words the agent used. A step is only marked as followed when there is
          a quote to back it up — if the recording does not settle it, it is left out of the score
          rather than counted against the rep.
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          Write each step as something you could point at in a transcript.{" "}
          <span className="text-text">
            &ldquo;Acknowledged the objection before answering&rdquo;
          </span>{" "}
          can be judged; <span className="text-text">&ldquo;handled the objection well&rdquo;</span>{" "}
          cannot, and will produce a confident number that means nothing.
        </p>
        <p className="max-w-prose text-sm leading-relaxed text-text-muted">
          Scoring needs speaker separation on the recording, which is a per-instance setting. Calls
          are scored from the moment you save — earlier calls are not re-scored, because the audio
          would have to be transcribed a second time.
        </p>
      </Card>

      <SopEditor
        active={active}
        maxSteps={data?.maxSteps ?? 12}
        defaultSteps={data?.defaultSteps ?? []}
        canDeactivate={Boolean(active)}
      />

      {sops.length > 1 || (active && active.version > 1) ? (
        <Card className="space-y-1.5">
          <MonoLabel>Version history</MonoLabel>
          <p className="text-sm leading-relaxed text-text-muted">
            Editing saves a new version. Calls keep the version they were scored under, so an old
            review always shows the wording it was actually judged against.
          </p>
          <ul className="space-y-1 pt-1 text-sm text-text-muted">
            {sops.map((s) => (
              <li key={s.id}>
                <span className="text-text">{s.name}</span> — v{s.version}
                {s.is_active ? " · active" : ""}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
