import { z } from "zod";

/**
 * The ingestion API's wire contract (`Build docs/no-crm-api-dashboard-build-
 * plan.md` §6.2-§6.4, M2).
 *
 * In this package rather than in the API, because three things validate
 * against it: the controller on the way in, the Import Center's column mapper
 * (a spreadsheet row becomes one of these objects before it reaches the same
 * drain), and the OpenAPI generator that publishes it. Three copies of a
 * public contract is three chances to document a field the server rejects.
 *
 * ── snake_case, WHICH DIVERGES FROM /v1/public ON PURPOSE ───────────────────
 *
 * `public-api.controller.ts` takes camelCase (`projectKey`). This surface takes
 * snake_case, because §6.4's published examples are snake_case and those
 * examples ARE the documentation an integrator copies. Rather than pick one and
 * break somebody, `normalizeKeys` below accepts either and the docs show one.
 * A key cannot be both spellings at once, so there is no ambiguity to resolve -
 * only two spellings of the same unambiguous thing.
 *
 * ── A TIMESTAMP WITHOUT A ZONE IS REFUSED ───────────────────────────────────
 *
 * §2 says "accept ISO 8601 with offsets". `2026-10-10T10:12:03` has no offset,
 * and the tempting move is to assume UTC. That is wrong in a way nobody would
 * catch: a Mumbai floor's 10am calls would land on `day` as 04:30 UTC, which is
 * the same date - until the 9pm shift, whose calls move to tomorrow. Half a
 * day's work silently attributed to the wrong day on somebody's scorecard.
 *
 * So an instant must carry an offset or a `Z`, and the error says so. An
 * attendance DATE is different and correctly has no zone: a day is a day.
 */

/** §16: 500 items per request. */
export const MAX_BATCH_ITEMS = 500;

/**
 * An ISO 8601 instant that names its own offset.
 *
 * Checked with a regex before `new Date`, because `new Date("2026-10-10")`
 * succeeds and means midnight UTC - exactly the silent assumption above.
 */
const OFFSET_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * Named `WireInstant` and not `Instant` because `time.ts` already exports an
 * `Instant` and both are in the barrel. Not a cosmetic clash: this one is a
 * PARSER for untrusted input that refuses an offsetless string, and the other
 * is an internal time value. Giving them one name would let a future import
 * pick up the lenient one on a public write path.
 */
export const WireInstant = z
  .string()
  .max(40)
  .refine((v) => OFFSET_ISO.test(v), {
    message:
      "must be an ISO 8601 timestamp WITH an offset or Z, e.g. 2026-10-10T10:12:03+05:30. " +
      "A timestamp without one is ambiguous and would be attributed to the wrong day.",
  })
  .refine((v) => !Number.isNaN(Date.parse(v)), { message: "not a valid timestamp" })
  .transform((v) => new Date(v));

/** A calendar day, deliberately zoneless. */
export const Day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date as YYYY-MM-DD")
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { message: "not a valid date" });

/**
 * The customer's own identifier for something.
 *
 * Deliberately permissive about shape - it is THEIR id and we do not get to
 * have opinions about it - but bounded in length and non-empty, because an
 * empty external id is an upsert key that collides with every other empty one.
 */
const ExternalId = z.string().trim().min(1).max(200);

/** Minor units, never a float (§2). */
const MinorAmount = z.number().int().nonnegative();
const Currency = z.string().regex(/^[A-Z]{3}$/, "must be a 3-letter ISO currency code");

/**
 * Anything the customer sends that we do not model.
 *
 * §6.3 offers two behaviours - "unknown fields rejected or stored as custom
 * attributes per setting" - and this is the stored half. A dialer that sends
 * `queue_name` should not get a 400 for it: the field is kept, available on the
 * drill-down and in exports, and ignored by the KPI engine.
 *
 * Bounded at 50 keys so a malformed integration cannot turn one call into a
 * megabyte of jsonb.
 */
const Attributes = z.record(z.string().max(80), z.unknown()).refine(
  (v) => Object.keys(v).length <= 50,
  { message: "at most 50 custom attributes" },
);

// ── Resources ───────────────────────────────────────────────────────────────

export const TelecallerInput = z.object({
  name: z.string().trim().min(1).max(200),
  team_external_id: ExternalId.nullish(),
  // `archived` frees an `active_telecallers` quota slot without deleting
  // anybody's history, which is why §4's limit behaviour can say "block adding
  // more but never remove existing ones".
  status: z.enum(["active", "archived"]).default("active"),
  joined_on: Day.nullish(),
  attributes: Attributes.optional(),
});
export type TelecallerInput = z.infer<typeof TelecallerInput>;

