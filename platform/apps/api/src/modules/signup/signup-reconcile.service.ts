import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import { SignupService } from "./signup.service";

/**
 * Provision signups whose payment landed but whose tenant never appeared.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS IS THE PIECE THAT MAKES SELF-SERVE ACTUALLY UNATTENDED
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Everything else in the signup path is the happy case: the buyer pays, the
 * webhook fires, the org appears, the claim link is mailed. This exists for
 * when it does not, and it is justified by three documented properties of the
 * gateway rather than by any suspicion about our own code:
 *
 *   1. **Razorpay delivers AT LEAST ONCE, in no guaranteed order.**
 *   2. **A failing delivery is retried for 24 hours and then the endpoint is
 *      DISABLED** until somebody re-enables it by hand in their dashboard -
 *      a total provisioning outage with a human recovery step and no alarm.
 *   3. **Some successful payments emit no webhook at all**: an authentication
 *      payment on a subscription that is not yet due is documented to produce
 *      no event, so a flow that waits for one waits forever.
 *
 * Any of those, without this, is a customer who has had money taken and
 * received nothing - and because the entire promise is that nobody on our side
 * is involved, there is no queue anyone is watching. The first we would hear of
 * it is a chargeback.
 *
 * ── WHY IT RUNS HERE AND NOT IN THE WORKER ──────────────────────────────────
 *
 * Every other sweep in this system lives in `apps/worker`, and this one does
 * not. The reason is that provisioning is Nest-wired - `provisionTenant` plus
 * `InvitesService` plus `SupabaseAdminService` - and reaching it from the worker
 * would mean either a second copy of the provisioning path (the exact mistake
 * `provisioning.ts` exists to prevent) or a new internal HTTP route with its own
 * credential, widening the attack surface to save a process boundary. Running
 * the loop next to the code it calls is the smaller compromise, and it is
 * recorded here so the inconsistency reads as a decision.
 *
 * Safe across replicas: `provisionFromSignup` takes a row lock and re-reads
 * `status` inside the transaction that creates the org, so two sweeps racing
 * each other - or racing a webhook - cannot produce two tenants. This class is
 * deliberately dumb for that reason. A "has it already?" check here would be a
 * second, weaker copy of that logic, and it would race.
 */
@Injectable()
export class SignupReconcileService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SignupReconcileService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly signups: SignupService,
  ) {}

  onModuleInit(): void {
    // Five minutes: fast enough that a webhook outage costs a buyer minutes
    // rather than hours, slow enough not to be a poll loop against the DB.
    const ms = Number(process.env.SIGNUP_RECONCILE_INTERVAL_MS) || 5 * 60_000;
    // Opt-out rather than opt-in. A sweep that has to be switched on is a sweep
    // that is off in the environment where it mattered.
    if (process.env.SIGNUP_RECONCILE_ENABLED === "false") {
      this.log.warn("signup reconciliation is OFF - paid signups will not self-heal");
      return;
    }
    this.timer = setInterval(() => void this.tick(), ms);
    // Node keeps the process alive for an interval; this one should not be the
    // reason a container refuses to shut down.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const ids = await this.signups.pendingProvision();
      let done = 0;
      for (const id of ids) {
        try {
          await this.signups.provisionFromSignup(id);
          done += 1;
          this.log.warn(`reconciled signup ${id} that the webhook did not provision`);
        } catch (err) {
          // One stuck signup must not stop the others; the row keeps its own
          // `error` for the operator screen.
          this.log.error(`signup ${id} still failing: ${String(err)}`);
        }
      }
      await this.warnOnStuck();
      return done;
    } catch (err) {
      this.log.error(`signup reconciliation tick failed: ${String(err)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Retrying is cheap and silent. Still being unprovisioned half an hour after
   * the money arrived means the retries are not working, and that is the one
   * failure in this system that costs real money with nobody watching - so it
   * gets the loudest thing available in a process with no pager.
   */
  private async warnOnStuck(): Promise<void> {
    const { rows } = await this.db.adminPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM org_signups
        WHERE status IN ('paid', 'failed')
          AND paid_at < now() - interval '30 minutes'
          AND paid_at > now() - interval '7 days'`,
    );
    const stuck = Number(rows[0]?.n ?? 0);
    if (stuck > 0) {
      this.log.error(
        `${stuck} signup(s) PAID AND UNPROVISIONED for over 30 minutes - ` +
          `check the Razorpay webhook endpoint is still enabled in their dashboard`,
      );
    }
  }
}
