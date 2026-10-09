"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  EmptyState,
  ErrorBanner,
  MonoLabel,
  StatusChip,
  useConfirm,
  useToast,
} from "@aura/ui";
import type { WebFormDefinition } from "@aura/shared/dist/web-forms";
import { useServerState } from "@/lib/use-server-state";
import { createWebFormAction, setWebFormStatusAction } from "./actions";
import { FieldBuilder } from "./field-builder";

/** `webFormDto()` in web-forms.service.ts, as the console receives it. */
export interface WebFormView {
  id: string;
  sourceId: string | null;
  name: string;
  slug: string;
  definition: WebFormDefinition;
  definitionBroken: boolean;
  consentRequired: boolean;
  consentText: string | null;
  thankYouText: string | null;
  status: string;
  submitCount: number;
}

const FIELD =
  "rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-text disabled:opacity-60";

/**
 * 0161's three statuses over `StatusChip`'s four tones.
 *
 * `closed` is `muted`, not `danger`. Closing a form is a decision somebody
 * made, and orange means an error in this console - the same reason a paused
 * dial campaign is not painted as a fault.
 */
const STATUS_TONE: Record<string, "solid" | "muted" | "outline"> = {
  published: "solid",
  draft: "outline",
  closed: "muted",
};

/**
 * The form builder (Build docs/40 §B4).
 *
 * ── WHAT PUBLISHING MEANS, SAID ON THE SCREEN ──────────────────────────────
 *
 * A published form is a public URL in this business's name where strangers type
 * their phone number. That is a different act from saving a draft, so it is a
 * separate control with its own confirmation, and the consent sentence is
 * edited right beside it - because `consentRequired` is not cosmetic on this
 * table: §16 turns it into the consent basis recorded against every number the
 * form collects, and the dialer later reads that basis to decide whether the
 * person may be rung at all.
 */
export function FormsConsole({
  initial,
  publicBase,
  can,
}: {
  initial: WebFormView[];
  publicBase: string | null;
  can: { create: boolean; edit: boolean };
}) {
  const [forms, setForms] = useServerState(initial);

  return (
    <div className="space-y-5">
      {can.create ? (
        <NewForm onCreated={(form) => setForms((list) => [form, ...list])} />
      ) : null}

      {forms.length === 0 ? (
        <EmptyState
          title="No web forms yet"
          description="A form is a page on your own site where somebody types their details. Every submission becomes a lead on the board, with the consent you asked for recorded against their number."
        />
      ) : (
        forms.map((form) => (
          <FormCard
            key={form.id}
            form={form}
            publicBase={publicBase}
            canEdit={can.edit}
            onChanged={(next) =>
              setForms((list) => list.map((f) => (f.id === next.id ? next : f)))
            }
          />
        ))
      )}
    </div>
  );
}

