/**
 * Minimal SQL migration runner. Runs as the ADMIN connection (DATABASE_URL),
 * which owns the tables; the app connects as `aura_app` (APP_DATABASE_URL).
 * Each migrations/*.sql file is applied once, in filename order, inside a
 * transaction, and recorded in schema_migrations.
 */
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { sslFor } = require("./ssl");

async function main() {
  const url =
    process.env.DATABASE_URL ??
    "postgresql://aura:aura_dev_password@localhost:5433/callintel";
  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );

  const dir = path.join(__dirname, "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const { rows } = await client.query("SELECT name FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.name));

  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    process.stdout.write(`applying ${file} ... `);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log("ok");
      ran++;
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(`FAILED\n${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
  console.log(ran === 0 && process.exitCode !== 1 ? "nothing to apply" : `${ran} migration(s) applied`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
