-- 0103_lead_permissions.sql - the permission grid reaches the lead board.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
--
-- `role_permissions` (0039) has governed the CRM object model since it was
-- built, and nothing else. Every `@RequireCrmPermission` in the API names
-- contact / account / deal / task / conversation / product / quotation /
-- invoice - and NOT `leads`, which is the surface an Aura tenant actually
-- spends the day in.
--
-- So the console's Roles & permissions screen was, for the average customer,
-- a screen about a part of the product they use least. An owner could set
-- forty checkboxes and change nothing about who may read or move a lead. That
-- was answered by the console PERSONA alone, which is a much blunter
-- instrument: it has five values and they are about which desk somebody sits
-- at, not about what they may do once they are there.
--
-- ── WHY THIS NEEDS A MIGRATION AND NOT JUST A DECORATOR ─────────────────────
--
-- `CrmPermissionsGuard` denies whatever it finds no grant for. Mounting it on
-- the leads controller without seeding `lead` grants first would 403 every
-- user in every tenant on the console's most-used page, the moment the API
-- container restarted. 0041's header says exactly this about `task`, and it is
-- the one failure mode this file exists to prevent.
--
-- ── HOW THE GRANTS ARE DERIVED ──────────────────────────────────────────────
--
-- Not from a fixed table of what each system role "should" have. From what
-- each role ALREADY HOLDS, so that the grid after this migration permits
-- exactly what the product permitted before it.
--
-- A role gets `lead:<action>` if it holds `contact:<action>` OR `deal:<action>`,
-- at the WIDER of the two scopes. The union rather than either one alone
-- because a role stripped of contacts but not deals (or the reverse) is a real
-- configuration, and taking the intersection would narrow it on both counts.
--
-- Custom roles are included. They are seeded by the same rule as the system
-- five, because "this migration must not change what anybody can do" applies
-- to a role a customer defined exactly as much as to one we shipped.
--
-- ── AND THE BACKSTOP ────────────────────────────────────────────────────────
--
-- A role holding NEITHER contact nor deal grants would come out of the rule
-- above with nothing, and its holders would lose the lead board. Yesterday
-- they had it. So such a role gets `lead:view` and `lead:edit` at `all` -
-- which is what the persona already allowed them, no more.
--
-- Over-granting to exactly yesterday's behaviour is the right direction for a
-- migration. Narrowing it is then a deliberate act by an owner on a screen
-- that finally does something, rather than a surprise delivered by a deploy.

-- ── The derived grants ──────────────────────────────────────────────────────
--
-- `scope` takes min() over the text, which puts 'all' before 'owned'
-- alphabetically and therefore picks the WIDER of the two. The same tie-break
-- CrmPermissionsGuard's own ORDER BY uses, and for the same reason: two
-- grants means somebody was given both, and silently applying the narrower one
-- is a lockout nobody configured.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT rp.org_id, rp.role_id, 'lead', rp.action, min(rp.scope)
  FROM role_permissions rp
 WHERE rp.object_type IN ('contact', 'deal')
   -- Only the actions the API actually enforces for a lead. The leads
   -- controller has five routes - four reads and one PATCH - so `create`,
   -- `delete` and `export` would be rows no code ever reads. The console
   -- renders those cells as inert (see ENFORCED_PERMISSIONS); writing them
   -- here would contradict it.
   AND rp.action IN ('view', 'edit')
 GROUP BY rp.org_id, rp.role_id, rp.action
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── The backstop ────────────────────────────────────────────────────────────
--
-- Any role that came out of the rule above with no lead grants at all. Almost
-- always none; the exception is a custom role somebody built by hand with the
-- CRM objects stripped, and its holders must not lose the board.
INSERT INTO role_permissions (org_id, role_id, object_type, action, scope)
SELECT r.org_id, r.id, 'lead', a.action, 'all'
  FROM roles r
  CROSS JOIN (VALUES ('view'), ('edit')) AS a(action)
 WHERE NOT EXISTS (
        SELECT 1 FROM role_permissions rp
         WHERE rp.role_id = r.id AND rp.object_type = 'lead')
ON CONFLICT (role_id, object_type, action) DO NOTHING;

-- ── Prove it, rather than assume it ─────────────────────────────────────────
--
-- Every membership that can reach the console must resolve to at least one
-- `lead:view` grant after this runs, through the same join the guard uses -
-- including its `role_id IS NULL` fallback to matching `roles.key` against the
-- legacy `memberships.role` string.
--
-- Raised as a WARNING rather than an exception, deliberately. This migration
-- runs inside the deploy's migrate job; aborting it would leave the schema
-- half-applied and the deploy dead, to fix a data condition that is visible
-- and repairable from the console afterwards. A loud count in the deploy log
-- is what somebody can act on.
DO $do$
DECLARE stranded int;
BEGIN
  SELECT count(*) INTO stranded
    FROM memberships m
    JOIN organizations o ON o.id = m.org_id AND 'aura' = ANY(o.enabled_modules)
   WHERE m.status = 'active'
     AND NOT EXISTS (
       SELECT 1
         FROM roles r
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = 'lead' AND rp.action = 'view'
        WHERE r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
     );

  IF stranded > 0 THEN
    RAISE WARNING '0103: % membership(s) would lose the lead board - grant lead:view to their role', stranded;
  ELSE
    RAISE NOTICE '0103: every active membership resolves to a lead:view grant';
  END IF;
END $do$;
