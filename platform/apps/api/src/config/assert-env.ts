/**
 * Boot-time environment assertion (checklist 08 §0.2).
 *
 * Several call sites default a secret to a literal when its variable is unset:
 * `common/admin-key.guard.ts` (ADMIN_API_KEY), and `common/device-auth.guard.ts`,
 * `common/device-nonce.ts`, `modules/devices/devices.controller.ts`,
 * `modules/tenancy/erasure.controller.ts` (JWT_SECRET). Those defaults exist so
 * `pnpm dev` works with no setup, which is worth keeping - right up until the
 * same image boots in production with one variable missing, at which point a
 * string published in this repository is a working root credential on the open
 * internet. There is no compose flag, no typo and no fresh container that makes
 * that survivable.
 *
 * So the fix is not to delete the dev defaults (that turns local dev into a
 * config exercise) but to make it impossible to REACH production carrying them.
 * This runs as the first statement of bootstrap(), before NestFactory.create,
 * and throws - the container dies in its restart loop instead of serving.
 * A crashed container is a strictly better outcome than an open one.
 *
 * ORDERING NOTE. In production the values are real process environment
 * variables: docker-compose.prod.yml gives every node service `env_file:
 * .env.production`, so Docker populates the environment before node starts and
 * this check sees exactly what the guards will later see. In development
 * `ConfigModule.forRoot({ envFilePath: [...] })` loads `platform/.env` during
 * NestFactory.create - i.e. AFTER this runs - so a var supplied only by that
 * file reads as unset here. That is precisely why the non-production branch
 * only warns and never throws: outside production this output is a heads-up,
 * not a verdict.
 */

/** A variable whose absence or dev value is a security hole, not a missing feature. */
interface RequiredVar {
  name: string;
  /** What is exposed when this one is wrong - the operator needs the stakes, not just the name. */
  why: string;
  /** Exact values that must never reach production (case-insensitive). */
  rejected: string[];
  /** Substrings that only ever appear in an uncustomised example value. */
  rejectedContains?: string[];
}

/**
 * Every literal below is copied from a file that ships in this repo -
 * `.env.example`, `.env.production.example`, or the `??` fallback in the code
 * itself. Anything published is, by definition, not a secret.
 */
const REQUIRED: RequiredVar[] = [
  {
    name: "ADMIN_API_KEY",
    why:
      "AdminKeyGuard mints a platform_admin principal for whoever presents it, " +
      "with x-org-id trusted - it reads and writes every tenant's data",
    rejected: ["dev-admin-key", "replace-with-a-long-random-key"],
  },
  {
    name: "JWT_SECRET",
    why:
      "signs device access tokens, the enrollment nonces, and the erasure receipt HMAC - " +
      "anyone holding it can mint a token for any device in any tenant",
    rejected: [
      "dev-jwt-secret-change-me",
      "dev-secret",
      "changeme",
      "replace-with-a-long-random-secret",
    ],
  },
  {
    name: "CRM_SECRET_KEY",
    why:
      "seals stored CRM credentials with AES-256-GCM; unset means customer CRM API keys " +
      "sit in the database in plaintext",
    rejected: ["dev-crm-secret-key-not-for-production", "replace-with-openssl-rand-hex-32"],
  },
  {
    name: "APP_DATABASE_URL",
    why:
      "the non-superuser runtime role is the only thing that makes RLS bind; " +
      "falling back to the owner connection silently disables tenant isolation",
    rejected: ["postgresql://aura_app:aura_app_password@localhost:5433/callintel"],
    // The production example ships with these two tokens still in the URL.
    rejectedContains: ["PROJECTREF", "APP_DB_PASSWORD_VALUE"],
  },
  {
    name: "DATABASE_URL",
    why:
      "the RLS-bypassing admin pool (getAdminPool in packages/db) - used for cross-tenant admin " +
      "routes, enrollment, and webhook lookups before an org is known - falls back to a published " +
      "owner-credential connection string, unset means anyone who can reach the DB port has it",
    rejected: ["postgresql://aura:aura_dev_password@localhost:5433/callintel"],
  },
  {
    name: "S3_ACCESS_KEY_ID",
    why: "falls back to the published MinIO dev literal, same class of risk as the other keys here",
    rejected: ["aura_minio"],
  },
  {
    name: "S3_SECRET_ACCESS_KEY",
    why:
      "falls back to the published MinIO dev literal - unset, recordings and any S3-backed data " +
      "sit behind a credential anyone can read in this repo",
    rejected: ["aura_minio_password"],
  },
];

