import { Controller, Get, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { S3Service } from "../../s3/s3.service";

/** image/x-icon and image/vnd.microsoft.icon both mean ".ico" (tenancy.controller.ts's
 *  upload-url endpoint), so the extension has to fall back to one of them on read too. */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

/**
 * Serves one org's uploaded branding image - the read side of the presigned
 * upload in `tenancy.controller.ts`.
 *
 * Deliberately a SEPARATE controller, not another route on `TenancyController`:
 * that controller carries `@UseGuards(AdminKeyGuard, TenantGuard)` on the whole
 * class, and this route has to be the opposite of that. A logo or favicon has
 * to render for a signed-out browser (a `<link rel="icon">` request carries no
 * session, no admin key, nothing) - the same reason the images have always been
 * plain URLs here, upload or not.
 *
 * Not a security boundary: `orgId`/`filename` are not secrets, and nothing
 * behind them is either - every field this endpoint can serve is, by
 * definition, a value the branding form already renders in a bare `<img>` for
 * anyone who loads the console. The filename's uuid is what stops a stale or
 * guessed name from resolving, not authorization.
 *
 * Reached through the WEB app's own `/branding-assets/...` proxy route, not
 * called directly by a browser - see that route's own note on why.
 */
@Controller("branding-assets")
export class BrandingAssetsController {
  constructor(private readonly s3: S3Service) {}

  @Get(":orgId/:filename")
  async get(
    @Param("orgId") orgId: string,
    @Param("filename") filename: string,
    @Res() res: Response,
  ): Promise<void> {
    // Both segments are path components of an S3 key below - reject anything
    // that could smuggle a `/` or `..` into it before it ever reaches S3.
    const UUID = /^[0-9a-f-]{36}$/i;
    const FILENAME = /^(logo|favicon|banner|sidebarIcon|loginBackground)-[0-9a-f-]{36}\.[a-z]+$/i;
    if (!UUID.test(orgId) || !FILENAME.test(filename)) {
      res.status(404).end();
      return;
    }

    const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    const contentType = CONTENT_TYPE_BY_EXT[ext];
    if (!contentType) {
      res.status(404).end();
      return;
    }

    const object = await this.s3.getObject(`org/${orgId}/branding/${filename}`);
    if (!object) {
      res.status(404).end();
      return;
    }

    res
      // Immutable: the uuid in the filename means a re-upload is a new object
      // under a new name, so this exact URL's bytes never change under it.
      .setHeader("Cache-Control", "public, max-age=31536000, immutable")
      .setHeader("Content-Type", object.contentType || contentType)
      .send(object.body);
  }
}
