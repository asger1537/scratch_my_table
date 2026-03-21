# Example Workflows

This folder contains canonical workflow IR examples for V1.

Rules:
- every file is plain workflow JSON
- every file uses `version: 1`
- all column references use explicit `columnId` values
- these are examples for authoring, import/export, and roundtrip testing

Notes:
- the `columnId` values are illustrative and assume compatible imported schemas
- the examples correspond to the workflows documented in `docs/example-workflows.md`
- some examples fit the provided CSV fixtures directly, while others assume similarly shaped tables

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
