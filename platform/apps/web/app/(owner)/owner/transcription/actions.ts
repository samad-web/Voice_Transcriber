"use server";

import { revalidatePath } from "next/cache";
import { AsrLanguage, AsrMode, normaliseVocabulary, VOCABULARY_MAX } from "@aura/shared";
import { API_URL } from "@/lib/server-api";
import { getOwner } from "@/lib/owner-context";
import { errorText, ownerHeaders, type ActionResult } from "../actions";

/**
 * The client's own transcription settings - the language their floor speaks,
 * the script transcripts come back in, and the names the analyser must spell
 * correctly.
 *
 * ── THE PERSONA CHECK BELOW IS THE REAL CONTROL, NOT A COURTESY ───────────
 *
 * This is the opposite of `../team/actions.ts`, and the difference matters
 * enough to state plainly. There, the check was a nicety: the API's
 * `@RequireOwnerRole("owner")` refused a manager regardless.
 *
 * Until doc 31 §2 X8 the API could not refuse anyone here: `PATCH
 * /v1/org/policy` was gated only by `OrgRoleGuard`, which every owner-console
 * request passes (the admin key mints `"platform_admin"`), so this function
 * was the whole gate. The API now enforces both halves itself - owner or
 * manager from memberships (`@OperatorMayCall` keeps the operator console's
 * bare-key access), and a console person may send only `asrLanguage`,
 * `asrMode` and `vocabulary` (`CONSOLE_POLICY_FIELDS` in
 * tenancy.controller.ts). The check below stays so a refusal reads as a
 * sentence rather than a 403.
 *
 * ── AND THE FIELD WHITELIST ───────────────────────────────────────────────
 *
 * `PATCH /v1/org/policy` also accepts `consentPolicy`, `retentionDays`,
 * `storeFullNumber`, `transcriptionEnabled` and `appLockPassword` - compliance
 * and fleet settings that are the PROVIDER's to set, not the customer's. This
 * action builds its own body from three named fields and forwards nothing it
 * was handed; the API would now refuse the other five from a console person
 * anyway, but a spread of the caller's object is still the wrong shape.
 */
export interface TranscriptionSettings {
  /** `null` means auto-detect - a real choice, not an absence. */
  asrLanguage: string | null;
  asrMode: string;
  vocabulary: string[];
}

export async function updateTranscriptionAction(
  settings: TranscriptionSettings,
): Promise<ActionResult> {
  const owner = await getOwner();
  if (!owner) return { error: "Not signed in as an instance owner" };
  const role = owner.membership.ownerRole;
  if (role !== "owner" && role !== "manager") {
    return { error: "Only an Owner or Manager can change transcription settings." };
  }

  // Parsed here rather than forwarded, so a bad value comes back as a sentence
  // instead of a zod issue array from the API.
  let asrLanguage: string | null = null;
  if (settings.asrLanguage !== null) {
    const parsed = AsrLanguage.safeParse(settings.asrLanguage);
    if (!parsed.success) return { error: `"${settings.asrLanguage}" is not a supported language` };
    // `unknown` IS the auto-detect sentinel, and the column stores NULL for it
    // (migration 0016) - so it is normalised here rather than round-tripped as
    // a string the database would then have to interpret.
    asrLanguage = parsed.data === "unknown" ? null : parsed.data;
  }

  const mode = AsrMode.safeParse(settings.asrMode);
  if (!mode.success) return { error: `"${settings.asrMode}" is not a transcript style` };

  const vocabulary = normaliseVocabulary(settings.vocabulary ?? []);
  if (vocabulary.length > VOCABULARY_MAX) {
    return { error: `At most ${VOCABULARY_MAX} terms.` };
  }
  // The API caps a term at 120 characters; say so here rather than letting the
  // whole save fail on one long entry with no indication which.
  const tooLong = vocabulary.find((t) => t.length > 120);
  if (tooLong) {
    return { error: `"${tooLong.slice(0, 30)}…" is too long - keep terms under 120 characters.` };
  }

  const headers = await ownerHeaders();
  if (!headers) return { error: "Not signed in as an instance owner" };

  try {
    const res = await fetch(`${API_URL}/v1/org/policy`, {
      method: "PATCH",
      headers,
      cache: "no-store",
      body: JSON.stringify({ asrLanguage, asrMode: mode.data, vocabulary }),
    });
    if (!res.ok) return { error: await errorText(res) };
  } catch {
    return { error: "The platform API did not answer." };
  }

  revalidatePath("/owner/transcription");
  return {};
}
