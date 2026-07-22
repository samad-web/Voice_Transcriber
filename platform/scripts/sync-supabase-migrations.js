/**
 * Mirror packages/db/migrations/*.sql into supabase/migrations/ so the Supabase
 * CLI (`supabase db push`) and the dashboard's migration view can apply the
 * exact same SQL our own runner does.
 *
 * packages/db/migrations stays CANONICAL — this directory is generated, never
 * hand-edited. Supabase orders by the numeric prefix, so 0001 becomes
 * 20260101000001, 0002 becomes 20260101000002, and so on: stable across runs,
 * and always in our order.
 *
 *   node scripts/sync-supabase-migrations.js          # write
 *   node scripts/sync-supabase-migrations.js --check  # CI: fail if stale
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "packages", "db", "migrations");
const OUT = path.join(__dirname, "..", "supabase", "migrations");
/** Arbitrary fixed epoch — only the ordering matters to Supabase. */
const BASE = "2026010100";

const check = process.argv.includes("--check");

const files = fs.readdirSync(SRC).filter((f) => f.endsWith(".sql")).sort();
fs.mkdirSync(OUT, { recursive: true });

const expected = new Map();
for (const file of files) {
  const m = /^(\d{4})_(.+)\.sql$/.exec(file);
  if (!m) throw new Error(`migration ${file} must be named NNNN_name.sql`);
  const [, seq, name] = m;
  expected.set(`${BASE}${seq}_${name}.sql`, fs.readFileSync(path.join(SRC, file), "utf8"));
}

let stale = [];
for (const [name, sql] of expected) {
  const dest = path.join(OUT, name);
  const current = fs.existsSync(dest) ? fs.readFileSync(dest, "utf8") : null;
  if (current === sql) continue;
  stale.push(name);
  if (!check) fs.writeFileSync(dest, sql);
}
for (const orphan of fs.readdirSync(OUT).filter((f) => f.endsWith(".sql") && !expected.has(f))) {
  stale.push(`${orphan} (removed)`);
  if (!check) fs.unlinkSync(path.join(OUT, orphan));
}

if (check && stale.length) {
  console.error(`supabase/migrations is stale:\n  ${stale.join("\n  ")}\nrun: pnpm db:supabase:sync`);
  process.exit(1);
}
console.log(
  stale.length ? `synced ${stale.length} file(s) → supabase/migrations` : "supabase/migrations already up to date",
);
