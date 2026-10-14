/**
 * Publish an Android APK to the fleet's self-update channel (migration 0081).
 *
 * Uploads the file to object storage, records its digest, and optionally flips
 * it live. Handsets pick it up on their next /v1/devices/me/update poll (~6h, on
 * wifi) and INSTALL IT WITHOUT ASKING on Android 12+ (between calls); older
 * phones get a tap-to-install notification. So --publish is the rollout itself:
 * install a build on one test handset by hand before publishing it.
 *
 * Runs inside the api/worker image, which already carries `pg`, the AWS SDK and
 * the same S3_* / DATABASE_URL environment the API uses:
 *
 *   docker cp Aura-1.1.0-4.apk aura-api-1:/tmp/
 *   docker exec aura-api-1 node scripts/publish-app-release.js /tmp/Aura-1.1.0-4.apk \
 *     --notes "Adds in-app updates" --publish
 *
 * Other modes:
 *   node scripts/publish-app-release.js --list          # what is uploaded / live
 *   node scripts/publish-app-release.js --unpublish 4   # stop offering build 4
 *   node scripts/publish-app-release.js --promote 4     # start offering build 4
 *
 * Uploading is NOT publishing. Without --publish the row lands with
 * published=false and no handset is offered it, so a build can be staged and
 * checked before the fleet sees it.
 *
 * ROLLBACK IS ASYMMETRIC, and this is worth knowing before you need it:
 * --unpublish stops the SPREAD, it does not undo an install. Android will not
 * downgrade an app, so phones that already took the build keep it. Recovering
 * those needs a NEW, higher versionCode carrying the old code.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// pnpm keeps node_modules isolated per package, so the AWS SDK - a dependency of
// apps/api, not of the workspace root - is not resolvable from this directory.
// Anchor the require on the api package instead of reaching for a relative path
// into its node_modules, which would be a different (and wronger) guess in the
// repo than in the runtime image.
const { createRequire } = require("node:module");
const apiRequire = createRequire(require.resolve("../apps/api/package.json"));
const { PutObjectCommand, S3Client } = apiRequire("@aws-sdk/client-s3");
// @aura/db is loaded by path rather than by name for the same reason; `pg`
// then resolves from that package's own node_modules, where it does live.
const { getAdminPool, closeAllPools } = require("../packages/db/dist/index.js");

const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

/** Same client shape as apps/api/src/s3/s3.service.ts - internal endpoint. */
function s3() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: process.env.S3_REGION ?? "ap-south-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
    },
  });
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

/**
 * `Aura-1.1.0-4.apk` -> { versionName: "1.1.0", versionCode: 4 }.
 *
 * The build names the file this way on purpose (app/build.gradle.kts renames
 * every release output), so the common path needs no flags and cannot disagree
 * with what is actually inside the APK. --version-code / --version-name
 * override it for a file that has been renamed in transit.
 */
function parseFilename(file) {
  const m = /^Aura-([0-9][0-9A-Za-z._-]*)-(\d+)\.apk$/.exec(path.basename(file));
  return m ? { versionName: m[1], versionCode: Number(m[2]) } : {};
}

async function list(pool) {
  const { rows } = await pool.query(
    `SELECT version_code, version_name, published, size_bytes, notes, created_at
       FROM app_releases ORDER BY version_code DESC`,
  );
  if (rows.length === 0) {
    console.log("No releases published yet.");
    return;
  }
  for (const r of rows) {
    console.log(
      [
        r.published ? "LIVE  " : "staged",
        `code ${String(r.version_code).padStart(4)}`,
        `v${r.version_name}`.padEnd(10),
        `${(Number(r.size_bytes) / 1048576).toFixed(1)} MB`,
        new Date(r.created_at).toISOString().slice(0, 10),
        r.notes ?? "",
      ].join("  "),
    );
  }
}

/**
 * Builds that must never reach a handset, and why.
 *
 * A denylist in code rather than a line in a memo, because the note "never
 * publish 1.2.0/code 10" has existed since 2026-10-01 and the only thing
 * enforcing it was somebody remembering at the moment of the rollout - which
 * is the moment least suited to remembering anything. --publish IS the
 * rollout: Android 12+ installs it unattended, between calls, and --unpublish
 * stops the spread without undoing a single install.
 *
 * Recovering a bad build therefore needs a NEW, HIGHER versionCode carrying
 * the old code. That asymmetry is what makes a cheap guard here worth more than
 * a careful human there.
 */
const NEVER_PUBLISH = new Map([
  [
    10,
    "1.2.0 / code 10 was superseded before it ever shipped (see phone-alerts-0150). " +
      "Publish 1.2.1 / code 11 or later instead.",
  ],
]);

