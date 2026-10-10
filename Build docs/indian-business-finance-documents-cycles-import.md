# Indian business finance: documents, reporting cycles, and Excel import

## 1. Documents a typical Indian business needs

Group them in the app as **document categories**, so each can carry an expiry date, an owner, and a reminder.

### Registration and identity (one-time, with renewals)

- Incorporation certificate, MOA/AOA (company), LLP agreement, or partnership deed
- PAN and TAN
- GST registration certificate
- Udyam (MSME) registration
- Shops and Establishment / trade licence
- Professional tax, PF and ESI registrations
- IEC (if importing or exporting)
- Bank account details and cancelled cheque

### Sales documents

- Tax invoices, credit notes and debit notes (e-invoice IRN and QR code where applicable)
- E-way bills (for movement of goods)
- Quotations, sales orders and receipts
- Customer contracts and agreements

### Purchase and expense documents

- Vendor bills and purchase orders
- Expense vouchers and reimbursement claims
- Rent agreement and utility bills
- Vendor contracts

### Banking and cash

- Bank statements and bank reconciliation statements
- Payment gateway settlement reports (such as Razorpay)
- Cash book and petty cash vouchers
- Loan sanction letters and repayment schedules

### Payroll and HR

- Offer and appointment letters, salary register and payslips
- PF/ESI challans and returns
- Form 16 and TDS on salary records

### Tax records

- GST returns (GSTR-1, GSTR-3B, annual GSTR-9) and payment challans
- TDS challans, quarterly TDS returns, and TDS certificates (Form 16A)
- Advance tax challans
- Form 26AS / AIS statements
- Income tax return with computation
- Tax audit report, if applicable

### Books and financial statements

- Ledgers, trial balance, profit and loss account, balance sheet, cash flow statement
- Fixed asset register with depreciation schedule
- Inventory records and stock statements

### Companies only (ROC compliance)

- Board and general meeting minutes, statutory registers
- Auditor appointment documents
- Annual ROC filings with the audited financial statements

### Others

- Insurance policies, property and lease documents
- Trademarks, licences and permits
- Statutory auditor and CA correspondence

---

## 2. How finance is viewed: frequency

India's financial year runs **1 April to 31 March**, so quarters are Q1 Apr-Jun, Q2 Jul-Sep, Q3 Oct-Dec, Q4 Jan-Mar. Make the year start and the view calendar configurable, since some businesses also track a calendar year.

| Frequency | What the owner looks at |
| --- | --- |
| **Daily** | Collections, payments out, cash and bank balance, due follow-ups |
| **Weekly** | Sales vs target, outstanding dues, expense spikes, cash flow outlook |
| **Monthly** | P&L, collections vs billed, expenses vs budget, GST and TDS payment, payroll, bank reconciliation, month-end close |
| **Quarterly** | Quarterly P&L and trends, TDS returns, advance tax instalments, QRMP GST for eligible small taxpayers, review of targets and budgets |
| **Half-yearly** | Mid-year review, forecast refresh, audit planning |
| **Yearly** | Final accounts, tax audit, ITR, ROC filings, annual GST return, year-end stock and asset verification, next-year budget |

### Typical compliance rhythm

- **Monthly:** GST returns, TDS deposit, PF/ESI, professional tax. Small taxpayers on the quarterly scheme file GST quarterly with monthly payments.
- **Quarterly:** TDS returns, and advance tax.
- **Yearly:** audit, ITR, annual GST return, and ROC filings for companies.

### Why due dates must be configurable: the advance tax example

India's new Income-tax Act, 2025 applies to income arising on or after 1 April 2026, and replaces the previous year and assessment year pairing with a single "tax year". The instalment structure is unchanged: 15% by 15 June, 45% by 15 September, 75% by 15 December, and the whole amount by 15 March, each less what was already paid. Advance tax is generally due where tax for the year, after TDS and TCS, is ₹10,000 or more. Section numbers and portal screens changed with the new Act, so the module must not hard-code legal references.

> **Verify with your CA.** Treat all due dates and thresholds in this document as defaults. Dates, thresholds and forms change by budget, notification and extension. Store them in an editable **compliance calendar table** (name, frequency, due-date rule, applicability, reminder offsets) and ship seed data that a CA or admin can edit, rather than putting dates in code.

### What the app should offer

