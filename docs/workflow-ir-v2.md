# Workflow IR v2

## Design Rules

Workflow IR v2 is the single current workflow format.

Rules:

- `version` is required and always `2`.
- A workflow is an ordered list of explicit tabular operations.
- Steps execute top to bottom.
- Later steps see schema changes made by earlier valid steps.
- Persisted workflows never refer to transient UI state.
- The IR is editor-agnostic. Blockly is only an authoring view.
- The IR does not contain loops, arbitrary variables, or user-defined functions.

## Workflow Object

Required fields:

- `version`
- `workflowId`
- `name`
- `steps`

Optional fields:

- `description`

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

Every step has:

- `id`
- `type`

Step types:

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
- trim / normalize text: `scopedTransform` with built-in string calls such as `lower(trim(value))`
- drop columns: `dropColumns`
- rename columns: `renameColumn`
- create a derived column: `deriveColumn`
- filter rows: `filterRows`
- split columns: `splitColumn`
- combine columns: `combineColumns`
- deduplicate rows: `deduplicateRows`
- sort rows: `sortRows`

## Expression Object

Workflow IR v2 uses one shared expression AST for both cell transforms and logical checks.

Expression kinds:

- `value`
- `literal`
- `column`
- `call`

Rules:

- `value` means the current selected cell and is valid only inside `scopedTransform.expression`.
- `literal` returns a scalar value.
- `column` reads one existing column by `columnId` from the current row.
- `call` applies one built-in pure function.

Built-in call names:

- string / text: `trim`, `lower`, `upper`, `collapseWhitespace`, `substring`, `replace`
- list / utility: `split`, `first`, `last`, `coalesce`, `concat`
- logic: `isEmpty`, `equals`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `greaterThan`, `lessThan`, `and`, `or`, `not`

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

```json
{
  "kind": "call",
  "name": "and",
  "args": [
    {
      "kind": "call",
      "name": "startsWith",
      "args": [
        {
          "kind": "column",
          "columnId": "col_first_name"
        },
        {
          "kind": "literal",
          "value": "A"
        }
      ]
    },
    {
      "kind": "call",
      "name": "startsWith",
      "args": [
        {
          "kind": "column",
          "columnId": "col_last_name"
        },
        {
          "kind": "literal",
          "value": "A"
        }
      ]
    }
  ]
}
```

## Validation Error Object

Semantic validation returns structured errors; this object is not persisted in the workflow itself.

Required fields:

- `code`
- `severity`
- `message`
- `path`
- `phase`

Optional fields:

- `stepId`
- `details`

## Step Definitions

### `scopedTransform`

Applies one expression to one or more selected columns, optionally only on rows matching a boolean expression.

Fields:

- `columnIds`
- `rowCondition` optional
- `expression`

Rules:

- the expression is evaluated once per selected cell
- `value` means the current selected cell value
- `column` may read another column from the current row
- if `rowCondition` is omitted, all rows are eligible
- `rowCondition` must resolve to a boolean value
- whitespace-sensitive logic is expressed explicitly with functions such as `trim(...)`

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
      }
    }
  ]
}
```

### `dropColumns`

Drops one or more existing columns from the active table.

Fields:

- `columnIds`

### `renameColumn`

Changes the display name of one existing column without changing its `columnId`.

Fields:

- `columnId`
- `newDisplayName`

### `deriveColumn`

Creates one new column from an expression.

Fields:

- `newColumn`
- `expression`

Rules:

- `column` references are valid here
- `value` is not valid here
- the authoring UI may present this as `create new column`
- blank initialization compiles to `{"kind":"literal","value":null}`
- copy-column initialization compiles to `{"kind":"column","columnId":"..."}`

### `filterRows`

Keeps or drops rows based on a boolean expression.

Fields:

- `mode`
- `condition`

Rules:

- `condition` uses the same expression AST as every other logical check
- `condition` must resolve to a boolean value

### `splitColumn`

Splits one string column into explicit output columns using a delimiter.

Fields:

- `columnId`
- `delimiter`
- `outputColumns`

### `combineColumns`

Creates a new string column by joining values from existing columns.

Fields:

- `columnIds`
- `separator`
- `newColumn`

### `deduplicateRows`

Removes duplicate rows using one or more key columns.

Fields:

- `columnIds`

### `sortRows`

Sorts rows using one or more sort keys.

Fields:

- `sorts`
