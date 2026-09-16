import { Controller, Get, NotFoundException, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Response } from "express";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";

/**
 * The public download for the handset app.
 *
 * ── WHY THIS EXISTS ALONGSIDE /devices/me/update ─────────────────────────
 *
 * The self-update channel (migration 0081) can only reach a phone that is
 * ALREADY enrolled and already running the app. It cannot install the first
 * copy, and it cannot help a handset that was wiped, replaced, or flashed with
 * a debug build that can never accept a release-signed update. Every one of
 * those needs a human to open a link on the phone and install an APK, and
 * until now there was no link to send them.
 *
 * ── WHY IT IS UNAUTHENTICATED, AND WHAT THAT DOES NOT MEAN ───────────────
 *
 * The person doing the install is standing in a shop with a new phone. They
 * have no console login, and by definition no device token yet - anything we
 * could ask them to authenticate WITH is the thing they are here to obtain. So
 * this is open, deliberately, and the honesty about what that exposes matters:
 *
 *   * It publishes the CLIENT BINARY. It publishes no tenant data, no
 *     recording, and no credential - the APK ships nothing tenant-specific,
 *     because a fresh install is inert until someone types an activation key
 *     into it (ActivationStore). Downloading this gets you an app that will
 *     not record anything for anyone.
 *   * It does NOT make the bucket public. devices.controller.ts is explicit
 *     that "the bucket is not public, and it must not become public just to
 *     serve an APK" - so this presigns per request and redirects, exactly as
 *     the update channel does. The object stays unreachable without a
 *     signature, and the signature this hands out dies in fifteen minutes.
 *
 * It is throttled, unlike the device poll: that one skips the limiter because a
 * whole floor of phones shares one NAT egress address and rate-limiting it
 * would starve the phones that poll last. Nothing here is a fleet, so the
 * limiter is free to do its job.
 */
@Controller("app")
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AppDownloadController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
  ) {}

  /**
   * What the newest published build is, without downloading it.
   *
   * `sha256` is here so somebody handing a phone to a technician can have the
   * install verified against a digest they were told out of band, which is the
   * only check available once the file has left our hands.
   */
  @Get("latest")
  async latest() {
    const release = await this.newestPublished();
    return {
      versionName: release.version_name,
      versionCode: release.version_code,
      sizeBytes: Number(release.size_bytes),
      sha256: release.sha256,
      ...(release.notes ? { notes: release.notes } : {}),
    };
  }

  /**
   * The download itself: a 302 to a short-lived presigned URL.
   *
   * A redirect rather than streaming the bytes through the API. Proxying a few
   * megabytes per request would put object-storage egress on the API's event
   * loop for the length of every slow mobile connection, and buy nothing - the
   * signature already bounds who can fetch it and for how long.
   *
   * `Cache-Control: no-store` because the response is a redirect to a URL that
   * expires. A cached 302 outlives its own signature and turns into a download
   * that fails for reasons nobody can see from the phone.
   */
  @Get("download")
  async download(@Res() res: Response): Promise<void> {
    const release = await this.newestPublished();
    // 15 minutes: a browser follows this immediately, so the window only has to
    // cover the redirect and the download itself, not a person's attention span.
    const url = await this.s3.presignedGetUrl(
      release.object_key,
      900,
      "application/vnd.android.package-archive",
    );
    res.setHeader("Cache-Control", "no-store").redirect(302, url);
  }

  /**
   * app_releases is fleet-wide - no org_id, no RLS - so there is no tenant
   * context to enter and the admin pool is the right handle, the same call the
   * device update route makes for the same reason.
   */
  private async newestPublished() {
    const {
      rows: [release],
    } = await this.db.adminPool().query<{
      version_code: number;
      version_name: string;
      object_key: string;
      sha256: string;
      size_bytes: string;
      notes: string | null;
    }>(
      `SELECT version_code, version_name, object_key, sha256, size_bytes, notes
         FROM app_releases
        WHERE published
        ORDER BY version_code DESC
        LIMIT 1`,
    );
    // Nothing published is a 404 rather than an empty 200: the caller asked for
    // a file, and "there isn't one" is not something a browser can render as a
    // download.
    if (!release) throw new NotFoundException("no published build");
    return release;
  }
}