/**
 * `IngestTeamInput`, not `TeamInput`: `org-chart.ts` owns that name and means
 * something different by it - a team inside the chart, with a lead POSITION
 * rather than a parent external id. The two must not be interchangeable.
 */
export const IngestTeamInput = z.object({
  name: z.string().trim().min(1).max(200),
  parent_external_id: ExternalId.nullish(),
});
export type IngestTeamInput = z.infer<typeof IngestTeamInput>;

export const CallInput = z.object({
  external_id: ExternalId,
  telecaller_external_id: ExternalId,
  direction: z.enum(["inbound", "outbound"]),
  started_at: WireInstant,
  // Tri-state and optional, not defaulted to false. `connect_rate` divides by
  // the calls where this was actually stated, so a missing value must stay
  // missing - doc 41 D2. A default of `false` would read as "nobody answered"
  // and hand an honest floor a 0% connect rate.
  connected: z.boolean().nullish(),
  duration_sec: z.number().int().min(0).max(86_400).nullish(),
  // Not derivable from duration and never inferred from it: a 10-minute call
  // on hold has 10 minutes of duration and no talk time.
  talk_time_sec: z.number().int().min(0).max(86_400).nullish(),
  disposition: z.string().trim().max(120).nullish(),
  // §6.5: the customer's own reference, pseudonymous by default. There is no
  // `phone` field here, deliberately - nothing in this schema invites a
  // counterparty number, because a field that exists gets filled.
  lead_ref: z.string().trim().max(200).nullish(),
  campaign: z.string().trim().max(200).nullish(),
  source: z.string().trim().max(120).nullish(),
  attributes: Attributes.optional(),
});
export type CallInput = z.infer<typeof CallInput>;

/**
 * An outcome attached after the fact (§6.2's `POST /v1/dispositions`).
 *
 * Separate from `CallInput` because the two arrive at different times from
 * different systems: a dialer posts the call the moment it ends, and the
 * agent's wrap-up screen posts the disposition a minute later. Making the
 * second a full call upsert would mean the dialer's payload has to be replayed
 * by whatever writes the outcome.
 */
export const DispositionInput = z.object({
  call_external_id: ExternalId,
  disposition: z.string().trim().min(1).max(120),
  // Optional, and only honoured when the call did not already carry one - a
  // wrap-up screen correcting itself is normal; a second system silently
  // overwriting the first is not. The drain enforces this, not the schema.
  talk_time_sec: z.number().int().min(0).max(86_400).nullish(),
  attributes: Attributes.optional(),
});
export type DispositionInput = z.infer<typeof DispositionInput>;

export const ConversionInput = z.object({
  external_id: ExternalId,
  telecaller_external_id: ExternalId,
  lead_ref: z.string().trim().max(200).nullish(),
  closed_at: WireInstant,
  value_minor: MinorAmount.nullish(),
  currency: Currency.nullish(),
  product: z.string().trim().max(200).nullish(),
  attributes: Attributes.optional(),
})
  // A value with no currency cannot be totalled or displayed, and guessing the
  // org's default would mix two currencies into one sum without saying so.
  .refine((v) => v.value_minor === null || v.value_minor === undefined || Boolean(v.currency), {
    message: "currency is required when value_minor is given",
    path: ["currency"],
  });
export type ConversionInput = z.infer<typeof ConversionInput>;

export const PaymentInput = z.object({
  external_id: ExternalId,
  // Optional: §6.3 accepts out-of-order data, so a payment may name a
  // conversion we have not been sent yet. It lands unlinked and the drain
  // re-resolves it when the conversion arrives.
  conversion_external_id: ExternalId.nullish(),
  telecaller_external_id: ExternalId,
  amount_minor: MinorAmount,
  currency: Currency,
  received_at: WireInstant,
  method: z.string().trim().max(80).nullish(),
  attributes: Attributes.optional(),
});
export type PaymentInput = z.infer<typeof PaymentInput>;

export const AttendanceInput = z.object({
  telecaller_external_id: ExternalId,
  date: Day,
  status: z.enum(["present", "absent", "leave", "holiday", "week_off"]),
  login_at: WireInstant.nullish(),
  logout_at: WireInstant.nullish(),
  attributes: Attributes.optional(),
});
export type AttendanceInput = z.infer<typeof AttendanceInput>;

