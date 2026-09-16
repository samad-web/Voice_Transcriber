"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus } from "lucide-react";
import {
  ORG_MODULES,
  WHATSAPP_PROVIDERS,
  type OrgModule,
  type WhatsAppProvider,
} from "@aura/shared";
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  FormField,
  Input,
  MonoLabel,
  RowHint,
  Select,
  StatusChip,
  useAlert,
  useToast,
} from "@aura/ui";
import { CopyValue } from "@/app/(platform)/instances/[id]/copy-value";
import {
  provisionTenantAction,
  updateProvisioningAction,
  type ProvisionResult,
} from "./actions";

export interface TenantProvisioning {
  id: string;
  name: string;
  enabled_modules: string[];
  whatsapp_provider: string;
}

/**
 * The provisioning surface: create an environment, and control what each
 * existing one has.
 *
 * ── WHY IT LIVES IN /admin AND NOT /instances ───────────────────────────────
 *
 * The operator console's instance page already edits one tenant's settings, and
 * three of these toggles started life there as individual cards. They are moved
 * rather than duplicated because the question this answers is comparative:
 * "which of my clients has the report builder", "who is still on manual
 * WhatsApp". That question cannot be asked one instance page at a time, and an
 * operator answering it by opening fourteen tabs will answer it wrong.
 *
 * ── WHY MODULES AND FEATURES ARE ONE FORM ───────────────────────────────────
 *
 * Because they interact. Turning the CRM off drops fourteen features with it,
 * and the API reconciles exactly that on write - so a UI that saved them
 * separately would show a state the server had already refused. The grid below
 * therefore greys a feature whose module is off rather than letting it be
 * ticked, and the Save sends both.
 */
