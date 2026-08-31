import { BadRequestException, Body, Controller, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";

/**
 * "Is this number actually on WhatsApp?"
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * Every message this platform sends to an enquirer goes over WhatsApp, and the
 * number comes from a form the enquirer typed it into. A landline, a typo, or a
 * number that simply has no WhatsApp account looks identical to a good one
 * until a rejection or a confirmation is queued against it and quietly fails.
 * This answers the question before that happens.
 *
 * ── THE RESPONSE SHAPE IS A TRAP, AND THIS IS WHERE IT IS HANDLED ──────────
 *
 * Verified against the live Evolution GO instance, not documentation:
 *
 *   POST /user/check   { "number": ["919944000000"], "formatJid": true }
 *
 *   on WhatsApp  → {"data":{"Users":[{"Query":"+919944000000",
 *                   "IsInWhatsapp":true,"JID":"…","VerifiedName":"…"}]}}
 *   NOT on it    → {"data":{"Users":null}}
 *
 * A number that is not on WhatsApp is **omitted from the array entirely**. It
 * does NOT come back with IsInWhatsapp:false, and an all-miss request returns
 * `null` rather than `[]`. So sending three numbers can return two entries, and
 * any code pairing request to response BY INDEX will attribute one person's
 * answer to another - silently, and in the direction that matters (marking a
 * reachable customer unreachable, or the reverse).
 *
 * Everything here is therefore matched BY `Query`, and every requested number
 * is accounted for explicitly: absent from the response means not on WhatsApp.
 *
 * ── IT DOES NOT SEND ANYTHING ──────────────────────────────────────────────
 *
 * A check is a presence lookup on the WhatsApp network - no message, no
 * notification, nothing the person sees. It is still traffic on an unofficial
 * client, so the batch is capped: bulk-enumerating numbers is exactly the
 * behaviour that gets an account banned, and the cap is what keeps this a
 * verification tool rather than a scanner.
 */

const CheckBody = z.object({
  /**
   * Capped at 50. The console checks the leads on screen, which is at most a
   * page; a caller wanting thousands is doing something this endpoint should
   * not make easy.
   */
  numbers: z.array(z.string().min(4).max(20)).min(1).max(50),
});

export interface NumberCheck {
  /** Exactly what the caller asked about, so a UI can key on it. */
  number: string;
  onWhatsApp: boolean;
  /** WhatsApp Business display name, when the account publishes one. */
  verifiedName?: string;
}

type EvolutionUser = {
  Query?: string;
  IsInWhatsapp?: boolean;
  VerifiedName?: string;
};

/** Digits only. Evolution echoes `Query` with a leading `+` regardless of how
 *  it was sent, so both sides are reduced to digits before comparing. */
function digits(value: string): string {
  return value.replace(/\D/g, "");
}

@Controller("admin/whatsapp")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class WhatsAppCheckController {
  @Post("check")
  async check(@Body() body: unknown): Promise<{ results: NumberCheck[]; configured: boolean }> {
    const parsed = CheckBody.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const base = process.env.EVOLUTION_BASE_URL?.trim().replace(/\/+$/, "");
    const key = process.env.EVOLUTION_API_KEY?.trim();

    // Unconfigured is reported, not thrown. The console renders "checking is
    // unavailable" rather than an error toast that looks like the numbers are
    // bad - a deployment with no WhatsApp connected is a valid deployment.
    if (!base || !key) {
      return { configured: false, results: [] };
    }

    const requested = parsed.data.numbers;

    let users: EvolutionUser[] = [];
    try {
      const res = await fetch(`${base}/user/check`, {
        method: "POST",
        headers: { apikey: key, "content-type": "application/json" },
        body: JSON.stringify({ number: requested.map(digits), formatJid: true }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        throw new Error(`Evolution ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
      const json = (await res.json()) as { data?: { Users?: EvolutionUser[] | null } };
      // `?? []` is load-bearing: an all-miss request answers with null.
      users = json.data?.Users ?? [];
    } catch (err) {
      throw new BadRequestException(
        `Could not reach WhatsApp to check these numbers: ${(err as Error).message}`,
      );
    }

    const found = new Map<string, EvolutionUser>();
    for (const u of users) {
      if (u.Query) found.set(digits(u.Query), u);
    }

    // Driven by what was ASKED, never by what came back - so every number gets
    // exactly one answer and nothing is dropped or transposed.
    return {
      configured: true,
      results: requested.map((number) => {
        const hit = found.get(digits(number));
        return {
          number,
          onWhatsApp: Boolean(hit?.IsInWhatsapp),
          ...(hit?.VerifiedName ? { verifiedName: hit.VerifiedName } : {}),
        };
      }),
    };
  }
}
