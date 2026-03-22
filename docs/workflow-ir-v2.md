# Workflow IR v2

## Design Rules

Workflow IR v2 remains intentionally small.

Rules:

- `version` is required from day one and is now `2`.
- A workflow is an ordered list of explicit tabular operations.
- Steps execute top to bottom.
- Later steps see schema changes made by earlier valid steps.
- Persisted workflows never refer to transient UI state such as “currently selected columns”.
- The IR is editor-agnostic. Blockly is an authoring view over this JSON, not the source of truth.
- The IR does not contain loops, arbitrary variables, user-defined functions, or general control flow.

## Workflow Object

Required fields:

- `version`: integer, always `2`
- `workflowId`: stable workflow identifier
- `name`: human-readable workflow name
- `steps`: ordered list of workflow steps

Optional fields:

- `description`: human-readable workflow description

Example:

```json
{
  "version": 2,
  "workflowId": "wf_customer_cleanup",
  "name": "Customer cleanup",
  "description": "Normalize email values, fill missing status, and remove duplicate rows.",
  "steps": []
}
```

## Step Object

Every workflow step has:

- `id`: stable step identifier unique within the workflow
- `type`: one of the v2 step types below

Workflow IR v2 step types:

- `scopedTransform`
- `dropColumns`
- `renameColumn`
- `deriveColumn`
- `filterRows`
- `splitColumn`
- `combineColumns`
- `deduplicateRows`
- `sortRows`

V1 capability mapping:

- fill empty cells: `scopedTransform` with `coalesce(value, <literal>)`
- trim / normalize text: `scopedTransform` with built-in function composition such as `lower(trim(value))`
- drop columns: `dropColumns`
- rename columns: `renameColumn`
- create a derived column: `deriveColumn`
- filter rows: `filterRows`
- split columns: `splitColumn`
- combine columns: `combineColumns`
- deduplicate rows: `deduplicateRows`
- sort rows: `sortRows`

## Expression Object

`scopedTransform` and `deriveColumn` use the same expression AST.

Expression kinds:

- `value`
- `literal`
- `column`
- `call`

Rules:

- `value` means the current selected cell value and is only valid inside `scopedTransform`.
- `literal` returns a scalar value.
- `column` reads one existing column by `columnId` from the current row and is valid inside both `deriveColumn` and `scopedTransform`.
- `call` applies one built-in pure function.

Built-in function names:

- `trim`
- `lower`
- `upper`
- `collapseWhitespace`
- `substring`
- `replace`
- `split`
- `first`
- `last`
- `coalesce`
- `concat`

Examples:

```json
{
  "kind": "value"
}
```

```json
{
  "kind": "literal",
  "value": "unknown"
}
```

```json
{
  "kind": "column",
  "columnId": "col_first_name"
}
```

```json
{
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
}
```

## Condition Object

`filterRows` and `scopedTransform.rowCondition` use the same recursive condition tree.

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
  "treatWhitespaceAsEmpty": true
}
```

```json
{
  "kind": "and",
  "conditions": [
    {
      "kind": "startsWith",
      "columnId": "col_first_name",
      "value": "A"
    },
    {
      "kind": "startsWith",
      "columnId": "col_last_name",
      "value": "A"
    }
  ]
}
```

## Validation Error Object

Semantic validation returns structured errors; this object is not part of the persisted workflow itself.

Required fields:

- `code`: stable machine-readable code such as `missingColumn` or `incompatibleType`
- `severity`: `error` or `warning`
- `message`: human-readable explanation
- `path`: JSON-style location such as `steps[2].expression.args[0]`
- `phase`: `structural` or `semantic`

Optional fields:

- `stepId`: the offending workflow step
- `details`: machine-readable context payload

## Step Definitions

### `scopedTransform`

Applies one expression to one or more selected columns, optionally only on rows matching a condition.

Fields:

- `columnIds`
- `rowCondition` optional
- `expression`
- `treatWhitespaceAsEmpty`

Rules:

- the expression is evaluated once per selected cell
- `value` means the current cell value
- `column` may read another column from the current row while the step is being applied
- if `rowCondition` is omitted, all rows are eligible
- `treatWhitespaceAsEmpty` affects `coalesce` emptiness checks inside the step
- authoring defaults `treatWhitespaceAsEmpty` to `true`; workflows may still explicitly disable it

Example:

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

### `renameColumn`

Changes the display name of one existing column without changing its `columnId`.

Fields:

- `columnId`
- `newDisplayName`

### `dropColumns`

Drops one or more existing columns from the active table.

Fields:

- `columnIds`

Rules:

- every referenced `columnId` must exist at that step
- at least one column must be selected
- the step must leave at least one column in the table

Example:

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

### `deriveColumn`

Creates one new column from an expression.

Fields:

- `newColumn`
  - `columnId`
  - `displayName`
- `expression`

Rules:

- `column` references are valid here
- `value` is not valid here

Example:

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

### `filterRows`

Keeps or drops rows based on a condition.

Fields:

- `mode`: `keep` or `drop`
- `condition`

### `splitColumn`

Splits one string column into explicit output columns using a delimiter.

Fields:

- `columnId`
- `delimiter`
- `outputColumns`
  - `columnId`
  - `displayName`

### `combineColumns`

Creates a new string column by joining values from existing columns.

Fields:

- `columnIds`
- `separator`
- `newColumn`
  - `columnId`
  - `displayName`

### `deduplicateRows`

Removes duplicate rows using one or more key columns.

Fields:

- `columnIds`

### `sortRows`

Sorts rows using one or more sort keys.

Fields:

- `sorts`
  - `columnId`
  - `direction`: `asc` or `desc`
