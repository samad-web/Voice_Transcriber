/**
 * Set the runtime role's password from the environment.
 *
 * 0001_init.sql creates `aura_app` with a well-known DEV password so a local
 * `pnpm setup` just works. That password must never survive into a real
 * deployment, and it cannot live in a migration file either — so production
 * bootstrapping is this one idempotent step:
 *
 *   DATABASE_URL=<owner conn>  APP_DB_PASSWORD=<strong secret>  node bootstrap-role.js
 *
 * Run it after `pnpm db:migrate`, then point APP_DATABASE_URL at the same
 * password. Re-running is safe (it only ALTERs).
 */
const { Client } = require("pg");
const { sslFor } = require("./ssl");

const ROLE = process.env.APP_DB_ROLE ?? "aura_app";
if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) {
  console.error("APP_DB_ROLE must be a lower_snake_case identifier");
  process.exit(1);
}
const DEV_PASSWORD = "aura_app_password";

async function main() {
  const url = process.env.DATABASE_URL;
  const password = process.env.APP_DB_PASSWORD;

  if (!url) throw new Error("DATABASE_URL (owner connection) is required");
  if (!password) throw new Error("APP_DB_PASSWORD is required");
  if (password === DEV_PASSWORD) {
    throw new Error("APP_DB_PASSWORD is still the dev password — generate a real secret");
  }
  if (password.length < 24) {
    throw new Error("APP_DB_PASSWORD must be at least 24 characters");
  }
  // CREATE/ALTER ROLE cannot take a bind parameter for the password, so it has
  // to be inlined — restrict the alphabet instead of trying to escape it.
  if (!/^[A-Za-z0-9_\-.~!@#%^*+=]+$/.test(password)) {
    throw new Error(
      "APP_DB_PASSWORD may only contain letters, digits and _-.~!@#%^*+= " +
        "(quotes and backslashes are rejected because the password is inlined into SQL)",
    );
  }

  const client = new Client({ connectionString: url, ssl: sslFor(url) });
  await client.connect();

  const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
  if (rows.length === 0) {
    await client.query(
      `CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`,
    );
    console.log(`created role ${ROLE}`);
  } else {
    await client.query(`ALTER ROLE ${ROLE} PASSWORD '${password}'`);
    console.log(`rotated password for ${ROLE}`);
  }

  // NOBYPASSRLS is the whole point of this role — assert it rather than assume.
  const {
    rows: [role],
  } = await client.query(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1",
    [ROLE],
  );
  if (role.rolsuper || role.rolbypassrls) {
    throw new Error(`${ROLE} can bypass RLS — tenant isolation would be silently off`);
  }

  console.log(`ok: ${ROLE} is a non-superuser, RLS-bound login role`);
  await client.end();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