- A period selector: day, week, month, quarter, half-year, financial year, custom range, with comparison to the previous period and the same period last year
- A **compliance calendar** with status (upcoming, due, filed, overdue), assignee and linked documents
- A **month-end close checklist**, with period locking from the finance spec
- A **document vault** tied to each compliance item (for example, the GSTR-3B challan attached to its filing)
- Reminders through the Advisor, using the same routing and escalation as the leak alerts

---

## 3. Excel import: dynamic, automatic and safe

"Automatically" works best as **detect, suggest and confirm**, not silent import. Finance data wrongly imported is hard to unwind, so auto-detection should do the work and a person should approve it once. After the first import, a saved template makes later imports one click.

### Flow

1. **Upload** (.xlsx, .xls, .csv, .tsv; reject macro files like .xlsm). Support drag and drop, and optionally scheduled or emailed imports later.
2. **Parse and detect structure:** list the sheets, find the real header row (skipping title rows and merged cells), and drop blank rows and total or subtotal rows.
3. **Detect the data type** from the headers and the content: sales/invoices, payments, expenses, leads, call logs, employees, ledger, bank statement.
4. **Auto-map columns** to application fields using:
   - Fuzzy header matching and a synonym list ("Amt", "Amount", "Total", "Invoice Value")
   - Content patterns: GSTIN, PAN, phone numbers, dates, ₹ amounts, IFSC codes
   - **Saved mapping templates** per source (a particular bank, Tally, Razorpay)
5. **Handle unknown columns dynamically:** offer to ignore them, or create a **custom field** (using the JSONB custom fields from the deal layer) with the detected type.
6. **Validate** and show a preview with errors highlighted:
   - Required fields, data types, ranges
   - Date format ambiguity (dd/mm/yyyy vs mm/dd/yyyy), amount formats with commas or ₹
   - GSTIN and PAN format checks, valid phone numbers
   - **Duplicate detection** against existing records and within the file
   - Lookups: does the telecaller, customer or deal referenced exist?
7. **Choose a mode:** create only, update existing (matched by a key such as invoice number), or upsert.
8. **Dry run** that shows "120 new, 15 updates, 4 skipped, 6 errors".
9. **Import in the background** in a transaction per batch, with a progress view.
10. **Result report:** downloadable error file with row numbers and reasons, so the user can fix and re-upload only failed rows.
11. **Undo:** every import is a batch with an ID, so the whole batch can be rolled back (subject to period locks).

### Key design points

- **Staging first:** parse into a staging table, validate there, and only then write to real tables.
- **Idempotency:** hash each row or use a natural key (invoice number, bank reference), so re-importing the same file doesn't duplicate data.
- **Imports feed the same pipelines:** imported payments go through the **same normalizer and matching engine** as connector payments, so reconciliation and the Advisor behave identically.
- **Source-specific parsers** for common formats: bank statements (each bank differs), Razorpay/Cashfree settlement reports, Tally exports, GST portal downloads (GSTR-2B), and the app's own export format.
- **Large files:** stream and chunk, cap size and rows per file, and run in a job queue.
- **Security:** virus scan, no formula execution, neutralize cells starting with `=`, `+`, `-` or `@` on export to prevent CSV injection, and limit file types.
- **Permissions and audit:** only roles with import rights can upload; log who imported what, when, and the batch contents. Sensitive imports (payroll, contracts) need elevated roles.
- **Import history page:** files, status, counts, mapping used, and one-click rollback.

### Suggested tech

- Parsing: SheetJS or ExcelJS (JavaScript), or openpyxl and pandas (Python), plus a streaming CSV parser
- Background jobs and a staging schema in your existing database
- A mapping UI built from your design system components, consistent with the rest of the app

---

## 4. Where this fits in the other specs

- **Finance spec:** add "document vault and compliance calendar" and "import center" as new sections and milestones (after bank statement import).
- **Org chart spec:** employee and contract imports plug into the same import center.
- **KPI section:** call logs and lead lists come in through the same import flow.

---

## 5. Open questions

- Which Excel sources will customers actually bring: Tally exports, bank statements, or their own sheets?
- Is the target customer a small proprietor or a registered company? This changes which compliance items matter.

---

## Sources

- [Section 408, Income Tax Department](https://www.incometaxindia.gov.in/w/section-408-6)
- [Advance Tax under Income-tax Act 2025, TaxGuru](https://taxguru.in/?p=1048485)
- [Advance tax guide, CalcGuru](https://calcguru.in/?p=5471)
