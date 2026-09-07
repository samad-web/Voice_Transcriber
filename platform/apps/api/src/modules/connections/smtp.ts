import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

/**
 * Sending through a plain SMTP server, for the mailboxes that are not Google
 * or Microsoft.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 *
 * `connection-providers.ts` has offered an IMAP/SMTP connection since the
 * mailbox sync was built, and `canSend()` returned false for it - so a tenant
 * on Zoho, Fastmail or their own mail server could READ their mail onto the
 * customer timeline and could not reply from the console. Half a feature, and
 * the half that was missing is the one people notice.
 *
 * ── WHY NOT A LIBRARY ───────────────────────────────────────────────────────
 *
 * This service has no runtime dependencies beyond Nest, zod and the AWS SDK -
 * razorpay.ts and stripe.ts are both hand-written against fetch for the same
 * reason. Nodemailer is a large tree for one code path, and SMTP for a single
 * message is a short, stable protocol: greet, EHLO, authenticate, envelope,
 * data. The part that is genuinely fiddly is not the socket, it is the
 * DIALOGUE - which reply codes mean continue, which mean stop, and how a
 * multi-line reply ends - and that is a pure function below with tests.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * No queueing, no retries, no connection pooling. One message, one connection,
 * one answer. Outbound mail from this console is a person pressing send on one
 * reply (outbound-mail.controller.ts enforces that, and safety rule 3 is why),
 * so there is no batch to amortise a pool over - and a retry on an SMTP error
 * is how a customer gets the same email four times.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  /**
   * True for implicit TLS (port 465). False means connect in the clear and
   * upgrade with STARTTLS (port 587), which is what most providers want.
   *
   * There is no third option. Sending credentials over an unencrypted socket
   * is not offered at any port, and a server that refuses STARTTLS gets an
   * error rather than a downgrade - the failure mode a downgrade prevents is
   * somebody's mailbox password on the wire.
   */
  secure: boolean;
}

export interface SmtpMessage {
  from: string;
  to: string;
  /** The already-built RFC 5322 message, headers and all. */
  mime: string;
}

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "SmtpError";
  }
}

// ── The dialogue, as a pure state machine ───────────────────────────────────

export type SmtpStep =
  | "greeting"
  | "ehlo"
  | "starttls"
  | "ehlo2"
  | "auth"
  | "authUser"
  | "authPass"
  | "mailFrom"
  | "rcptTo"
  | "data"
  | "body"
  | "quit"
  | "done";

export interface SmtpReply {
  code: number;
  lines: string[];
}

/**
 * Parse one server reply out of whatever has arrived so far.
 *
 * SMTP replies are `250-first`, `250-second`, `250 last` - the SPACE after the
 * code on the final line is the only thing marking the end, and a hyphen means
 * more is coming. Reading a multi-line EHLO as several replies is the classic
 * way to get one command out of step with its answer for the rest of the
 * session, at which point the server's "354 send data" is read as the answer
 * to AUTH and the password is transmitted as the message body.
 *
 * Returns null when the buffer does not yet hold a complete reply.
 */
export function parseReply(buffer: string): { reply: SmtpReply; rest: string } | null {
  const lines = buffer.split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length < 4) continue;
    // A space in position 3 ends the reply; a hyphen continues it.
    if (line[3] === " ") {
      const code = Number(line.slice(0, 3));
      if (!Number.isFinite(code)) return null;
      return {
        reply: { code, lines: lines.slice(0, i + 1).map((l) => l.slice(4)) },
        rest: lines.slice(i + 1).join("\r\n"),
      };
    }
  }
  return null;
}

/**
 * What to send next, given where we are and what the server just said.
 *
 * Every transition is explicit and every unexpected code is a stop, because
 * the alternative - carrying on and hoping - is what sends a password into a
 * DATA stream. The caller writes `send` (when present) and moves to `next`.
 */
