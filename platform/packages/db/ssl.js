/**
 * One TLS rule for every Postgres connection we open (CJS copy for the plain
 * node scripts; packages/db/src/index.ts has the identical logic for the pools).
 *
 * Managed Postgres — Supabase included — refuses plaintext connections, while
 * the local docker instance has no certificate at all. Rather than sprinkling
 * `?sslmode=` through connection strings, decide from the host: anything that
 * isn't loopback or a compose service name gets TLS.
 *
 * rejectUnauthorized is false because Supabase serves a cert chain that isn't in
 * Node's default store; the connection string's host is what identifies the
 * project. Set DB_SSL_CA to a PEM path for full verification.
 */
const fs = require("node:fs");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db"]);

function sslFor(connectionString) {
  if (process.env.DB_SSL === "0") return undefined;
  let host;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
  if (process.env.DB_SSL !== "1" && LOCAL_HOSTS.has(host)) return undefined;
  if (process.env.DB_SSL_CA) {
    return { ca: fs.readFileSync(process.env.DB_SSL_CA, "utf8"), rejectUnauthorized: true };
  }
  return { rejectUnauthorized: false };
}

module.exports = { sslFor };