async function setPublished(pool, versionCode, published) {
  if (published) {
    const forbidden = NEVER_PUBLISH.get(versionCode);
    if (forbidden) throw new Error(`refusing to publish code ${versionCode}: ${forbidden}`);

    /**
     * THE GUARD THE UPLOAD PATH HAS AND THIS ONE DID NOT.
     *
     * `setPublished` would promote any uploaded code, including one BELOW what
     * is already live. Every handset on the newer build would then be offered
     * an update its installer must refuse - Android will not downgrade - so the
     * fleet sits on a permanent update prompt that can never be satisfied, and
     * the only way out is yet another higher versionCode. The upload path
     * refuses this already; promoting a staged row skipped the same check.
     */
    const {
      rows: [live],
    } = await pool.query(
      "SELECT version_code, version_name FROM app_releases WHERE published AND version_code > $1 ORDER BY version_code DESC LIMIT 1",
      [versionCode],
    );
    if (live) {
      throw new Error(
        `code ${versionCode} is OLDER than the live v${live.version_name} (code ${live.version_code}). ` +
          "Android cannot downgrade, so this would offer the fleet an update every installer refuses. " +
          "To roll back, build a NEW higher versionCode carrying the old code.",
      );
    }
  }

  const { rows } = await pool.query(
    `UPDATE app_releases SET published = $2 WHERE version_code = $1
      RETURNING version_code, version_name`,
    [versionCode, published],
  );
  if (rows.length === 0) throw new Error(`no release with version_code ${versionCode}`);
  console.log(
    `${published ? "Published" : "Unpublished"} v${rows[0].version_name} (code ${rows[0].version_code})`,
  );
  if (published) {
    console.log(
      "This IS the rollout: Android 12+ installs it unattended, between calls, within ~6h.\n" +
        "There is no staged rollout and no canary. If this build is wrong, --unpublish stops\n" +
        "the spread but undoes no install - recovery needs a NEW higher versionCode.",
    );
  } else {
    console.log(
      "Note: handsets that already installed it keep it - Android cannot downgrade.",
    );
  }
}

async function main() {
  const pool = getAdminPool();

  if (has("list")) return list(pool);
  if (flag("unpublish")) return setPublished(pool, Number(flag("unpublish")), false);
  if (flag("promote")) return setPublished(pool, Number(flag("promote")), true);

  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    throw new Error("usage: publish-app-release.js <apk> [--version-code N] [--version-name X] [--notes ...] [--publish]");
  }
  if (!fs.existsSync(file)) throw new Error(`no such file: ${file}`);

  const fromName = parseFilename(file);
  const versionCode = Number(flag("version-code") ?? fromName.versionCode);
  const versionName = flag("version-name") ?? fromName.versionName;
  if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName) {
    throw new Error(
      `cannot determine version from "${path.basename(file)}".\n` +
        "Name it Aura-<versionName>-<versionCode>.apk, or pass --version-code and --version-name.",
    );
  }

  const forbidden = NEVER_PUBLISH.get(versionCode);
  if (forbidden && has("publish")) {
    throw new Error(`refusing to publish code ${versionCode}: ${forbidden}`);
  }
  if (forbidden) {
    console.warn(`WARNING: code ${versionCode} is on the never-publish list. ${forbidden}`);
  }

  const bytes = fs.readFileSync(file);
  // A zip local-file header. Catches the classic mistake of publishing the
  // build LOG, or an unsigned intermediate, before it reaches a single phone.
  if (bytes.subarray(0, 4).toString("hex") !== "504b0304") {
    throw new Error(`${path.basename(file)} is not an APK (no zip signature)`);
  }
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");

  // A code at or below what is already live would be offered to the fleet and
  // then refused by every installer - an update prompt that can never be
  // satisfied. Fail here instead.
  const {
    rows: [newest],
  } = await pool.query(
    "SELECT version_code, version_name FROM app_releases WHERE published ORDER BY version_code DESC LIMIT 1",
  );
  if (newest && versionCode <= newest.version_code) {
    throw new Error(
      `version_code ${versionCode} is not newer than the live v${newest.version_name} (code ${newest.version_code}). ` +
        "Bump versionCode in app/build.gradle.kts and rebuild.",
    );
  }

  const key = `app-releases/aura-${versionCode}.apk`;
  await s3().send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bytes,
      ContentType: "application/vnd.android.package-archive",
    }),
  );
  console.log(`Uploaded ${(bytes.length / 1048576).toFixed(1)} MB -> ${BUCKET}/${key}`);

  // ON CONFLICT so re-running after a failed publish replaces the staged row
  // rather than dying on the UNIQUE constraint. The digest is recomputed above,
  // so a re-upload of different bytes under the same code is recorded honestly.
  await pool.query(
    `INSERT INTO app_releases (version_code, version_name, object_key, sha256, size_bytes, notes, published)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (version_code) DO UPDATE
        SET version_name = EXCLUDED.version_name,
            object_key   = EXCLUDED.object_key,
            sha256       = EXCLUDED.sha256,
            size_bytes   = EXCLUDED.size_bytes,
            notes        = EXCLUDED.notes,
            published    = EXCLUDED.published,
            updated_at   = now()`,
    [versionCode, versionName, key, sha256, bytes.length, flag("notes") ?? null, has("publish")],
  );

  console.log(`sha256 ${sha256}`);
  if (has("publish")) {
    console.log(
      `LIVE: v${versionName} (code ${versionCode}) - handsets install it within ~6h ` +
        "(unattended on Android 12+, from a notification on older phones).",
    );
  } else {
    console.log(
      `Staged v${versionName} (code ${versionCode}). No handset sees it yet - ` +
        `run with --promote ${versionCode} to go live.`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => closeAllPools());
