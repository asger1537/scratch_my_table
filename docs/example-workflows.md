# Example Workflows

Examples below use illustrative internal `columnId` values such as `col_email` and `col_status`. In real data these IDs are stable internal identifiers, not user-facing names.

## 1. Fill Missing Status Values

Description:

- Fill empty values in the status column with `unknown`.

Intended effect:

- Rows with `null` or `""` in `status` become `unknown`.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_fill_status",
  "name": "Fill missing status",
  "steps": [
    {
      "id": "step_fill_status",
      "type": "fillEmpty",
      "target": {
        "kind": "columns",
        "columnIds": ["col_status"]
      },
      "value": "unknown",
      "treatWhitespaceAsEmpty": false
    }
  ]
}
```

## 2. Trim and Lowercase Email Addresses

Description:

- Normalize email formatting in a messy import.

Intended effect:

- Leading/trailing spaces are removed and all email text becomes lowercase.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_normalize_email",
  "name": "Normalize email addresses",
  "steps": [
    {
      "id": "step_normalize_email",
      "type": "normalizeText",
      "target": {
        "kind": "columns",
        "columnIds": ["col_email"]
      },
      "trim": true,
      "collapseWhitespace": false,
      "case": "lower"
    }
  ]
}
```

## 3. Rename a Column for Export

Description:

- Rename the customer ID header without changing the stable internal column reference.

Intended effect:

- The exported header becomes `external_customer_id`.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_rename_customer_id",
  "name": "Rename customer ID",
  "steps": [
    {
      "id": "step_rename_customer_id",
      "type": "renameColumn",
      "columnId": "col_customer_id",
      "newDisplayName": "external_customer_id"
    }
  ]
}
```

## 4. Create a Full Name Column

Description:

- Derive a new `full_name` column from first and last name.

Intended effect:

- The output table gains a new `full_name` column while keeping the original source columns.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_derive_full_name",
  "name": "Create full name",
  "steps": [
    {
      "id": "step_derive_full_name",
      "type": "deriveColumn",
      "newColumn": {
        "columnId": "col_full_name",
        "displayName": "full_name"
      },
      "expression": {
        "kind": "concat",
        "parts": [
          {
            "kind": "column",
            "columnId": "col_first_name"
          },
          {
            "kind": "literal",
            "value": " "
          },
          {
            "kind": "column",
            "columnId": "col_last_name"
          }
        ]
      }
    }
  ]
}
```

## 5. Keep Only Rows With an Email Address

Description:

- Remove rows that do not have a usable email value.

Intended effect:

- Any row whose `email` cell is empty is dropped from the output table.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_keep_rows_with_email",
  "name": "Keep rows with email",
  "steps": [
    {
      "id": "step_keep_rows_with_email",
      "type": "filterRows",
      "mode": "keep",
      "condition": {
        "kind": "not",
        "condition": {
          "kind": "isEmpty",
          "columnId": "col_email",
          "treatWhitespaceAsEmpty": false
        }
      }
    }
  ]
}
```

## 6. Keep Only Paid Orders Above 100

Description:

- Filter orders to a smaller export set.

Intended effect:

- Only rows where `order_total > 100` and `order_status == "paid"` remain.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_paid_orders_over_100",
  "name": "Paid orders over 100",
  "steps": [
    {
      "id": "step_paid_orders_over_100",
      "type": "filterRows",
      "mode": "keep",
      "condition": {
        "kind": "and",
        "conditions": [
          {
            "kind": "greaterThan",
            "columnId": "col_order_total",
            "value": 100
          },
          {
            "kind": "equals",
            "columnId": "col_order_status",
            "value": "paid"
          }
        ]
      }
    }
  ]
}
```

## 7. Split Full Name Into First and Last Name

Description:

- Split a single text column into two explicit output columns.

Intended effect:

