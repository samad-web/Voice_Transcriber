"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PhoneOff } from "lucide-react";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  FormField,
  Input,
  Select,
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
import { LocalTime } from "@/components/local-time";
import { useServerState } from "@/lib/use-server-state";
import {
  createDncListAction,
  setDncListStatusAction,
  type DncGrants,
  type DncList,
} from "./actions";
import { UploadPanel } from "./upload-panel";

/**
 * The lists this workspace holds, what goes into them, and how one is retired.
 *
 * ── THERE IS NO DELETE, AND THAT IS THE DESIGN ──────────────────────────────
 *
 * `dnc.controller.ts` has four routes and no fifth: a list is disabled, never
 * removed, because deleting one silently re-opens forty thousand numbers for
 * dialling with nothing left to say they were ever closed. So this component
 * offers Disable and Re-enable and no Remove - not a Remove that fails, and not
 * one hidden behind a permission. There is no route to call.
 *
 * Disabling is confirmed but NOT type-to-confirm: it is reversible in one
 * click, and `confirm.tsx` reserves the typed gate for things that are gone
 * afterwards. What the confirmation has to carry is the consequence, which is
 * not "this list disappears" but "these numbers become dialable again".
 */

/** Both halves of the 0158 CHECK, through a lookup so a third value renders as itself. */
const KIND_LABEL: Record<string, string> = {
  regulatory: "Regulatory",
  internal: "Our own",
};

const KIND_HINT: Record<string, string> = {
  regulatory: "A registry somebody else publishes and this business must honour.",
  internal: "Numbers this business decided for itself nobody here may ring.",
};

