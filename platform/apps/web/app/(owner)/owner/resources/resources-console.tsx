"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  EmptyState,
  ErrorBanner,
  MonoLabel,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useConfirm,
  useToast,
} from "@aura/ui";
import { useServerState } from "@/lib/use-server-state";
import {
  createResourceAction,
  holdResourceAction,
  releaseResourceAction,
  updateResourceAction,
} from "./actions";

/** `present()` in resources.controller.ts, as the console receives it. */
export interface ResourceView {
  id: string;
  resourceType: string;
  parentId: string | null;
  projectId: string | null;
  code: string;
  name: string;
  capacity: number;
  bookedCount: number;
  remaining: number;
  status: string;
  priceNum: number | null;
  currency: string | null;
  heldForLeadId: string | null;
  heldByUserId: string | null;
  heldUntil: string | null;
}

const FIELD =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60";

/**
 * `status` as a chip (0165's five values), over `StatusChip`'s four tones.
 *
 * Not `StateChip`: its states are CALL states and its tone is deliberately not
 * overridable, because red means MISSED in this console and orange means an
 * error. None of these is either. `sold` and `retired` are outcomes somebody
 * intended, `held` is a clock running, and nothing here is a fault - so nothing
 * here is `danger`.
 */
const STATUS_TONE: Record<string, "solid" | "muted" | "outline"> = {
  available: "solid",
  held: "muted",
  booked: "muted",
  sold: "muted",
  unavailable: "outline",
  retired: "outline",
};

