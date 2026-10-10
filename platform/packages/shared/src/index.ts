export * from "./enums";
export * from "./extraction";
export * from "./entities";
export * from "./device-api";
export * from "./device-recovery";
export * from "./crm-template";
export * from "./crm-providers";
export * from "./leads";
export * from "./branding";
export * from "./roles";
export * from "./asr";
export * from "./pipelines";
export * from "./custom-fields";
export * from "./custom-field-values";
export * from "./permissions";
export * from "./interactions";
export * from "./tasks";
export * from "./notifications";
export * from "./automation";
export * from "./targets";
export * from "./dedupe";
export * from "./connection-providers";
export * from "./funnel";
export * from "./funnel-answers";
export * from "./funnel-criteria";
export * from "./funnel-retention";
export * from "./message-templates";
export * from "./conversations";
export * from "./quiet-hours";
export * from "./automation-dryrun";
export * from "./outreach";
export * from "./quotations";
export * from "./wasi";
export * from "./plans";
export * from "./csv";
export * from "./import";
export * from "./org-modules";
export * from "./whatsapp-provider";
export * from "./projects";
export * from "./mcp";
export * from "./meta-mcp";
export * from "./api-scopes";
export * from "./report-builder";
export * from "./lead-intake";
export * from "./call-dispositions";
export * from "./agent-scorecard";
export * from "./performance-overview";
export * from "./team-activity";
export * from "./integrations";
export * from "./linkedin";
export * from "./whatsapp-qualification";
export * from "./call-sops";
export * from "./agent-kinds";
export * from "./features";
export * from "./staff";
export * from "./realtime";
export * from "./lead-routing";
export * from "./onboarding";
export * from "./recycle-bin";
export * from "./channel-health";
export * from "./messaging-window";
export * from "./messaging-providers";
export * from "./opt-out";
export * from "./setup-readiness";
export * from "./stage-packs";
export * from "./list-views";
export * from "./call-access";
export * from "./call-insights";
export * from "./call-log";
export * from "./missed-calls";
export * from "./storage";
export * from "./gstin";
export * from "./business-profile";
export * from "./password-policy";
export * from "./user-agent";
export * from "./auth-events";
export * from "./safe-path";
export * from "./attendance";
export * from "./attendance-absence-message";
export * from "./handset-alerts";

export * from "./time";
export * from "./call-issues";
export * from "./call-escalations";
export * from "./export-datasets";
export * from "./owner-scope";
export * from "./dialable";
// Doc 39 P1-P6. Until these were exported here, their consumers deep-imported
// `@aura/shared/dist/<name>` - which works and is the established fallback
// (console-phone.ts does it for ./phone), but only because `phone` and
// `import-phone` are deliberately NOT in the barrel: both pull in
// libphonenumber, and a barrel that drags it into every consumer is a barrel
// nobody can import cheaply. These five have no such cost, so they belong here
// and the deep imports in the API can collapse onto them.
export * from "./dialer";
export * from "./web-forms";
export * from "./resources";
export * from "./appointments";
export * from "./partners";

// The finance module (Build docs/finance-section-build-plan). Five files, in
// dependency order: `money` depends on nothing and everything else depends on
// it, which is the whole point of it existing separately - see its header for
// why money arithmetic may not happen in doubles.
//
// `money` also now owns `ratio`, which `call-insights.ts` used to define and
// re-exports from here. One definition, because §11 requires every finance
// rate to have exactly one, and a second copy in the barrel would be a name
// collision rather than a silent divergence - which is the only good kind.
export * from "./money";
export * from "./finance";
export * from "./finance-stats";
export * from "./finance-advisor";
export * from "./finance-detectors";
export * from "./finance-metrics";

// Build docs/indian-business-finance-documents-cycles-import, in dependency
// order. `fiscal` underpins both of the next two: the compliance calendar
// generates a year of filings from the financial year, and the console's
// period picker resolves "this quarter" against it.
//
// `xlsx-read` is NOT in the barrel, for the reason the Doc 39 note above gives
// about `sheets` and `import-phone`: it is reached only by the import wizard,
// which deep-imports it so that nothing else pays for it. It has no cost worth
// avoiding today, but it is the one module here whose only consumer is a
// single lazy-loaded screen, and keeping it out keeps that true.
export * from "./fiscal";
export * from "./compliance";
export * from "./documents";
export * from "./import-detect";

// The organization chart (Build docs/org-chart-build-plan.md, migrations
// 0177/0178). Two files, in dependency order: `org-chart` owns the vocabulary
// and the schemas, `org-chart-tree` the cycle check and the layout. Both are
// in the barrel because three consumers need them - the API for the integrity
// rules, the console for the canvas, and the PDF exporter for a layout that
// has to match the one on screen exactly.
export * from "./org-chart";
export * from "./org-chart-tree";

// The transcript agent (Build docs/transcript-agent-build-plan.md, migrations
// 0184-0187). Eight files, in dependency order - `feature-gates` is first
// because the agent's own modules import its modes and capabilities, and it is
// deliberately generic so KPI, Finance and the org chart can adopt the same
// toggles, admin screen and audit trail (§3A, §20).
//
// `time-phrases` and `amount-phrases` are the §7 resolvers, and they are in the
// barrel rather than deep-imported because three consumers need them: the
// worker to resolve a phrase, the API to simulate a policy, and the console to
// show an owner what a rule would do.
export * from "./feature-gates";
export * from "./transcript-redaction";
export * from "./time-phrases";
export * from "./amount-phrases";
export * from "./transcript-agent";
export * from "./agent-policy";
export * from "./callbacks";
export * from "./agent-eval";