export function nextCommand(
  step: SmtpStep,
  reply: SmtpReply,
  config: SmtpConfig,
  message: SmtpMessage,
): { send: string | null; next: SmtpStep } {
  const ok = (...codes: number[]) => codes.includes(reply.code);

  switch (step) {
    case "greeting":
      if (!ok(220)) throw new SmtpError(`server did not greet: ${first(reply)}`, reply.code);
      return { send: `EHLO aura`, next: config.secure ? "auth" : "starttls" };

    case "starttls":
      if (!ok(250)) throw new SmtpError(`EHLO refused: ${first(reply)}`, reply.code);
      // Refuse to continue if the server does not offer STARTTLS. Sending the
      // password in the clear is not a fallback anybody should be given.
      if (!reply.lines.some((l) => l.toUpperCase().includes("STARTTLS"))) {
        throw new SmtpError(
          "this server does not offer STARTTLS, and Aura will not send your password unencrypted",
          null,
        );
      }
      return { send: "STARTTLS", next: "ehlo2" };

    case "ehlo2":
      if (!ok(220)) throw new SmtpError(`STARTTLS refused: ${first(reply)}`, reply.code);
      // A second EHLO after the upgrade: the server's advertised capabilities
      // before and after TLS are allowed to differ, and AUTH is routinely
      // offered only after it.
      return { send: `EHLO aura`, next: "auth" };

    case "auth":
      if (!ok(250)) throw new SmtpError(`EHLO refused: ${first(reply)}`, reply.code);
      // AUTH LOGIN rather than PLAIN: both are universally supported, and
      // LOGIN's two-step exchange keeps the password out of the same line as
      // the command - which matters only because SMTP servers log command
      // lines, and a password in a mail log is a password in a backup.
      return { send: "AUTH LOGIN", next: "authUser" };

    case "authUser":
      if (!ok(334)) throw new SmtpError(`server refused AUTH LOGIN: ${first(reply)}`, reply.code);
      return { send: Buffer.from(config.user, "utf8").toString("base64"), next: "authPass" };

    case "authPass":
      if (!ok(334)) throw new SmtpError(`server rejected the username: ${first(reply)}`, reply.code);
      return { send: Buffer.from(config.password, "utf8").toString("base64"), next: "mailFrom" };

    case "mailFrom":
      // 535 is the one worth naming: it is a wrong password, and most
      // providers want an app-specific password rather than the login one.
      if (reply.code === 535) {
        throw new SmtpError(
          "the mail server rejected those credentials - most providers need an app password, not your login password",
          535,
        );
      }
      if (!ok(235)) throw new SmtpError(`authentication failed: ${first(reply)}`, reply.code);
      return { send: `MAIL FROM:<${envelope(message.from)}>`, next: "rcptTo" };

    case "rcptTo":
      if (!ok(250)) throw new SmtpError(`sender refused: ${first(reply)}`, reply.code);
      return { send: `RCPT TO:<${envelope(message.to)}>`, next: "data" };

    case "data":
      if (!ok(250, 251)) throw new SmtpError(`recipient refused: ${first(reply)}`, reply.code);
      return { send: "DATA", next: "body" };

    case "body":
      if (!ok(354)) throw new SmtpError(`server would not accept data: ${first(reply)}`, reply.code);
      // Dot-stuffing and the terminator. A line consisting of a single "." ENDS
      // the message, so any line in the body that begins with a dot has to be
      // doubled - otherwise a message quoting "..." truncates itself there and
      // the rest is interpreted as SMTP commands.
      return { send: `${dotStuff(message.mime)}\r\n.`, next: "quit" };

    case "quit":
      if (!ok(250)) throw new SmtpError(`the message was not accepted: ${first(reply)}`, reply.code);
      return { send: "QUIT", next: "done" };

    default:
      return { send: null, next: "done" };
  }
}

/** Double any leading dot, per RFC 5321 §4.5.2. */
export function dotStuff(body: string): string {
  return body.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
}

/**
 * An address safe to put inside `<>`.
 *
 * CR, LF and `>` stripped. Without it an address containing a newline injects
 * an SMTP command into the envelope - the mail equivalent of the header
 * injection buildMime() already guards against, and the reason that function
 * strips the same characters from its headers.
 */
export function envelope(address: string): string {
  return address.replace(/[\r\n<>]/g, "").trim();
}

function first(reply: SmtpReply): string {
  return reply.lines[0] ?? `code ${reply.code}`;
}

// ── The socket driver ───────────────────────────────────────────────────────

/**
 * Run the dialogue against a real server.
 *
 * Deliberately thin: it owns the socket, the TLS upgrade and the timeout, and
 * every DECISION is `nextCommand` above. That is what makes the protocol
 * testable without a mail server, and it is why this function has no branching
 * of its own beyond the upgrade.
 */
export async function sendSmtpMessage(
  config: SmtpConfig,
  message: SmtpMessage,
  timeoutMs = 20_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let socket: Socket | TLSSocket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port });

    let step: SmtpStep = "greeting";
    let buffer = "";
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    const timer = setTimeout(
      () => finish(new SmtpError(`${config.host} did not answer within ${timeoutMs}ms`, null)),
      timeoutMs,
    );

    const pump = (chunk: Buffer | string) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const parsed = parseReply(buffer);
        if (!parsed) return;
        buffer = parsed.rest;

        let outcome;
        try {
          outcome = nextCommand(step, parsed.reply, config, message);
        } catch (err) {
          return finish(err as Error);
        }

        // The STARTTLS upgrade is the one thing the state machine cannot do
        // for itself: it has to happen between writing the command and reading
        // the next reply, and it replaces the socket.
        if (step === "ehlo2" && !config.secure && outcome.next === "auth") {
          // The raw socket's listeners come OFF first. Left attached, it would
          // keep delivering the encrypted bytes of the TLS session into
          // `buffer` alongside the decrypted ones from the upgraded socket,
          // and the reply parser would be reading ciphertext.
          const raw = socket;
          raw.removeAllListeners("data");
          raw.removeAllListeners("error");
          raw.removeAllListeners("close");
          const upgraded = tlsConnect({ socket: raw, servername: config.host });
          upgraded.on("data", pump);
          upgraded.on("error", (err) => finish(err));
          upgraded.on("close", () =>
            finish(step === "done" ? undefined : new SmtpError("connection closed early", null)),
          );
          socket = upgraded;
        }

        step = outcome.next;
        if (outcome.send !== null) socket.write(`${outcome.send}\r\n`);
        if (step === "done") return finish();
      }
    };

    socket.on("data", pump);
    socket.on("error", (err) => finish(err));
    socket.on("close", () =>
      finish(step === "done" ? undefined : new SmtpError("connection closed early", null)),
    );
  });
}
