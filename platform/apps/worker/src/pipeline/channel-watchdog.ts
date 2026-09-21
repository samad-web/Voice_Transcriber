import { getAdminPool, withOrgContext } from "@aura/db";
import {
  OWNER_ROLE_ADMINS,
  channelAlert,
  channelHasGoneQuiet,
  providerSpec,
  readChannel,
  type ChannelProbeOutcome,
} from "@aura/shared";

/**
 * The WhatsApp channel watchdog (migrations 0110/0100).
 *
 * ── WHY THE ON-DEMAND PROBE IS NOT ENOUGH ───────────────────────────────
 *
 * `POST /v1/messaging/channels/:id/verify` proves a channel works, but only
 * when somebody presses a button on a settings page they visit roughly once.
 * A Hub API key rotated at 2am, a provider account suspended, a forward secret
 * that was never entered - each of those makes the channel stop carrying
 * messages, and the first signal today is a customer saying "I replied days
 * ago". By then the evidence is gone and the reputation is spent.
 *
 * ── TWO CHECKS, BECAUSE THEY CATCH DIFFERENT FAILURES ───────────────────
 *
 * The PROBE asks the provider a question, so it sees a refused key within
 * minutes. It cannot see a channel whose credentials are perfect and which is
 * silently receiving nothing - a number de-registered on Meta's side, a
 * forwarding rule somebody switched off, a webhook URL that stopped resolving.
 *
 * SILENCE is the only signal for that, and silence takes days to become
 * evidence rather than a quiet week. Neither check subsumes the other, so both
 * run here and both route into the same `channelAlert` rule - the decision
 * about when something is worth interrupting a person for exists once.
 *
 * ── SAFETY RULE 3: NOTHING AUTOMATED SENDS ──────────────────────────────
 *
 * The only thing that leaves this sweep is a call to Aura's own verify route,
 * which in turn asks the provider `GET /templates` with the org's own key -
 * a read, to find out whether that key still works.
 *
 * Everything it PRODUCES is a `notifications` row, which
 * packages/shared/src/notifications.ts describes as something that "cannot
 * reach a person who is not signed in to the console". It sends no message to
 * a customer or to anyone else, and there is no column in its path that could
 * hold an address to send one to.
 */

/** Small: each channel costs a network round trip to somebody else's host. */
const BATCH = 25;

/**
 * How long a channel may stay unprobed before the watchdog re-asks.
 *
 * Six hours, not six minutes. The probe is a request against a third party's
 * production API on behalf of every tenant at once, and the failures it catches
 * (a rotated key, a suspended account) are not the kind that resolve on their
 * own - finding one four hours late costs nothing that finding it four minutes
 * late would have saved.
 */
const PROBE_STALE_MS = 6 * 60 * 60 * 1000;

interface WatchedChannel {
  id: string;
  org_id: string;
  provider: string;
  status: "active" | "disabled";
  display_name: string | null;
  inbound_address: string;
  api_key: string | null;
  api_base_url: string | null;
  last_probe_at: Date | null;
  last_probe_outcome: ChannelProbeOutcome | null;
  last_inbound_at: Date | null;
  has_forward_secret: boolean;
}

/**
 * Probing goes through the API over HTTP rather than reimplementing it here.
 *
 * Same reasoning `report-schedules.ts` states for rendering: the worker is a
 * separate process that does not load the API's module graph, and the ONE
 * thing that must not exist twice is the definition of what each provider
 * answer means. A second copy of "401 means the key was refused, 404 against a
 * web page means the host URL is wrong" would drift, and it would drift
 * silently - the console and the watchdog would disagree about whether a
 * channel works, and nothing would fail.
 *
 * The endpoint also RECORDS the probe (migration 0110), so the sweep gets the
 * measurement written and the fresh row back in one call, with the decryption
 * of the org's key staying on the side of the boundary that already does it.
 *
 * Injected so the sweep is testable without a network.
 */
export type ProbeFn = (
  orgId: string,
  channelId: string,
) => Promise<{ outcome: ChannelProbeOutcome; detail: string | null } | null>;

