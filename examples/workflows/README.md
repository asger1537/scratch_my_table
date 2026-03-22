# Example Workflows

This folder contains canonical workflow IR v2 examples.

Rules:

- every file is plain workflow JSON
- every file uses `version: 2`
- all column references use explicit `columnId` values
- scoped cell transforms use `scopedTransform` plus the expression AST
- these files are used for authoring, import/export, migration, and roundtrip testing

Notes:

- the `columnId` values are illustrative and assume compatible imported schemas
- the examples correspond to the workflows documented in `docs/example-workflows.md`
- supported legacy `version: 1` workflows are still upgraded on load, but these examples are stored in canonical v2 form

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
- `14-fill-email-from-customer-id.workflow.json`
