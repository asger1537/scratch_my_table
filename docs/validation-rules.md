# Validation Rules

## Validation Model

Workflow IR v2 validation has two layers:

1. Structural validation against `schemas/workflow-ir-v2.schema.json`.
2. Semantic validation against the active table schema as it exists at each workflow step.

Rules:

- Validation runs in step order.
- A valid step may change the schema seen by later steps.
- An invalid step does not contribute schema changes to later validation.
- The validator continues after an error to collect more concrete issues.
- Missing columns are always validation errors, never silent no-ops.

## Global Rules

### Workflow-Level Rules

- `version` must equal `2`.
- `workflowId` must be present.
- `name` must be present.
- Step `id` values must be unique within the workflow.

Supported migration behavior:

- supported legacy `version: 1` workflows are upgraded to canonical v2 before structural validation completes
- after upgrade, all later validation runs against the v2 shape only

### Column Reference Rules

- Every referenced `columnId` must exist in the schema visible at that step.
- A step may reference a column created by an earlier valid step.
- A step may not reference a column created by a later step.

Error code:

- `missingColumn`

### Display Name Conflict Rules

Display name conflict checks use the same normalization as import:

1. trim outer whitespace
2. collapse internal whitespace runs to one space
3. compare case-insensitively

Rules:

- `renameColumn`, `deriveColumn`, `splitColumn`, and `combineColumns` must not create a conflicting display name.
- Workflow-authored naming conflicts are validation errors.
- V1 does not auto-suffix workflow-authored names.

Error code:

- `nameConflict`

### Created Column ID Rules

- Any new `columnId` must be unique within the schema visible at that step.
- `splitColumn` output column IDs must be distinct from one another.
- A new `columnId` must not reuse an existing imported or previously created column ID.

Error code:

- `duplicateColumnId`

### Type Compatibility Rules

Validation uses the column `logicalType` visible at that step.

Rules:

- `unknown` is treated as compatible when the active table provides no contradictory non-null values.
- `mixed` is incompatible with operations that require a single ordering or comparison model.
- String functions do not silently coerce number or boolean columns in place.

Error code:

- `incompatibleType`

## Expression Rules

Workflow IR v2 uses the shared expression AST:

- `value`
- `literal`
- `column`
- `call`

Rules:

- `value` is valid only inside `scopedTransform`.
- `column` is valid inside both `deriveColumn` and `scopedTransform`.
- `literal` is always structurally valid.
- `call` must use one supported built-in function name and the correct arity.

Function rules:

- `trim`, `lower`, `upper`, `collapseWhitespace` require exactly 1 string-like argument
- `substring` requires 3 arguments: string input, numeric start, numeric length
- `replace` requires 3 arguments: string input, string `from`, string `to`
- `split` requires 2 scalar arguments: string input and string delimiter, and returns an intermediate list value
- `first` and `last` require exactly 1 argument and accept either a string or a list value
- `coalesce` requires exactly 2 arguments with compatible logical types
- `concat` requires at least 2 arguments and returns a string
- Final `scopedTransform` and `deriveColumn` expressions must resolve to scalar cell values; list values are only valid as intermediate results

Errors:

- `invalidExpression`
- `incompatibleType`
- `missingColumn`

## Step Rules

### `scopedTransform`

Valid when:

- every targeted column exists
- at least one target column is provided
- target column references are unique
- `rowCondition`, if present, is valid
- the expression is valid for every targeted column type

Rules:

- `value` is evaluated as the current selected cell
- `column` may read any existing column from the current row
- `rowCondition` is evaluated against the current row before applying the expression
- `treatWhitespaceAsEmpty` affects `coalesce(...)` empty matching only
- authoring defaults `treatWhitespaceAsEmpty` to `true`; workflows may still explicitly set it to `false`
- `treatWhitespaceAsEmpty: true` is only valid when a `coalesce` call may inspect string or unknown cells

Common capability mappings:

- fill empty cells: `coalesce(value, <literal>)`
- normalize text: nested string functions such as `lower(trim(value))`

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `emptyTarget`
- `invalidExpression`
- `incompatibleType`

