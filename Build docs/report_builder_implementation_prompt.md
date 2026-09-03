# Feature Implementation Prompt (v2): Advanced Report Builder & Charting Engine

## Context for Claude Code
You are implementing a **Report Builder** module inside a multi-tenant, CRM-agnostic AI marketing and lead automation platform. This module lets business users (analysts, PMs) assemble multi-widget report pages from tenant data, get intelligent chart suggestions, theme the output, and export or schedule delivery of the final report.

Treat this as a production feature inside an existing multi-tenant system — **not a standalone prototype**. Tenant isolation, permissions, and integration with the platform's existing notification service are first-class requirements, not afterthoughts.

Read this entire prompt before writing code. Where a decision is marked `[ARCHITECTURE DECISION]`, resolve it explicitly in your design doc before implementation and state your reasoning.

---

## 1. Objective

Build a modular Report Builder that allows users to:
- Assemble multi-widget, multi-page report canvases via drag-and-drop
- Map tenant data sources (uploaded files or API-backed) to chart configurations
- Receive intelligent, explainable chart-type suggestions based on data shape
- Apply design themes and custom color palettes across all widgets instantly
- Export to PDF/PNG, or schedule automated recurring delivery
- Do all of the above safely within a multi-tenant environment with proper isolation and permissions

---

## 2. Target Users

- **Business Analysts & PMs**: aggregate tenant data into client-ready or executive-ready reports without manual design work
- **Designers & Developers**: need clean component architecture, scalable state management, and high-fidelity export
- **Platform Admins**: need tenant-level control over who can create, edit, share, and schedule reports

---

## 3. Functional Requirements

### 3.1 Drag-and-Drop Canvas & Layout Engine
- Flexible grid layout (`react-grid-layout` or equivalent) supporting resize, rearrange, reposition
- Widget types: Chart, Metric/KPI Card, Text/Markdown Note, Divider/Spacer, **Data Table** (new — needed for Executive/Corporate preset)
- Multi-page reports: add, remove, reorder pages
- **Autosave**: debounce-save canvas state every N seconds; visually indicate save status
- **Undo/redo**: minimum 20-step history per editing session
- **Draft vs. Published state**: edits to a published report don't affect the live/shared version until explicitly published

### 3.2 Data Mapper & Intelligent Suggestion Engine
- **Data source connectors**: CSV/JSON upload, plus connection to preset internal API endpoints (tenant-scoped)
- **Column mapping UI**: map columns to X-Axis, Y-Axis, Group By, Series, Filter
- **Data transformation layer** (new — required, not optional):
  - Aggregations: sum, avg, count, min, max, distinct count
  - Group-by with multiple levels
  - Calculated/derived fields (basic expression support)
  - Filters applied before chart rendering
- **Smart suggestions** with visible rationale (not a black box):
  - Categorical + Numerical → Bar, Pie/Donut (switch to Top-N + "Other" grouping automatically when cardinality > 12)
  - Time-series + Numerical → Line, Area
  - Numerical + Numerical → Scatter, Bubble
  - Single Numerical Metric → KPI Card with trend indicator
  - Ambiguous/mixed-type columns → flag to user rather than guessing silently
  - Each suggestion includes a one-line "why" (e.g., "Time-series data with one numeric field — Line chart shows trend clearly")
- **Schema drift handling**: if a re-uploaded/refreshed data source no longer matches existing column mappings, flag broken widgets explicitly rather than failing silently or auto-guessing a new mapping
- **Data volume strategy** `[ARCHITECTURE DECISION]`: define the row-count threshold above which aggregation/sampling happens server-side rather than in-browser. Client-side rendering of unbounded row counts is not acceptable.

### 3.3 Charting Library & Customization
- Supported types: Line, Bar, Pie/Donut, Area, Scatter, Radar, Data Table, KPI Card
- **Cross-widget filtering**: a filter or click interaction on one widget can optionally filter other widgets on the same page (define scope: page-level filter bus)
- **Drill-down**: clicking a data point can open a detail view or apply a temporary filter
- **Annotations**: support reference lines/thresholds on trend charts (e.g., target lines)
- Color palettes: built-in themes (Minimal Monochrome, Corporate Navy, Vibrant Sunset, Forest Emerald) + custom hex picker for series/background, saved per-tenant
- Design presets, instantly swappable across all widgets on a page:
  - **Minimalistic**: thin axis lines, subtle/hidden gridlines, generous padding, muted tones, soft rounded corners
  - **Stylish/Modern**: gradient fills, glassmorphism containers, glowing data points, bold typography, dark-mode optimized
  - **Executive/Corporate**: crisp borders, high-contrast dark text, sharp corners, structured data tables embedded alongside charts

