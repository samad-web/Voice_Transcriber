# Telecaller Performance Section: Build Plan

## 1. Core idea: a KPI catalog plus owner configuration

Don't hard-code KPIs. Build a **catalog** of KPIs the system knows how to calculate, and let the owner **select and configure** 4-6 of them during setup. Everything downstream (scoring, dashboards, leaderboards) reads from that configuration.

## 2. Setup flow for the owner

The owner works through six steps, and the confirmed result becomes the configuration the scoring engine reads.

1. **Business type**: real estate, education, insurance, loans, etc. This pre-selects a recommended KPI set, which the owner can edit.
2. **Pick 4-6 KPIs** from the catalog, with a counter and a block after 6.
3. **Configure each KPI:**
    - Target (e.g. 80 calls/day)
    - Period (daily, weekly, monthly)
    - Weight (all weights must total 100%)
    - Direction (higher is better, or lower is better, e.g. complaints)
4. **Scope**: apply to everyone, or per team or role (the owner may want different targets for a senior and a new joiner).
5. **Rating bands**: e.g. below 60% = Needs improvement, 60-90% = On track, above 90% = Excellent.
6. **Review and confirm**, with a "KPI changes apply from [date]" notice so past data isn't rewritten.

## 3. KPI catalog

Each KPI is defined once in the system, so the owner only chooses and tunes it. Group the catalog into four categories: Activity, Quality, Result and Discipline. Consider requiring at least one Result KPI and one Activity KPI, so the owner can't pick a set that is easy to game.

| Field | Example |
| --- | --- |
| key | `connect_rate` |
| category | Activity / Quality / Result / Discipline |
| formula | connected calls ÷ dialed calls |
| data source | call logs |
| unit | % |
| direction | higher is better |

## 4. Data model (simplified)

The effective dates on the KPI configuration matter most: without them, changing a target next month would silently change last month's scores.

| Table | Purpose |
| --- | --- |
| `organization`, `user`, `team` | Users are telecaller, manager or owner |
| `call_log` | Caller, lead, start/end time, duration, outcome, recording URL |
| `lead` | Status, source, assigned_to, follow-up date |
| `conversion` | Lead, caller, value, date |
| `kpi_catalog` | The KPI definitions from section 3 |
| `org_kpi_config` | Org, KPI, target, weight, period, scope, effective_from, effective_to |
| `kpi_snapshot` | User, KPI, period, actual, target, achievement %, score; precomputed daily so dashboards load fast and history survives config changes |

## 5. Scoring engine

Each KPI gets an achievement percentage against its target (actual ÷ target), capped (e.g. at 120%) so one huge number can't hide weak areas. For "lower is better" KPIs, invert the formula.

```
overall score = Σ (achievement_i × weight_i)
```

This gives a single 0-100 score per telecaller. Org performance is the same engine rolled up: average or sum across telecallers, then per team and for the whole business.

Run it as a scheduled job (hourly or nightly) writing to `kpi_snapshot`, plus live counters for today's activity.

## 6. Screens

The telecaller sees their own progress first; the owner and manager see the org-wide picture.

**Telecaller view**

- Today's progress per KPI (progress bars against target)
- Overall score and rating band
- Trend vs last week/month
- Rank (optional; some owners won't want public leaderboards, so make it a setting)
- "What to do next": pending follow-ups

**Owner/manager view**

- Org scorecard: each KPI actual vs target
- Telecaller leaderboard with sort and filter (team, date range)
- Drill-down from a telecaller to their calls, leads and recordings
- Funnel: dialed → connected → interested → converted
- Alerts: people below threshold, targets missed 3 days in a row

## 7. Data capture, the hardest part

The KPIs are only as good as the data, so decide early how each one is captured. Make dispositions mandatory and quick, since missing data will wreck your numbers.

| Method | What it covers |
| --- | --- |
| Auto-captured (most reliable) | Dialer or telephony integration (Exotel, Knowlarity, Twilio, etc.) giving calls, duration and recordings |
| Required on call end | A mandatory disposition: interested, callback, not reachable, wrong number, converted |
| Manager-scored | Quality scores from a short review form on sampled recordings |
| System-derived | Attendance from login/logout; follow-up compliance from reminder timestamps |

## 8. Improvements, in phases

Start with a small MVP and layer in incentives, quality review and AI coaching as the data matures.

**Phase 1 (MVP)**

- KPI catalog with 8-10 KPIs
- Owner setup wizard
- Daily snapshots
- Telecaller and owner dashboards

**Phase 2**

- Incentive engine: slabs tied to scores (e.g. 100% target = ₹X)
- Quality review workflow with scorecards for recordings
- Alerts and daily summary on WhatsApp or email
- Custom KPIs (the owner defines a count of a specific disposition)
- Export reports (PDF/Excel)

**Phase 3**

- Call transcription and AI quality scoring (script adherence, tone, objection handling)
- Coaching suggestions ("your connect rate drops after 4 PM")
- Lead-quality adjustment: don't penalize conversion rate when the lead list was poor, and compare by lead source
- Forecasting: projected month-end achievement at the current pace
- Benchmarking against similar businesses on your platform
- Ramp-up targets for new hires (30/60/90-day expectations)

## 9. Pitfalls to design around

| Pitfall | How to design around it |
| --- | --- |
| Gaming | Pair activity with outcome KPIs, flag suspiciously short calls, and cap achievement percentages |
| Unfair comparisons | Normalize for lead quality and shift length, and allow per-person target overrides |
| Target changes rewriting history | Use the effective-date approach from section 4 |
| Too many KPIs | Keep the 4-6 limit as a guardrail |
| Demotivation | Show telecallers their own progress first, and let owners decide leaderboard visibility |
| Data trust | Show last-synced time and flag missing dispositions |
