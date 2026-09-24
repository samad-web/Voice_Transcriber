/**
 * Provider adapters for inbound mail sync (PRD Layer 1).
 *
 * One interface, one implementation per provider, and nothing above this file
 * knows which provider a connection uses. Adding a provider means adding an
 * entry to ADAPTERS - the same "onboarding is data, not a branch in the
 * dispatcher" contract the connection catalogue itself has.
 *
 * WHAT AN ADAPTER RETURNS. A normalised message, deliberately small: who it
 * was between, when, the subject, and a short snippet. NOT the body. The
 * timeline needs to show that a conversation happened and what it was about;
 * mirroring the full text of a rep's mail into a shared CRM is a different
 * decision with a much larger blast radius, and it is not this increment's to
 * make.
 */

export interface NormalisedMessage {
  /** Provider's own id - the idempotency key (migration 0044). */
  externalId: string;
  from: string;
  to: string[];
  subject: string | null;
  snippet: string | null;
  occurredAt: Date;
  /**
   * The RFC 5322 Message-ID, where the provider hands it over (Graph does).
   *
   * Graph's own `id` changes when a message moves folder - a draft that is
   * sent becomes a NEW id in Sent Items - so the id our console learns when it
   * sends (email-send.ts, apps/api) can never equal the one this sync later
   * reads. The Message-ID survives the move, which makes it the only key that
   * can tell "the Sent copy of a message we already recorded" apart from a new
   * message. See the de-duplication in email-sync.ts.
   */
  internetMessageId?: string | null;
}

export interface FetchResult {
  messages: NormalisedMessage[];
  /**
   * Opaque, stored on the connection and handed back on the next run. The
   * real adapters use it for exactly one thing: a `resume:` position when a
   * pass stopped at its page cap (see resumeCursor).
   */
  cursor: string | null;
  /**
   * Every message received between `since` and this instant has been
   * returned. The caller may advance the connection's position to here and
   * NO further.
   *
   * This exists because "advance to now" was the bug: the old adapters read
   * one page of 50, the sync then moved the window to the present, and
   * message 51 onwards was never looked at again - silently, with no error
   * anywhere. An adapter that stops early now says where it stopped.
   */
  syncedThrough: Date;
  /** False when the pass hit its page cap and there is more to read. */
  complete: boolean;
}

/**
 * How much one pass may read.
 *
 * A cap, because an unbounded pass over a first sync (thirty days of a busy
 * mailbox) is thousands of sequential provider calls: it blocks every other
 * connection behind it in the sweep and runs straight into the provider's
 * per-user rate limit. The cap makes a backlog take several passes instead
 * of one - which is only safe because `syncedThrough` stops at what was read.
 */
export interface FetchLimits {
  pageSize: number;
  maxPages: number;
}

export const DEFAULT_FETCH_LIMITS: FetchLimits = { pageSize: 50, maxPages: 10 };

const RESUME_PREFIX = "resume:";

/**
 * The cursor a capped pass leaves behind: read from exactly here next time.
 *
 * Why the sync does not simply restart from `syncedThrough` minus its usual
 * ten-minute overlap: if more than one pass's worth of mail sits inside ten
 * minutes (a bulk import, a mailing-list storm), every pass would re-read the
 * same capped slice and never get past it. Resuming at the exact point
 * guarantees forward progress; the overlap is kept for the ordinary, caught-up
 * case, where it covers messages the provider indexed late.
 */
export function resumeCursor(at: Date): string {
  return `${RESUME_PREFIX}${at.toISOString()}`;
}

/** The position a `resume:` cursor names, or null for any other cursor. */
export function resumePoint(cursor: string | null): Date | null {
  if (!cursor?.startsWith(RESUME_PREFIX)) return null;
  const at = new Date(cursor.slice(RESUME_PREFIX.length));
  return Number.isNaN(at.getTime()) ? null : at;
}

export interface EmailAdapter {
  id: string;
  /**
   * Messages received since `since`, up to the limits.
   *
   * An adapter is expected to OVERLAP rather than risk a gap: a message that
   * arrives mid-poll must be picked up next time, and the unique index on
   * `interactions.external_id` makes re-reporting it free. What it must never
   * do is claim, through `syncedThrough`, to have covered time it did not read.
   */
  fetchSince(
    accessToken: string,
    cursor: string | null,
    since: Date,
    fetchImpl?: typeof fetch,
    limits?: FetchLimits,
  ): Promise<FetchResult>;
}

/** RFC 5322 addresses arrive as `Name <a@b.com>` as often as bare. */
export function parseAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const angled = /<([^>]+)>/.exec(raw);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();
  return candidate.includes("@") ? candidate : null;
}

// ── Google (Gmail API) ──────────────────────────────────────────────────────

/**
 * A Gmail window narrower than this is not halved again - see the adapter.
 * A minute, because more than a pass's worth of mail inside one minute is a
 * bulk import rather than a person's inbox, and halving further would only
 * spend list calls finding that out.
 */
const MIN_GMAIL_WINDOW_MS = 60_000;

