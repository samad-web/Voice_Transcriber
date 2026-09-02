/**
 * Publish an Android APK to the fleet's self-update channel (migration 0081).
 *
 * Uploads the file to object storage, records its digest, and optionally flips
 * it live. Handsets pick it up on their next /v1/devices/me/update poll (~1h)
 * and offer it to whoever is holding the phone.
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

const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
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

async function setPublished(pool, versionCode, published) {
  const { rows } = await pool.query(
    `UPDATE app_releases SET published = $2 WHERE version_code = $1
      RETURNING version_code, version_name`,
    [versionCode, published],
  );
  if (rows.length === 0) throw new Error(`no release with version_code ${versionCode}`);
  console.log(
    `${published ? "Published" : "Unpublished"} v${rows[0].version_name} (code ${rows[0].version_code})`,
  );
  if (!published) {
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
    console.log(`LIVE: v${versionName} (code ${versionCode}) - the fleet is offered it within ~1h.`);
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
