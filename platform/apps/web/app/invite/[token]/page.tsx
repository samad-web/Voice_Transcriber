import type { Metadata } from "next";
import Link from "next/link";
import { Card, ErrorBanner, Logo, MonoLabel } from "@aura/ui";
import { API_URL, crossTenantHeaders } from "@/lib/server-api";
import { googleSignInEnabled } from "@/lib/supabase/google";
import { authErrorMessage } from "../../login/auth-errors";
import { GoogleButton } from "../../login/google-button";

// The token is a credential: keep the page out of search indexes, and keep its
// URL out of the Referer header of anything the page links to.
export const metadata: Metadata = {
  title: "Join your team - Aura Platform",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Preview =
  | {
      status: "pending";
      orgName: string;
      email: string;
      name: string | null;
      roleLabel: string;
      invitedByName: string | null;
      expiresAt: string;
    }
  | { status: "invalid" | "expired" | "accepted" | "revoked" }
  | { status: "unavailable" };

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

async function loadPreview(token: string): Promise<Preview> {
  // Checked here too so a mangled link never becomes an API call.
  if (!TOKEN_RE.test(token)) return { status: "invalid" };
  try {
    const res = await fetch(`${API_URL}/v1/auth/invites/preview?token=${encodeURIComponent(token)}`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) return { status: "unavailable" };
    return (await res.json()) as Preview;
  } catch {
    return { status: "unavailable" };
  }
}

/** "in 3 days" / "in 5 hours" - relative, so it needs no time zone the invitee hasn't chosen yet. */
function expiresIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} days`;
}

const DEAD_LINK: Record<string, { title: string; body: string }> = {
  invalid: {
    title: "This invite link isn't valid",
    body: "Check you opened the whole link from the email, or ask whoever invited you to send it again.",
  },
  expired: {
    title: "This invite has expired",
    body: "Invites only work for a limited time. Ask whoever invited you to send a new one.",
  },
  accepted: {
    title: "This invite has already been used",
    body: "If it was you, sign in with the same Google account.",
  },
  revoked: {
    title: "This invite was withdrawn",
    body: "Ask whoever invited you for a new link.",
  },
  unavailable: {
    title: "We couldn't check this invite",
    body: "The platform didn't answer. Reload the page in a moment.",
  },
};

function deadLink(status: string): { title: string; body: string } {
  return DEAD_LINK[status] ?? DEAD_LINK.invalid;
}

/**
 * Where an invite link lands (0137). Public - the person has no account yet.
 *
 * One decision on the page: continue with Google as the invited address. The
 * owner already chose the role, phone numbers and telecaller binding when
 * issuing the invite, so there is nothing to fill in; the callback applies
 * them on acceptance.
 */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ token }, { error }] = await Promise.all([params, searchParams]);
  const [preview, google] = await Promise.all([loadPreview(token), googleSignInEnabled()]);
  const errorMessage = authErrorMessage(error);

  return (
    <main className="flex min-h-dvh items-center justify-center p-4 sm:p-6">
      <Card elevated className="w-full max-w-md space-y-5">
        <div className="flex items-center gap-3">
          <Logo size={40} priority />
          <div>
            <p className="text-sm leading-tight font-semibold text-text">Aura Platform</p>
            <MonoLabel className="mt-0.5">Workspace invite</MonoLabel>
          </div>
        </div>

        {preview.status === "pending" ? (
          <>
            <div className="space-y-1.5">
              <h1 className="text-2xl leading-tight font-semibold text-text">Join {preview.orgName}</h1>
              <p className="text-sm leading-relaxed text-text-muted">
                {preview.invitedByName ? `${preview.invitedByName} invited you` : "You've been invited"} to join as{" "}
                <span className="font-medium text-text">{preview.roleLabel}</span>.
              </p>
            </div>

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-md border border-border bg-surface-hover p-3 text-sm">
              {preview.name ? (
                <>
                  <dt className="text-text-muted">Name</dt>
                  <dd className="min-w-0 break-words text-text">{preview.name}</dd>
                </>
              ) : null}
              <dt className="text-text-muted">Email</dt>
              <dd className="min-w-0 font-medium break-all text-text">{preview.email}</dd>
              <dt className="text-text-muted">Expires</dt>
              <dd className="text-text">{expiresIn(preview.expiresAt)}</dd>
            </dl>

            {errorMessage ? <ErrorBanner>{errorMessage}</ErrorBanner> : null}

            {google ? (
              <>
                <GoogleButton inviteToken={token} />
                <p className="text-xs leading-relaxed text-text-muted">
                  Choose the Google account for <span className="font-medium text-text">{preview.email}</span>. Any
                  other account is turned away, and the link works once.
                </p>
              </>
            ) : (
              <p className="rounded-md border border-warning bg-warning-subtle p-3 text-sm leading-relaxed text-warning-text">
                Google sign-in isn&apos;t switched on for this platform yet, so this invite can&apos;t be accepted.
                Let whoever invited you know.
              </p>
            )}
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <h1 className="text-xl leading-tight font-semibold text-text">{deadLink(preview.status).title}</h1>
              <p className="text-sm leading-relaxed text-text-muted">{deadLink(preview.status).body}</p>
            </div>
            <Link href="/login" className="inline-block text-sm font-medium text-accent hover:underline">
              Go to sign in
            </Link>
          </>
        )}
      </Card>
    </main>
  );
}