/**
 * Every message id in [since, until], or `overflow` once there are more
 * than `max` of them.
 *
 * Pages are followed rather than trusted: Gmail can hand back a
 * `nextPageToken` whose page turns out empty, and treating that token alone
 * as "more than fits" would shrink the window for nothing.
 */
async function listGmailIds(
  accessToken: string,
  since: Date,
  until: Date,
  max: number,
  fetchImpl: typeof fetch,
): Promise<{ ids: string[]; overflow: boolean }> {
  // Epoch seconds, widened by a second at each end: whether Gmail's bounds
  // are inclusive is not documented, and re-reading a message is free
  // (ON CONFLICT DO NOTHING) where missing one is not.
  const q = `after:${Math.floor(since.getTime() / 1000) - 1} before:${
    Math.ceil(until.getTime() / 1000) + 1
  }`;
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gapi<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}` +
        `&maxResults=${Math.min(500, max + 1)}` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""),
      accessToken,
      fetchImpl,
    );
    for (const m of page.messages ?? []) ids.push(m.id);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length <= max);
  return { ids, overflow: ids.length > max };
}

const gmail: EmailAdapter = {
  id: "google",
  async fetchSince(accessToken, _cursor, since, fetchImpl = fetch, limits = DEFAULT_FETCH_LIMITS) {
    // Date-based rather than historyId-based: a historyId older than ~a week
    // is rejected outright, which turns a paused worker into a permanently
    // broken sync.
    //
    // ── WHY THE WINDOW IS HALVED RATHER THAN PAGED NEWEST-FIRST ─────────────
    //
    // Gmail's list has no sort parameter and does not document its order (in
    // practice newest first). A pass that read the first N ids and stopped
    // would therefore have read the NEWEST part of the window - and there is
    // no position to hand back that means "everything older than this is
    // still to do" without trusting an undocumented order. So instead the
    // window's upper bound comes down until the whole window fits in one
    // pass, and the pass then reads ALL of it: whatever order Gmail returns,
    // every message in [since, until] has been seen, and `until` is an honest
    // `syncedThrough`. Listing is ids only and cheap; it is the per-message
    // metadata fetch the cap is protecting.
    const cap = limits.pageSize * limits.maxPages;
    const top = new Date();
    let until = top;
    let ids: string[];
    for (;;) {
      const listed = await listGmailIds(accessToken, since, until, cap, fetchImpl);
      if (!listed.overflow) {
        ids = listed.ids;
        break;
      }
      const span = until.getTime() - since.getTime();
      if (span <= MIN_GMAIL_WINDOW_MS) {
        // Cannot narrow further. Read the sliver whole, over the cap, rather
        // than drop part of it; and if even that is absurd, fail loudly - a
        // parked connection with a reason beats a silent gap.
        const all = await listGmailIds(accessToken, since, until, cap * 10, fetchImpl);
        if (all.overflow) {
          throw new Error(
            `more than ${cap * 10} messages inside one minute at ${since.toISOString()} - ` +
              "refusing to skip any of them",
          );
        }
        ids = all.ids;
        break;
      }
      until = new Date(since.getTime() + Math.floor(span / 2));
    }

    const messages: NormalisedMessage[] = [];
    for (const id of ids) {
      const full = await gapi<{
        id: string;
        internalDate?: string;
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata` +
          `&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        accessToken,
        fetchImpl,
      );
      const header = (name: string) =>
        full.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? null;

      const from = parseAddress(header("from"));
      if (!from) continue;
      messages.push({
        externalId: full.id,
        from,
        to: (header("to") ?? "")
          .split(",")
          .map((part) => parseAddress(part))
          .filter((a): a is string => a !== null),
        subject: header("subject"),
        snippet: full.snippet ?? null,
        occurredAt: full.internalDate ? new Date(Number(full.internalDate)) : new Date(),
      });
    }
    const complete = until === top;
    return {
      messages,
      cursor: complete ? null : resumeCursor(until),
      syncedThrough: until,
      complete,
    };
  },
};

// ── Microsoft (Graph) ───────────────────────────────────────────────────────

const graph: EmailAdapter = {
  id: "microsoft",
  async fetchSince(accessToken, _cursor, since, fetchImpl = fetch, limits = DEFAULT_FETCH_LIMITS) {
    // OLDEST first, which Graph allows because the ordering property is also
    // the first one filtered on (its rule for combining $orderby and
    // $filter). That ordering is what makes a capped pass safe here: when the
    // cap stops the walk, everything up to the last message seen has been
    // read, so that message's time is an honest `syncedThrough`. Graph's
    // default order is newest first, where stopping early means having read
    // the wrong end of the window.
    const top = new Date();
    const filter = `receivedDateTime ge ${since.toISOString()}`;
    let url: string | null =
      `https://graph.microsoft.com/v1.0/me/messages?$top=${limits.pageSize}` +
      "&$select=id,subject,bodyPreview,receivedDateTime,from,toRecipients,internetMessageId,isDraft" +
      `&$filter=${encodeURIComponent(filter)}&$orderby=${encodeURIComponent("receivedDateTime asc")}`;

    const messages: NormalisedMessage[] = [];
    let lastSeen: Date | null = null;
    for (let page = 0; url && page < limits.maxPages; page++) {
      const data: {
        value?: Array<{
          id: string;
          subject?: string;
          bodyPreview?: string;
          receivedDateTime?: string;
          internetMessageId?: string;
          isDraft?: boolean;
          from?: { emailAddress?: { address?: string } };
          toRecipients?: Array<{ emailAddress?: { address?: string } }>;
        }>;
        "@odata.nextLink"?: string;
      } = await gapi(url, accessToken, fetchImpl);

      for (const item of data.value ?? []) {
        // Position advances past every item READ, kept or not - a skipped
        // draft is still behind us.
        if (item.receivedDateTime) lastSeen = new Date(item.receivedDateTime);
        // /me/messages spans every folder, Drafts included. A draft has not
        // happened yet, and the console's own sends pass through Drafts for
        // a moment on their way out (email-send.ts).
        if (item.isDraft) continue;
        const from = parseAddress(item.from?.emailAddress?.address);
        if (!from) continue;
        messages.push({
          externalId: item.id,
          from,
          to: (item.toRecipients ?? [])
            .map((r) => parseAddress(r.emailAddress?.address))
            .filter((a): a is string => a !== null),
          subject: item.subject ?? null,
          snippet: item.bodyPreview ?? null,
          occurredAt: item.receivedDateTime ? new Date(item.receivedDateTime) : new Date(),
          internetMessageId: item.internetMessageId ?? null,
        });
      }
      url = data["@odata.nextLink"] ?? null;
    }

    if (!url) return { messages, cursor: null, syncedThrough: top, complete: true };

    // Stopped at the cap with more to read. Resume AT the last time seen, not
    // after it: Graph's times are whole seconds, and the rest of that second
    // may be on the page we did not fetch. If the cap was spent without
    // leaving `since` at all, resuming would re-read the same slice forever -
    // say so instead.
    if (!lastSeen || lastSeen.getTime() <= since.getTime()) {
      throw new Error(
        `more than ${limits.pageSize * limits.maxPages} messages share the timestamp ` +
          `${since.toISOString()} - refusing to skip any of them`,
      );
    }
    return { messages, cursor: resumeCursor(lastSeen), syncedThrough: lastSeen, complete: false };
  },
};