### `renameColumn`

Valid when:

- the referenced `columnId` exists
- `newDisplayName` is non-empty after trimming
- the normalized new display name does not conflict with any other visible display name

Rules:

- Renaming does not change `columnId`.
- Renaming a column to its current display name is valid.

Errors:

- `missingColumn`
- `nameConflict`
- `invalidDisplayName`

### `dropColumns`

Valid when:

- every referenced `columnId` exists
- at least one column is provided
- column references are unique
- at least one column remains after the drop

Rules:

- dropped columns are removed from the visible schema for later steps
- later steps validate against the reduced schema after the drop step has applied

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `emptyTarget`
- `emptySchema`

### `deriveColumn`

Valid when:

- `newColumn.columnId` is unique
- `newColumn.displayName` is unique after normalization
- every referenced column in the expression exists at that step
- the expression does not use `value`

Rules:

- `column` references are valid here
- `concat` may combine mixed literal and column inputs because it stringifies values
- `coalesce` inputs must still resolve to compatible logical types or `unknown`

Errors:

- `duplicateColumnId`
- `nameConflict`
- `missingColumn`
- `invalidExpression`
- `incompatibleType`

### `filterRows`

Valid when:

- every referenced column in the condition exists
- each condition uses a comparator compatible with the referenced column type

Comparator rules:

- `isEmpty` is valid for any column type
- `equals` is valid for any non-mixed column if the literal value matches the column type
- `contains`, `startsWith`, and `endsWith` require `string` or `unknown`
- `greaterThan` and `lessThan` require `number`, `date`, `datetime`, or `unknown`
- `and` and `or` require at least two child conditions
- `not` requires exactly one child condition

Errors:

- `missingColumn`
- `invalidCondition`
- `incompatibleType`

### `splitColumn`

Valid when:

- the source `columnId` exists
- the source column is `string` or `unknown`
- `delimiter` is non-empty
- `outputColumns` contains at least two entries
- every output `columnId` is unique
- every output `displayName` is unique and does not conflict with existing display names

Execution edge cases:

- null input produces null in every output column
- fewer parts than outputs produces trailing nulls
- more parts than outputs merges the remainder into the last output column
- the source column remains in the schema

Errors:

- `missingColumn`
- `duplicateColumnId`
- `nameConflict`
- `incompatibleType`
- `invalidDelimiter`

### `combineColumns`

Valid when:

- every source column exists
- at least two source columns are provided
- source column references are unique
- the new column ID and display name are unique

Rules:

- source column order is the order listed in `columnIds`
- the result column logical type is `string`
- source columns remain in the schema

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `duplicateColumnId`
- `nameConflict`
- `emptyTarget`

### `deduplicateRows`

Valid when:

- every key column exists
- at least one key column is provided
- key column references are unique

Edge cases:

- duplicate rows are detected using exact canonical value equality on the current table state
- if all key values are equal, the first row in current `rowOrder` survives
- if `sortRows` appears earlier in the workflow, its order determines which row is kept

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `emptyTarget`

### `sortRows`

Valid when:

- at least one sort key is present
- every sort key column exists
- each sort key is unique within the step
- every sort key column is not `mixed`

Edge cases:

- nulls sort last in both ascending and descending order
- rows equal on all sort keys preserve prior relative order
- string sort is case-sensitive code-point order
- number sort is numeric
- boolean sort is `false < true`
- date/datetime sort uses ISO chronological order

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `incompatibleType`
- `emptySort`

## Missing-Column Behavior

Missing-column behavior is fixed:

- A referenced missing `columnId` is a validation error.
- Preview and run are blocked until the error is resolved.
- The system must not silently skip the step.
- The system must not fall back to matching on display name.

## Incompatible-Type Behavior

Incompatible-type behavior is also fixed:

- Semantic incompatibility is a validation error, not a warning.
- V1 does not silently cast target columns for in-place operations.
- The intentional stringification operations are `concat` and `combineColumns`.

## Error Reporting

Every semantic error should include:

- error code
- human-readable message
- step ID
- JSON path
- enough detail to explain the failing `columnId`, comparator, function, or proposed display name
