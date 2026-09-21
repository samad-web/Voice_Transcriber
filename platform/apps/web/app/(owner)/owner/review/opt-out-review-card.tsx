"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@aura/ui";
import type { ReviewOptOut } from "@/lib/review-queue";
import { confirmOptOutAction, dismissOptOutAction } from "./actions";
import { ReviewCardFrame, type ReviewCardProps } from "./review-card";

/**
 * A message that MIGHT have been a request to stop (migration 0100's
 * `probable`). The message itself is quoted, because the whole point of a
 * person deciding is that they read what was actually said rather than trust
 * the classifier.
 */
export function OptOutReviewCard({ item, waiting, onResolved, onFailed }: ReviewCardProps<ReviewOptOut>) {
  const [busy, setBusy] = useState<"confirm" | "dismiss" | null>(null);
  const who = item.peer_label ?? item.peer_address;

  const decide = async (choice: "confirm" | "dismiss") => {
    setBusy(choice);
    const res = choice === "confirm" ? await confirmOptOutAction(item.id) : await dismissOptOutAction(item.id);
    setBusy(null);
    if (res.error) return onFailed("Couldn't record that decision", res.error);
    if (!res.done) return onResolved(item.id, "Somebody else already decided this one");
    onResolved(
      item.id,
      choice === "confirm" ? `Messages to ${who} are now blocked` : `Kept messaging ${who} open`,
    );
  };

  return (
    <ReviewCardFrame
      sourceLabel="Possible opt-out"
      waiting={waiting}
      title={`${who} may have asked to stop being messaged`}
      meta={
        <>
          <span className="font-mono">{item.peer_address}</span>
          <span>{item.channel === "whatsapp" ? "WhatsApp" : item.channel.toUpperCase()}</span>
        </>
      }
    >
      {item.message_body ? (
        <blockquote className="border-l-2 border-border-strong pl-3 text-sm break-words text-text">
          {item.message_body}
        </blockquote>
      ) : item.source_private ? (
        // Not "no longer stored" - it is stored, and it is not this reviewer's
        // to read. Saying which is the difference between a data problem and
        // a privacy rule working (0125).
        <p className="text-xs text-text-muted">
          This arrived on a colleague&rsquo;s own WhatsApp number, so the message is visible only to
          them. The opt-out still applies to everyone.
        </p>
      ) : (
        <p className="text-xs text-text-muted">The message that raised this is no longer stored.</p>
      )}
      <p className="mt-2 text-xs text-text-muted">
        Confirming stops anyone sending to this number until an owner or manager releases it. Nothing is
        sent either way.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          loading={busy === "confirm"}
          disabled={busy !== null}
          onClick={() => void decide("confirm")}
        >
          Confirm opt-out
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={busy === "dismiss"}
          disabled={busy !== null}
          onClick={() => void decide("dismiss")}
        >
          Not an opt-out
        </Button>
        {item.conversation_id ? (
          <Link
            href={`/owner/inbox?conversation=${item.conversation_id}`}
            className="ml-auto text-xs text-text-muted underline hover:text-text"
          >
            Read the conversation
          </Link>
        ) : null}
      </div>
    </ReviewCardFrame>
  );
}
