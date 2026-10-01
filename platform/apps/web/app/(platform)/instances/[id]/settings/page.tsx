import { operatorGate } from "@/lib/operator-gate";
import { googleSignInEnabled } from "@/lib/supabase/google";
import { AppLockForm } from "../app-lock-form";
import { AsrSettings } from "../asr-settings";
import { CallIntelToggle } from "../call-intel-toggle";
import { CrmModuleToggle } from "../crm-module-toggle";
import { DeleteInstance } from "../delete-instance";
import { ErasureTool } from "../erasure-tool";
import { OwnerAccounts } from "../owner-accounts";
import { PolicyForm } from "../policy-form";
import { QualificationToggle } from "../qualification-toggle";
import { TranscriptionToggle } from "../transcription-toggle";
import { loadInstances, loadInvites, loadOrg, loadOwners } from "../instance-data";
import { Section } from "../instance-ui";

/**
 * What we have configured for this customer: their modules, how their calls are
 * captured and kept, who can sign in, and the two irreversible tools.
 *
 * Every editor here keeps its edits local until Save is pressed. That used to
 * matter a great deal: this was one of five always-mounted panels in a
 * client-side tab strip, and the strip used `hidden` rather than a conditional
 * render precisely so that switching tab could not throw a half-typed glossary
 * away. Each panel is its own route now (doc 34 Part B), so the browser owns
 * that question in the ordinary way - navigating away really does discard an
 * unsaved edit, which is what a person already expects a page to do.
 */
export default async function InstanceSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const [org, instances, ownerData] = await Promise.all([
    loadOrg(orgId),
    loadInstances(orgId),
    loadOwners(orgId),
  ]);
  // Owner invites by link (0137) - SECONDARY: a failure here hides the pending
  // list and the invite option, never the rest of the page.
  const [inviteData, googleEnabled] = await Promise.all([loadInvites(orgId), googleSignInEnabled()]);
  const owners = ownerData.owners;

  return (
    <>
      <Section
        title="Modules"
        description="What this customer's own console can see. Each switch is scoped to this tenant."
      >
        {/* Four on/off cards, 2x2, so the whole module state is one glance.

            The grid stretches (no `items-start`) and ModuleCard pins each
            button to a footer, so cards in a row share a height and their
            headers and buttons line up.

            The rows are paired by kind, which also pairs them by height.
            Row 1 is what runs on the tenant's data - paid ASR, and WhatsApp
            text sent to an AI provider - and both are a bare switch. Row 2 is
            what the tenant's own console shows, and both carry a panel about
            which of their accounts it reaches. Pairing a bare switch with a
            panel card is what left a card-sized hole under the short one. */}
        <div className="grid gap-5 lg:grid-cols-2">
          <TranscriptionToggle
            orgId={orgId}
            enabled={org.transcription_enabled !== false}
            instanceName={org.name}
          />
          <QualificationToggle
            orgId={orgId}
            enabled={org.whatsapp_qualification_enabled === true}
            retentionDays={org.qualification_retention_days ?? 90}
            instanceName={org.name}
          />
          <CallIntelToggle
            orgId={orgId}
            enabled={org.enabled_modules.includes("call_intel")}
            instanceName={org.name}
            owners={owners}
            modules={org.enabled_modules}
          />
          <CrmModuleToggle
            orgId={orgId}
            enabled={org.enabled_modules.includes("crm")}
            instanceName={org.name}
            owners={owners}
            modules={org.enabled_modules}
          />
        </div>
      </Section>

      <Section
        title="Capture & retention"
        description="How this customer's calls are transcribed, how long they are kept, and who can open the app."
      >
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <AsrSettings
            orgId={orgId}
            asrLanguage={org.asr_language ?? null}
            asrMode={org.asr_mode ?? null}
            vocabulary={org.vocabulary ?? []}
          />
          <div className="flex flex-col gap-5">
            <PolicyForm orgId={orgId} initial={org} />
            <AppLockForm orgId={orgId} enabled={org.app_lock_enabled} />
          </div>
        </div>
      </Section>

      <Section
        title="Owner sign-ins"
        description="Sign-ins scoped to this instance only - never the operator console."
      >
        <OwnerAccounts
          orgId={orgId}
          workspace={org.name}
          owners={owners}
          authConfigured={ownerData.authConfigured}
          invites={inviteData?.invites ?? []}
          inviteByLink={{
            googleEnabled: googleEnabled && Boolean(inviteData?.authConfigured),
            mailConfigured: Boolean(inviteData?.mailConfigured),
          }}
        />
      </Section>

      <Section
        title="Danger zone"
        tone="danger"
        description="Irreversible. Both of these destroy customer data that no backup on this side restores."
      >
        <div className="grid items-start gap-5 lg:grid-cols-2">
          <ErasureTool orgId={orgId} />
          {instances.map((inst) => (
            <DeleteInstance
              key={inst.id}
              orgId={orgId}
              instanceId={inst.id}
              instanceName={inst.name}
            />
          ))}
        </div>
      </Section>
    </>
  );
}
