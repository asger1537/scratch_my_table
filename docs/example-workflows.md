# Example Workflows

Examples below use illustrative internal `columnId` values such as `col_email` and `col_status`. In real data these IDs are stable internal identifiers, not user-facing names.

## 1. Fill Missing Status Values

Description:

- Fill empty values in the status column with `unknown`.

Intended effect:

- Rows with `null`, `""`, or whitespace-only status become `unknown`.

IR example:

```json
{
  "version": 2,
  "workflowId": "wf_fill_status",
  "name": "Fill missing status",
  "steps": [
    {
      "id": "step_fill_status",
      "type": "scopedTransform",
      "columnIds": ["col_status"],
      "expression": {
        "kind": "call",
        "name": "coalesce",
        "args": [
          {
            "kind": "value"
          },
          {
            "kind": "literal",
            "value": "unknown"
          }
        ]
      },
      "treatWhitespaceAsEmpty": true
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
  "version": 2,
  "workflowId": "wf_normalize_email",
  "name": "Normalize email addresses",
  "steps": [
    {
      "id": "step_normalize_email",
      "type": "scopedTransform",
      "columnIds": ["col_email"],
      "expression": {
        "kind": "call",
        "name": "lower",
        "args": [
          {
            "kind": "call",
            "name": "trim",
            "args": [
              {
                "kind": "value"
              }
            ]
          }
        ]
      },
      "treatWhitespaceAsEmpty": false
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
  "version": 2,
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
  "version": 2,
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
        "kind": "call",
        "name": "concat",
        "args": [
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

- Any row whose `email` cell is empty or whitespace-only is dropped from the output table.

IR example:

```json
{
  "version": 2,
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
          "treatWhitespaceAsEmpty": true
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
  "version": 2,
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
  "version": 2,
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
  "version": 2,
  "workflowId": "wf_combine_location",
  "name": "Create location column",
  "steps": [
    {
      "id": "step_combine_location",
      "type": "combineColumns",
      "columnIds": ["col_city", "col_state"],
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
  "version": 2,
  "workflowId": "wf_deduplicate_email",
  "name": "Deduplicate by email",
  "steps": [
    {
      "id": "step_deduplicate_email",
      "type": "deduplicateRows",
      "columnIds": ["col_email"]
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
  "version": 2,
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

- Normalize text, fill missing status values, derive a location column, remove rows without usable email, deduplicate by email, and sort the final export.

IR example:

```json
{
  "version": 2,
  "workflowId": "wf_messy_customer_cleanup",
  "name": "Messy customer cleanup",
  "description": "Normalize text, fill defaults, remove incomplete rows, and sort for export.",
  "steps": [
    {
      "id": "step_normalize_email",
      "type": "scopedTransform",
      "columnIds": ["col_email"],
      "expression": {
        "kind": "call",
        "name": "lower",
        "args": [
          {
            "kind": "call",
            "name": "trim",
            "args": [
              {
                "kind": "value"
              }
            ]
          }
        ]
      },
      "treatWhitespaceAsEmpty": false
    },
    {
      "id": "step_normalize_name",
      "type": "scopedTransform",
      "columnIds": ["col_full_name", "col_city"],
      "expression": {
        "kind": "call",
        "name": "collapseWhitespace",
        "args": [
          {
            "kind": "call",
            "name": "trim",
            "args": [
              {
                "kind": "value"
              }
            ]
          }
        ]
      },
      "treatWhitespaceAsEmpty": false
    },
    {
      "id": "step_fill_status",
      "type": "scopedTransform",
      "columnIds": ["col_status"],
      "expression": {
        "kind": "call",
        "name": "coalesce",
        "args": [
          {
            "kind": "value"
          },
          {
            "kind": "literal",
            "value": "unknown"
          }
        ]
      },
      "treatWhitespaceAsEmpty": true
    },
    {
      "id": "step_location",
      "type": "combineColumns",
      "columnIds": ["col_city", "col_state"],
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
        "treatWhitespaceAsEmpty": true
      }
    },
    {
      "id": "step_dedupe_email",
      "type": "deduplicateRows",
      "columnIds": ["col_email"]
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

## 12. Derive Initials From First Name and Final Surname Segment

Description:

- Create an `initials` column using the first character of `first_name` and the first character of the final space-delimited part of `last_name`.

Intended effect:

- `Alice Ng` becomes `AN`.
- `Cara Patel Singh` becomes `CS`.
- `Diego Ramirez Lopez` becomes `DL`.

IR example:

```json
{
  "version": 2,
  "workflowId": "wf_derive_initials",
  "name": "Derive initials",
  "steps": [
    {
      "id": "step_derive_initials",
      "type": "deriveColumn",
      "newColumn": {
        "columnId": "col_initials",
        "displayName": "initials"
      },
      "expression": {
        "kind": "call",
        "name": "concat",
        "args": [
          {
            "kind": "call",
            "name": "upper",
            "args": [
              {
                "kind": "call",
                "name": "first",
                "args": [
                  {
                    "kind": "column",
                    "columnId": "col_first_name"
                  }
                ]
              }
            ]
          },
          {
            "kind": "call",
            "name": "upper",
            "args": [
              {
                "kind": "call",
                "name": "first",
                "args": [
                  {
                    "kind": "call",
                    "name": "last",
                    "args": [
                      {
                        "kind": "call",
                        "name": "split",
                        "args": [
                          {
                            "kind": "column",
                            "columnId": "col_last_name"
                          },
                          {
                            "kind": "literal",
                            "value": " "
                          }
                        ]
                      }
                    ]
                  }
                ]
              }
            ]
          }
        ]
      }
    }
  ]
}
```

## 13. Drop Internal Export Columns

Description:

- Remove columns that should not appear in the final export.

Intended effect:

- The output table no longer includes `notes` or `internal_flag`.

IR example:

```json
{
  "version": 2,
  "workflowId": "wf_drop_internal_columns",
  "name": "Drop internal columns",
  "steps": [
    {
      "id": "step_drop_internal_columns",
      "type": "dropColumns",
      "columnIds": ["col_notes", "col_internal_flag"]
    }
  ]
}
```

## 14. Fill Missing Email From Customer ID

Description:

- Fill missing `email` cells from `customer_id` in the same row before dropping rows that still have no usable email.

Intended effect:

- Existing email values are preserved.
- Empty or whitespace-only email values fall back to `customer_id`.

IR example:

```json
{
  "version": 2,
  "workflowId": "wf_fill_email_from_customer_id",
  "name": "Fill missing email from customer ID",
  "steps": [
    {
      "id": "step_fill_email",
      "type": "scopedTransform",
      "columnIds": ["col_email"],
      "expression": {
        "kind": "call",
        "name": "coalesce",
        "args": [
          {
            "kind": "value"
          },
          {
            "kind": "column",
            "columnId": "col_customer_id"
          }
        ]
      },
      "treatWhitespaceAsEmpty": true
    }
  ]
}
```