### 3.4 Multi-Tenancy & Permissions (new — required)
- All reports, data sources, saved templates, and custom palettes are scoped to a tenant; no cross-tenant data leakage under any circumstance
- Role-based access per report: Owner, Editor, Viewer
- Uploaded data files are stored with tenant-scoped access control, not globally addressable URLs
- Audit trail: track who created/edited/exported/shared a report and when

### 3.5 Templates & Reuse (new)
- Save any report as a reusable template (layout + widget configs, data mapping left unbound for reuse with new data)
- Tenant-level template library, since this platform is SOP-driven and reports will likely be regenerated on a recurring structure per client

#### 3.5.1 Starter Template Library (new — required for beginner usability)
A blank drag-and-drop canvas is not a workable starting point for a first-time user. Ship a set of pre-built starter templates so a beginner can pick a close-fit structure and just bind their data, rather than assembling a report from scratch.
- **Minimum starter set for v1** (aligned to this platform's lead/marketing domain):
  - Lead Funnel Report (stage breakdown, conversion rate KPI, source-of-lead chart)
  - Weekly/Monthly Sales Summary (revenue trend line, top deals table, KPI cards)
  - Campaign Performance Overview (channel comparison bar chart, engagement trend, cost-per-lead KPI)
  - Blank canvas (for advanced users who want to start from scratch)
- Each starter template ships with **placeholder widgets that clearly indicate what kind of column to map** (e.g., a chart labeled "Map a date column here for your trend line") rather than empty/unlabeled widgets
- Starter templates are global (platform-provided, not tenant-created) and always visible to every tenant, in addition to any tenant-saved custom templates
- When a user picks a starter template with no data source yet connected, the canvas guides them directly into the data upload/mapping step rather than showing broken/empty widgets
- Starter templates should be reviewable/editable by platform admins (not hardcoded, so the set can grow without a code change) — store them the same way as tenant templates, just with a global/platform-owned tenant flag

**New Acceptance Criterion (add to Section 5):**
18. [ ] A first-time user can select a starter template, upload a matching CSV, and produce a populated report without needing to manually add a single widget from a blank canvas

### 3.6 Export & Delivery Service
- **Export formats**: high-resolution PDF, PNG image package (zip)
- **Rendering strategy** `[ARCHITECTURE DECISION]`: evaluate client-side (`html2canvas` + `jsPDF`) vs. server-side headless-browser rendering (e.g., Puppeteer). Client-side is faster to ship but has known font-rendering and cross-browser fidelity issues; server-side is more reliable for client-facing PDF quality. Recommend server-side for this platform given exports are likely sent to end clients, but document the tradeoff and get sign-off before building.
- Graceful pagination: charts/widgets never split awkwardly across PDF page breaks
- **Data export**: allow exporting a widget's underlying (post-transformation) data as CSV/Excel, not just the visual
- **Scheduled delivery** (new — high value given existing platform infrastructure): allow a report to be scheduled (e.g., weekly) and delivered via the platform's existing notification service (email/WhatsApp per your platform's channel support)
- **Shareable link**: optional read-only link to a published report, tenant-permission-aware

### 3.7 Non-Functional Requirements (new — required)
- **Performance**: define target render time for a page with 8–10 widgets and a dataset up to [specify row count, e.g., 50k rows post-aggregation]
- **Accessibility**: keyboard-navigable canvas editing where feasible; charts have accessible data-table fallback/summary for screen readers
- **Responsive behavior**: canvas editing is desktop-first; define explicit read-only/simplified mobile viewing mode rather than attempting drag-and-drop on mobile
- **Error/empty states**: explicit UI for broken data source, empty dataset, failed chart render, export failure — no silent failures
- **Internationalization**: number and date formatting respect tenant locale settings if the platform supports multiple locales

---

## 4. Technical Architecture & Guidelines