/**
 * Advisory only, in every environment. 08 §0.2 lists SUPABASE_URL alongside the
 * four above, but an unset Supabase key CLOSES a feature (owner sign-ins can be
 * listed but not created - see modules/owner/supabase-admin.service.ts) rather
 * than opening a door, and crashing a live API over a provisioning capability
 * would be a self-inflicted outage. It warns loudly and keeps serving.
 */
const RECOMMENDED: { name: string; why: string }[] = [
  { name: "SUPABASE_URL", why: "owner sign-ins cannot be provisioned without it" },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    why: "owner sign-ins cannot be provisioned without it",
  },
];

/** Prefixes that only ever begin an example value nobody filled in. */
const PLACEHOLDER_PREFIXES = ["replace-with", "your-", "changeme", "change-me", "todo"];

/**
 * Secrets shorter than this are weak, but length is NOT fatal: refusing to boot
 * over a short-but-real key would take a live platform down to fix a weakness it
 * is already living with, and the operator cannot rotate it while the API is in
 * a crash loop. Warn, and let 08 §0.3 (rotation) deal with it.
 */
const MIN_SECRET_LENGTH = 24;
const LENGTH_CHECKED = new Set(["ADMIN_API_KEY", "JWT_SECRET", "CRM_SECRET_KEY"]);

/**
 * Describes what is wrong with a value, or null when it is acceptable.
 *
 * Only ever names the marker it matched, never the value itself - a real secret
 * must not end up in a log line or a crash trace.
 */
function inspect(variable: RequiredVar, raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return "is not set (or is empty)";

  const lowered = value.toLowerCase();
  for (const rejected of variable.rejected) {
    if (lowered === rejected.toLowerCase()) {
      return `is the published example value "${rejected}"`;
    }
  }
  for (const marker of variable.rejectedContains ?? []) {
    if (value.includes(marker)) {
      return `still contains the example placeholder "${marker}"`;
    }
  }
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      return `looks like an unfilled placeholder (begins "${prefix}")`;
    }
  }
  return null;
}

/**
 * Fails the process in production when any credential is missing or is a known
 * dev/example value; warns and continues everywhere else.
 *
 * Reports EVERY offending variable in one error. An operator staring at a
 * restart loop should need one pass over the env file, not four deploys.
 */
export function assertRequiredEnv(env: NodeJS.ProcessEnv = process.env): void {
  const production = env.NODE_ENV === "production";

  const fatal: string[] = [];
  const advisory: string[] = [];

  for (const variable of REQUIRED) {
    const problem = inspect(variable, env[variable.name]);
    if (problem) {
      fatal.push(`  ${variable.name} ${problem}\n      → ${variable.why}`);
      continue;
    }
    const value = env[variable.name]!.trim();
    if (LENGTH_CHECKED.has(variable.name) && value.length < MIN_SECRET_LENGTH) {
      advisory.push(
        `${variable.name} is only ${value.length} characters; use at least ${MIN_SECRET_LENGTH} ` +
          `(openssl rand -base64 36 | tr -d '/+=' | head -c 40)`,
      );
    }
  }

  for (const variable of RECOMMENDED) {
    if (!env[variable.name]?.trim()) {
      advisory.push(`${variable.name} is not set - ${variable.why}`);
    }
  }

  for (const note of advisory) console.warn(`[env] WARNING: ${note}`);

  if (fatal.length === 0) return;

  if (production) {
    throw new Error(
      [
        `Refusing to start: ${fatal.length} required environment variable(s) are unset or still ` +
          `hold a development default. Under NODE_ENV=production each of these is a credential ` +
          `published in this repository, so the API would be serving customer data behind a key ` +
          `anyone can read.`,
        "",
        ...fatal,
        "",
        "Fix all of them in platform/.env.production (see .env.production.example) and redeploy.",
      ].join("\n"),
    );
  }

  for (const problem of fatal) {
    console.warn(`[env] WARNING:${problem.replace(/\n\s+/g, "\n[env]          ")}`);
  }
  console.warn(
    "[env] The above are development defaults. Each one is FATAL under NODE_ENV=production. " +
      "(In dev, values supplied only by platform/.env are loaded later by ConfigModule and may " +
      "read as unset here.)",
  );
}
