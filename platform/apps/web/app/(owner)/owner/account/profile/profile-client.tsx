"use client";

import { useState, useTransition } from "react";
import { Button, Card, ErrorBanner, FormField, Input, PasswordInput, useToast } from "@aura/ui";
import { updateNameAction, updatePhoneAction } from "../actions";

export interface ProfileView {
  name: string | null;
  email: string;
  phone: string | null;
  jobTitle: string | null;
  staffCode: string | null;
}

/**
 * Profile -> Your details (doc 27 §4.1).
 *
 * Three different rules on one card, each for a reason:
 *   - the NAME is yours to change, and is shared across every workspace you
 *     belong to (`users` spans orgs);
 *   - the EMAIL is not: changing it needs auth email, and none is configured;
 *   - the PHONE is this workspace's, and is where call-access approval codes
 *     go (0122), so changing it asks for your password and is audited.
 * Job title and staff code belong to the workspace's staff register and are
 * the owner's to edit, on Staff.
 */
export function ProfileDetails({ profile, passwordRequired }: { profile: ProfileView; passwordRequired: boolean }) {
  const toast = useToast();

  const [name, setName] = useState(profile.name ?? "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [savingName, startName] = useTransition();

  const [editingPhone, setEditingPhone] = useState(false);
  const [phone, setPhone] = useState(profile.phone ?? "");
  const [password, setPassword] = useState("");
  const [phoneErrors, setPhoneErrors] = useState<Record<string, string>>({});
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [savingPhone, startPhone] = useTransition();
  const [currentPhone, setCurrentPhone] = useState(profile.phone);

  const saveName = (event: React.FormEvent) => {
    event.preventDefault();
    setNameError(null);
    startName(async () => {
      const result = await updateNameAction(name.trim());
      if (result.error) setNameError(result.fieldErrors?.name ?? result.error);
      else toast("Name saved");
    });
  };

  const savePhone = (event: React.FormEvent) => {
    event.preventDefault();
    setPhoneErrors({});
    setPhoneError(null);
    startPhone(async () => {
      const result = await updatePhoneAction({ phone, password });
      if (result.fieldErrors || result.error) {
        setPhoneErrors(result.fieldErrors ?? {});
        if (!result.fieldErrors) setPhoneError(result.error ?? null);
        return;
      }
      setCurrentPhone(phone.trim() || null);
      setPassword("");
      setEditingPhone(false);
      toast("Phone saved");
    });
  };

  return (
    <Card className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-text">Your details</h2>
        <p className="mt-1 text-sm text-text-muted">How you appear to your team.</p>
      </div>

      <form onSubmit={saveName} className="space-y-3">
        <FormField
          label="Name"
          name="name"
          className="max-w-sm"
          hint="Shown to your team in every workspace you belong to."
          error={nameError ?? undefined}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="name" />
        </FormField>
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={savingName}
          disabled={!name.trim() || name.trim() === (profile.name ?? "")}
        >
          Save name
        </Button>
      </form>

      <dl className="grid gap-4 border-t border-border pt-5 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Email</dt>
          <dd className="mt-1 truncate text-sm text-text">{profile.email}</dd>
          <dd className="mt-1 text-xs text-text-muted">To change your email, ask your workspace owner.</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Phone (this workspace)</dt>
          <dd className="mt-1 text-sm text-text">{currentPhone || "Not set"}</dd>
          {!editingPhone ? (
            <dd className="mt-1">
              <button
                type="button"
                onClick={() => setEditingPhone(true)}
                className="text-xs font-medium text-text underline underline-offset-2 hover:text-text-muted"
              >
                {currentPhone ? "Change phone" : "Add phone"}
              </button>
            </dd>
          ) : null}
        </div>
        <div>
          <dt className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Job title</dt>
          <dd className="mt-1 text-sm text-text">{profile.jobTitle || "—"}</dd>
        </div>
        <div>
          <dt className="text-xs font-semibold tracking-wide text-text-subtle uppercase">Staff code</dt>
          <dd className="mt-1 text-sm text-text">{profile.staffCode || "—"}</dd>
          <dd className="mt-1 text-xs text-text-muted">Your workspace owner edits these on Staff.</dd>
        </div>
      </dl>

      {editingPhone ? (
        <form onSubmit={savePhone} className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-sm text-text-muted">
            Call-access approval codes are sent to this number, so changing it needs your password.
          </p>
          <FormField label="Phone" name="phone" className="max-w-sm" error={phoneErrors.phone}>
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              maxLength={40}
              autoComplete="tel"
              placeholder="+91 98765 43210"
            />
          </FormField>
          {passwordRequired ? (
            <FormField label="Current password" name="phone-password" className="max-w-sm" error={phoneErrors.password}>
              <PasswordInput
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </FormField>
          ) : null}
          {phoneError ? <ErrorBanner>{phoneError}</ErrorBanner> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" loading={savingPhone} disabled={passwordRequired && !password}>
              Save phone
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={savingPhone}
              onClick={() => {
                setEditingPhone(false);
                setPhone(currentPhone ?? "");
                setPassword("");
                setPhoneErrors({});
                setPhoneError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
