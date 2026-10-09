"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  WebFormDefinition,
  WebFormSlug,
  WebFormStatus,
} from "@aura/shared/dist/web-forms";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * The web-form builder's console actions (Build docs/40 §B4, migration 0161).
 *
 * 0161 built the table, the platform-wide slug rules, the public render and
 * submit routes, the honeypot and the whole field schema in `@aura/shared` -
 * and no console ever reached the four authenticated routes, so a tenant could
 * not create a form (doc 40, F4).
 *
 * ── THE SLUG IS UNIQUE ACROSS THE WHOLE PLATFORM ───────────────────────────
 *
 * Not per tenant. 0161 carries `web_forms_slug_global` as well as
 * `web_forms_org_slug`, because a form is served from one public path and two
 * tenants cannot both own `/f/contact`. That makes a taken slug the single most
 * likely refusal on this screen, and it has to arrive as a sentence beside the
 * field rather than as a 500 from a unique-index violation - which is what
 * `refusal()` below is mostly for.
 *
 * ── NOTHING HERE PUBLISHES BY ITSELF ───────────────────────────────────────
 *
 * A form is created as a DRAFT and `status` is not in the create body at all.
 * A form that could be created published would be collecting strangers' phone
 * numbers at a public URL before anybody had read the consent text on it.
 */

const PAGE = "/owner/forms";

const Name = z.string().trim().min(1, "Name this form.").max(160);

const Create = z.object({
  name: Name,
  // Optional: the API slugifies the name when it is absent, which is the right
  // default - somebody naming a form "Contact us" means `contact-us`.
  slug: WebFormSlug.optional(),
  definition: WebFormDefinition.optional(),
  // Default TRUE at the API, and not restated here as a default. Sending it
  // explicitly from the form is what keeps the checkbox honest: on this table
  // `consentRequired` is not cosmetic - §16 turns it into the consent basis
  // recorded against every number the form collects.
  consentRequired: z.boolean(),
  consentText: z.string().trim().max(1000).nullish(),
  thankYouText: z.string().trim().max(2000).nullish(),
});

const Patch = z
  .object({
    name: Name.optional(),
    slug: WebFormSlug.optional(),
    definition: WebFormDefinition.optional(),
    consentRequired: z.boolean().optional(),
    consentText: z.string().trim().max(1000).nullish(),
    thankYouText: z.string().trim().max(2000).nullish(),
    status: WebFormStatus.optional(),
  })
  // Hand-built and refined, like the API's own `PatchForm`: `.partial()` of the
  // create schema keeps `.default()`, and on this table that would rewrite
  // `consentRequired` to true on any PATCH that did not mention it.
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
    // Non-JSON: a proxy or a crash rather than a refusal with something to say.
  }
  if (res.status === 409) {
    // The platform-wide slug index. Named, because "409" tells somebody
    // nothing and this is the refusal they will actually hit.
    return "That web address is already taken. Try a different one.";
  }
  return `That didn't save (${res.status}).`;
}

async function call<T>(
  method: "POST" | "PATCH",
  path: string,
  body: unknown,
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
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "The server could not be reached. Try again in a moment." };
  }
  if (!res.ok) return { error: await refusal(res) };
  const text = await res.text();
  return { data: (text ? JSON.parse(text) : {}) as T };
}

export interface FormResult {
  error?: string;
  form?: unknown;
}

export async function createWebFormAction(input: unknown): Promise<FormResult> {
  const parsed = Create.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const result = await call<unknown>("POST", "/v1/web-forms", parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { form: result.data };
}

export async function updateWebFormAction(id: unknown, patch: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !id) return { error: "Which form?" };
  const parsed = Patch.safeParse(patch);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  const result = await call<unknown>("PATCH", `/v1/web-forms/${id}`, parsed.data);
  if ("error" in result) return result;
  revalidatePath(PAGE);
  return { form: result.data };
}

/**
 * Publish or close, as its own action.
 *
 * Separate from the general PATCH because the two directions are not
 * symmetrical and the UI should not offer one control that flips whichever way
 * the current state suggests. Publishing puts a form at a public URL where
 * strangers type their phone numbers; closing is always safe.
 *
 * There is no delete, and 0161 does not offer one: deleting a form orphans the
 * `lead_sources` row its leads are attributed to and 404s a link already in
 * circulation. Closing is the end state.
 */
export async function setWebFormStatusAction(
  id: unknown,
  status: unknown,
): Promise<FormResult> {
  const parsed = WebFormStatus.safeParse(status);
  if (!parsed.success) return { error: "Unknown status." };
  return updateWebFormAction(id, { status: parsed.data });
}