### Recommended Stack
- **Frontend**: React / Next.js
- **State Management**: Zustand or Redux Toolkit — must support autosave middleware and undo/redo history, not just in-memory state
- **Layout Engine**: `react-grid-layout`
- **Charting Library**: Apache ECharts (recommended for customization depth) — flag bundle-size tradeoff vs. Recharts in your design doc if initial load time is a concern
- **Export**: Server-side rendering service (Puppeteer or equivalent) preferred over pure client-side `html2canvas`+`jsPDF`; if client-side is chosen for v1, document the fidelity limitations explicitly
- **Persistence**: report definitions (layout + widget configs + data bindings) stored server-side, tenant-scoped, versioned
- **Scheduling/Delivery**: integrate with existing platform notification service — do not build a parallel delivery mechanism

### Data Flow
1. Data source (upload or API) → tenant-scoped storage
2. Schema inference → column metadata (type, cardinality, null rate)
3. Transformation layer (filter/aggregate/group) → applied dataset
4. Suggestion engine reads transformed schema → ranked chart suggestions with rationale
5. Widget renders from transformed dataset + theme/preset config
6. Canvas state (layout + all widget configs + data bindings, NOT raw data) persisted and versioned
7. Export pipeline reads live canvas state + re-fetches/re-renders for output

---

## 5. Acceptance Criteria

### Core (from v1)
1. [ ] Users can create a new report canvas and add/resize/remove chart widgets seamlessly
2. [ ] Users can upload a CSV, view its schema, and map columns to chart axes with real-time preview
3. [ ] The suggestion engine highlights recommended chart types based on column data types, with a visible one-line rationale per suggestion
4. [ ] Users can switch between design presets and apply custom color palettes that instantly re-theme all widgets
5. [ ] Users can trigger "Download PDF" and get a professionally formatted, multi-page PDF without visual clipping or awkward page breaks

### Data & Transformation
6. [ ] Users can apply an aggregation (e.g., sum by category) and a filter to a data source before mapping to a chart, with real-time preview
7. [ ] Re-uploading a data source with a changed/missing column flags affected widgets explicitly rather than failing silently
8. [ ] Datasets above the defined row-count threshold are aggregated/sampled without freezing the browser

### Multi-Tenancy & Permissions
9. [ ] A user from Tenant A cannot access, list, or reference any report, data source, or template belonging to Tenant B, under any UI or API path
10. [ ] Viewer-role users cannot edit or delete a report; Editor-role users can edit but not change sharing/permissions; only Owners can manage access

### Templates & Scheduling
11. [ ] A report can be saved as a template and reused to create a new report with a different data source bound to the same layout/widget structure
12. [ ] A report can be scheduled for recurring delivery and is successfully delivered via the platform's existing notification service on schedule

### Export Fidelity
13. [ ] PDF export renders correctly (no clipped charts, no missing fonts) when tested across [Chrome, Safari, Firefox — specify which are in scope]
14. [ ] Widget-level data export (CSV/Excel of transformed data) matches what's visually rendered in the chart

### Non-Functional
15. [ ] A page with 8–10 widgets and a representative dataset renders within [performance target] on a mid-tier device
16. [ ] Empty data source, broken mapping, and export failure states each show a clear, actionable error message — none fail silently
17. [ ] Charts have an accessible fallback (data table or summary) for screen reader users

---

## 6. Explicit Decisions Needed Before Implementation

Claude Code should propose and document a recommendation for each, rather than silently picking one:

1. **PDF rendering**: client-side (`html2canvas`+`jsPDF`) vs. server-side (Puppeteer/headless Chrome)
2. **Data volume threshold**: at what row count does processing move server-side?
3. **Cross-widget filter scope**: page-level only, or report-wide?
4. **Template data-binding model**: how is a template's data mapping "unbound" and re-bindable to a new source?
5. **Charting library**: confirm ECharts vs. Recharts given bundle-size and animation-need tradeoffs for this platform's typical report size

---

## 7. Out of Scope for v1 (explicitly deferred, not forgotten)

- Real-time collaborative multi-user editing (conflict resolution beyond basic optimistic locking)
- Full BI-style ad-hoc query builder (this is a report/dashboard tool, not a data warehouse UI)
- Cross-tenant benchmarking/aggregate reporting
