#!/usr/bin/env node
/**
 * Tenancy invariants for the API surface (hardening plan §1.1).
 *
 * The tenant boundary used to live in ~70 hand-written `orgIdFromHeader(...)`
 * calls, one per handler, where forgetting one was silent rather than a
 * compile error. It now lives in `TenantGuard` + `@OrgId()`. These checks stop
 * the old shape from creeping back in — they are grep, not tests, and cost
 * nothing to run on every build.
 *
 *   1. No handler reads the `x-org-id` header itself.
 *   2. Every route authenticated by AdminKeyGuard is also tenant-scoped.
 *   3. `orgIdFromHeader` is gone and stays gone.
 *
 * Usage: node scripts/check-tenancy.js
 */
const fs = require("node:fs");
const path = require("node:path");

const API_SRC = path.join(__dirname, "..", "apps", "api", "src");
const MODULES = path.join(API_SRC, "modules");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const failures = [];
const rel = (f) => path.relative(path.join(__dirname, ".."), f).split(path.sep).join("/");

for (const file of walk(MODULES)) {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/);

  lines.forEach((line, i) => {
    const at = `${rel(file)}:${i + 1}`;

    // 1. Reading the header directly bypasses the guard's resolution — the
    //    admin-key path trusts that header, so a handler that reads it itself
    //    is deciding its own tenant again.
    if (/@Headers\(\s*["']x-org-id["']\s*\)|headers\[["']x-org-id["']\]/.test(line)) {
      failures.push(`${at}  reads x-org-id directly — inject @OrgId() instead`);
    }

    // 3. The old helper.
    if (/\borgIdFromHeader\b/.test(line)) {
      failures.push(`${at}  uses orgIdFromHeader — removed; use @OrgId()`);
    }

    // 2. Authentication without tenant scoping. @CrossTenant() is the opt-out,
    //    and it is checked at the route/class level by the guard itself, so the
    //    guard still has to be mounted.
    if (/@UseGuards\([^)]*\bAdminKeyGuard\b/.test(line) && !/\bTenantGuard\b/.test(line)) {
      failures.push(`${at}  AdminKeyGuard without TenantGuard — every authenticated route is tenant-scoped`);
    }
  });
}

if (failures.length > 0) {
  console.error(`tenancy check FAILED (${failures.length}):\n`);
  for (const f of failures) console.error("  " + f);
  console.error(
    "\nThe org is resolved once, by TenantGuard, from the authenticated principal.\n" +
      "A route that genuinely spans tenants marks itself @CrossTenant().",
  );
  process.exit(1);
}

console.log("tenancy check OK — no handler resolves its own org");
