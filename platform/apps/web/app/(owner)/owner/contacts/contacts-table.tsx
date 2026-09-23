"use client";

import Link from "next/link";
import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import { BulkActionBar } from "../bulk/bulk-action-bar";
import { useRowSelection } from "../bulk/use-row-selection";
import { TagChips } from "../tag-chips";
import { relativeTime, type Contact } from "../types";

/**
 * The Contacts list, with row selection for the bulk bar (reassign, tag,
 * copy email addresses).
 *
 * Selection lives here and nowhere else; filters, sort and page are URL state
 * owned by the page, so changing any of them re-renders these rows and the
 * selection drops whatever left the screen (use-row-selection.ts).
 */
export function ContactsTable({ contacts, filtered }: { contacts: Contact[]; filtered: boolean }) {
  const selection = useRowSelection(contacts.map((c) => c.id));
  const zone = useOrgTimeZone();

  if (contacts.length === 0) {
    return filtered ? (
      <EmptyState title="No contacts match these filters" description="Clear a filter above to see more." />
    ) : (
      <EmptyState
        title="No contacts yet"
        description="Contacts appear automatically as calls are qualified into leads, or when one is created by hand."
      />
    );
  }

  const selectedRows = contacts.filter((c) => selection.selected.has(c.id));

  return (
    <>
      <Table caption="Contacts">
        <TableHead>
          <tr>
            <TableHeaderCell className="w-10">
              <input
                type="checkbox"
                checked={selection.allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selection.someSelected;
                }}
                onChange={selection.toggleAll}
                aria-label={selection.allSelected ? "Deselect all contacts on this page" : "Select all contacts on this page"}
                className="h-4 w-4 cursor-pointer accent-accent"
              />
            </TableHeaderCell>
            <TableHeaderCell>Name</TableHeaderCell>
            <TableHeaderCell>Email</TableHeaderCell>
            <TableHeaderCell className="hidden md:table-cell">Owner</TableHeaderCell>
            <TableHeaderCell className="hidden lg:table-cell">Tags</TableHeaderCell>
            <TableHeaderCell className="text-right">Calls</TableHeaderCell>
            <TableHeaderCell className="hidden text-right sm:table-cell">Lead score</TableHeaderCell>
            <TableHeaderCell>Last activity</TableHeaderCell>
          </tr>
        </TableHead>
        <TableBody>
          {contacts.map((contact) => {
            const checked = selection.selected.has(contact.id);
            return (
              <TableRow key={contact.id} aria-selected={checked || undefined} className={checked ? "bg-surface-hover" : undefined}>
                <TableCell className="w-10">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => selection.toggle(contact.id)}
                    aria-label={`Select ${contact.display_name}`}
                    className="h-4 w-4 cursor-pointer accent-accent"
                  />
                </TableCell>
                <TableCell>
                  <Link href={`/owner/contacts/${contact.id}`} className="block font-medium text-text hover:underline">
                    {contact.display_name}
                  </Link>
                  {contact.title ? <span className="text-xs text-text-muted">{contact.title}</span> : null}
                </TableCell>
                <TableCell className="text-text-muted">{contact.email ?? "-"}</TableCell>
                <TableCell className="hidden text-text-muted md:table-cell">{contact.owner_name ?? "-"}</TableCell>
                <TableCell className="hidden lg:table-cell">
                  <TagChips tags={contact.tags} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{contact.call_count}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {contact.lead_score > 0 ? (
                    <span className="font-medium text-text">{contact.lead_score}</span>
                  ) : (
                    <span className="text-text-muted">-</span>
                  )}
                </TableCell>
                <TableCell className="text-text-muted tabular-nums">{relativeTime(contact.last_activity_at, zone)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <BulkActionBar
        object="contacts"
        noun="contact"
        ids={selection.ids}
        onClear={selection.clear}
        reassign="people"
        tag
        emailRecipients={selectedRows.map((c) => ({ id: c.id, name: c.display_name, email: c.email }))}
      />
    </>
  );
}