function FormCard({
  form,
  publicBase,
  canEdit,
  onChanged,
}: {
  form: WebFormView;
  publicBase: string | null;
  canEdit: boolean;
  onChanged: (next: WebFormView) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const path = `/f/${form.slug}`;
  const url = publicBase ? `${publicBase}${path}` : path;

  const run = (work: () => Promise<{ error?: string; form?: unknown }>, done?: string) => {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.form) onChanged(result.form as WebFormView);
      if (done) toast(done);
      router.refresh();
    });
  };

  const publish = async () => {
    const ok = await confirm({
      title: `Publish “${form.name}”?`,
      body: `Anyone with the link can fill it in, and every submission becomes a lead. The page will be live at ${url}.`,
      confirmLabel: "Publish it",
    });
    if (!ok) return;
    run(() => setWebFormStatusAction(form.id, "published"), "Form is live");
  };

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text">{form.name}</h3>
            <StatusChip tone={STATUS_TONE[form.status] ?? "outline"}>{form.status}</StatusChip>
          </div>
          <p className="mt-1 truncate text-sm text-text-muted">
            {form.status === "published" ? url : `${url} — once published`}
          </p>
          {!publicBase ? (
            <p className="mt-1 text-xs text-text-muted">
              The full web address depends on your site domain, which is not set here.
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right">
          <MonoLabel>Submissions</MonoLabel>
          <p className="text-sm font-semibold text-text">{form.submitCount.toLocaleString()}</p>
        </div>
      </div>

      {/* An unreadable definition is reported, never silently coerced. 0161's
          DTO flags it rather than returning an empty form, precisely so this
          screen can refuse to open a blank builder over the top of it. */}
      {form.definitionBroken ? (
        <ErrorBanner>
          This form&rsquo;s fields could not be read, so the builder is closed to avoid saving
          over them. Support can recover it.
        </ErrorBanner>
      ) : null}

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {editing && !form.definitionBroken ? (
        <FieldBuilder
          form={form}
          onSaved={(next) => {
            onChanged(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <p className="text-sm text-text-muted">
            {form.definition.fields.length === 0
              ? "No questions yet."
              : form.definition.fields.map((f) => f.label).join(" · ")}
          </p>

          {canEdit ? (
            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {!form.definitionBroken ? (
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
                  disabled={pending}
                  onClick={() => setEditing(true)}
                >
                  Edit questions
                </button>
              ) : null}
              {form.status === "published" ? (
                <button
                  type="button"
                  className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-muted disabled:opacity-60"
                  disabled={pending}
                  onClick={() =>
                    run(() => setWebFormStatusAction(form.id, "closed"), "Form closed")
                  }
                >
                  Close it
                </button>
              ) : (
                <button
                  type="button"
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
                  disabled={pending || form.definition.fields.length === 0}
                  onClick={() => void publish()}
                >
                  {form.status === "closed" ? "Publish again" : "Publish"}
                </button>
              )}
              {form.definition.fields.length === 0 && form.status !== "published" ? (
                <span className="self-center text-xs text-text-muted">
                  Add at least one question first.
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function NewForm({ onCreated }: { onCreated: (form: WebFormView) => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [consentRequired, setConsentRequired] = useState(true);
  const [consentText, setConsentText] = useState(
    "I agree to be contacted about this enquiry.",
  );

  if (!open) {
    return (
      <div>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90"
          onClick={() => setOpen(true)}
        >
          New form
        </button>
      </div>
    );
  }

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createWebFormAction({
        name,
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        // Two fields to begin with: a name and a phone number. A form created
        // with no questions cannot be published (the card refuses it), and an
        // empty builder is a worse starting point than the two things every
        // enquiry form on earth asks for.
        definition: {
          fields: [
            { key: "name", type: "text", label: "Your name", required: true, options: [] },
            { key: "phone", type: "phone", label: "Phone number", required: true, options: [] },
          ],
        },
        consentRequired,
        consentText: consentRequired ? consentText.trim() || null : null,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.form) onCreated(result.form as WebFormView);
      toast(`“${name}” created as a draft`);
      setOpen(false);
      setName("");
      setSlug("");
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-text">New form</h3>
        <p className="mt-1 max-w-2xl text-sm text-text-muted">
          Created as a draft with a name and a phone field. Nothing is live until you publish
          it.
        </p>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <MonoLabel>Name</MonoLabel>
          <input
            className={`${FIELD} w-full`}
            value={name}
            disabled={pending}
            placeholder="e.g. Contact us"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="space-y-1.5">
          <MonoLabel>Web address</MonoLabel>
          <div className="flex items-center gap-1 text-sm text-text-muted">
            <span>/f/</span>
            <input
              className={`${FIELD} w-full`}
              value={slug}
              disabled={pending}
              placeholder="contact-us"
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
          </div>
          <span className="block text-xs text-text-muted">
            Leave it empty and we will make one from the name. It has to be unused by every
            other business on the platform, so a plain word may already be taken.
          </span>
        </label>
      </div>

      <div className="space-y-2 border-t border-border pt-3">
        <label className="flex items-center gap-2 text-sm text-text">
          <input
            type="checkbox"
            checked={consentRequired}
            disabled={pending}
            onChange={(e) => setConsentRequired(e.target.checked)}
          />
          Ask for permission to contact them
        </label>
        {consentRequired ? (
          <>
            <input
              className={`${FIELD} w-full max-w-2xl`}
              value={consentText}
              disabled={pending}
              aria-label="The permission sentence they tick"
              onChange={(e) => setConsentText(e.target.value)}
            />
            <p className="max-w-2xl text-xs text-text-muted">
              This sentence is recorded against every number the form collects, and the dialer
              reads it later when deciding whether that person may be rung at all.
            </p>
          </>
        ) : (
          <p className="max-w-2xl text-xs text-text-muted">
            Without it, numbers from this form are stored with no recorded permission — and the
            dialer holds those back unless you have told it otherwise.
          </p>
        )}
      </div>

      <div className="flex gap-2 border-t border-border pt-3">
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-text hover:opacity-90 disabled:opacity-60"
          disabled={pending || !name.trim()}
          onClick={submit}
        >
          Create draft
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

