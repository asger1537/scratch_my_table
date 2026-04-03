# Validation Rules

## Validation Model

Workflow IR v2 validation has two layers:

1. Structural validation against `schemas/workflow-ir-v2.schema.json`
2. Semantic validation against the active table schema as it exists at each workflow step

Rules:

- Validation runs in step order.
- A valid step may change the schema seen by later steps.
- An invalid step does not contribute schema changes to later validation.
- The validator continues after an error to collect more issues.
- Missing columns are always validation errors.

## Global Rules

### Workflow-Level Rules

- `version` must equal `2`
- `workflowId` must be present
- `name` must be present
- step `id` values must be unique

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

- `renameColumn`, `deriveColumn`, `splitColumn`, and `combineColumns` must not create a conflicting display name
- workflow-authored naming conflicts are validation errors
- workflow-authored names are not auto-suffixed

Error code:

- `nameConflict`

### Created Column ID Rules

- Any new `columnId` must be unique within the visible schema.
- `splitColumn` output column IDs must be distinct from one another.
- A new `columnId` must not reuse an existing imported or previously created column ID.

Error code:

- `duplicateColumnId`

### Type Compatibility Rules

Validation uses the column `logicalType` visible at that step.

Rules:

- `unknown` is treated as compatible when the active table provides no contradictory non-null values
- `mixed` is incompatible with operations that require a single comparison or ordering model
- string functions do not silently coerce number or boolean columns in place

Error code:

- `incompatibleType`

## Expression Rules

Workflow IR v2 uses one shared expression AST:

- `value`
- `literal`
- `column`
- `call`

Rules:

- `value` is valid only inside `scopedRule.cases[*].when`, `scopedRule.cases[*].then.value`, and `scopedRule.defaultPatch.value`
- `value` is represented exactly as `{ "kind": "value" }`
- `null` must be represented as `{ "kind": "literal", "value": null }`
- `column` is valid anywhere row-scoped expressions are evaluated
- `literal` is always structurally valid
- `call` must use one supported built-in function name and the correct arity
- logical checks in `filterRows.condition`, `scopedRule.rowCondition`, and `scopedRule.cases[*].when` are ordinary expressions and must resolve to boolean

Function rules:

- `now` requires exactly 0 arguments
- `trim`, `lower`, `upper`, `toNumber`, `toString`, `toBoolean`, `collapseWhitespace`, `first`, `last`, `isEmpty`, `not`, `round`, `floor`, `ceil`, and `abs` require exactly 1 argument
- `substring` requires 3 arguments: string input, numeric start, numeric length
- `replace`, `replaceRegex`, `dateDiff`, and `dateAdd` require 3 arguments
- `split`, `atIndex`, `extractRegex`, `coalesce`, `equals`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `greaterThan`, `lessThan`, `add`, `subtract`, `multiply`, `divide`, `modulo`, and `datePart` require exactly 2 arguments
- `and`, `or`, and `concat` require at least 2 arguments
- `switch` requires at least 4 arguments and must have an even number of arguments
- `split` returns an intermediate list value
- final `scopedRule` patch values and `deriveColumn` expressions must resolve to scalar cell values

Type rules:

- `now` returns `datetime`
- `datePart` requires a date, datetime, or string-like input plus a string unit and returns `number`
- `dateDiff` requires two date, datetime, or string-like inputs plus a string literal unit and returns `number`
- `dateAdd` requires a date, datetime, or string-like input, a numeric amount, and a string literal unit; it returns `datetime`
- `trim`, `lower`, `upper`, `collapseWhitespace` require string-like inputs
- `toNumber`, `toString`, and `toBoolean` require one scalar input; they accept mixed and unknown scalar sources and resolve to `number`, `string`, and `boolean`
- `substring` requires string, number, number
- `replace` requires string, string, string
- `extractRegex` requires string-like inputs and returns `string`
- `replaceRegex` requires three string-like inputs and returns `string`
- `split` requires string, string
- `atIndex` requires a string or intermediate list as the first input, and a number as the second input
- `first` and `last` accept a string or intermediate list
- `round`, `floor`, `ceil`, and `abs` require numeric inputs and return `number`
- `add`, `subtract`, `multiply`, `divide`, and `modulo` require numeric inputs and return `number`
- `coalesce` requires scalar inputs with compatible logical types
- `switch` requires the `target` to be comparable to all `match` inputs. All `result` inputs and the `defaultResult` must resolve to compatible logical types
- `concat` accepts scalar inputs and returns `string`
- `isEmpty` requires a scalar input and returns `boolean`
- `not` requires a boolean-like input and returns `boolean`
- `and` and `or` require boolean-like inputs and return `boolean`
- `equals` requires comparable scalar inputs and returns `boolean`
- `greaterThan` and `lessThan` require ordered comparable scalar inputs and return `boolean`
- `contains`, `startsWith`, `endsWith`, and `matchesRegex` require string-like inputs and return `boolean`
- `isEmpty` treats whitespace-only strings as empty

