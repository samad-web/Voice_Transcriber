"use client";

import { useState } from "react";
import { Button } from "@aura/ui";
import { MyWhatsApp } from "../../../inbox/my-whatsapp";
import { personalWhatsAppStatusAction } from "../../../inbox/my-whatsapp-actions";
import { StepActions, StepHeading } from "../step-heading";
import type { StepProps } from "../types";

/**
 * Linking your own WhatsApp: the Inbox's own panel (0125), hosted as it is -
 * the pairing code or QR, the polling, the "linked" state. The Inbox keeps it
 * too; this is the same component, not a second pairing flow.
 */
export function PersonalWhatsAppAuth({ next, fail }: StepProps) {
  const [busy, setBusy] = useState(false);

  const moveOn = async () => {
    setBusy(true);
    const status = await personalWhatsAppStatusAction();
    setBusy(false);
    if (!status.connected) {
      fail(status.detail ?? "Your phone is not linked yet. Finish pairing above, then continue.");
      return;
    }
    next();
  };

  return (
    <>
      <StepHeading title="Link your phone">
        Open WhatsApp on your phone and link it the way you would link WhatsApp Web. Your chats stay
        private to you.
      </StepHeading>
      <div className="mt-4 rounded-lg border border-border p-4">
        <MyWhatsApp />
      </div>
      <StepActions>
        <Button type="button" loading={busy} onClick={() => void moveOn()}>
          Continue
        </Button>
      </StepActions>
    </>
  );
}
