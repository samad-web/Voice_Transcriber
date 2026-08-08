// ESLint, one flat config for the whole workspace (08_ROAD_TO_10.md §1.1).
//
// THE DIAL IS SET DELIBERATELY LOW. This is ~20,000 lines of TypeScript that
// has never been linted. A maximal config — recommendedTypeChecked, say —
// produces four figures of errors on day one, most of them `no-unsafe-*` on
// `pg` query rows that are genuinely `any`, and the whole thing gets switched
// off within a week. So: the recommended set, three type-aware rules that each
// catch a real class of production bug, and nothing stylistic (Prettier owns
// that — see .prettierrc.json).
//
// The three type-aware rules earn their keep here specifically:
//   no-floating-promises  the worker's pipeline is all async; a dropped await
//                         on a stage means the call advances before its work
//                         finished, with no error anywhere.
//   no-misused-promises   an async function passed where a sync callback is
//                         expected (Nest interceptors, setInterval sweeps)
//                         swallows rejections silently.
//   await-thenable        an `await` on a non-Promise is almost always a
//                         forgotten call — `await this.foo` vs `await this.foo()`.
//
// Anything promoted beyond this should be promoted one rule at a time, with the
// cleanup that makes it pass, not as a config-wide flip.
//
// NO REACT / NEXT / JSX-A11Y PLUGINS ARE REGISTERED, and apps/web is linted by
// this config alone — there is no eslint-config-next anywhere in the workspace.
// The consequence is easy to trip over: an inline
// `// eslint-disable-next-line @next/next/no-img-element` (or any jsx-a11y rule)
// is not a harmless no-op, it is a hard ESLint ERROR — "Definition for rule not
// found" — because ESLint refuses to disable a rule it cannot resolve. Two of
// those had been sitting in apps/web since before this config existed and
// became build-breaking the moment it landed. So: do not write a disable
// comment naming a rule from a plugin that is not in this file. If you want
// those rules, add the plugin here and to the lockfile first.

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

export default tseslint.config(
  {
    // Global ignores. `dist`/`.next` are build output; the .d.ts files in them
    // are generated. Migrations are SQL and the supabase/ tree is a byte-exact
    // copy of packages/db/migrations (see .prettierignore for why).
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/build/**",
      "**/coverage/**",
      "**/*.d.ts",
      "packages/db/migrations/**",
      "supabase/**",
    ],
  },

  // ---------------------------------------------------------------------------
  // Plain CommonJS scripts: packages/db/{migrate,seed,verify-rls,ssl,...}.js and
  // scripts/*.js. These are deliberately not TypeScript — they run with bare
  // `node` in the migrate container, before anything is compiled.
  // ---------------------------------------------------------------------------
  {
    files: ["**/*.js", "**/*.cjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
  },

  // ---------------------------------------------------------------------------
  // TypeScript, everywhere. Syntax-only rules: no type information required, so
  // this block also covers any future file that is not in a tsconfig yet.
  // ---------------------------------------------------------------------------
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.recommended],
    plugins: { import: importPlugin },
    rules: {
      // WARN, not error. The pg driver hands back `any` rows and the LLM
      // providers return unvalidated JSON; a hard error here would be noise
      // proportional to how much of the codebase touches a database. Typing
      // those boundaries properly is Stage 2/3 work, not a lint sweep.
      "@typescript-eslint/no-explicit-any": "warn",

      // Unused code is real dead weight, but a leading underscore is the
      // established way to say "required by the signature, not used" — Nest
      // lifecycle hooks and Express middleware both need it.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],

      // Import ordering only — the resolver-dependent rules (no-unresolved and
      // friends) would need eslint-import-resolver-typescript to understand the
      // workspace links and the web app's `@/*` alias, and a wrong answer there
      // is worse than no answer. WARN because it is the one rule here most
      // likely to fire on files nobody is otherwise touching.
      "import/order": [
        "warn",
        {
          groups: ["builtin", "external", "internal", "parent", "sibling", "index"],
          // Without a resolver, `@aura/shared` looks like any other scoped
          // package. Pin the workspace packages and the web alias into the
          // internal group so the order is deterministic. Excluding only
          // "builtin" from pathGroups is required for these to apply at all —
          // the default also excludes "external", which is what @aura/* is
          // classified as.
          pathGroups: [
            { pattern: "@aura/**", group: "internal", position: "before" },
            { pattern: "@/**", group: "internal" },
          ],
          pathGroupsExcludedImportTypes: ["builtin"],
          // "ignore", not "always": the existing code writes its imports as one
          // contiguous block. Enforcing blank lines between groups would touch
          // nearly every file for zero defect value.
          "newlines-between": "ignore",
        },
      ],
      "import/no-duplicates": "warn",
    },
  },

  // ---------------------------------------------------------------------------
  // Type-aware rules. Scoped to the directories that a tsconfig actually
  // includes ("src" for every package, the whole tree for apps/web) — the
  // project service throws on a file no tsconfig owns, so a new top-level
  // directory (platform/tests/, say) must degrade to syntax-only linting rather
  // than crash `pnpm lint` for everybody.
  // ---------------------------------------------------------------------------
  {
    files: [
      "apps/api/src/**/*.ts",
      "apps/worker/src/**/*.ts",
      "apps/web/**/*.{ts,tsx}",
      // apps/marketing has the same shape as apps/web — its tsconfig includes
      // the whole tree — so it gets the same type-aware rules. Without this
      // line the new app is linted syntax-only and silently misses
      // no-floating-promises, which is the rule slice 4's server actions will
      // most need.
      "apps/marketing/**/*.{ts,tsx}",
      "packages/*/src/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
);
