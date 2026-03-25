# Data Semantics

## Canonical Value Rules

### Null vs Empty String

V1 preserves `null` and empty string as different values.

Rules:

- `null` means the source cell had no value.
- `""` means the source explicitly contained an empty text value.
- Emptiness-sensitive behavior only treats `null` and `""` as empty.
- `null` is not equal to `""` for equality checks, deduplication, or sort comparison.

### Whitespace-Only Values

Whitespace-only text is preserved on import as a string.

Rules:

- `"   "` is not automatically converted to `null`.
- whitespace-only strings are not treated as empty by default
- if a workflow wants whitespace-sensitive emptiness, it must express that directly, for example `isEmpty(trim(column("email")))`
- `trim(...)` or `collapseWhitespace(...)` may turn whitespace-only strings into `""`

## Expression Semantics

Workflow IR v2 uses one shared expression AST for both data transforms and logical checks.

Expression node kinds:

- `value`
- `literal`
- `column`
- `call`

Rules:

- `value` means the current selected cell and is valid only inside `scopedTransform.expression`
- `column` means another column in the current row and is valid anywhere row-scoped expressions are evaluated
- `literal` may be `string`, `number`, `boolean`, or `null`
- `call` applies one built-in pure function

Built-in function semantics:

- `trim(x)`: trims leading and trailing whitespace from string inputs
- `lower(x)`: lowercases string inputs
- `upper(x)`: uppercases string inputs
- `collapseWhitespace(x)`: replaces one or more whitespace runs with one ASCII space
- `substring(x, start, length)`: returns the selected string slice
- `replace(x, from, to)`: replaces all exact `from` matches with `to`
- `split(x, delimiter)`: splits a string into a list of string parts
- `first(x)`: returns the first character of a string or the first element of a list; empty inputs return `null`
- `last(x)`: returns the last character of a string or the last element of a list; empty inputs return `null`
- `coalesce(a, b)`: returns `a` unless `a` is `null` or `""`, otherwise returns `b`
- `concat(a, b, ...)`: stringifies non-null scalar values and joins them with no separator
- `isEmpty(x)`: returns `true` only when `x` is `null` or `""`
- `equals(a, b)`: exact scalar equality
- `contains(a, b)`: string containment
- `startsWith(a, b)`: string prefix check
- `endsWith(a, b)`: string suffix check
- `matchesRegex(a, b)`: regex test where `b` is a pattern string
- `greaterThan(a, b)`: ordered scalar comparison
- `lessThan(a, b)`: ordered scalar comparison
- `and(a, b, ...)`: boolean conjunction
- `or(a, b, ...)`: boolean disjunction
- `not(x)`: boolean negation

Determinism rules:

- Functions are pure and deterministic.
- No function mutates other cells, rows, or schema.
- V1 does not support user-defined functions, loops, or recursion.

## Type Inference

### Supported Logical Types

Schema-level logical types:

- `unknown`
- `string`
- `number`
- `boolean`
- `date`
- `datetime`
- `mixed`

### Inference Algorithm

Type inference runs per column after import and after workflow execution using all non-null cells in that column.

Rules:

1. Ignore `null` values for inference.
2. If no non-null values remain, the column type is `unknown`.
3. If every non-null value is a boolean, the column type is `boolean`.
4. If every non-null value is a finite number, the column type is `number`.
5. If every non-null value is an ISO `YYYY-MM-DD` string, the column type is `date`.
6. If every non-null value is an ISO-8601 datetime string, the column type is `datetime`.
7. If every non-null value is a string and none of the rules above apply, the column type is `string`.
8. Otherwise the column type is `mixed`.

## Duplicate Column Names

Header normalization is deterministic and happens at import time.

Rules:

1. Trim leading and trailing whitespace from each header.
2. Collapse internal whitespace runs to a single space for conflict checks.
3. If the normalized header is empty, use `Column`.
4. If a normalized display name already exists, append ` (2)`, ` (3)`, and so on.
5. Duplicate checks are case-insensitive.
6. `columnId` is generated separately and does not depend on later renames.

## Formulas on Import

V1 imports spreadsheet formulas as values only.

Rules:

- If a formula cell has a cached calculated value, import that value.
- If a formula cell has no cached value, import `null` and emit an import warning.
- Formula text is not preserved.
- Formula dependency graphs are not preserved.

## Deduplication Semantics

`deduplicateRows` uses exact canonical values on the current table state.

Rules:

- Deduplication keys are evaluated after all prior workflow steps.
- The only keep rule is `keep first`.
- “First” means first row in the current `rowOrder` when the step executes.
- `null` equals `null`.
- `""` equals `""`.
- `null` does not equal `""`.
- String comparison is exact and case-sensitive.

## Sorting Semantics

`sortRows` is deterministic and stable.

Rules:

- Nulls sort last, regardless of ascending or descending direction.
- Empty string sorts as a non-null string.
- String sorting uses raw string code-point order.
- Number sorting uses numeric order.
- Boolean sorting uses `false < true`.
- Date and datetime sorting use chronological order of valid ISO strings.
- Sorts are stable: rows equal on all sort keys preserve their previous relative order.

## Split-Column Semantics

`splitColumn` creates explicit output columns.

Rules:

- The IR must contain explicit `outputColumns`.
- The default UI suggestion for new display names is `<source display name>_1`, `<source display name>_2`, and so on.
- Output display names must still pass normal duplicate-name validation rules.
- The number of output columns controls the maximum number of produced parts.
- If the input has fewer parts than output columns, trailing outputs become `null`.
- If the input has more parts than output columns, the final output column receives the unsplit remainder.
- Split does not trim parts automatically.

## Combine-Column Semantics

`combineColumns` always creates a new string column.

Rules:

- Source columns are read left to right.
- `null` and `""` are skipped when building the combined string.
- Whitespace-only strings are not skipped automatically.
- The separator is inserted only between kept values.
- Source columns remain in the output table.

## Open Questions

None for the current milestone.
