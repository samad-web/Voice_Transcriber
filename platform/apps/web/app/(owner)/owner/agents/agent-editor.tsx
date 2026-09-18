"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AGENT_KIND_SPECS, AgentDefinition, type AgentDefinitionInput } from "@aura/shared";
import {
  Button,
  Card,
  Input,
  Label,
  MonoLabel,
  Select,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import {
  definitionFrom,
  type EditorField,
  type EditorState,
  editorStateFrom,
  issueMessages,
} from "@/lib/agent-studio";
import { createAgentAction, generateAgentAction, saveAgentVersionAction } from "./actions";
import { DrafterTestPanel } from "./drafter-test-panel";
import { ExtractorTestPanel } from "./extractor-test-panel";
import { FieldList, TEXTAREA_CLASS } from "./field-list";
import { LeadRulesPanel } from "./lead-rules-panel";
import { QualifierTestPanel } from "./qualifier-test-panel";
import { ReplySettings } from "./reply-settings";

const INSTRUCTION_HINTS: Record<
  EditorState["kind"],
  { label: string; placeholder: string; help: string }
> = {
  call_extractor: {
    label: "Instructions",
    placeholder:
      "You read sales calls for [your business]. Base every value strictly on what was said; if something was not said, leave it empty.",
    help: "Say who is on the call and what your business sells. The more specific, the fewer wrong answers.",
  },
  chat_qualifier: {
    label: "Your business, and what counts as a real enquiry",
    placeholder:
      "We sell [products] in [cities]. A real enquiry asks about price, stock, a quote or a visit. Job seekers and suppliers are not enquiries.",
    help: "This is added to the built-in rules, which still decide what is personal, spam or a wrong number - those can't be overridden.",
  },
  reply_drafter: {
    label: "How replies should read",
    placeholder:
      "Thank them, recap what they want in one line, and propose one next step. Never promise a price or date that wasn't agreed.",
    help: "What to say, what to offer, and what never to promise. Your team always reads and edits the draft before sending.",
  },
};

/**
 * Create or edit one agent.
 *
 * Every save goes through `AgentDefinition` in the browser first - the API
 * validates again with the same schema, so this is the sentence, not the gate.
 * An edit is saved as a NEW version; nothing a past call was read with is ever
 * rewritten (see agents.service.ts).
 */
export function AgentEditor({
  mode,
  agentId,
  initial,
  savedKeys,
  latestVersion,
  activeVersion,
  workspaces,
}: {
  mode: "create" | "edit";
  agentId?: string;
  initial: AgentDefinitionInput;
  /** True for a stored agent, whose detail keys are frozen. */
  savedKeys: boolean;
  latestVersion?: number;
  activeVersion?: number | null;
  /** Offered only when creating a call extractor in an org with more than one. */
  workspaces: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();

  const [state, setState] = useState<EditorState>(() => editorStateFrom(initial, { savedKeys }));
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState<"saving" | "drafting" | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  const spec = AGENT_KIND_SPECS[state.kind];
  const hints = INSTRUCTION_HINTS[state.kind];
  const set = (patch: Partial<EditorState>) => setState((prev) => ({ ...prev, ...patch }));

  const draft = async () => {
    if (!description.trim()) return;
    const hasContent = state.instructions.trim() || state.fields.length > 0;
    if (
      hasContent &&
      !(await confirm({
        title: "Replace what is in the form?",
        body: "The AI's draft replaces the instructions and details below. Nothing is saved until you press Save.",
        confirmLabel: "Replace",
      }))
    ) {
      return;
    }
    setBusy("drafting");
    const res = await generateAgentAction({
      kind: state.kind,
      description,
      baseAgentId: mode === "edit" ? agentId : undefined,
    });
    setBusy(null);
    if (res.error || !res.draft) {
      await alert({ title: "Couldn't draft the agent", body: res.error, tone: "danger" });
      return;
    }
    const drafted = editorStateFrom(
      {
        kind: state.kind,
        name: res.draft.name,
        instructions: res.draft.instructions,
        fields: res.draft.fields,
      } as AgentDefinitionInput,
      { savedKeys: false },
    );
    // A drafted detail whose key matches one already saved IS that detail -
    // keep it attached to its history instead of minting `budget_2`.
    const savedByKey = new Map(state.fields.flatMap((f) => (f.key ? [[f.key, f] as const] : [])));
    const fields: EditorField[] = drafted.fields.map((f, i) => {
      const draftedKey = res.draft!.fields[i]?.key;
      const saved = draftedKey ? savedByKey.get(draftedKey) : undefined;
      return saved ? { ...f, uid: saved.uid, key: saved.key, name: saved.name } : f;
    });
    setState((prev) => ({
      ...prev,
      name: prev.name.trim() ? prev.name : drafted.name,
      instructions: drafted.instructions,
      fields: prev.kind === "reply_drafter" ? [] : fields,
      // Rules pointed at details that may no longer exist; the rules panel
      // re-derives from uids, and anything orphaned is dropped at save.
    }));
    toast("Draft filled in - review it, then test and save.");
  };

  const save = async (activate: boolean) => {
    const definition = definitionFrom(state);
    const parsed = AgentDefinition.safeParse(definition);
    if (!parsed.success) {
      setProblems(issueMessages(parsed.error.issues, state));
      return;
    }
    setProblems([]);

    if (activate && mode === "edit" && activeVersion != null) {
      const ok = await confirm({
        title: `Switch to version ${(latestVersion ?? 0) + 1}?`,
        body: `Version ${activeVersion} stops being used for new ${state.kind === "reply_drafter" ? "drafts" : "work"}. You can switch back from the version list.`,
        confirmLabel: "Save and switch on",
      });
      if (!ok) return;
    }

    setBusy("saving");
    if (mode === "create") {
      const res = await createAgentAction({
        definition,
        workspaceId: state.kind === "call_extractor" && workspaces.length > 1 ? workspaceId : null,
        activate,
      });
      setBusy(null);
      if (res.error || !res.id) {
        await alert({ title: "Couldn't save the agent", body: res.error, tone: "danger" });
        return;
      }
      toast(
        activate ? "Agent saved and switched on" : "Agent saved - switch it on when you're ready",
      );
      router.push(`/owner/agents/${res.id}`);
      return;
    }

    const res = await saveAgentVersionAction({ agentId: agentId!, definition, activate });
    setBusy(null);
    if (res.error) {
      await alert({ title: "Couldn't save the change", body: res.error, tone: "danger" });
      return;
    }
    toast(`Saved as version ${res.version}${activate ? " and switched on" : ""}`);
    router.replace(`/owner/agents/${agentId}`);
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <MonoLabel>About this agent</MonoLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="agent-name">Name</Label>
            <Input
              id="agent-name"
              maxLength={120}
              value={state.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={`e.g. ${spec.label === "Reply drafter" ? "Friendly follow-up" : "Sales enquiry"}`}
            />
          </div>
          {mode === "create" && state.kind === "call_extractor" && workspaces.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="agent-workspace">Reads calls from</Label>
              <Select
                id="agent-workspace"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="agent-purpose">What it's for</Label>
          <Input
            id="agent-purpose"
            maxLength={1000}
            value={state.purpose}
            onChange={(e) => set({ purpose: e.target.value })}
            placeholder="One line your team will recognise"
          />
        </div>
      </Card>

      <Card className="space-y-3">
        <MonoLabel>Describe it and let AI draft it</MonoLabel>
        <p className="max-w-prose text-sm text-text-muted">
          {mode === "edit"
            ? "Describe a change in plain words - the draft starts from this agent's latest version."
            : "Describe what you need in plain words. You'll review everything before it is saved."}
        </p>
        <textarea
          aria-label="Describe the agent"
          rows={3}
          maxLength={2000}
          className={TEXTAREA_CLASS}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={
            state.kind === "reply_drafter"
              ? "e.g. A short WhatsApp follow-up in Tamil or English that invites them for a site visit this weekend"
              : state.kind === "chat_qualifier"
                ? "e.g. We sell interlock bricks in Chennai. Find people asking for prices or bulk quantities, and note the quantity and site location"
                : "e.g. For brick sales calls, note the brick type, quantity, site location and budget, and whether they want a quotation"
          }
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => void draft()}
          disabled={busy !== null || !description.trim()}
        >
          {busy === "drafting" ? "Drafting…" : "Draft it for me"}
        </Button>
      </Card>

      <Card className="space-y-2">
        <Label htmlFor="agent-instructions">{hints.label}</Label>
        <p className="max-w-prose text-xs text-text-muted">{hints.help}</p>
        <textarea
          id="agent-instructions"
          rows={6}
          maxLength={spec.maxInstructions}
          className={TEXTAREA_CLASS}
          value={state.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder={hints.placeholder}
        />
        <p className="text-right text-xs text-text-subtle">
          {state.instructions.length.toLocaleString("en-IN")} /{" "}
          {spec.maxInstructions.toLocaleString("en-IN")}
        </p>
      </Card>

      {spec.hasFields ? (
        <Card className="space-y-3">
          <MonoLabel>
            {state.kind === "chat_qualifier" ? "Extra details to note" : "Details to pull out"}
          </MonoLabel>
          {state.kind === "chat_qualifier" ? (
            <p className="max-w-prose text-sm text-text-muted">
              Name, email, company and budget are already picked out for every enquiry. Add anything
              else your team needs - they appear on the review card before anyone approves the lead.
            </p>
          ) : null}
          <FieldList
            fields={state.fields}
            maxFields={spec.maxFields}
            noun={state.kind === "chat_qualifier" ? "conversation" : "call"}
            onChange={(fields) => set({ fields })}
          />
        </Card>
      ) : null}

      {state.kind === "call_extractor" ? (
        <Card className="space-y-3">
          <MonoLabel>When a call becomes a lead</MonoLabel>
          <LeadRulesPanel state={state} onChange={(leadRules) => set({ leadRules })} />
        </Card>
      ) : null}

      {state.kind === "reply_drafter" ? (
        <Card className="space-y-3">
          <MonoLabel>Style</MonoLabel>
          <ReplySettings
            config={state.replyConfig}
            onChange={(replyConfig) => set({ replyConfig })}
          />
        </Card>
      ) : null}

      <Card className="space-y-3">
        <MonoLabel>Test before you save</MonoLabel>
        {state.kind === "call_extractor" ? (
          <ExtractorTestPanel state={state} />
        ) : state.kind === "chat_qualifier" ? (
          <QualifierTestPanel state={state} />
        ) : (
          <DrafterTestPanel state={state} />
        )}
      </Card>

      <div className="sticky bottom-0 z-10 -mx-1 space-y-2 border-t border-border bg-bg/95 px-1 py-3 backdrop-blur">
        {problems.length > 0 ? (
          <ul role="alert" className="space-y-1 text-sm text-text">
            {problems.map((p) => (
              <li key={p}>• {p}</li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={() => void save(true)} disabled={busy !== null}>
            {busy === "saving" ? "Saving…" : "Save and switch on"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void save(false)}
            disabled={busy !== null}
          >
            {mode === "edit"
              ? `Save as version ${(latestVersion ?? 0) + 1}`
              : "Save without switching on"}
          </Button>
          <span className="text-xs text-text-muted">
            {spec.kind === "reply_drafter"
              ? "Only one reply drafter is used at a time."
              : spec.kind === "chat_qualifier"
                ? "Only one chat qualifier runs at a time."
                : "Only one call extractor runs per workspace. Switching this on replaces the one running."}
          </span>
        </div>
      </div>
    </div>
  );
}
