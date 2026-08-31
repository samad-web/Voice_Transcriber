# Rollback scripts

Hand-run reversals, one per migration that has one. **Deliberately not in
`packages/db/migrations/`**: `migrate.js` applies every `migrations/*.sql` in
filename order, so a `0075_down.sql` sitting beside `0075_boards.sql` would
create the tables and then immediately drop them on the very next statement.
`scripts/sync-supabase-migrations.js` would mirror it into Supabase too.

Run one by hand, against a database you have checked twice:

    psql "$DATABASE_URL" -f packages/db/rollback/0075_down.sql

Each file's header states what it restores and what it deliberately leaves
standing — audit history and human corrections are kept, not dropped.
