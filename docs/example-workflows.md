# Example Workflows

All canonical examples under `examples/workflows/` are runnable against the root workbook `Customers_Messy.xlsx`.

Imported `columnId` values for that workbook are:

- `col_customer_id`
- `col_first_name`
- `col_last_name`
- `col_email`
- `col_email_2`
- `col_column`
- `col_status`
- `col_sign_up_date`
- `col_notes`
- `col_balance`
- `col_vip`

Use the JSON files in `examples/workflows/` as the source of truth. This document is the compact catalog.

## 1. Fill Missing Status

- File: `01-fill-missing-status.workflow.json`
- Fills empty or whitespace-only `status` cells with `unknown`.

## 2. Normalize Email Addresses

- File: `02-normalize-email.workflow.json`
- Trims and lowercases both `email` columns.

## 3. Rename Customer ID

- File: `03-rename-customer-id.workflow.json`
- Renames the `Customer ID` export header without changing `col_customer_id`.

## 4. Create Full Name

- File: `04-derive-full-name.workflow.json`
- Derives `full_name` from trimmed `first_name` and `last_name`.

## 5. Keep Rows With Any Usable Email

- File: `05-keep-rows-with-email.workflow.json`
- Keeps rows where either `email` or `Email (2)` contains a usable value.

## 6. Keep Active Or Pending VIP Customers

- File: `06-paid-orders-over-100.workflow.json`
- Keeps rows where `VIP?` is `true` and `status` is `active` or `pending`.

## 7. Split Last Name

- File: `07-split-full-name.workflow.json`
- Splits `last_name` on spaces into `last_name_part_1` and `last_name_part_2`.

## 8. Combine Contact Emails

- File: `08-combine-location.workflow.json`
- Combines `email` and `Email (2)` into `contact_emails`.

## 9. Deduplicate By Email

- File: `09-deduplicate-by-email.workflow.json`
- Keeps the first row for each exact primary email value.

## 10. Sort Customers

- File: `10-sort-orders.workflow.json`
- Sorts by `sign_up_date` descending, then `last_name` ascending.

## 11. Customers Messy Cleanup

- File: `11-messy-customer-cleanup.workflow.json`
- Normalizes text, fills `email` from `Email (2)`, fills status, derives `full_name`, removes rows without usable email, deduplicates, and sorts.

## 12. Derive Initials

- File: `12-derive-initials.workflow.json`
- Creates initials from the first letter of `first_name` and the first letter of the final `last_name` segment.

## 13. Drop Internal Columns

- File: `13-drop-columns.workflow.json`
- Drops `Email (2)` and `Notes`.

## 14. Fill Missing Email From Email (2)

- File: `14-coalesce_email.workflow.json`
- Uses `Email (2)` as a fallback for empty primary `email`, then drops the alternate-email column.

## 15. Keep Rows With Date-Only Sign Up Dates

- File: `15-filter-signup-date-format.workflow.json`
- Keeps rows whose `sign_up_date` matches `YYYY-MM-DD`.

## 16. Keep North Or West Customers Who Are Active Or Pending

- File: `16-high-value-paid-or-shipped.workflow.json`
- Demonstrates stacked boolean logic over the imported `Column` and `Status` fields.

## 17. Extract Second Last-Name Part

- File: `17-extract-middle-name.workflow.json`
- Uses `atIndex(split(...), 1)` to derive the second space-delimited part of `last_name`.

## 18. Extract Customer Number

- File: `18-extract-order-code-regex.workflow.json`
- Uses `extractRegex(customer_id, "\\d+")` to derive the numeric customer suffix.

## 19. Normalize Customer ID Digits

- File: `19-normalize-phone-digits-regex.workflow.json`
- Uses `replaceRegex(customer_id, "[^0-9]", "")` to keep digits only.

## 20. Map Status Labels With Switch

- File: `20-map-status-label-with-switch.workflow.json`
- Uses `switch(lower(trim(status)), ...)` to map status values to readable labels with a default fallback.

## 21. Calculate Priority Score

- File: `21-calculate-priority-score.workflow.json`
- Uses `switch`, `multiply`, `add`, `divide`, and `round` to derive a numeric `priority_score` from `status` and `VIP?`.

## 22. Derive Signup Date Metrics

- File: `22-derive-signup-date-metrics.workflow.json`
- Uses `now`, `datePart`, `dateAdd`, and `dateDiff` to derive a stable run timestamp, `signup_year`, `follow_up_at`, and `account_age_days` from `sign_up_date`.

## 23. Highlight VIP Fields

- File: `23-highlight-vip-fields.workflow.json`
- Uses `scopedRule` with a format patch to highlight `status` and `balance` for rows where `VIP?` is `true`.

## 24. Scoped Rule Single Action

- File: `24-scoped-rule-single-action.workflow.json`
- Shows the compact single-action authoring shape: one `defaultPatch` that both normalizes VIP `status` cells and fills them with a highlight color.

## 25. Scoped Rule Cases

- File: `25-scoped-rule-cases.workflow.json`
- Shows the cases-mode authoring shape: ordered `cases` with first-match-wins semantics plus a `defaultPatch` fallback for `status`.
