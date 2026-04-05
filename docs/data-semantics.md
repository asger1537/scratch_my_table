# Data Semantics

## Canonical Value Rules

### Null vs Empty String

Rules:

- `null` means the source cell had no value.
- `""` means the source explicitly contained an empty text value.
- `coalesce(...)` treats only `null` and `""` as empty.
- `isEmpty(...)` treats `null`, `""`, and whitespace-only strings as empty.
- `null` is not equal to `""` for equality checks, deduplication, or sort comparison.

### Whitespace-Only Values

Whitespace-only text is preserved on import as a string.

Rules:

- `"   "` is not automatically converted to `null`.
- whitespace-only strings remain strings on import
- `isEmpty(...)` treats whitespace-only strings as empty
- `trim(...)` or `collapseWhitespace(...)` may turn whitespace-only strings into `""`

## Expression Semantics

Workflow IR v2 uses one shared expression AST for both data transforms and logical checks.

Expression node kinds:

- `value`
- `literal`
- `column`
- `call`
- `match`

Rules:

- `value` means the current selected cell and is valid only inside `scopedRule.cases[*].when`, `scopedRule.cases[*].then.value`, and `scopedRule.defaultPatch.value`
- during `scopedRule` case evaluation, `value` reflects the cell value after any earlier matching cases have already applied
- `value` is represented exactly as `{ "kind": "value" }`
- `null` is represented as `{ "kind": "literal", "value": null }`
- `column` means another column in the current row and is valid anywhere row-scoped expressions are evaluated
- `literal` may be `string`, `number`, `boolean`, or `null`
- `call` applies one built-in pure function
- `match` applies ordered exclusive classification over one subject expression

Built-in function semantics:

- `now()`: returns the execution timestamp for the current workflow run; it is stable across every row and step in that one execution
- `datePart(x, part)`: extracts one UTC date/time part from `x`, where `part` is one of `year`, `month`, `day`, `dayOfWeek`, `hour`, `minute`, or `second`
- `dateDiff(a, b, unit)`: returns the numeric difference `a - b` in `years`, `months`, `days`, `hours`, `minutes`, or `seconds`
- `dateAdd(x, amount, unit)`: adds `amount` of the given `years`, `months`, `days`, `hours`, `minutes`, or `seconds` unit to `x` and returns an ISO datetime string
- `round(x)`: returns `x` rounded to the nearest integer
- `floor(x)`: returns the greatest integer less than or equal to `x`
- `ceil(x)`: returns the smallest integer greater than or equal to `x`
- `abs(x)`: returns the absolute value of `x`
- `add(a, b)`: returns `a + b`
- `subtract(a, b)`: returns `a - b`
- `multiply(a, b)`: returns `a * b`
- `divide(a, b)`: returns `a / b`
- `modulo(a, b)`: returns `a % b`
- `trim(x)`: trims leading and trailing whitespace from string inputs
- `lower(x)`: lowercases string inputs
- `upper(x)`: uppercases string inputs
- `toNumber(x)`: returns `x` unchanged for numeric inputs, `1` or `0` for booleans, parses trimmed finite numeric strings, and returns `null` for empty, invalid, or non-finite inputs
- `toString(x)`: returns `null` for `null`, leaves strings unchanged, and stringifies numbers and booleans
- `toBoolean(x)`: accepts booleans, numeric `1`/`0`, and trimmed case-insensitive `true`/`false`/`yes`/`no`/`1`/`0`; all other inputs return `null`
- `collapseWhitespace(x)`: replaces one or more whitespace runs with one ASCII space
- `substring(x, start, length)`: returns the selected string slice
- `replace(x, from, to)`: replaces all exact `from` matches with `to`
- `extractRegex(x, pattern)`: returns the first match of the regular expression `pattern` in string `x`, or `null` if no match is found.
- `replaceRegex(x, pattern, replacement)`: replaces all matches of the regular expression `pattern` in string `x` with `replacement`.
- `split(x, delimiter)`: splits a string into a list of string parts
- `atIndex(x, index)`: returns the element at the zero-based `index` of a list, or the character at `index` of a string. Out-of-bounds or invalid indices return `null`.
- `first(x)`: returns the first character of a string or the first element of a list; empty inputs return `null`
- `last(x)`: returns the last character of a string or the last element of a list; empty inputs return `null`
- `coalesce(a, b)`: returns `a` unless `a` is `null` or `""`, otherwise returns `b`
- `match(subject, cases)`: evaluates `subject` once and returns the `then` expression from the first case whose pattern matches and whose optional `when` guard is true. Wildcard fallback is optional; if no case matches, the result is `null`.
- `concat(a, b, ...)`: stringifies non-null scalar values and joins them with no separator
- `isEmpty(x)`: returns `true` when `x` is `null`, `""`, or a whitespace-only string
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

Math function rules:

- Math functions require strictly numeric inputs.
- If any input is `null` or non-numeric, including `""`, the function returns `null`.
- `divide(..., 0)` and `modulo(..., 0)` return `null`.

Date/time function rules:

- Date/time functions accept ISO date strings, ISO datetime strings, or existing `date` / `datetime` typed values.
- Date-only strings are parsed as midnight UTC.
- ISO datetime strings without an explicit timezone are treated as UTC.
- Invalid dates or unsupported units return `null`.
- `now()` is stable across a single workflow execution.

Determinism rules:

- Functions are pure and deterministic.
- No function mutates other cells, rows, or schema.
- Workflow IR v2 does not support user-defined functions, loops, or recursion.
- Explicit casts are the intended way to normalize messy imported values before math, sorting, or boolean logic.
- `match` is the intended classification and bucketing construct for deriving labels or scores.
- `scopedRule` remains the cumulative cell-rewrite construct; multiple `scopedRule` cases may apply in sequence to the evolving current cell value.

## Cell Formatting Semantics

Workflow formatting is separate from canonical cell values.

Rules:

- `scopedRule` format patches store per-cell fill color state without changing the underlying value
- formatting is produced by workflow execution; import still ignores incoming spreadsheet formatting
- preview UI may render runtime fill colors directly from the transformed table state
- CSV export is value-only and does not preserve formatting
- XLSX export writes runtime fill colors for styled cells

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