/** The real one: the API's own verify route, called as an admin for that org. */
export async function probeViaApi(
  orgId: string,
  channelId: string,
): Promise<{ outcome: ChannelProbeOutcome; detail: string | null } | null> {
  const apiUrl = process.env.API_URL ?? "http://localhost:4000";
  try {
    const res = await fetch(`${apiUrl}/v1/messaging/channels/${channelId}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": process.env.ADMIN_API_KEY ?? "dev-admin-key",
        "x-org-id": orgId,
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      probe: { outcome: ChannelProbeOutcome; detail: string | null };
    };
    return body.probe;
  } catch {
    // The API being unreachable is not evidence about the CHANNEL, so this
    // returns null and the sweep falls back to the last recorded outcome
    // rather than inventing an `unreachable` that would alert every tenant at
    // once the moment the API restarted.
    return null;
  }
}

export async function runChannelWatchdog(probe: ProbeFn = probeViaApi): Promise<void> {
  const pool = getAdminPool();

  // Cross-tenant on the admin pool to FIND the work, then back into each org's
  // RLS context to act on it - the shape every other sweep here uses.
  const { rows } = await pool.query<WatchedChannel>(
    `SELECT id, org_id, provider, status, display_name, inbound_address,
            api_key, api_base_url, last_probe_at, last_probe_outcome, last_inbound_at,
            (forward_secret IS NOT NULL) AS has_forward_secret
       FROM messaging_channels
      WHERE status = 'active'
        AND channel = 'whatsapp'
      ORDER BY last_probe_at ASC NULLS FIRST
      LIMIT $1`,
    [BATCH],
  );

  for (const channel of rows) {
    try {
      await checkOne(channel, probe);
    } catch (err) {
      // One tenant's channel must never stop the sweep for the rest. A
      // provider that hangs, a decrypt that fails on a key written under a
      // rotated CRM_SECRET_KEY - both are this org's problem, not everyone's.
      console.error(`channel watchdog (channel ${channel.id}):`, err);
    }
  }
}

async function checkOne(channel: WatchedChannel, probe: ProbeFn): Promise<void> {
  let outcome = channel.last_probe_outcome;

  const stale =
    channel.last_probe_at === null ||
    Date.now() - channel.last_probe_at.getTime() > PROBE_STALE_MS;

  // Only providers that HAVE a probe get one. Gated on the provider table
  // rather than on `provider === "wasi"`, which is what this said when Wasi was
  // the only thing to probe: a personal channel is probed through Evolution's
  // own status endpoint, and Meta's APIs have no probe at all and must not be
  // asked for one - the verify route answers `provider_error` for a channel it
  // cannot check, and that became a standing "No answer" warning on channels
  // with nothing wrong with them.
  const probeKind = providerSpec(channel.provider)?.probe ?? "none";
  if (stale && probeKind !== "none" && channel.api_key) {
    // The endpoint writes last_probe_* itself, so there is nothing to persist
    // here - and only one place that can write a measurement.
    const result = await probe(channel.org_id, channel.id);
    if (result) outcome = result.outcome;
  }

  const reading = readChannel({
    provider: channel.provider,
    status: channel.status,
    hasApiKey: channel.api_key !== null,
    hasForwardSecret: channel.has_forward_secret,
    lastProbeAt: channel.last_probe_at?.toISOString() ?? null,
    lastProbeOutcome: outcome,
    lastInboundAt: channel.last_inbound_at?.toISOString() ?? null,
  });

  const nickname = channel.display_name ?? channel.inbound_address;
  const alert = channelAlert(reading, nickname);
  if (alert) {
    await raise(channel.org_id, alert.title, alert.body, alert.dedupeKey);
    return;
  }

  // Only when the channel itself looks fine. A channel that is already
  // shouting about a refused key does not also need "it has gone quiet" - the
  // refused key IS why it is quiet, and two notices for one fault is how a
  // person learns the second one is noise.
  if (
    channelHasGoneQuiet(
      {
        status: channel.status,
        lastInboundAt: channel.last_inbound_at?.toISOString() ?? null,
      },
      new Date(),
    )
  ) {
    await raise(
      channel.org_id,
      `WhatsApp "${nickname}" has not received a message in a week`,
      "The credentials still check out, so this may simply be a quiet week - or the number may have stopped forwarding to Aura. Worth sending yourself a test message from another phone.",
      // Weekly, not per-sweep: without the week in the key this would write a
      // row every six hours for as long as the quiet lasted.
      `channel:${nickname}:quiet:${weekStamp(new Date())}`,
    );
  }
}

/**
 * Write the notification to every owner and manager of the org.
 *
 * Those two personas and no one else, the same pair `seesSetupChecklist`
 * picks: a telecaller cannot re-enter a Hub API key, and every page behind
 * this alert refuses them - so telling them would be a standing notice about
 * somebody else's job.
 *
 * `dedupe_key` is what makes a sweep safe to run on a timer. The same fault on
 * the next pass collapses onto the same row; a fault that CHANGES produces a
 * different key and gets through, which is the escalation you want.
 */
async function raise(
  orgId: string,
  title: string,
  body: string,
  dedupeKey: string,
): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
       SELECT $1, m.user_id, 'channel_needs_attention', $2, $3, '/owner/messaging-setup', $4
         FROM memberships m
        WHERE m.org_id = $1 AND m.owner_role = ANY($5::text[])
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [orgId, title, body, dedupeKey, OWNER_ROLE_ADMINS],
    );
  });
}

/** ISO-ish year+week, so a quiet-channel notice repeats weekly and not hourly. */
function weekStamp(now: Date): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const week = Math.floor((now.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${now.getUTCFullYear()}w${week}`;
}

export function startChannelWatchdog(probe: ProbeFn = probeViaApi): NodeJS.Timeout {
  const interval = Number(process.env.CHANNEL_WATCHDOG_INTERVAL_MS ?? 30 * 60 * 1000);
  return setInterval(() => {
    void runChannelWatchdog(probe).catch((err) => console.error("channel watchdog:", err));
  }, interval);
}
