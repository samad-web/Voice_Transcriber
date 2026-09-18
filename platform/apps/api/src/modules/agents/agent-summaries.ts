import type { AgentKind } from "@aura/shared";

/** One stored version, as `AgentsService.list` selects it. */
export interface AgentVersionRow {
  id: string;
  version: number;
  kind: AgentKind;
  name: string;
  purpose: string;
  workspace_id: string | null;
  system_prompt: string;
  field_schema: { fields?: unknown[] } | null;
  lead_rules: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  labels: unknown;
  is_active: boolean;
  archived_at: string | null;
  created_at: string;
}

/** An agent as the studio's overview shows it - one card per id, not per version. */
export interface AgentSummary {
  id: string;
  kind: AgentKind;
  /** The LATEST version's name and purpose - what the owner last saved. */
  name: string;
  purpose: string;
  workspaceId: string | null;
  latestVersion: number;
  /** Null when no version of this agent is switched on. */
  activeVersion: number | null;
  versionCount: number;
  fieldCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Collapse version rows into one summary per agent.
 *
 * `activeVersion` is reported separately from `latestVersion` because they
 * differ whenever somebody saved a change without switching it on, or rolled
 * back - and "the agent you are looking at is not the one running" is exactly
 * what the card has to make visible.
 *
 * Sorted with running agents first, then by name, so the studio opens on what
 * is actually reading calls today.
 */
export function summarizeAgents(rows: AgentVersionRow[]): AgentSummary[] {
  const byId = new Map<string, AgentVersionRow[]>();
  for (const row of rows) {
    const list = byId.get(row.id) ?? [];
    list.push(row);
    byId.set(row.id, list);
  }

  const summaries: AgentSummary[] = [];
  for (const [id, versions] of byId) {
    versions.sort((a, b) => b.version - a.version);
    const latest = versions[0]!;
    const active = versions.find((v) => v.is_active) ?? null;
    summaries.push({
      id,
      kind: latest.kind,
      name: latest.name,
      purpose: latest.purpose,
      workspaceId: latest.workspace_id,
      latestVersion: latest.version,
      activeVersion: active?.version ?? null,
      versionCount: versions.length,
      fieldCount: Array.isArray(latest.field_schema?.fields)
        ? latest.field_schema.fields.length
        : 0,
      createdAt: versions[versions.length - 1]!.created_at,
      updatedAt: latest.created_at,
    });
  }

  return summaries.sort((a, b) => {
    const running = Number(b.activeVersion !== null) - Number(a.activeVersion !== null);
    return running !== 0 ? running : a.name.localeCompare(b.name);
  });
}
