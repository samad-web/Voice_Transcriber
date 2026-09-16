# Vendored upstream

`upstream/` is a copy of [supabase/supabase](https://github.com/supabase/supabase)`/docker`,
taken verbatim and committed. **Nothing in it is edited.** Every Aura-specific
change lives in `docker-compose.aura.yml`, which is applied as a compose overlay.

| | |
|---|---|
| Commit | `a351a36e9b35b53f8dbbbb33d6e8e2ac3a3b9144` |
| Vendored | 2026-09-07 |
| Gateway | Envoy (`api-gw`), which upstream now uses instead of Kong |

## Why vendored rather than cloned at deploy time

Supabase's own instructions are `git clone --depth 1 supabase/supabase` on the
box. That means the version running in production is whatever `master` happened
to be on the day someone last ran it, with no record of which one that was and
no way to reproduce it.

Postgres image tags matter here in a way they do not for a stateless service: a
`db` container that comes back on a different major version will not start
against an existing data directory, and finding that out during a restart is a
bad time to learn which version you were on. Pinning it in git means the answer
is `git log`.

## What was taken

The default (Envoy) stack only. Deliberately omitted:

- `docker-compose.kong.yml`, `.pgbouncer.yml`, `.pg15.yml`, `.logs.yml`,
  `.caddy.yml`, `.rustfs.yml` — alternative topologies we do not run.
- `dev/`, `CHANGELOG.md`, `CONFIG.md`, `versions.md` — 200KB of documentation
  that is better read on GitHub than in this repo's diffs.
- `setup.sh`, `run.sh`, `update.sh`, `reset.sh` — they assume they own the
  compose project, the `.env` file and the volumes. `bin/` here does the same
  jobs against Aura's layout.
- `utils/` — kept out for the same reason, but `utils/db-passwd.sh` and
  `utils/upgrade-pg17.sh` are worth reading from upstream before you ever
  rotate the Postgres password or change its major version.

`docker-compose.s3.yml` and `docker-compose.nginx.yml` are vendored but unused —
they document how upstream expects those two things to be wired, and both are
relevant if Supabase Storage is ever pointed at the platform's MinIO.

## Refreshing

1. Read upstream's `CHANGELOG.md` for the range you are crossing. Postgres major
   version bumps and GoTrue schema migrations are the two that need a plan
   rather than a pull.
2. Re-download at the new commit into `upstream/`, keeping the same file list.
3. `docker compose --env-file .env.selfhost -f upstream/docker-compose.yml -f docker-compose.aura.yml config`
   and diff against the previous output. **Check the published ports first** —
   upstream publishes the gateway and Postgres on `0.0.0.0`, and
   `docker-compose.aura.yml` neutralises that with `ports: !override`. A service
   renamed upstream silently loses its override, and the symptom is Postgres on
   the public internet with no error anywhere.
4. Update the commit and date in the table above.
5. `bash bin/verify-selfhost.sh` after the stack restarts. Check 1 exists for
   exactly the failure in step 3.

## The one modification that is not in the overlay

None. If that changes, record it here — an undocumented edit under `upstream/`
is invisible at refresh time and will be silently reverted.