/** "in 3 hours" / "in 2 days", from an ISO timestamp. */
function until(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  // A hold whose clock has run out is still a row with `held_until` in the
  // past: 0165 expires holds lazily, on read, rather than with a sweeper. So
  // this has to say "expired" rather than "in -2 hours".
  if (ms <= 0) return "expired";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "within the hour";
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * The tenant's own stock (Build docs/40 §B3, migration 0165).
 *
 * ── ONE TABLE FOR NINE INDUSTRIES ──────────────────────────────────────────
 *
 * There is no per-vertical branch here and there is not supposed to be: a
 * chair, a flat, a crew and a batch of forty seats are the same row with a
 * different `resource_type` and a different `capacity`. `resources.ts` records
 * that decision and this screen is where it either holds up or does not.
 *
 * What capacity MEANS is the only thing a reader needs: a unique item is 1 and
 * a batch of forty is 40. So the table shows capacity and what is left of it
 * side by side, because "3 of 40 booked" is the fact and "booked" alone is not.
 */
export function ResourcesConsole({
  initial,
  total,
  types,
  inUse,
}: {
  initial: ResourceView[];
  total: number;
  types: string[];
  inUse: Array<{ type: string; count: number }>;
}) {
  const [rows, setRows] = useServerState(initial);
  const [typeFilter, setTypeFilter] = useState<string>("");

  const visible = useMemo(
    () => (typeFilter ? rows.filter((r) => r.resourceType === typeFilter) : rows),
    [rows, typeFilter],
  );

  return (
    <div className="space-y-5">
      <NewResource
        types={types}
        onCreated={(resource) => setRows((list) => [resource, ...list])}
      />

      {inUse.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <MonoLabel>Show</MonoLabel>
          <button
            type="button"
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              typeFilter === "" ? "border-accent text-accent" : "border-border text-text-muted"
            }`}
            onClick={() => setTypeFilter("")}
          >
            All ({total})
          </button>
          {inUse.map((entry) => (
            <button
              key={entry.type}
              type="button"
              className={`rounded-full border px-3 py-1 text-xs font-medium ${
                typeFilter === entry.type
                  ? "border-accent text-accent"
                  : "border-border text-text-muted"
              }`}
              onClick={() => setTypeFilter(entry.type)}
            >
              {entry.type} ({entry.count})
            </button>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <EmptyState
          title="Nothing bookable yet"
          description="A resource is whatever this business books time or stock against — a chair, a room, a bay, a crew, a flat, a batch of seats. Capacity is how many bookings fit: one for a unique item, forty for a batch of forty."
        />
      ) : (
        <Card>
          <Table caption="Everything this workspace books time or stock against">
            <TableHead>
              <TableRow>
                <TableHeaderCell>Code</TableHeaderCell>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Type</TableHeaderCell>
                <TableHeaderCell className="text-right">Booked</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell>Hold</TableHeaderCell>
                <TableHeaderCell className="text-right">Actions</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((row) => (
                <ResourceRow
                  key={row.id}
                  row={row}
                  onChanged={(next) =>
                    setRows((list) => list.map((r) => (r.id === next.id ? next : r)))
                  }
                />
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function ResourceRow({
  row,
  onChanged,
}: {
  row: ResourceView;
  onChanged: (next: ResourceView) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (work: () => Promise<{ error?: string; resource?: unknown }>, done?: string) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.resource) onChanged(result.resource as ResourceView);
      if (done) toast(done);
      router.refresh();
    });
  };

  const retire = async () => {
    // Confirmed, and the wording says what is lost. 0165 has no delete - a
    // retired row keeps its bookings and its history - but it leaves the
    // pickers, so somebody mid-sale on this unit will stop finding it.
    const ok = await confirm({
      title: `Retire ${row.code}?`,
      body: "It stops being offered for new bookings. Existing bookings and history stay as they are, and you can set it back to available later.",
      confirmLabel: "Retire it",
    });
    if (!ok) return;
    run(() => updateResourceAction(row.id, { status: "retired" }), `${row.code} retired`);
  };

  const holdLabel = until(row.heldUntil);

  return (
    <>
      <TableRow>
        <TableCell className="font-medium text-text">{row.code}</TableCell>
        <TableCell>{row.name}</TableCell>
        <TableCell className="text-text-muted">{row.resourceType}</TableCell>
        <TableCell className="text-right tabular-nums">
          {/* The fact, not half of it. "3" alone reads as a problem on a batch
              of 40 and as sold out on a single room. */}
          {row.bookedCount} of {row.capacity}
        </TableCell>
        <TableCell>
          <StatusChip tone={STATUS_TONE[row.status] ?? "outline"}>{row.status}</StatusChip>
        </TableCell>
        <TableCell className="text-text-muted">{holdLabel ?? "—"}</TableCell>
        <TableCell className="text-right">
          <div className="flex justify-end gap-2">
            {row.heldUntil ? (
              <button
                type="button"
                className="text-sm font-medium text-accent hover:underline disabled:opacity-60"
                disabled={pending}
                onClick={() => run(() => releaseResourceAction(row.id), `${row.code} released`)}
              >
                Release
              </button>
            ) : row.remaining > 0 && row.status === "available" ? (
              <button
                type="button"
                className="text-sm font-medium text-accent hover:underline disabled:opacity-60"
                disabled={pending}
                // No hours passed: the window comes from the TYPE (0165's
                // DEFAULT_HOLD_HOURS - days for a flat, hours for a chair),
                // which is a better answer than a number typed on this screen.
                onClick={() => run(() => holdResourceAction(row.id), `${row.code} held`)}
              >
                Hold
              </button>
            ) : null}
            {row.status !== "retired" ? (
              <button
                type="button"
                className="text-sm font-medium text-text-muted hover:underline disabled:opacity-60"
                disabled={pending}
                onClick={() => void retire()}
              >
                Retire
              </button>
            ) : (
              <button
                type="button"
                className="text-sm font-medium text-accent hover:underline disabled:opacity-60"
                disabled={pending}
                onClick={() =>
                  run(
                    () => updateResourceAction(row.id, { status: "available" }),
                    `${row.code} is available again`,
                  )
                }
              >
                Restore
              </button>
            )}
          </div>
        </TableCell>
      </TableRow>
      {error ? (
        <TableRow>
          <TableCell colSpan={7}>
            <ErrorBanner>{error}</ErrorBanner>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function NewResource({
  types,
  onCreated,
}: {
  types: string[];
  onCreated: (resource: ResourceView) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [resourceType, setResourceType] = useState(types[0] ?? "");
  const [typedType, setTypedType] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState(1);

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90"
          onClick={() => setOpen(true)}
        >
          Add something bookable
        </button>
      </div>
    );
  }

  const chosenType = resourceType === "__other" ? typedType.trim() : resourceType;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createResourceAction({ resourceType: chosenType, code, name, capacity });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.resource) onCreated(result.resource as ResourceView);
      toast(`${code} added`);
      setOpen(false);
      setCode("");
      setName("");
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">Add something bookable</h3>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Capacity is how many bookings fit at once — one for a single room or flat, forty for a
          batch of forty seats.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <label className="space-y-1.5">
          <MonoLabel>Type</MonoLabel>
          <select
            className={`${FIELD} w-full`}
            value={resourceType}
            disabled={pending}
            onChange={(e) => setResourceType(e.target.value)}
          >
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            {/* The API takes any well-formed key and 0165 refuses a CHECK on
                purpose, so the picker must not be a ceiling. A tenant who sells
                villas types `villa` and keeps it. */}
            <option value="__other">Something else…</option>
          </select>
          {resourceType === "__other" ? (
            <input
              className={`${FIELD} mt-1.5 w-full`}
              value={typedType}
              disabled={pending}
              placeholder="e.g. villa"
              aria-label="Your own type name"
              onChange={(e) => setTypedType(e.target.value.toLowerCase())}
            />
          ) : null}
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Code</MonoLabel>
          <input
            className={`${FIELD} w-full`}
            value={code}
            disabled={pending}
            placeholder="e.g. A-1203"
            onChange={(e) => setCode(e.target.value)}
          />
          <span className="block text-xs text-text-muted">
            Unique in this workspace — it is how staff refer to it.
          </span>
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Name</MonoLabel>
          <input
            className={`${FIELD} w-full`}
            value={name}
            disabled={pending}
            placeholder="e.g. Tower A, 12th floor"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Capacity</MonoLabel>
          <input
            type="number"
            min={1}
            max={100000}
            className={`${FIELD} w-full`}
            value={capacity}
            disabled={pending}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="flex gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
          disabled={pending || !chosenType || !code.trim() || !name.trim()}
          onClick={submit}
        >
          Add it
        </button>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
          disabled={pending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}
