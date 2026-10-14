import Link from "next/link";
import { BrutalButton } from "@aura/ui";
import { OperatorScopeNote } from "@/components/operator-scope-note";
import { BillingsChart } from "./billings-chart";
import { ClientTable } from "./client-table";
import { Concentration } from "./concentration";
import { LifecycleFunnel } from "./lifecycle-funnel";
import { CommercialTiles, DeliveryTiles } from "./tiles";
import type { Commercial } from "./types";

/**
 * THE COMMERCIAL HALF OF THE PLATFORM HUB (doc 49 P13c).
 *
 * ── THE ORDER IS THE ARGUMENT ───────────────────────────────────────────────
 *
 * Doc 49's layout, and its reason for it: the hub today is "a competent
 * OPERATIONAL dashboard" with "no commercial view whatsoever". So the business
 * comes first, the charts that explain it second, whether the product is
 * actually being delivered third, and the client table last - and the existing
 * operational tiles move BELOW all of it rather than being deleted. An operator
 * opening this screen should see what the business is doing before seeing how
 * many devices are paired.
 *
 * ── AND THE DELIVERY ROW SITS DIRECTLY UNDER THE REVENUE ────────────────────
 *
 * Deliberately adjacent, which is doc 49's sequencing argument made visual: "a
 * commercial dashboard built over a pipeline that transcribes 4% of calls will
 * draw confident revenue charts for a product that is not delivering." Putting
 * the transcription success rate and the open platform incidents immediately
 * under the MRR tile is what stops the revenue figure being read alone.
 */
export function CommercialSection({ data }: { data: Commercial }) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-lg font-semibold text-text">The business</h2>
        <CommercialCtas data={data} />
      </div>

      {/* Doc 49 P13b: every figure below is computed over the clients this
          operator may see, so the qualification arrives before the numbers.
          Renders nothing for the root. */}
      <OperatorScopeNote scope={data.scope} note={data.scopeNote} subject="clients" />

      <CommercialTiles data={data} />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <BillingsChart data={data.billingsByMonth} />
        <LifecycleFunnel data={data.lifecycle} />
        <Concentration data={data.concentration} />
      </div>

      <h2 className="pt-2 text-lg font-semibold text-text">Is it being delivered</h2>
      <DeliveryTiles data={data} />

      <h2 className="pt-2 text-lg font-semibold text-text">Clients</h2>
      <ClientTable data={data} />
    </section>
  );
}

/**
 * The hub's actions (doc 49 P13c, "CTAs").
 *
 * ── A SUPERADMIN DOES NOT SEE "INVITE A SUPERADMIN" AT ALL ──────────────────
 *
 * Absent, not disabled. Doc 49 is explicit about why, and it is the right
 * instinct: "a greyed-out control is an invitation to find out why." A control
 * that renders and then refuses has taught somebody where the boundary is and
 * annoyed them in the process.
 *
 * `isRoot` comes from the API, which decides it against
 * `PLATFORM_ROOT_OPERATOR_EMAIL` - never from anything the browser asserts.
 * And hiding it is a console-tier courtesy rather than the enforcement: the
 * invite route is root-gated on the server, because a hidden page is not a
 * closed door.
 *
 * ── THE OTHER FOUR GO WHERE THE WORK IS, PRE-FILTERED ───────────────────────
 *
 * A CTA that lands on an unfiltered list has moved the work rather than
 * starting it. Each of these carries the filter that makes the next screen
 * about the thing the tile was complaining about.
 */
function CommercialCtas({ data }: { data: Commercial }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href="/instances/new">
        <BrutalButton shadow>Onboard a client</BrutalButton>
      </Link>

      {/* `/operators`, not `/team`: /team is a redirect to a client's own Access
          page and has nothing to do with platform staff. Checked rather than
          assumed - doc 49's CTA table names "the 0145 invite flow", and this
          is where it lives. */}
      {data.isRoot ? (
        <Link href="/operators">
          <BrutalButton>Invite a superadmin</BrutalButton>
        </Link>
      ) : null}

      {/* Doc 49 asks for a "Chase overdue" CTA pointing at "the scoped invoice
          list, filtered to overdue". THERE IS NO SUCH SCREEN. The API has
          `admin/billing/orders` with a settle and a cancel action, and the
          operator console has no page in front of it at all - so this would be
          a link to a 404, and a dead CTA on a dashboard is worse than an
          absent one.

          The unsettled orders are not lost: every one of them is on the
          Clients table below, per client, with its age. The missing screen is
          recorded in DEPLOYMENT.md §14 as the follow-on this row needs. */}
      {data.incidents.tickets > 0 ? (
        <Link
          href="/support?source=system"
          className="text-xs text-danger-text underline hover:text-text"
        >
          {data.incidents.tickets} platform incident
          {data.incidents.tickets === 1 ? "" : "s"}
        </Link>
      ) : null}
    </div>
  );
}
