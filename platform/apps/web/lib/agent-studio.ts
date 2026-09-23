import {
  type AgentDefinitionInput,
  type AgentKind,
  agentFieldKey,
  DEFAULT_TIME_ZONE,
  type ExtractionField,
  type ExtractionFieldType,
  formatDayMonth,
  formatTime,
  LeadRules,
  parseReplyDrafterConfig,
  type ReplyDrafterConfig,
} from "@aura/shared";

/**
 * The studio editor's working state, and the two conversions it needs:
 * a stored or template definition INTO the form, and the form back OUT to an
 * `AgentDefinition` the API validates.
 *
 * Pure on purpose - the editor component is large and the rules below are the
 * part that can quietly lose data, so they are here where a test can reach
 * them.
 *
 * ── WHY A DETAIL HAS A `uid` AS WELL AS A `key` ─────────────────────────────
 *
 * A saved detail's `key` is what every call's facts are stored under, so it
 * never changes (agentFieldKey's comment). A NEW detail has no key yet: the
 * owner is still typing its name, and minting a key per keystroke would make
 * the lead rules below point at a key that no longer exists by the time they
 * save. So the form refers to details by a `uid` that is stable for the life
 * of the page, and keys are minted once, at the moment the definition is built.
 */

export interface EditorField {
  uid: string;
  /** The stored key. Null while the detail is new. */
  key: string | null;
  /** What the owner calls it. For a saved detail this is derived from the key. */
  name: string;
  type: ExtractionFieldType;
  description: string;
  /** Carried through untouched - see the editor for why it is not offered. */
  required: boolean;
  /** Comma-separated, for "One of a list". */
  options: string;
}

export type LeadRole = "none" | "required" | "any";

export interface EditorLeadRules {
  roles: Record<string, LeadRole>;
  minFilled: number;
  titleUid: string | null;
  valueUid: string | null;
  /** Not offered in the form; preserved so an operator's setting survives an owner's edit. */
  allowFailedValidation: boolean;
}

export interface EditorState {
  kind: AgentKind;
  name: string;
  purpose: string;
  instructions: string;
  fields: EditorField[];
  leadRules: EditorLeadRules;
  replyConfig: ReplyDrafterConfig;
}

let uidCounter = 0;
/** Unique within the page. Not a key - never stored. */
export function nextUid(): string {
  uidCounter += 1;
  return `f${uidCounter}`;
}