- The table gains `first_name` and `last_name` columns derived from `full_name`.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_split_full_name",
  "name": "Split full name",
  "steps": [
    {
      "id": "step_split_full_name",
      "type": "splitColumn",
      "columnId": "col_full_name",
      "delimiter": " ",
      "outputColumns": [
        {
          "columnId": "col_first_name",
          "displayName": "first_name"
        },
        {
          "columnId": "col_last_name",
          "displayName": "last_name"
        }
      ]
    }
  ]
}
```

## 8. Combine City and State Into One Location Column

Description:

- Create a display-friendly location string from two existing columns.

Intended effect:

- The table gains `location`, for example `Seattle, WA`.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_combine_location",
  "name": "Create location column",
  "steps": [
    {
      "id": "step_combine_location",
      "type": "combineColumns",
      "target": {
        "kind": "columns",
        "columnIds": ["col_city", "col_state"]
      },
      "separator": ", ",
      "newColumn": {
        "columnId": "col_location",
        "displayName": "location"
      }
    }
  ]
}
```

## 9. Deduplicate Customers by Email

Description:

- Remove duplicate customer rows using email as the uniqueness key.

Intended effect:

- Only the first row for each exact email value survives.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_deduplicate_email",
  "name": "Deduplicate by email",
  "steps": [
    {
      "id": "step_deduplicate_email",
      "type": "deduplicateRows",
      "target": {
        "kind": "columns",
        "columnIds": ["col_email"]
      }
    }
  ]
}
```

## 10. Sort Orders by Date Then Total

Description:

- Order exported rows so the newest and highest-value records appear first.

Intended effect:

- Orders sort by `ordered_at` descending, then by `order_total` descending.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_sort_orders",
  "name": "Sort orders",
  "steps": [
    {
      "id": "step_sort_orders",
      "type": "sortRows",
      "sorts": [
        {
          "columnId": "col_ordered_at",
          "direction": "desc"
        },
        {
          "columnId": "col_order_total",
          "direction": "desc"
        }
      ]
    }
  ]
}
```

## 11. Clean Up a Messy Customer Export

Description:

- Run a realistic multi-step workflow on `messy-customers.csv`.

Intended effect:

- Normalize text, fill missing status values, derive a location column, remove rows without email, deduplicate by email, and sort the final export.

IR example:

```json
{
  "version": 1,
  "workflowId": "wf_messy_customer_cleanup",
  "name": "Messy customer cleanup",
  "description": "Normalize text, fill defaults, remove incomplete rows, and sort for export.",
  "steps": [
    {
      "id": "step_normalize_email",
      "type": "normalizeText",
      "target": {
        "kind": "columns",
        "columnIds": ["col_email"]
      },
      "trim": true,
      "collapseWhitespace": false,
      "case": "lower"
    },
    {
      "id": "step_normalize_name",
      "type": "normalizeText",
      "target": {
        "kind": "columns",
        "columnIds": ["col_full_name", "col_city"]
      },
      "trim": true,
      "collapseWhitespace": true,
      "case": "preserve"
    },
    {
      "id": "step_fill_status",
      "type": "fillEmpty",
      "target": {
        "kind": "columns",
        "columnIds": ["col_status"]
      },
      "value": "unknown",
      "treatWhitespaceAsEmpty": true
    },
    {
      "id": "step_location",
      "type": "combineColumns",
      "target": {
        "kind": "columns",
        "columnIds": ["col_city", "col_state"]
      },
      "separator": ", ",
      "newColumn": {
        "columnId": "col_location",
        "displayName": "location"
      }
    },
    {
      "id": "step_drop_missing_email",
      "type": "filterRows",
      "mode": "drop",
      "condition": {
        "kind": "isEmpty",
        "columnId": "col_email",
        "treatWhitespaceAsEmpty": false
      }
    },
    {
      "id": "step_dedupe_email",
      "type": "deduplicateRows",
      "target": {
        "kind": "columns",
        "columnIds": ["col_email"]
      }
    },
    {
      "id": "step_sort_signup",
      "type": "sortRows",
      "sorts": [
        {
          "columnId": "col_signup_date",
          "direction": "desc"
        },
        {
          "columnId": "col_full_name",
          "direction": "asc"
        }
      ]
    }
  ]
}
```