// ── Stub, for local verification ────────────────────────────────────────────

/**
 * Returns fixture messages instead of calling a provider, under EMAIL_STUB=1.
 *
 * The same device the ASR and analysis stages already use (ASR_STUB /
 * ANALYZE_STUB): a real Gmail round trip needs a registered OAuth app and a
 * populated mailbox, and without a stub the entire sync path - matching,
 * de-duplication, timeline writes, cursor handling - could only ever be
 * reasoned about rather than run.
 *
 * `EMAIL_STUB_ADDRESS` names the counterparty, so a test can point the fixture
 * at a contact that actually exists.
 */
const stub: EmailAdapter = {
  id: "stub",
  async fetchSince(_accessToken, cursor, _since) {
    const counterparty = process.env.EMAIL_STUB_ADDRESS ?? "someone@example.com";
    const round = Number(cursor ?? "0") + 1;
    return {
      messages: [
        {
          externalId: `stub-inbound-${round}`,
          from: counterparty,
          to: ["rep@example.com"],
          subject: `Quote request (round ${round})`,
          snippet: "Could you send the revised quote for the paving order?",
          occurredAt: new Date(),
        },
        {
          externalId: `stub-outbound-${round}`,
          from: "rep@example.com",
          to: [counterparty],
          subject: `Re: Quote request (round ${round})`,
          snippet: "Sending it across this afternoon.",
          occurredAt: new Date(),
        },
      ],
      cursor: String(round),
      syncedThrough: new Date(),
      complete: true,
    };
  },
};

const ADAPTERS: Record<string, EmailAdapter> = {
  google: gmail,
  microsoft: graph,
  stub,
};

/**
 * The adapter for a provider, or null when that provider cannot sync yet.
 *
 * `imap` is a connection the console offers and this file cannot service:
 * IMAP needs a real client library, which is a dependency decision, and
 * nothing here can test one without a mail server. Returning null makes that
 * visible to the caller as "not supported" rather than as silence - a
 * connected mailbox that never syncs and never says why is the worse failure.
 */
export function emailAdapter(provider: string): EmailAdapter | null {
  if (process.env.EMAIL_STUB === "1") return stub;
  return ADAPTERS[provider] ?? null;
}

/**
 * Carries the HTTP status, because the caller has to tell two failures apart:
 * a 401 means the user must reconnect and retrying is pointless, while a 5xx
 * or a timeout is worth trying again next tick.
 */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`provider responded ${status}: ${detail}`);
    this.name = "ProviderHttpError";
  }

  /** The token is dead - no amount of retrying revives it. */
  get needsReconnect(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

async function gapi<T>(url: string, accessToken: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new ProviderHttpError(res.status, detail.slice(0, 200));
  }
  return (await res.json()) as T;
}
