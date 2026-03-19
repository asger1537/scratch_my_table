# Workflow IR v1

## Design Rules

The V1 workflow IR is intentionally small.

Rules:

- `version` is required from day one.
- A workflow is an ordered list of explicit tabular operations.
- Steps execute top to bottom.
- Later steps see schema changes made by earlier valid steps.
- The persisted IR never refers to “selected columns” or any other transient UI state.
- The IR does not contain loops, arbitrary variables, or general control flow.

## Workflow Object

Required fields:

- `version`: integer, always `1` for V1
- `workflowId`: stable workflow identifier
- `name`: human-readable workflow name
- `steps`: ordered list of workflow steps

Optional fields:

- `description`: human-readable workflow description

Example:

```json
{
  "version": 1,
  "workflowId": "wf_customer_cleanup",
  "name": "Customer cleanup",
  "description": "Normalize customer text fields and remove duplicate emails.",
  "steps": []
}
```

## Step Object

Every workflow step has:

- `id`: stable step identifier unique within the workflow
- `type`: one of the V1 step types below

V1 step types:

- `fillEmpty`
- `normalizeText`
- `renameColumn`
- `deriveColumn`
- `filterRows`
- `splitColumn`
- `combineColumns`
- `deduplicateRows`
- `sortRows`

## Target Object

V1 uses one persisted target shape for explicit column references:

```json
{
  "kind": "columns",
  "columnIds": ["col_email", "col_status"]
}
```

Rules:

- `columnIds` must be explicit internal `columnId` values.
- Order matters when the consuming step is order-sensitive, such as `combineColumns`.
- The target object is not a symbolic selection.

## Condition Object

`filterRows` uses a recursive condition tree.

Leaf conditions:

- `isEmpty`
- `equals`
- `contains`
- `startsWith`
- `endsWith`
- `greaterThan`
- `lessThan`

Boolean combinators:

- `and`
- `or`
- `not`

Examples:

```json
{
  "kind": "isEmpty",
  "columnId": "col_email",
  "treatWhitespaceAsEmpty": false
}
```

```json
{
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
```

## Expression Object

`deriveColumn` uses a small recursive expression tree.

Expression kinds:

- `literal`
- `column`
- `concat`
- `coalesce`

Rules:

- `literal` returns a scalar value.
- `column` reads one existing column by `columnId`.
- `concat` returns a string by concatenating its parts left to right.
- `coalesce` returns the first non-null input.

Examples:

```json
{
  "kind": "literal",
  "value": " "
}
```

```json
{
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
```

## Validation Error Object

Semantic validation returns structured errors; this object is not part of the persisted workflow itself.

Required fields:

- `code`: stable machine-readable code such as `missingColumn` or `nameConflict`
- `severity`: `error` or `warning`
- `message`: human-readable explanation
- `path`: JSON-style location such as `steps[2].sorts[0].columnId`

Optional fields:

- `stepId`: the offending workflow step
- `details`: machine-readable context payload

Example:

```json
{
  "code": "missingColumn",
  "severity": "error",
  "message": "Column 'col_email' does not exist at step 'step_filter_email'.",
  "path": "steps[1].condition.columnId",
  "stepId": "step_filter_email",
  "details": {
    "columnId": "col_email"
  }
}
```

## Step Definitions

### `fillEmpty`

Fills empty cells in the targeted columns with one literal value.

Fields:

- `target`
- `value`: string, number, or boolean
- `treatWhitespaceAsEmpty`: boolean

Example:

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

### `normalizeText`

Normalizes text in the targeted columns.

Fields:

- `target`
- `trim`: boolean
- `collapseWhitespace`: boolean
- `case`: `preserve`, `lower`, or `upper`

Example:

```json
{
  "version": 1,
  "workflowId": "wf_normalize_email",
  "name": "Normalize email text",
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

### `renameColumn`

Changes the display name of one existing column without changing its `columnId`.

Fields:

- `columnId`
- `newDisplayName`

Example:

```json
{
  "version": 1,
  "workflowId": "wf_rename_customer_id",
  "name": "Rename customer ID column",
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

### `deriveColumn`

Creates one new column from an expression.

Fields:

- `newColumn`
  - `columnId`
  - `displayName`
- `expression`

Example:

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

### `filterRows`

Keeps or drops rows based on a condition.

Fields:

- `mode`: `keep` or `drop`
- `condition`

Example:

```json
{
  "version": 1,
  "workflowId": "wf_filter_missing_email",
  "name": "Drop rows with missing email",
  "steps": [
    {
      "id": "step_filter_missing_email",
      "type": "filterRows",
      "mode": "drop",
      "condition": {
        "kind": "isEmpty",
        "columnId": "col_email",
        "treatWhitespaceAsEmpty": false
      }
    }
  ]
}
```

### `splitColumn`

Splits one string column into explicit output columns using a delimiter.

Fields:

- `columnId`
- `delimiter`
- `outputColumns`
  - `columnId`
  - `displayName`

Example:

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

### `combineColumns`

Creates a new string column by joining values from existing columns.

Fields:

- `target`
- `separator`
- `newColumn`
  - `columnId`
  - `displayName`

Example:

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

### `deduplicateRows`

Removes duplicate rows using one or more key columns.

Fields:

- `target`

Example:

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

### `sortRows`

Sorts rows using one or more sort keys.

Fields:

- `sorts`
  - `columnId`
  - `direction`: `asc` or `desc`

Example:

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
