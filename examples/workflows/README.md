# Example Workflows

This folder contains canonical workflow IR v2 examples.

Rules:

- every file is plain workflow JSON
- every file uses `version: 2`
- all column references use explicit `columnId` values
- scoped cell changes use `scopedRule` plus the shared expression AST and optional format patches
- filters and row predicates use the same expression AST with boolean-returning `call` nodes
- these files are used for authoring, import/export, migration, and roundtrip testing

Notes:

- all examples are now runnable against the root workbook `Customers_Messy.xlsx`
- the canonical imported column IDs for that workbook are:
  `col_customer_id`, `col_first_name`, `col_last_name`, `col_email`, `col_email_2`, `col_column`, `col_status`, `col_sign_up_date`, `col_notes`, `col_balance`, and `col_vip`
- some numbered filenames are historical slots; the workflow `name` field inside each JSON is the canonical title
- the examples correspond to the workflows documented in `docs/example-workflows.md`

Files:

- `01-fill-missing-status.workflow.json`
- `02-normalize-email.workflow.json`
- `03-rename-customer-id.workflow.json`
- `04-derive-full-name.workflow.json`
- `05-keep-rows-with-email.workflow.json`
- `06-paid-orders-over-100.workflow.json`
- `07-split-full-name.workflow.json`
- `08-combine-location.workflow.json`
- `09-deduplicate-by-email.workflow.json`
- `10-sort-orders.workflow.json`
- `11-messy-customer-cleanup.workflow.json`
- `12-derive-initials.workflow.json`
- `13-drop-columns.workflow.json`
- `14-coalesce_email.workflow.json`
- `15-filter-signup-date-format.workflow.json`
- `16-high-value-paid-or-shipped.workflow.json`
- `17-extract-middle-name.workflow.json`
- `18-extract-order-code-regex.workflow.json`
- `19-normalize-phone-digits-regex.workflow.json`
- `20-map-status-label-with-switch.workflow.json`
- `21-calculate-priority-score.workflow.json`
- `22-derive-signup-date-metrics.workflow.json`
- `23-highlight-vip-fields.workflow.json`
- `24-scoped-rule-single-action.workflow.json`
- `25-scoped-rule-cases.workflow.json`
