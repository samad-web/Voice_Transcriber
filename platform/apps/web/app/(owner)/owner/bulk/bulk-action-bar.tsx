"use client";

import { useState } from "react";
import { Mail, Tag, UserRoundCog, X } from "lucide-react";
import { useToast } from "@aura/ui";
import type { BulkObject } from "./actions";
import { EmailListDialog, type EmailRecipient } from "./email-list-dialog";
import { ReassignDialog } from "./reassign-dialog";
import { TagDialog } from "./tag-dialog";

/**
 * The bar that appears while rows are ticked: how many, and what can be done
 * to all of them at once.
 *
 * Offers only what the object actually supports - a lead has no tags and no
 * email address, a task has neither - rather than disabled buttons that
 * explain themselves on hover. Whether the person may do it is the API's call
 * (bulk/actions.ts); the result says how many changed and how many were
 * skipped, and the bar says that back in words.
 *
 * Sticky at the bottom of the list, so it stays in reach while scrolling a long
 * page of rows and never covers the header a person is reading.
 */
export function BulkActionBar({
  object,
  noun,
  ids,
  onClear,
  reassign,
  tag = false,
  emailRecipients,
}: {
  object: BulkObject;
  /** Singular noun: "contact". */
  noun: string;
  ids: string[];
  onClear: () => void;
  /** Who the rows can be given to; omit to offer no reassign. */
  reassign?: "people" | "telecallers";
  tag?: boolean;
  /** The selected rows' addresses; omit to offer no email list. */
  emailRecipients?: EmailRecipient[];
}) {
  const toast = useToast();
  const [open, setOpen] = useState<"reassign" | "tag" | "email" | null>(null);

  const count = ids.length;
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;

  // No router.refresh() here: the server action's revalidatePath already sends
  // the re-rendered list back with its response. Refreshing on top of it raced
  // the router's action queue - the refreshed rows intermittently never landed
  // and every later navigation stalled behind it (caught in the Phase 5
  // browser run, not reproducible by typecheck or unit tests).
  const finished = (verb: string, result: { updated?: number; skipped?: number }) => {
    const skipped = result.skipped ?? 0;
    toast(
      `${verb} ${plural(result.updated ?? 0)}.` +
        (skipped > 0 ? ` ${skipped} skipped - outside what you can change.` : ""),
      { duration: skipped > 0 ? 7000 : 4000 },
    );
    setOpen(null);
    onClear();
  };

  const action = (key: "reassign" | "tag" | "email", label: string, Icon: typeof Tag) => (
    <button
      type="button"
      onClick={() => setOpen(key)}
      // px-2 on a phone: count + three actions + clear must fit one row at
      // 400px, where px-3 pushed the clear button onto a second line.
      className="inline-flex h-10 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-bg transition-colors duration-150 ease-out hover:bg-bg/15 sm:h-9 sm:px-3"
    >
      {/* Words only on a phone - the three icons are the ~66px that kept the row from fitting at 400px. */}
      <Icon aria-hidden="true" className="hidden h-4 w-4 sm:block" />
      {label}
    </button>
  );

  return (
    <>
      {/* Only the BAR depends on a selection. The dialogs below stay mounted
          whatever is ticked: finishing an action clears the selection, and a
          dialog unmounted while its server action is still settling is the
          other half of the race described above. */}
      {count > 0 ? (
        <div
          role="toolbar"
          aria-label={`Actions for ${plural(count)} selected`}
          // rounded-3xl rather than full: if a row ever does wrap (a narrower
          // phone), a pill stretched over two lines reads as a blob.
          className="sticky bottom-3 z-20 mx-auto flex w-fit max-w-full flex-wrap items-center gap-0.5 rounded-3xl bg-text py-1 pr-1 pl-3 text-bg shadow-lg sm:gap-1 sm:pl-4"
        >
          <span className="mr-0.5 text-sm font-medium whitespace-nowrap tabular-nums sm:mr-1" aria-live="polite">
            {count} selected
          </span>
          {reassign ? action("reassign", "Reassign", UserRoundCog) : null}
          {tag ? action("tag", "Tag", Tag) : null}
          {emailRecipients ? action("email", "Email", Mail) : null}
          <button
            type="button"
            onClick={onClear}
            aria-label="Clear selection"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full transition-colors duration-150 ease-out hover:bg-bg/15 sm:h-9 sm:w-9"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {reassign ? (
        <ReassignDialog
          open={open === "reassign"}
          object={object}
          kind={reassign}
          ids={ids}
          noun={noun}
          onClose={() => setOpen(null)}
          onDone={(result) => finished("Reassigned", result)}
        />
      ) : null}
      {tag && (object === "contacts" || object === "deals") ? (
        <TagDialog
          open={open === "tag"}
          object={object}
          ids={ids}
          noun={noun}
          onClose={() => setOpen(null)}
          onDone={(result) => finished("Tagged", result)}
        />
      ) : null}
      {emailRecipients ? (
        <EmailListDialog open={open === "email"} recipients={emailRecipients} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}
