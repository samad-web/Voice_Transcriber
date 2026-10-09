"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { MAX_HOLD_HOURS, ResourceManualStatus, ResourceTypeKey } from "@aura/shared/dist/resources";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * The bookable-resources console (Build docs/40 §B3, migration 0165).
 *
 * ── WHAT A "RESOURCE" IS, AND WHY THE TYPE IS A FREE KEY ───────────────────
 *
 * The thing a business books: a chair, a room, a scanner, a crew, a bay, a
 * batch of forty seats, a flat in a tower, an 07:00 class, a 14 Oct departure.
 * One table, one self-referencing parent column, and `capacity` carrying the
 * whole of the modelling - a unique item is capacity 1 and a batch of 40 is 40.
 *
 * `resource_type` is a lower-case key with NO database CHECK, deliberately
 * (0165). `@aura/shared`'s `RESOURCE_TYPE_SUGGESTIONS` is what the console
 * OFFERS per stage pack; the API accepts any well-formed key, and a tenant who
 * types `villa` keeps it. A CHECK would mean a migration every time somebody
 * sells something new.
 *
 * ── THE SCHEMAS BELOW ARE COPIES, AND THE API STILL VALIDATES ──────────────
 *
 * 0165 keeps its bodies in the controller rather than in `@aura/shared`, so
 * these mirror them. They exist to turn a typo into a sentence next to the
 * field instead of a round trip; the API is what decides. Where a bound is
 * shared - `MAX_HOLD_HOURS`, `ResourceTypeKey`, `ResourceManualStatus` - it is
 * imported rather than retyped, because those are the ones that would drift
 * silently.
 */

const PAGE = "/owner/resources";

const Create = z.object({
  resourceType: ResourceTypeKey,
  code: z.string().trim().min(1, "Give this a code.").max(120),
  name: z.string().trim().min(1, "Name this.").max(200),
  // Required with no default, matching the API. §24's modelling is that
  // capacity answers "how many bookings fit"; a default of 1 would answer it
  // on the uploader's behalf, which is how a forty-seat batch comes to refuse
  // its second admission.
  capacity: z.number().int().min(1, "At least one.").max(100_000),
  priceNum: z.number().nullable().optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});

const Update = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    capacity: z.number().int().min(1).max(100_000).optional(),
    priceNum: z.number().nullable().optional(),
    status: ResourceManualStatus.optional(),
  })
  // Hand-built and refined, not `Create.partial()`: `.partial()` keeps
  // `.default()`, so a PATCH omitting a defaulted field rewrites it. There is a
  // live instance of that bug in outreach cadences.
  .refine((b) => Object.keys(b).length > 0, "nothing to update");

type Refusal = { error: string };
type Ok<T> = { data: T };

async function refusal(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown };
    const m = body.message;
    if (typeof m === "string") return m;
    if (Array.isArray(m)) {
      const first = m[0] as { message?: unknown } | undefined;
      if (first && typeof first.message === "string") return first.message;
    }
  } catch {
    // Non-JSON body: a proxy or a crash, not a refusal with something to say.
  }
  // 409 is the one worth naming. 0165's unique index on (org_id, code) is what
  // stops two rows claiming the same flat, and "already exists" is actionable
  // where a bare status code is not.
  if (res.status === 409) return "Something here already uses that code.";
  return `That didn't save (${res.status}).`;
}

async function call<T>(
  method: "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<Refusal | Ok<T>> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in to a workspace." };
  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      cache: "no-store",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return { error: "The server could not be reached. Try again in a moment." };
  }
  if (!res.ok) return { error: await refusal(res) };
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : {}) as T };
}

export interface ResourceResult {
  error?: string;
  resource?: unknown;
}

export async function createResourceAction(input: unknown): Promise<ResourceResult> {
  const parsed = Create.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ resource: unknown }>("POST", "/v1/resources", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { resource: result.data.resource };
}

export async function updateResourceAction(id: unknown, patch: unknown): Promise<ResourceResult> {
  if (typeof id !== "string" || !id) return { error: "Which one?" };
  const parsed = Update.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the details." };
  const result = await call<{ resource: unknown }>("PATCH", `/v1/resources/${id}`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { resource: result.data.resource };
}

/**
 * Hold a resource for a while, so two reps cannot sell the same flat.
 *
 * `hours` omitted means the window comes from the TYPE - 0165's
 * `DEFAULT_HOLD_HOURS` is 2-7 days for a property unit and closer to 2 hours
 * for a salon station - and that default is the right one to take, because a
 * number typed here is a number somebody guessed. Clamped to `MAX_HOLD_HOURS`
 * either way: an unbounded hold is a rep quietly reserving the whole tower.
 */
export async function holdResourceAction(id: unknown, hours?: unknown): Promise<ResourceResult> {
  if (typeof id !== "string" || !id) return { error: "Which one?" };
  const parsedHours =
    hours === undefined || hours === null
      ? undefined
      : z.number().int().min(1).max(MAX_HOLD_HOURS).safeParse(hours);
  if (parsedHours && !parsedHours.success) {
    return { error: `A hold can run from 1 hour to ${MAX_HOLD_HOURS / 24} days.` };
  }
  const result = await call<{ resource: unknown }>("POST", `/v1/resources/${id}/hold`, {
    ...(parsedHours?.success ? { hours: parsedHours.data } : {}),
  });
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { resource: result.data.resource };
}

export async function releaseResourceAction(id: unknown): Promise<ResourceResult> {
  if (typeof id !== "string" || !id) return { error: "Which one?" };
  const result = await call<{ resource: unknown }>("POST", `/v1/resources/${id}/release`, {});
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { resource: result.data.resource };
}