export function Provisioning({ tenants }: { tenants: TenantProvisioning[] }) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<TenantProvisioning | null>(null);

  return (
    <Card elevated className="overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-bg-subtle px-5 py-3.5">
        <h4 className="text-sm font-semibold text-text">Provisioning</h4>
        <span className="text-xs text-text-muted">modules and WhatsApp per client</span>
        <Button
          type="button"
          size="sm"
          className="ml-auto"
          onClick={() => setCreating(true)}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          New environment
        </Button>
      </div>

      {tenants.length === 0 ? (
        <p className="py-10 text-center text-sm text-text-muted">
          No tenants provisioned yet.
        </p>
      ) : (
        <div tabIndex={0} role="region" aria-label="Provisioning" className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <caption className="sr-only">Per-tenant modules and WhatsApp provider</caption>
            <thead className="bg-bg-subtle">
              <tr>
                {["Tenant", "Modules", "WhatsApp", ""].map((h) => (
                  <th
                    key={h}
                    scope="col"
                    className="border-b border-border px-4 py-2.5 text-xs font-medium text-text-muted"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tenants.map((t) => {
                const provider = WHATSAPP_PROVIDERS.find((p) => p.id === t.whatsapp_provider);
                return (
                  <tr key={t.id} className="transition-colors duration-150 hover:bg-surface-hover">
                    <td className="px-4 py-3 align-middle font-medium text-text">{t.name}</td>
                    <td className="px-4 py-3 align-middle">
                      <div className="flex flex-wrap gap-1">
                        {ORG_MODULES.filter((m) => t.enabled_modules.includes(m.id)).map((m) => (
                          <StatusChip key={m.id} tone="muted">
                            {m.label}
                          </StatusChip>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-middle">
                      {/* Neutral, always. "Which provider" is a category, not
                          one of the four states the console paints - see
                          @aura/ui's state.tsx. */}
                      <StatusChip tone={t.whatsapp_provider === "none" ? "outline" : "muted"}>
                        {provider?.label ?? t.whatsapp_provider}
                      </StatusChip>
                    </td>
                    <td className="px-4 py-3 text-right align-middle">
                      <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(t)}>
                        Configure
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating ? <CreateEnvironment onClose={() => setCreating(false)} /> : null}
      {editing ? <ConfigureTenant tenant={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

/**
 * The module + feature grid, shared by create and configure.
 *
 * A feature whose module is off is rendered DISABLED and unticked rather than
 * hidden. Hiding it would make the CRM checkbox silently change the length of
 * the list under it, which reads as the form breaking; disabling it shows what
 * turning the module on would give them, which is the question an operator is
 * usually answering when they hover over it.
 */
function ModuleFeatureGrid({
  modules,
  onModules,
}: {
  modules: OrgModule[];
  onModules: (next: OrgModule[]) => void;
}) {
  const toggleModule = (id: OrgModule, on: boolean) => {
    // 'aura' is not optional: every tenant provisioned here gets an instance,
    // a workspace and devices, so an org without it would be describing itself
    // falsely. The API forces it too - this just stops offering the lie.
    if (id === "aura") return;
    onModules(on ? [...modules, id] : modules.filter((m) => m !== id));
  };

  return (
    <div className="space-y-5">
      {ORG_MODULES.map((module) => {
        const on = modules.includes(module.id);
        return (
          <div key={module.id}>
            <Checkbox
              checked={on}
              disabled={module.id === "aura"}
              onChange={(e) => toggleModule(module.id, e.target.checked)}
              label={module.label}
              description={
                module.id === "aura"
                  ? "Always on - every environment gets an instance, a workspace and devices."
                  : module.blurb
              }
            />
          </div>
        );
      })}

      <RowHint kind="blocked">
        A module is the commercial entitlement - what the client bought, and the boundary the
        API enforces on every request. Which PAGES they see inside it is their own decision,
        made on their console&rsquo;s Features page and stored per-org (migration 0101). Turning a
        module off here takes its features with it; turning one on offers them, switched to
        whatever the catalogue says a new tenant should get.
      </RowHint>
    </div>
  );
}

function WhatsAppProviderField({
  value,
  onChange,
}: {
  value: WhatsAppProvider;
  onChange: (next: WhatsAppProvider) => void;
}) {
  const spec = WHATSAPP_PROVIDERS.find((p) => p.id === value);
  return (
    <FormField label="WhatsApp provider" name="whatsappProvider" hint={spec?.blurb}>
      <Select value={value} onChange={(e) => onChange(e.target.value as WhatsAppProvider)}>
        {WHATSAPP_PROVIDERS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
    </FormField>
  );
}

function CreateEnvironment({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("Default");
  const [region, setRegion] = useState("ap-south-1");
  const [modules, setModules] = useState<OrgModule[]>(["aura", "crm"]);
  const [whatsappProvider, setWhatsappProvider] = useState<WhatsAppProvider>("none");
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const submit = () =>
    startTransition(async () => {
      const res = await provisionTenantAction({
        name: name.trim(),
        workspaceName: workspaceName.trim(),
        region: region.trim() || undefined,
        modules,
        whatsappProvider,
      });
      if (res.error) {
        await alert({ title: "Couldn't provision the environment", body: res.error, tone: "danger" });
        return;
      }
      // NOT closed on success. The enrollment key is shown exactly once and is
      // unrecoverable afterwards - only its hash is stored - so the dialog
      // becomes the receipt rather than vanishing with the one thing in it
      // that cannot be looked up again.
      setResult(res);
      toast("Environment provisioned");
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={result ? "Environment provisioned" : "New CRM environment"}
      dismissOnBackdrop={!result}
      footer={
        result ? (
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" loading={pending} disabled={!name.trim()} onClick={submit}>
              Provision
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <p className="text-sm text-text-muted">
            The enrollment key below is shown once and cannot be retrieved again - only its hash is
            stored. Give it to whoever is setting up the first handset.
          </p>
          <div>
            <MonoLabel>Enrollment key</MonoLabel>
            <CopyValue value={result.enrollmentKey ?? ""} label="enrollment key" className="mt-1" />
          </div>
          <div>
            <MonoLabel>Organization id</MonoLabel>
            <CopyValue value={result.orgId ?? ""} label="organization id" className="mt-1" />
          </div>
          <RowHint kind="action">
            Expires {result.expiresAt ? new Date(result.expiresAt).toLocaleString() : "shortly"}.
            Issue another from the instance page if it lapses before anyone enrols.
          </RowHint>
        </div>
      ) : (
        <div className="space-y-4">
          <FormField label="Client name" name="name" hint="What this environment is called everywhere.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Interiors" />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Workspace" name="workspaceName">
              <Input value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} />
            </FormField>
            <FormField label="Region" name="region">
              <Input value={region} onChange={(e) => setRegion(e.target.value)} />
            </FormField>
          </div>

          <WhatsAppProviderField value={whatsappProvider} onChange={setWhatsappProvider} />

          <div>
            <MonoLabel>Modules</MonoLabel>
            <div className="mt-2">
              <ModuleFeatureGrid modules={modules} onModules={setModules} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ConfigureTenant({
  tenant,
  onClose,
}: {
  tenant: TenantProvisioning;
  onClose: () => void;
}) {
  const [modules, setModules] = useState<OrgModule[]>(tenant.enabled_modules as OrgModule[]);
  const [whatsappProvider, setWhatsappProvider] = useState<WhatsAppProvider>(
    (tenant.whatsapp_provider as WhatsAppProvider) ?? "none",
  );
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = () =>
    startTransition(async () => {
      const res = await updateProvisioningAction(tenant.id, {
        modules,
        whatsappProvider,
      });
      if (res.error) {
        await alert({ title: "Couldn't save", body: res.error, tone: "danger" });
        return;
      }
      toast(`${tenant.name} updated`);
      onClose();
    });

  return (
    <Dialog
      open
      onClose={onClose}
      title={tenant.name}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" loading={pending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <WhatsAppProviderField value={whatsappProvider} onChange={setWhatsappProvider} />
        {whatsappProvider === "wasi" ? (
          <RowHint kind="action">
            The client&rsquo;s WhatsApp Setup page will offer an in-app Facebook connect. It becomes
            live once this environment has a Wasi Hub API key and client id on its WhatsApp channel
            - Wasi issues those per client, and the connect call authenticates with them.
          </RowHint>
        ) : null}
        <div>
          <MonoLabel>Modules</MonoLabel>
          <div className="mt-2">
            <ModuleFeatureGrid modules={modules} onModules={setModules} />
          </div>
        </div>
      </div>
    </Dialog>
  );
}

