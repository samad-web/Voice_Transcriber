/**
 * Provider adapters for inbound mail sync (PRD Layer 1).
 *
 * One interface, one implementation per provider, and nothing above this file
 * knows which provider a connection uses. Adding a provider means adding an
 * entry to ADAPTERS — the same "onboarding is data, not a branch in the
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
  /** Provider's own id — the idempotency key (migration 0044). */
  externalId: string;
  from: string;
  to: string[];
  subject: string | null;
  snippet: string | null;
  occurredAt: Date;
}

export interface FetchResult {
  messages: NormalisedMessage[];
  /** Opaque, stored on the connection and handed back on the next run. */
  cursor: string | null;
}

export interface EmailAdapter {
  id: string;
  /**
   * Messages since `cursor` (or since `since` on a first run).
   *
   * An adapter is expected to OVERLAP rather than risk a gap: a message that
   * arrives mid-poll must be picked up next time, and the unique index on
   * `interactions.external_id` makes re-reporting it free.
   */
  fetchSince(
    accessToken: string,
    cursor: string | null,
    since: Date,
    fetchImpl?: typeof fetch,
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

const gmail: EmailAdapter = {
  id: "google",
  async fetchSince(accessToken, _cursor, since, fetchImpl = fetch) {
    // Gmail's `after:` takes epoch seconds. Deliberately date-based rather
    // than historyId-based: a historyId older than ~a week is rejected
    // outright, which turns a paused worker into a permanently broken sync.
    const after = Math.floor(since.getTime() / 1000);
    const list = await gapi<{ messages?: Array<{ id: string }> }>(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(
        `after:${after}`,
      )}&maxResults=50`,
      accessToken,
      fetchImpl,
    );

    const messages: NormalisedMessage[] = [];
    for (const stub of list.messages ?? []) {
      const full = await gapi<{
        id: string;
        internalDate?: string;
        snippet?: string;
        payload?: { headers?: Array<{ name: string; value: string }> };
      }>(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=metadata` +
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
    return { messages, cursor: null };
  },
};

// ── Microsoft (Graph) ───────────────────────────────────────────────────────

const graph: EmailAdapter = {
  id: "microsoft",
  async fetchSince(accessToken, _cursor, since, fetchImpl = fetch) {
    const filter = `receivedDateTime ge ${since.toISOString()}`;
    const data = await gapi<{
      value?: Array<{
        id: string;
        subject?: string;
        bodyPreview?: string;
        receivedDateTime?: string;
        from?: { emailAddress?: { address?: string } };
        toRecipients?: Array<{ emailAddress?: { address?: string } }>;
      }>;
    }>(
      `https://graph.microsoft.com/v1.0/me/messages?$top=50&$select=id,subject,bodyPreview,receivedDateTime,from,toRecipients&$filter=${encodeURIComponent(
        filter,
      )}`,
      accessToken,
      fetchImpl,
    );

    const messages: NormalisedMessage[] = [];
    for (const item of data.value ?? []) {
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
      });
    }
    return { messages, cursor: null };
  },
};

// ── Stub, for local verification ────────────────────────────────────────────

/**
 * Returns fixture messages instead of calling a provider, under EMAIL_STUB=1.
 *
 * The same device the ASR and analysis stages already use (ASR_STUB /
 * ANALYZE_STUB): a real Gmail round trip needs a registered OAuth app and a
 * populated mailbox, and without a stub the entire sync path — matching,
 * de-duplication, timeline writes, cursor handling — could only ever be
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
 * visible to the caller as "not supported" rather than as silence — a
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

  /** The token is dead — no amount of retrying revives it. */
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