export function SuppressionLists({ initial, can }: { initial: DncList[]; can: DncGrants }) {
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [lists, setLists] = useServerState(initial);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [uploadTo, setUploadTo] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [kind, setKind] = useState("regulatory");
  const [nameError, setNameError] = useState<string | null>(null);

  const open = lists.find((l) => l.id === uploadTo) ?? null;

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    // Checked here as well as in the action and the API, so an empty name costs
    // a keystroke rather than a round trip - and through FormField's own inline
    // error, not a `required` attribute. The browser's bubble is replaced
    // app-wide (packages/ui/src/field-validation.tsx) and a form that leans on
    // it is a form whose message nobody here wrote.
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError("Name this list.");
      return;
    }
    if (trimmed.length > 120) {
      setNameError("Use at most 120 characters.");
      return;
    }
    setNameError(null);

    startTransition(async () => {
      const result = await createDncListAction({ name: trimmed, kind });
      if (result.error) {
        setError(result.error);
        return;
      }
      setName("");
      toast("List created");
      // A refresh rather than splicing the answer in: `POST /dnc/lists` returns
      // five fields and the table shows seven - it carries neither who uploaded
      // it nor when. Half a row now and the rest on the next navigation would
      // read as a bug in the table.
      if (result.list) setUploadTo(result.list.id);
      router.refresh();
    });
  };

  const setStatus = async (list: DncList, next: "active" | "disabled") => {
    if (next === "disabled") {
      const ok = await confirm({
        title: `Stop using "${list.name}"?`,
        body: `The ${list.entryCount.toLocaleString()} number${
          list.entryCount === 1 ? "" : "s"
        } on this list stop being suppressed, and this team can ring them again. The list is kept, and you can put it back in force at any time.`,
        confirmLabel: "Stop using it",
        tone: "danger",
        // Reversible in one click - see the header. The typed gate is for
        // things that are gone afterwards.
        requireTyped: false,
      });
      if (!ok) return;
    }

    setError(null);
    startTransition(async () => {
      const result = await setDncListStatusAction(list.id, next);
      if (result.error) {
        setError(result.error);
        return;
      }
      const saved = result.list;
      setLists((current) =>
        current.map((l) => (l.id === list.id ? { ...l, status: saved?.status ?? next } : l)),
      );
      // Nothing may be appended to a disabled list - the API answers 409 - so
      // the upload panel must not be left open over one.
      if (next === "disabled" && uploadTo === list.id) setUploadTo(null);
      toast(next === "disabled" ? "List is no longer in force" : "List is back in force");
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-2">
        <h3 className="text-sm font-semibold text-text">Numbers nobody here may ring</h3>
        <p className="max-w-3xl text-sm text-text-muted">
          Upload a regulatory registry, or build your own list. A number on an active list is
          blocked before anybody can dial it, and the reason shown to the caller says it came from a
          do-not-call list.
        </p>
        <p className="max-w-3xl text-sm text-text-muted">
          Only the numbers&rsquo; fingerprints are stored, never the numbers themselves, so nothing
          here can be read back as a phone number. A list is never deleted - it is taken out of
          force and kept, so there is always a record of who was closed and when.
        </p>
      </Card>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {/* Said once, here, rather than as a disabled control on every row.
          Not an ErrorBanner: nothing has gone wrong, this is simply what
          this person's role is for. */}
      {!can.create && !can.edit ? (
        <Card>
          <p className="text-sm text-text-muted">
            You can see which lists are in force, but not change them. Ask an owner of this
            workspace if a number needs adding or a list needs taking out of force.
          </p>
        </Card>
      ) : null}

      {lists.length === 0 ? (
        <EmptyState
          icon={<PhoneOff className="h-8 w-8" aria-hidden="true" />}
          title="No do-not-call lists yet"
          description={
            can.create
              ? "Make one below, then paste your numbers in or upload the sheet they came on."
              : "Nobody has added one yet. An owner of this workspace can create the first."
          }
        />
      ) : (
        <Table caption="Do-not-call lists">
          <TableHead>
            <TableRow>
              <TableHeaderCell>List</TableHeaderCell>
              <TableHeaderCell>Kind</TableHeaderCell>
              <TableHeaderCell>Numbers</TableHeaderCell>
              <TableHeaderCell>Added by</TableHeaderCell>
              <TableHeaderCell>Added</TableHeaderCell>
              <TableHeaderCell>In force</TableHeaderCell>
              <TableHeaderCell>
                <span className="sr-only">Actions</span>
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {lists.map((list) => {
              const active = list.status === "active";
              return (
                <TableRow key={list.id}>
                  <TableCell className="font-medium">{list.name}</TableCell>
                  <TableCell className="text-text-muted">
                    {KIND_LABEL[list.kind] ?? list.kind}
                  </TableCell>
                  <TableCell className="tabular-nums">{list.entryCount.toLocaleString()}</TableCell>
                  <TableCell className="text-text-muted">
                    {list.uploadedByName ?? "Not recorded"}
                  </TableCell>
                  <TableCell className="text-text-muted">
                    <LocalTime iso={list.createdAt} mode="date" />
                  </TableCell>
                  <TableCell>
                    {active ? (
                      <StatusChip tone="solid">In force</StatusChip>
                    ) : (
                      <StatusChip tone="outline">Not in force</StatusChip>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* A reader without the write grants gets no controls at
                        all rather than controls that 403. "Read-only" is said
                        once, above the table, so it is not repeated per row. */}
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {active && can.create ? (
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={pending}
                          onClick={() => setUploadTo(uploadTo === list.id ? null : list.id)}
                        >
                          {uploadTo === list.id ? "Close" : "Add numbers"}
                        </Button>
                      ) : null}
                      {can.edit ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => void setStatus(list, active ? "disabled" : "active")}
                        >
                          {active ? "Stop using" : "Put back in force"}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {open ? (
        <UploadPanel
          key={open.id}
          list={open}
          onFinished={(entryCount) =>
            setLists((current) => current.map((l) => (l.id === open.id ? { ...l, entryCount } : l)))
          }
        />
      ) : null}

      {can.create ? (
        <Card>
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <FormField
              label="New list"
              name="dnc-name"
              error={nameError}
              hint="What this list is, in the words your team would use."
            >
              <Input
                value={name}
                maxLength={120}
                placeholder="National DNC registry"
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(null);
                }}
              />
            </FormField>
            <FormField label="Where it came from" name="dnc-kind" hint={KIND_HINT[kind]}>
              <Select value={kind} onChange={(event) => setKind(event.target.value)}>
                <option value="regulatory">A registry we must honour</option>
                <option value="internal">Our own list</option>
              </Select>
            </FormField>
            <div className="flex items-end">
              <Button type="submit" variant="secondary" loading={pending}>
                Create list
              </Button>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