Errors:

- `invalidExpression`
- `incompatibleType`
- `missingColumn`
- `invalidRegex`

## Step Rules

### `comment`

Valid when:

- `text` is present and non-empty

Behavior:

- comment steps are always schema-neutral
- comment steps do not produce semantic validation issues beyond structural shape checks

### `scopedRule`

Valid when:

- every targeted column exists
- at least one target column is provided
- target column references are unique
- `rowCondition`, if present, is a valid boolean expression
- at least one of `cases` or `defaultPatch` is present
- every `cases[*].when` expression resolves to boolean
- every `cases[*].then` and `defaultPatch`, if present, defines at least one of `value` or `format`
- every patch `value`, if present, resolves to a scalar cell value
- every `format.fillColor`, if present, is a valid 6-digit hex color such as `#ffeb9c`
- all value-producing branches are type-compatible for each targeted column

Rules:

- `rowCondition` is evaluated against the current row before any targeted cell work
- `value` is evaluated as the current selected cell
- `column` may read any existing column from the current row
- cases are checked top to bottom and every matching case applies in order
- later matching cases see the current cell value after earlier matching cases have already applied
- `defaultPatch`, if present, applies when no case matches
- patches may change value only, format only, or both
- format-only rules do not change schema
- a style-only change still counts as a changed cell in execution metadata
- preview and XLSX export may use the resulting color state
- CSV export ignores color state

Common capability mappings:

- fill empty cells: `defaultPatch.value = coalesce(value, <literal>)`
- fill empty trimmed text: `defaultPatch.value = coalesce(trim(value), <literal>)`
- normalize text: `defaultPatch.value = lower(trim(value))`
- highlight cells: `defaultPatch.format.fillColor = "#ffeb9c"`
- transform and highlight together: use both `then.value` and `then.format` in the same matching case

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `emptyTarget`
- `invalidColor`
- `invalidExpression`
- `incompatibleType`

### `renameColumn`

Valid when:

- the referenced `columnId` exists
- `newDisplayName` is non-empty after trimming
- the normalized new display name does not conflict with any other visible display name

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

Errors:

- `duplicateColumnId`
- `nameConflict`
- `missingColumn`
- `invalidExpression`
- `incompatibleType`

### `filterRows`

Valid when:

- every referenced column in the condition exists
- the condition resolves to a boolean logical type

Errors:

- `missingColumn`
- `invalidExpression`
- `invalidRegex`
- `incompatibleType`

### `splitColumn`

Valid when:

- the source `columnId` exists
- the source column is `string` or `unknown`
- `delimiter` is non-empty
- `outputColumns` contains at least two entries
- every output `columnId` is unique
- every output `displayName` is unique and does not conflict with existing display names

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

Errors:

- `missingColumn`
- `duplicateColumnReference`
- `incompatibleType`
- `emptySort`

## Missing-Column Behavior

- A referenced missing `columnId` is a validation error.
- Preview and run are blocked until the error is resolved.
- The system does not silently skip the step.
- The system does not fall back to matching on display name.

## Incompatible-Type Behavior

- Semantic incompatibility is a validation error, not a warning.
- The runtime does not silently cast target columns for in-place operations.
- Intentional stringification operations are `concat` and `combineColumns`.
