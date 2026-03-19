# Validation Rules

## Validation Model

V1 validation has two layers:

1. Structural validation against `schemas/workflow-ir-v1.schema.json`.
2. Semantic validation against the active table schema as it exists at each workflow step.

Rules:

- Validation runs in step order.
- A valid step may change the schema seen by later steps.
- An invalid step does not contribute schema changes to later validation.
- The validator should continue after an error to collect more concrete issues.
- Missing columns are always validation errors, never silent no-ops.

## Global Rules

### Workflow-Level Rules

- `version` must equal `1`.
- `workflowId` must be present.
- `name` must be present.
- Step `id` values must be unique within the workflow.

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
- String operations do not silently coerce number or boolean columns in place.

Error code:

- `incompatibleType`

## Step Rules

### `fillEmpty`

Valid when:

- every targeted column exists
- the target is not empty
- the fill value is compatible with every targeted column

Compatibility rules:

- `string`, `date`, and `datetime` columns require a string fill value
- `number` columns require a numeric fill value
- `boolean` columns require a boolean fill value
- `unknown` columns accept any non-null scalar fill value
- `mixed` columns are invalid targets

Additional rule:

- `treatWhitespaceAsEmpty: true` is only valid when every targeted column is `string` or `unknown`

Errors:

- `missingColumn`
- `incompatibleType`
- `emptyTarget`

### `normalizeText`

Valid when:

- every targeted column exists
- every targeted column is `string` or `unknown`

Rules:

- `trim`, `collapseWhitespace`, and `case` are explicit; omitted behavior is not inferred
- Number, boolean, date, datetime, and mixed columns are invalid targets

Errors:

- `missingColumn`
- `incompatibleType`
- `emptyTarget`

### `renameColumn`

Valid when:

- the referenced `columnId` exists
- `newDisplayName` is non-empty after trimming
- the normalized new display name does not conflict with any other visible display name

Rules:

- Renaming does not change `columnId`
- Renaming a column to its current display name is valid

Errors:

- `missingColumn`
- `nameConflict`
- `invalidDisplayName`

### `deriveColumn`

Valid when:

- `newColumn.columnId` is unique
- `newColumn.displayName` is unique after normalization
- every referenced column in the expression exists at that step

Expression rules:

- `literal` is always valid
- `column` requires an existing `columnId`
- `concat` must contain at least one part and returns a string
- `coalesce` must contain at least two inputs
- `coalesce` inputs must resolve to compatible logical types or `unknown`

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

- every targeted source column exists
- at least two source columns are provided
- the new column ID and display name are unique

Rules:

- source column order is the order listed in the target
- the result column logical type is `string`
- source columns remain in the schema
- repeated source column references are invalid

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `duplicateColumnId`
- `nameConflict`
- `emptyTarget`

### `deduplicateRows`

Valid when:

- every targeted key column exists
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

Missing-column behavior is fixed for V1:

- A referenced missing `columnId` is a validation error.
- Preview and run are blocked until the error is resolved.
- The system must not silently skip the step.
- The system must not fall back to matching on display name.

## Incompatible-Type Behavior

Incompatible-type behavior is also fixed:

- Semantic incompatibility is a validation error, not a warning.
- V1 does not silently cast target columns for in-place operations.
- The only intentional stringification operations are `concat` inside `deriveColumn` and `combineColumns`.

## Error Reporting

Every semantic error should include:

- error code
- human-readable message
- step ID
- JSON path
- enough detail to explain the failing `columnId`, comparator, or proposed display name