export const QualityScoreInput = z.object({
  external_id: ExternalId,
  telecaller_external_id: ExternalId,
  call_external_id: ExternalId.nullish(),
  reviewer: z.string().trim().max(200).nullish(),
  score: z.number().min(0),
  // Required, and that is the point: a score of 8 means nothing without it,
  // and `qa_score` is `Σscore ÷ Σmax_score` precisely so a rubric out of 10 and
  // one out of 100 can coexist in one org. Defaulting it to 100 would silently
  // divide every out-of-10 review by ten.
  max_score: z.number().positive(),
  rubric: Attributes.optional(),
  reviewed_at: WireInstant,
}).refine((v) => v.score <= v.max_score, {
  message: "score cannot exceed max_score",
  path: ["score"],
});
export type QualityScoreInput = z.infer<typeof QualityScoreInput>;

/**
 * A target override (§6.2's `POST /v1/targets`).
 *
 * Writes an `org_kpi_config` row, so it carries the same effective-dating as
 * the wizard - there is one table and one resolution rule whether a target was
 * set by a person or by an integration. `weight_pct` is deliberately absent:
 * weights total 100 across the whole set and an API that could change one in
 * isolation would leave the set invalid. Weights are a wizard decision.
 */
export const TargetInput = z.object({
  kpi_key: z.string().trim().min(1).max(60),
  scope: z.enum(["org", "team", "telecaller"]),
  /** Required unless `scope` is `org`. The customer's own id for the subject. */
  scope_external_id: ExternalId.nullish(),
  target_value: z.number().min(0).nullable(),
  period: z.enum(["daily", "weekly", "monthly"]).default("monthly"),
  effective_from: Day,
}).refine((v) => v.scope === "org" || Boolean(v.scope_external_id), {
  message: "scope_external_id is required unless scope is 'org'",
  path: ["scope_external_id"],
});
export type TargetInput = z.infer<typeof TargetInput>;

// ── Batching ────────────────────────────────────────────────────────────────

/**
 * A batch envelope.
 *
 * Accepts `{ calls: [...] }` or a bare array, because both turn up in the wild
 * and refusing one is a 400 for a shape that is obvious. §6.4's example uses
 * the named form, so that is what the docs show.
 */
export function batchOf<T extends z.ZodTypeAny>(item: T, field: string) {
  const list = z.array(item).min(1).max(MAX_BATCH_ITEMS);
  return z.union([z.object({ [field]: list }).transform((v) => v[field] as z.infer<T>[]), list]);
}

/**
 * One item's outcome (§6.3: "batch endpoints return per-item results and never
 * fail the whole batch for one bad row").
 *
 * `index` is the item's position in the request the caller sent, which is the
 * only handle they have on a row that had no valid `external_id` to name it
 * by - and a rejected row is exactly the case where the id may be the problem.
 */
export const IngestItemResult = z.object({
  index: z.number().int().min(0),
  external_id: z.string().nullable(),
  status: z.enum(["accepted", "rejected", "duplicate"]),
  /** The raw event id, so a caller can ask `GET /v1/events/{id}` about it. */
  event_id: z.string().uuid().nullable().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      field_errors: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    })
    .nullable()
    .optional(),
});
export type IngestItemResult = z.infer<typeof IngestItemResult>;

export interface IngestBatchResponse {
  accepted: number;
  rejected: number;
  /**
   * Items that were already present under the same idempotency key. Counted
   * separately from `accepted` because an integrator retrying a timeout wants
   * to know their retry was recognised, not that it worked twice.
   */
  duplicate: number;
  results: IngestItemResult[];
  request_id: string;
}

/**
 * Accept camelCase as well as snake_case, one level deep.
 *
 * One level is deliberate: `attributes` is the customer's own object and its
 * keys must survive exactly as sent. Rewriting `{"attributes": {"queueName":
 * "x"}}` into `queue_name` would corrupt a field we promised to keep verbatim.
 */
export function normalizeKeys<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    // A caller who sent both spellings gets the snake_case one, because that is
    // the documented name. Never merge them.
    if (snake in out && key !== snake) continue;
    out[snake] = value;
  }
  return out;
}

/**
 * The error body, built in one place (§6.3 and §9.4).
 *
 * `docs_url` is part of the contract rather than a nicety: an integrator
 * hitting an error at 2am in a timezone we do not share needs the page, not a
 * support ticket.
 */
export interface ProblemBody {
  code: string;
  message: string;
  field_errors?: { field: string; message: string }[];
  request_id: string;
  docs_url: string;
  /** §9.4, present only on `entitlement_required`. */
  required_plan?: string;
  upgrade_url?: string;
}

export const INGEST_DOCS_BASE = "/docs/api";

export function problem(
  code: string,
  message: string,
  requestId: string,
  extra?: Partial<ProblemBody>,
): ProblemBody {
  return {
    code,
    message,
    request_id: requestId,
    docs_url: `${INGEST_DOCS_BASE}#${code}`,
    ...extra,
  };
}

/** zod issues in the §6.3 `field_errors` shape. */
export function fieldErrors(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}
