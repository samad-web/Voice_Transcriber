import type { Metadata } from "next";
import { Container, Card } from "@/components/ui/layout";
import { Prose } from "@/components/ui/content";
import { ButtonLink, TextLink } from "@/components/ui/button";
import { formatSize, latestRelease } from "@/lib/app-release";
import { pageMetadata } from "@/lib/metadata";
import { APP_DOWNLOAD_URL } from "@/lib/site";

/**
 * /app - the install page for the handset app.
 *
 * ── WHY A PAGE AND NOT JUST THE LINK ─────────────────────────────────────
 *
 * `GET /v1/app/download` already existed and works: it 302s to a presigned APK.
 * But a bare redirect handed to somebody standing in a shop with a new phone
 * gives them a file and nothing else - no way to tell whether they got the
 * current build, no warning that Android will refuse the install until they
 * allow this browser to install apps, and no hint that the thing they just
 * installed does nothing at all without an activation key. Every one of those
 * is a support call, and each one is answered here instead.
 *
 * ── NOINDEX, AND WHY NOT robots.txt ──────────────────────────────────────
 *
 * A stranger who finds this page can download a binary that is inert until
 * somebody types a key into it - so this is not a leak, but it is also not
 * content: it has nothing to offer a search result, and an indexed APK link
 * attracts scanner traffic and mirror sites.
 *
 * `noIndex` via the meta tag rather than a robots.txt disallow, and the
 * difference matters. A disallow stops the crawler FETCHING the page, so it
 * never reads the noindex, and the URL can still surface as a bare link with no
 * description. Excluding it properly requires letting the crawler in to be told
 * no. It is kept out of sitemap.ts for the same reason /admin is: a door, not a
 * page.
 */
export const metadata: Metadata = pageMetadata({
  title: "Install the Aura app",
  description:
    "Download the Aura call-recording app for Android, and the two settings a new handset needs before it will capture anything.",
  path: "/app",
  noIndex: true,
});

/**
 * Rendered per request, not cached.
 *
 * The whole point of the version line is that it matches what the download
 * button is about to hand over. A cached page that says 1.1.1 while the
 * endpoint serves 1.2.0 would be worse than showing no version at all, because
 * somebody would trust it. The call is cheap, internal, and already falls back
 * to nothing when it fails.
 */
export const dynamic = "force-dynamic";

export default async function AppDownloadPage() {
  const release = await latestRelease();

  return (
    <Container className="pt-12 sm:pt-16 pb-20">
      <div className="max-w-3xl">
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-text text-balance">
          Install the Aura app
        </h1>
        <p className="mt-4 text-lg text-text-muted text-pretty">
          For Android handsets on your call floor. Open this page on the phone itself - the download
          is the app, not a link to a store.
        </p>

        <Card className="mt-8">
          <ButtonLink href={APP_DOWNLOAD_URL} size="lg">
            Download for Android
          </ButtonLink>

          {release ? (
            <p className="mt-4 text-sm text-text-muted">
              Version {release.versionName} · build {release.versionCode} ·{" "}
              {formatSize(release.sizeBytes)}
              {release.notes ? (
                <>
                  <br />
                  <span className="text-text">{release.notes}</span>
                </>
              ) : null}
            </p>
          ) : (
            // The button still works: the endpoint resolves the newest build on
            // its own. Only the confirmation is missing, and saying so is better
            // than a blank space that reads as a broken page.
            <p className="mt-4 text-sm text-text-muted">
              The download works, but the version could not be read just now. Check it against the
              About screen once the app is installed.
            </p>
          )}

          {release ? (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm text-text-muted hover:text-text">
                Verify this file
              </summary>
              <p className="mt-2 text-sm text-text-muted">
                SHA-256 of the APK you are about to download. Compare it with the digest you were
                given separately if the phone is being set up by somebody outside your team.
              </p>
              <code className="mt-2 block break-all rounded-md border border-border bg-bg-subtle p-3 font-mono text-xs text-text">
                {release.sha256}
              </code>
            </details>
          ) : null}
        </Card>

        <Prose className="mt-10">
          <h2>Before you install</h2>
          <p>
            Android blocks apps that did not come from the Play Store until you allow it, once, for
            the browser you are downloading with. When the phone says the file is blocked, tap{" "}
            <strong>Settings</strong> on that prompt and turn on{" "}
            <strong>Allow from this source</strong>, then tap the download again. You only do this
            on the first install; updates after that are handled by the app itself.
          </p>
          <p>
            If the phone already has an older Aura build signed with a different key, uninstall it
            first - Android refuses to replace an app whose signature does not match, and the error
            it shows does not say so.
          </p>

          <h2>After you install</h2>
          <p>
            The app does nothing until it is activated. Open it and enter the{" "}
            <strong>activation key</strong> for the handset, issued from the Aura console. Until
            then it records nothing, uploads nothing and belongs to no account, which is why this
            download can be public.
          </p>
          <p>
            Then turn on automatic call recording in the phone&rsquo;s own Phone app. Aura reads the
            recordings the handset writes; it does not record the call itself, so a phone with that
            setting off produces no files and there is nothing to collect.{" "}
            <TextLink href="/compatibility">
              Check your handset model first
            </TextLink>{" "}
            - Samsung, Xiaomi, Redmi, POCO, Realme, Oppo, Vivo and OnePlus work, while Pixel,
            Motorola and Nokia cannot be used at all.
          </p>
        </Prose>
      </div>
    </Container>
  );
}
