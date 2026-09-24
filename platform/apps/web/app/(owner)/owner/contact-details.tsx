"use client";

import { useState } from "react";
import { useDraftState } from "@/lib/use-server-state";
import Link from "next/link";
import { MonoLabel } from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import { updateContactAction, type ContactUpdate } from "./crm-actions";
import { InlineField } from "./inline-field";
import { RecordPicker } from "./record-picker";
import { relativeTime, type Contact } from "./types";

/**
 * The contact's key facts, edited in place (lib: inline-field.tsx).
 *
 * Name, email, title and company are editable; the phone number is not, and
 * that is not an omission - only a prefix and the last three digits are ever
 * stored (the full number lives as a hash), so there is nothing whole to edit.
 *
 * Permission: the API decides (`contact:edit`, with the `owned` scope). There
 * is no endpoint that tells the console a grant in advance, so the first
 * refusal locks the card with a plain sentence instead of letting a person
 * type into fields that will all bounce.
 */
export function ContactDetails({ contact }: { contact: Contact }) {
  const [locked, setLocked] = useState(false);
  const [accountId, setAccountId] = useDraftState(contact.account_id);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [nameIsHuman, setNameIsHuman] = useDraftState(Boolean(contact.display_name_set_by_human_at));
  const zone = useOrgTimeZone();

  const phone = contact.phone_prefix
    ? `${contact.phone_prefix}…`
    : contact.phone_last3
      ? `…${contact.phone_last3}`
      : null;

  const save = async (update: ContactUpdate): Promise<string | undefined> => {
    const result = await updateContactAction(contact.id, update);
    if (!result.error) return undefined;
    if (/\b403\b|forbidden|permission/i.test(result.error)) {
      setLocked(true);
      return "You don't have permission to edit this contact.";
    }
    if (/\b404\b|not found/i.test(result.error)) {
      setLocked(true);
      return "This contact is no longer available to you.";
    }
    return result.error;
  };

  const lockReason = "You don't have permission to edit this contact";

  return (
    <div>
      <MonoLabel>Details</MonoLabel>
      <dl className="mt-3 space-y-3 text-xs">
        <div>
          <InlineField
            label="Name"
            value={contact.display_name}
            required
            readOnly={locked}
            readOnlyReason={lockReason}
            onSave={async (next) => {
              const failure = await save({ displayName: next ?? "" });
              if (!failure) setNameIsHuman(true);
              return failure;
            }}
          />
          <p className="mt-0.5 text-[11px] text-text-subtle">
            {nameIsHuman
              ? "Set by a teammate - calls won't rename them"
              : "From call analysis - edit it to keep your version"}
          </p>
        </div>
        <InlineField
          label="Email"
          type="email"
          value={contact.email}
          readOnly={locked}
          readOnlyReason={lockReason}
          onSave={(next) => save({ email: next })}
        />
        <InlineField
          label="Title"
          value={contact.title}
          placeholder="Add a job title"
          maxLength={120}
          readOnly={locked}
          readOnlyReason={lockReason}
          onSave={(next) => save({ title: next })}
        />
        <div>
          <dt className="text-text-muted">Company</dt>
          <dd className="mt-1">
            <RecordPicker
              objectType="account"
              value={accountId}
              disabled={locked}
              onChange={(next) => {
                const previous = accountId;
                setAccountId(next);
                setAccountError(null);
                void save({ accountId: next }).then((failure) => {
                  if (failure) {
                    setAccountId(previous);
                    setAccountError(failure);
                  }
                });
              }}
            />
            {accountId ? (
              <Link href={`/owner/accounts/${accountId}`} className="mt-1 inline-block text-xs text-accent-text hover:underline">
                Open company
              </Link>
            ) : null}
            {accountError ? (
              <p role="alert" className="mt-1 text-xs text-orange-text">
                {accountError}
              </p>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-text-muted">Phone</dt>
          <dd className="mt-0.5 text-sm font-medium text-text tabular-nums" title="Only part of the number is stored">
            {phone ?? "-"}
          </dd>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <dt className="text-text-muted">Calls</dt>
            <dd className="mt-0.5 text-sm font-medium text-text tabular-nums">{contact.call_count}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Last activity</dt>
            <dd className="mt-0.5 text-sm font-medium text-text tabular-nums">
              {relativeTime(contact.last_activity_at, zone)}
            </dd>
          </div>
        </div>
      </dl>
    </div>
  );
}
