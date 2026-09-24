import { createRequire } from "node:module";
import type { RequestHandler } from "express";
import { IMPORT_RUN_MAX_BYTES } from "@aura/shared";

/**
 * The one route whose JSON body may exceed the API's global 1 MB.
 *
 * As mounted on express: `app.use` sees the raw URL, BEFORE Nest strips the
 * `v1` global prefix (main.ts), so the prefix is spelled out here.
 */
export const IMPORT_RUN_PATH = "/v1/import/run";

/**
 * A JSON parser for `POST /v1/import/run` alone, capped at
 * `IMPORT_RUN_MAX_BYTES` (8 MB) instead of the global 1 MB (X7).
 *
 * ── WHY A ROUTE-SCOPED PARSER AND NOT A BIGGER GLOBAL LIMIT ─────────────────
 *
 * The global cap bounds what any caller can make this process buffer, and
 * nothing else needs more than 1 MB - so it stays. The importer does: 5,000
 * rows is the advertised limit, and a 5,000-row contact file is 2-4 MB of JSON
 * (import-body-limit.spec.ts measures it), so imports failed with a bare 413 far
 * below the row limit the console promised.
 *
 * ── WHY IT WORKS ────────────────────────────────────────────────────────────
 *
 * Mounted BEFORE the global parser (main.ts), it reads the body first; the
 * global `jsonParser` that runs next sees a request whose body has already
 * been consumed (body-parser 2 checks `onFinished.isFinished(req)`) and passes
 * it through untouched, so its 1 MB cap never applies to this path - and still
 * applies to every other one. Nest's own default parser is not added at init
 * either, because a `jsonParser` layer already exists (it checks by name).
 * The route's guards are unaffected: this runs before routing, as the global
 * parser always did, and does nothing but parse.
 *
 * `express` here is the copy @nestjs/platform-express itself runs on, loaded
 * from that package's own resolution: apps/api does not depend on express
 * directly (pnpm would not resolve it from here), and a second copy would be a
 * second body-parser with its own defaults.
 */
export function importRunBodyParser(): RequestHandler {
  const fromNest = createRequire(require.resolve("@nestjs/platform-express"));
  const express = fromNest("express") as { json(options: { limit: number }): RequestHandler };
  return express.json({ limit: IMPORT_RUN_MAX_BYTES });
}

/** Mount it. Must run before `app.useBodyParser("json", ...)` in main.ts. */
export function mountImportBodyParser(app: { use(path: string, handler: RequestHandler): unknown }): void {
  app.use(IMPORT_RUN_PATH, importRunBodyParser());
}
