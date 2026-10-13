-- 0199_growth_mandate_reprice.sql - put Growth under the bank's auto-debit
-- ceiling so it can be sold and renewed with nobody on our side.
--
-- ── WHY A PRICE LIVES IN A MIGRATION AT ALL ─────────────────────────────────
--
-- It does not, really. `plan_prices` is seeded but UNREAD - `quoteSubscription`
-- resolves against the `CAPTURE_PLANS` constant in packages/shared/src/pricing.ts,
-- and that is where this change actually takes effect. This migration exists so
-- the seeded table does not sit there contradicting the code: an operator who
-- reads `plan_prices` to answer "what does Growth cost" should not get an answer
-- the checkout disagrees with. `plan_entitlements` is a different matter - that
-- one IS read, and a stale 200 there would meter a customer for hours they are
-- no longer sold.
--
-- ── WHAT CHANGED AND WHY ────────────────────────────────────────────────────
--
-- RBI's e-mandate framework clears a recurring debit without the customer
-- re-authenticating only up to ₹15,000, and the ₹1,00,000 carve-out is for
-- insurance, mutual funds and credit-card bills - not software. The debit is
-- GST-INCLUSIVE, so the ceiling on a list price is ₹15,000 / 1.18 = ₹12,711.
--
-- Growth was ₹19,999 for 200 hours, which debits ₹23,599 and would hand every
-- customer a bank authentication link on every single renewal. It is now
-- ₹12,699 for 185 hours: ₹14,985 debited, and ~21% margin against Sarvam
-- diarized at an effective ₹54 an audio-hour, which is the margin the project
-- owner accepted on 2026-10-13 when trading it for a tier that renews itself.
--
-- 185 rather than 200 is not a rounding: at 200 hours the margin is 15%.
--
-- Nothing here touches an existing subscriber's entitlements row. Orgs already
-- on capture_growth keep whatever `org_subscriptions`/`org_addon_grants` gave
-- them until their plan is re-applied; this changes what the CATALOGUE sells.

BEGIN;

-- The unread-but-visible price table, brought into line with pricing.ts.
-- Keyed on plan_id, and the column is `annual_monthly_minor` - every number on
-- this price list is the annual-cadence MONTHLY rate, which is the whole reason
-- an annual Growth subscription fits under a ₹15,000 mandate at all.
UPDATE plan_prices
   SET annual_monthly_minor = 1269900,
       updated_at = now()
 WHERE plan_id = (SELECT id FROM plans WHERE key = 'capture_growth')
   AND region = 'IN';

-- The read one. A stale 200 here meters hours that are no longer sold.
--
-- Restated as the whole blob, with the same marker and the same expand-from-CTE
-- shape 0197 uses, because packages/shared/src/entitlements.test.ts reads the
-- LATEST migration that restates a plan and diffs it against PLAN_SEED. A
-- surgical one-key UPDATE would leave that check reading 0197's superseded 200
-- forever, which is precisely the drift the check exists to catch.
WITH seed(plan_key, entitlements) AS (VALUES
  -- PLAN_SEED_CAPTURE_GROWTH
  ('capture_growth', '{
    "active_telecallers":          {"limit": null},
    "dashboard_logins":            {"limit": null},
    "ingest_events_monthly":       {"limit": 0, "per": "month"},
    "api_rate_per_min":            {"limit": 300, "per": "minute"},
    "history_retention":           {"months": null},
    "selectable_kpis":             {"limit": 6},
    "custom_kpis":                 {"enabled": true},
    "team_structure":              {"enabled": true, "variant": "teams"},
    "export_formats":              {"enabled": true, "variant": "csv_excel_pdf"},
    "scheduled_reports":           {"enabled": true, "variant": "unlimited_branded"},
    "threshold_alerts":            {"enabled": true, "variant": "email_whatsapp_escalation"},
    "outgoing_webhooks":           {"enabled": true},
    "import_center":               {"enabled": true, "variant": "advanced"},
    "manual_quality_scoring":      {"enabled": true},
    "revenue_summary":             {"enabled": true, "variant": "full"},
    "audit_log_window":            {"months": 12},
    "sso":                         {"enabled": false},
    "ip_allowlist":                {"enabled": false},
    "white_label":                 {"enabled": false},
    "handset_pairing":             {"enabled": true},
    "paired_handsets":             {"limit": 4},
    "crm":                         {"enabled": true},
    "ai_features":                 {"enabled": true},
    "transcription_hours_monthly": {"limit": 185, "per": "month"},
    "audio_retention_days":        {"days": 90},
    "storage_cap_gb":              {"limit": 15},
    "speaker_separation":          {"enabled": true}
  }'::jsonb)
-- PLAN_SEED_END_0199
)
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_type, value)
SELECT p.id, e.key, pe.limit_type, e.value
  FROM seed s
  JOIN plans p ON p.key = s.plan_key
  CROSS JOIN LATERAL jsonb_each(s.entitlements) AS e(key, value)
  JOIN plan_entitlements pe ON pe.plan_id = p.id AND pe.entitlement_key = e.key
ON CONFLICT (plan_id, entitlement_key) DO UPDATE SET
  value      = EXCLUDED.value,
  updated_at = now();

-- Growth must now debit under the ceiling, or this migration has not done its
-- job. ₹12,699 + 18% = ₹14,984.82. Asserted rather than trusted, because the
-- whole point of the re-price is a number staying on one side of a line.
DO $$
DECLARE net bigint; gross numeric;
BEGIN
  SELECT annual_monthly_minor INTO net
    FROM plan_prices
   WHERE plan_id = (SELECT id FROM plans WHERE key = 'capture_growth')
     AND region = 'IN';
  gross := net * 1.18;
  IF gross > 1500000 THEN
    RAISE EXCEPTION '0199: Growth debits %, over the Rs15,000 e-mandate ceiling', gross / 100;
  END IF;
END $$;

-- And the metered hours must match what the price list sells.
DO $$
DECLARE h int;
BEGIN
  SELECT (value ->> 'limit')::int INTO h
    FROM plan_entitlements
   WHERE plan_id = (SELECT id FROM plans WHERE key = 'capture_growth')
     AND entitlement_key = 'transcription_hours_monthly';
  IF h IS DISTINCT FROM 185 THEN
    RAISE EXCEPTION '0199: Growth meters % hours, expected 185', h;
  END IF;
END $$;

COMMIT;