/** `customer_name` → "Customer name". */
export function humanizeKey(key: string): string {
  const words = key.replace(/_+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

export function blankField(): EditorField {
  return {
    uid: nextUid(),
    key: null,
    name: "",
    type: "string",
    description: "",
    required: false,
    options: "",
  };
}

/**
 * A definition into editor state.
 *
 * `savedKeys` is true for a stored agent (its keys are frozen) and false for a
 * template or an AI draft, whose keys are only suggestions until first saved.
 */
export function editorStateFrom(
  def: AgentDefinitionInput,
  opts: { savedKeys: boolean },
): EditorState {
  const fields: EditorField[] = (def.fields ?? []).map((f) => ({
    uid: nextUid(),
    key: opts.savedKeys ? f.key : null,
    name: humanizeKey(f.key),
    type: f.type,
    description: f.description ?? "",
    required: f.required ?? false,
    options: (f.enumValues ?? []).join(", "),
  }));
  const uidOf = new Map((def.fields ?? []).map((f, i) => [f.key, fields[i]!.uid]));

  const rules = LeadRules.parse(def.kind === "call_extractor" ? (def.leadRules ?? {}) : {});
  const roles: Record<string, LeadRole> = {};
  for (const f of def.fields ?? []) {
    const uid = uidOf.get(f.key)!;
    roles[uid] = rules.requiredFields.includes(f.key)
      ? "required"
      : rules.anyFields.includes(f.key)
        ? "any"
        : "none";
  }

  return {
    kind: def.kind,
    name: def.name ?? "",
    purpose: def.purpose ?? "",
    instructions: def.instructions ?? "",
    fields,
    leadRules: {
      roles,
      minFilled: rules.minFilled,
      titleUid: rules.titleField ? (uidOf.get(rules.titleField) ?? null) : null,
      valueUid: rules.valueField ? (uidOf.get(rules.valueField) ?? null) : null,
      allowFailedValidation: rules.allowFailedValidation,
    },
    replyConfig: parseReplyDrafterConfig(def.kind === "reply_drafter" ? def.config : {}),
  };
}

export function blankState(kind: AgentKind): EditorState {
  return editorStateFrom({ kind, name: "", instructions: "", fields: [] } as AgentDefinitionInput, {
    savedKeys: false,
  });
}

/**
 * The key each detail will be saved under.
 *
 * Saved keys are claimed first, so a new detail can never mint a key an
 * existing one already owns - "Budget" added beside a saved `budget` becomes
 * `budget_2`, and the saved facts stay where they were.
 */
export function mintKeys(fields: EditorField[]): Map<string, string> {
  const taken = new Set(fields.flatMap((f) => (f.key ? [f.key] : [])));
  const keyOf = new Map<string, string>();
  for (const f of fields) {
    if (f.key) {
      keyOf.set(f.uid, f.key);
      continue;
    }
    const key = agentFieldKey(f.name || f.description || "detail", taken);
    taken.add(key);
    keyOf.set(f.uid, key);
  }
  return keyOf;
}

function toExtractionField(f: EditorField, key: string): ExtractionField {
  const options = f.options
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    key,
    type: f.type,
    // A detail with no description would give the model nothing but the key to
    // go on, and a key is not an instruction.
    description: f.description.trim() || f.name.trim() || humanizeKey(key),
    required: f.required,
    ...(f.type === "enum" ? { enumValues: options } : {}),
  };
}

/** Editor state out to the definition the API validates. */
export function definitionFrom(state: EditorState): AgentDefinitionInput {
  const keyOf = mintKeys(state.fields);
  const fields = state.fields.map((f) => toExtractionField(f, keyOf.get(f.uid)!));
  const base = {
    name: state.name,
    purpose: state.purpose,
    instructions: state.instructions,
  };

  if (state.kind === "reply_drafter") {
    return { kind: "reply_drafter", ...base, config: state.replyConfig };
  }
  if (state.kind === "chat_qualifier") {
    return { kind: "chat_qualifier", ...base, fields };
  }

  const keysWith = (role: LeadRole) =>
    state.fields.filter((f) => state.leadRules.roles[f.uid] === role).map((f) => keyOf.get(f.uid)!);
  // A title or value pointing at a detail that has since been removed is
  // dropped rather than sent: the API would refuse it, and the owner removed
  // the detail on purpose.
  const live = (uid: string | null) => (uid && keyOf.has(uid) ? keyOf.get(uid) : undefined);

  return {
    kind: "call_extractor",
    ...base,
    fields,
    leadRules: {
      requiredFields: keysWith("required"),
      anyFields: keysWith("any"),
      minFilled: state.leadRules.minFilled,
      titleField: live(state.leadRules.titleUid),
      valueField: live(state.leadRules.valueUid),
      allowFailedValidation: state.leadRules.allowFailedValidation,
    },
  };
}

export interface CallSampleLike {
  started_at: string;
  duration_s: number | null;
  remote_name: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  telecaller: string | null;
}

/**
 * One line for a call in the test picker: who, when, how long, whose phone.
 *
 * The caller is named the way the call log names them (contact name, then the
 * number's visible digits) - the owner is choosing a call they remember, and a
 * picker of timestamps alone makes them guess.
 *
 * `zone` is the workspace's (`useOrgTimeZone()`, Build docs/30), so the time
 * matches the call log rather than the viewer's browser.
 */
export function callSampleLabel(call: CallSampleLike, zone: string = DEFAULT_TIME_ZONE): string {
  const who =
    call.remote_name?.trim() ||
    (call.remote_number_prefix
      ? `${call.remote_number_prefix}…${call.remote_number_last3 ?? ""}`
      : null) ||
    (call.remote_number_last3 ? `…${call.remote_number_last3}` : null) ||
    "Unknown caller";
  const when = `${formatDayMonth(call.started_at, zone)}, ${formatTime(call.started_at, zone)}`;
  const seconds = Math.max(0, Math.round(call.duration_s ?? 0));
  const length = seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
  return [who, when, length, call.telecaller].filter(Boolean).join(" · ");
}

/**
 * A test value as the results table shows it. `null` means the agent found
 * nothing - which is the RIGHT answer for a detail the call never mentioned,
 * so it reads as a plain statement rather than an error.
 */
export function formatTestValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : null;
  if (typeof value === "number")
    return Number.isFinite(value) ? value.toLocaleString("en-IN") : null;
  return JSON.stringify(value);
}

/** Readable problems from a zod issue list, for the save bar. */
export function issueMessages(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  state: EditorState,
): string[] {
  return Array.from(
    new Set(
      issues.map((issue) => {
        const [head, index] = issue.path;
        if (head === "fields" && typeof index === "number") {
          const field = state.fields[index];
          const label = field?.name.trim() || `Detail ${index + 1}`;
          return `${label}: ${issue.message}`;
        }
        return issue.message;
      }),
    ),
  );
}
