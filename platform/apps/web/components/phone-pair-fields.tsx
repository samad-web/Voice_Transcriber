"use client";

import { useCallback } from "react";
import { Checkbox, FormField, Input } from "@aura/ui";
import { formatPhoneForDisplay } from "@aura/shared/dist/phone";
import { PhoneInput, usePhoneCheck } from "./phone-input";

/**
 * A person's mobile and WhatsApp numbers, with a "same as mobile" tick.
 *
 * For most of a phone floor the two are one number, and typing it twice is
 * exactly the kind of duplicate entry that ends with the two fields
 * disagreeing by a digit. Ticked (the default for a new person), WhatsApp is
 * not a second input at all - it shows the mobile number read-only and follows
 * every keystroke. Unticking hands the field back, pre-filled with the mobile
 * number so a one-digit difference is one edit, not a retype.
 *
 * Both are `PhoneInput`s: they start on the workspace's country, check the
 * number against the selected country's rules, and emit E.164. The mobile
 * field's own inline message says what is wrong; the parent gates its Save on
 * `usePhoneErrors` below, since these panels save from a button, not a form.
 *
 * Controlled: the parent owns all three values and sends `whatsapp` as shown,
 * so what is saved is what the form displayed.
 */
export function PhonePairFields({
  idPrefix,
  mobile,
  whatsapp,
  same,
  onChange,
  disabled,
  stacked = false,
}: {
  /** Seeds the field ids - two of these on one page need different prefixes. */
  idPrefix: string;
  mobile: string;
  whatsapp: string;
  same: boolean;
  onChange: (next: { mobile: string; whatsapp: string; same: boolean }) => void;
  disabled?: boolean;
  /** One column whatever the viewport - for a narrow panel inside a table row. */
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? "grid grid-cols-1 gap-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2"}>
      <FormField label="Mobile number" name={`${idPrefix}-mobile`} hint="Optional">
        <PhoneInput
          value={mobile}
          disabled={disabled}
          size={stacked ? "sm" : "md"}
          onChange={(value) => onChange({ mobile: value, whatsapp: same ? value : whatsapp, same })}
        />
      </FormField>
      <div className="space-y-2">
        {same ? (
          <FormField label="WhatsApp number" name={`${idPrefix}-whatsapp`}>
            <Input
              value={formatPhoneForDisplay(mobile)}
              readOnly
              disabled={disabled}
              size={stacked ? "sm" : "md"}
              aria-describedby={`${idPrefix}-same-note`}
              // readOnly, not disabled: a disabled field is skipped in a screen
              // reader's form mode, and this one should still be read out.
              placeholder="Same as mobile"
            />
          </FormField>
        ) : (
          <FormField label="WhatsApp number" name={`${idPrefix}-whatsapp`}>
            <PhoneInput
              value={whatsapp}
              disabled={disabled}
              size={stacked ? "sm" : "md"}
              onChange={(value) => onChange({ mobile, whatsapp: value, same })}
            />
          </FormField>
        )}
        <Checkbox
          label="Same as mobile number"
          checked={same}
          disabled={disabled}
          onChange={(e) =>
            // Unticking keeps the mobile number in the box as a starting point.
            onChange({ mobile, whatsapp: e.target.checked ? mobile : whatsapp || mobile, same: e.target.checked })
          }
        />
        <span id={`${idPrefix}-same-note`} className="sr-only">
          {same ? "Mirrors the mobile number. Untick Same as mobile number to enter a different one." : ""}
        </span>
      </div>
    </div>
  );
}

/**
 * The pair's problems, for the parent's Save gate: blank is fine, anything
 * else must be a valid number - the rule the API applies (console-phone.ts).
 */
export function usePhoneErrors(): (phones: { mobile: string; whatsapp: string; same: boolean }) => {
  mobile: string | null;
  whatsapp: string | null;
} {
  const check = usePhoneCheck();
  return useCallback(
    (phones) => {
      const mobile = check(phones.mobile);
      const whatsapp = phones.same ? null : check(phones.whatsapp);
      return {
        mobile: mobile.ok ? null : mobile.message,
        whatsapp: !whatsapp || whatsapp.ok ? null : whatsapp.message,
      };
    },
    [check],
  );
}
