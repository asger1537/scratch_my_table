# Data Semantics

## Canonical Value Rules

### Null vs Empty String

V1 preserves `null` and empty string as different values.

Rules:

- `null` means the source cell had no value.
- `""` means the source explicitly contained an empty text value.
- Emptiness-sensitive workflow behavior treats both `null` and `""` as empty by default.
- `null` is not equal to `""` for deduplication, equality filters, or sort comparison.

### Whitespace-Only Values

Whitespace-only text is preserved on import as a string.

Rules:

- `"   "` is not automatically converted to `null`.
- `"   "` is not automatically treated as empty.
- A step may opt in to treating whitespace-only strings as empty where the IR supports `treatWhitespaceAsEmpty`.
- `normalizeText` may turn whitespace-only strings into `""` when `trim` is enabled.

### String Normalization

`normalizeText` uses explicit flags instead of hidden behavior.

Rules:

- `trim: true` removes leading and trailing Unicode whitespace.
- `collapseWhitespace: true` replaces one or more consecutive whitespace characters inside the string with a single ASCII space.
- `case: "preserve" | "lower" | "upper"` is applied after trimming and whitespace collapsing.
- If normalization produces an empty string, the stored value becomes `""`, not `null`.

## Type Inference

### Supported Logical Types

The schema-level logical types for V1 are:

- `unknown`
- `string`
- `number`
- `boolean`
- `date`
- `datetime`
- `mixed`

### Inference Algorithm

Type inference runs per column after import and uses all non-null cells in that column.

Rules:

1. Ignore `null` values for inference.
2. If no non-null values remain, the column type is `unknown`.
3. If every non-null value is a boolean, the column type is `boolean`.
4. If every non-null value is a finite number, the column type is `number`.
5. If every non-null value is an ISO `YYYY-MM-DD` string, the column type is `date`.
6. If every non-null value is an ISO-8601 datetime string, the column type is `datetime`.
7. If every non-null value is a string and none of the rules above apply, the column type is `string`.
8. Otherwise the column type is `mixed`.

Conservative parsing rules:

- CSV values are only promoted beyond `string` when the parse is unambiguous.
- Locale-dependent formats such as `03/04/2025` remain `string`.
- Numbers with thousands separators remain `string`.
- Dates and datetimes are stored as ISO strings in cells, with the logical type recorded in the schema.

## Duplicate Column Names

Header normalization is deterministic and happens at import time.

Rules:

1. Trim leading and trailing whitespace from each header.
2. Collapse internal whitespace runs to a single space for conflict checks.
3. If the normalized header is empty, use `Column`.
4. If a normalized display name already exists, append ` (2)`, ` (3)`, and so on.
5. Duplicate checks are case-insensitive.
6. `columnId` is generated separately and does not depend on later renames.

Examples:

- `Email`, ` email `, and `EMAIL` become `Email`, `Email (2)`, and `Email (3)`.
- blank, blank become `Column` and `Column (2)`.

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
- The default and only V1 keep rule is `keep first`.
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

- The IR must contain explicit `outputColumns`; output names are not inferred at execution time.
- The default UI suggestion for new display names is `<source display name>_1`, `<source display name>_2`, and so on.
- Output display names must still pass the normal duplicate-name validation rules.
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

None for V1. The Phase 1 default is to fix the semantics above instead of introducing configurable import or execution modes.
