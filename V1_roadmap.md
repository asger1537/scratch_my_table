# V1 Roadmap

## V1 definition

V1 is an internal-only, local-first browser tool for applying reusable, block-defined transformations to one uploaded table at a time, with safe preview and export.

V1 should let an internal user:

1. upload a CSV/XLSX file
2. inspect the import result and select one active table
3. inspect the active table
4. build a simple workflow with blocks
5. preview the result safely
6. run the workflow
7. export the transformed table
8. save/load the workflow as versioned JSON

That is enough for a useful first internal release.

---

## V1 scope

### In scope

The V1 workflow step catalog is exactly:

- fill empty cells
- trim / normalize text
- rename columns
- create a derived column
- filter rows
- split columns
- combine columns
- deduplicate rows
- sort rows

These map to the persisted IR step types:

- `fillEmpty`
- `normalizeText`
- `renameColumn`
- `deriveColumn`
- `filterRows`
- `splitColumn`
- `combineColumns`
- `deduplicateRows`
- `sortRows`

### Out of scope for V1

Be strict here:

- joins / multi-table workflows
- group-by / aggregation
- pivots
- formula preservation
- spreadsheet formatting fidelity
- Excel macros
- collaboration
- auth / backend services
- cloud persistence
- AI-generated workflows
- batch processing many files at once
- full spreadsheet editing
- arbitrary scripting, loops, or generic user-authored control flow
- a text DSL as the execution source of truth

That list is what keeps V1 coherent and shippable.

---

## V1 product shape

I would define the product as four primary views.

### 1. Import + data view

Shows:

- uploaded file details
- active table / sheet selector
- column display names
- inferred logical types
- row count
- sample rows
- import warnings

### 2. Workflow view

A block-based editor for the V1 step catalog.

Important rule:

- blocks are an authoring view over the workflow IR
- the workflow IR is the source of truth
- transient UI selections are allowed in the editor, but persisted workflows must use explicit `columnId` references

### 3. Preview view

Shows:

- validation errors
- warnings
- before/after sample
- affected row count
- affected cell count

### 4. Workflow library view

For V1, this only needs:

- save workflow
- load workflow
- duplicate workflow
- export/import workflow JSON

Optional for late V1:

- readable DSL export as a secondary representation

---

## V1 user stories

These are the concrete stories V1 should satisfy.

### Story 1: Fill empty cells

A user fills empty values in one or more columns with a specified scalar value.

Example:

- fill missing `status` values with `"unknown"`

### Story 2: Normalize text

A user trims and normalizes text in one or more columns.

Examples:

- trim whitespace
- lowercase email addresses
- collapse internal whitespace in names

### Story 3: Rename columns

A user changes the exported/display header for a column without changing its stable internal `columnId`.

### Story 4: Create a derived column

A user creates a new column from one or more existing columns.

Examples:

- `full_name = first_name + " " + last_name`
- `display_label = coalesce(company_name, full_name)`

### Story 5: Filter rows

A user keeps or drops rows based on conditions.

Examples:

- keep rows with non-empty email
- keep paid orders above 100

### Story 6: Split columns

A user splits one text column into two or more explicit output columns.

Example:

- split `full_name` into `first_name` and `last_name`

### Story 7: Combine columns

A user combines multiple source columns into one new string column.

Example:

- combine `city` and `state` into `location`

### Story 8: Deduplicate rows

A user removes duplicates based on one or more key columns.

Example:

- keep the first row for each exact email

### Story 9: Sort rows

A user sorts rows by one or more columns.

Example:

- sort by `ordered_at desc`, then `order_total desc`

If V1 does these well, it is already a useful internal tool.

---

## Recommended V1 architecture

### Frontend

- TypeScript
- local-first browser app
- single-page application
- distributable as a simple bundled frontend

### Core runtime layers

- import layer
- canonical table model
- workflow IR
- validator
- executor
- preview/diff engine
- block editor projection
- persistence layer

### Core principles

Use:

- a canonical table model for imported and transformed data
- a typed workflow IR as the only persisted source of truth
- a block editor as one authoring view over the IR
- optional readable DSL export later as a secondary representation

Do not use:

- generated JavaScript as the workflow source of truth
- symbolic persisted targets like “currently selected columns”
- a general programming model as the user-facing abstraction

---

## Canonical table model for V1

Every uploaded file should normalize into:

- one `workbook`
- one or more imported `table` objects
- exactly one `activeTableId`
- a canonical `schema`
- stable `columnId` values
- stable `rowId` values
- `rowsById`
- `rowOrder`
- import warnings

### Supported input

- CSV
- XLSX

### Import rules

CSV:

- one CSV file becomes one workbook with one table
- the first row is treated as the header row
- subsequent rows are data rows
- the imported table becomes the active table automatically

XLSX:

- one XLSX file becomes one workbook with one table per sheet
- each sheet uses its first row as the header row
- the user selects exactly one sheet as the active table

### V1 assumptions

- workflows run against one active table only
- formulas are imported as values only
- formatting/styling is ignored
- merged cells are ignored
- macros are ignored
- dates/datetimes are stored as ISO strings with logical type metadata
- persisted workflow references must use stable `columnId` values, not display names

---

## V1 data semantics

These semantics are fixed for V1.

### Empty handling

- `null` and `""` are distinct values
- emptiness-sensitive behavior treats both `null` and `""` as empty by default
- whitespace-only strings are preserved as strings
- whitespace-only is only treated as empty when a step explicitly opts in with `treatWhitespaceAsEmpty`

### Text normalization

`normalizeText` uses explicit flags:

- `trim`
- `collapseWhitespace`
- `case: preserve | lower | upper`

### Type inference

Supported logical types:

- `unknown`
- `string`
- `number`
- `boolean`
- `date`
- `datetime`
- `mixed`

Inference is conservative and per-column.

### Duplicate headers

Header normalization is deterministic:

- trim outer whitespace
- collapse internal whitespace for conflict checks
- blank headers become `Column`
- duplicates get suffixes like `Email (2)`

### Deduplication

- V1 uses exact canonical value equality
- V1 keep rule is fixed to `keep first`
- “first” means first in current `rowOrder` when the step executes

### Sorting

- sorts are stable
- nulls sort last regardless of direction

### Split columns

- `splitColumn` requires explicit `outputColumns`
- output display names are not inferred at execution time
- the final output column receives any unsplit remainder

### Combine columns

- `combineColumns` always creates a new string column
- `null` and `""` are skipped
- whitespace-only strings are not skipped automatically

---

## V1 workflow model

The persisted workflow model is intentionally small and explicit.

### Workflow object

A workflow contains:

- `version`
- `workflowId`
- `name`
- optional `description`
- ordered `steps`

### Execution model

- steps execute top to bottom
- later steps see schema changes made by earlier valid steps
- validation runs in step order
- invalid steps do not contribute schema changes to later validation

### Important persisted-IR rule

Persisted workflows do not contain:

- symbolic selected columns
- row selections
- arbitrary variables
- loops
- generic control flow

Selections may exist in the UI, but before persistence they must resolve to explicit `columnId` references.

---

## V1 step catalog

### `fillEmpty`

Purpose:

- fill empty cells in targeted columns with a compatible scalar value

Core fields:

- `target`
- `value`
- `treatWhitespaceAsEmpty`

### `normalizeText`

Purpose:

- normalize existing string/unknown columns in place

Core fields:

- `target`
- `trim`
- `collapseWhitespace`
- `case`

### `renameColumn`

Purpose:

- change a column’s display/export name without changing `columnId`

Core fields:

- `columnId`
- `newDisplayName`

### `deriveColumn`

Purpose:

- create a new column from an expression

Core fields:

- `newColumn`
- `expression`

Supported expression kinds:

- `literal`
- `column`
- `concat`
- `coalesce`

### `filterRows`

Purpose:

- keep or drop rows based on a condition tree

Core fields:

- `mode`
- `condition`

Supported condition kinds:

- `isEmpty`
- `equals`
- `contains`
- `startsWith`
- `endsWith`
- `greaterThan`
- `lessThan`
- `and`
- `or`
- `not`

### `splitColumn`

Purpose:

- split one text column into explicit output columns

Core fields:

- `columnId`
- `delimiter`
- `outputColumns`

### `combineColumns`

Purpose:

- combine source columns into a new string column

Core fields:

- `target`
- `separator`
- `newColumn`

### `deduplicateRows`

Purpose:

- remove duplicates using one or more key columns

Core fields:

- `target`

### `sortRows`

Purpose:

- reorder rows deterministically using one or more sort keys

Core fields:

- `sorts`

---

## Validation model

Validation has two layers.

### 1. Structural validation

Validate against the JSON Schema for workflow IR.

### 2. Semantic validation

Validate against the active table schema as it exists at each step.

### Global rules

- missing columns are validation errors
- workflow-authored display-name conflicts are validation errors
- duplicate created `columnId` values are validation errors
- `mixed` is incompatible with operations that require a single comparison or ordering model
- invalid steps do not silently no-op

### Step-level rules to enforce

At minimum:

- `fillEmpty`: target exists, target non-empty, fill value type-compatible
- `normalizeText`: targets must be `string` or `unknown`
- `renameColumn`: referenced column exists and `newDisplayName` is valid
- `deriveColumn`: new column ID/display name unique; expression references valid
- `filterRows`: condition operators must be type-compatible
- `splitColumn`: source exists; source is `string` or `unknown`; delimiter non-empty; output columns valid
- `combineColumns`: at least two source columns; no repeated source columns; new column valid
- `deduplicateRows`: at least one key column; no repeated key references
- `sortRows`: sort keys exist; directions valid; key types orderable

---

## V1 roadmap by phase

## Phase 1: foundations and decisions

Goal:

- define the product boundary
- define the canonical data model
- define the workflow IR
- define fixed V1 semantics
- define validation rules
- define example workflows and fixtures

Deliverables:

- `docs/v1-scope.md`
- `docs/data-model.md`
- `docs/data-semantics.md`
- `docs/workflow-ir-v1.md`
- `docs/validation-rules.md`
- `docs/example-workflows.md`
- `docs/out-of-scope.md`
- `schemas/workflow-ir-v1.schema.json`
- fixtures

Acceptance criteria:

- all V1 step types are representable in IR
- semantics are explicit, not implied
- terminology is consistent
- no unresolved ambiguity around column identity, row identity, or validation order

## Phase 2: import/export and data grid

Goal:

- make file import, active-table selection, and table inspection solid

Deliverables:

- CSV import
- XLSX import
- active-sheet selector
- canonical import normalization
- data grid preview
- schema panel
- import warnings panel
- CSV/XLSX export

Tasks:

- build upload UI
- parse CSV and normalize to canonical model
- parse XLSX and create one table per sheet
- choose active table
- render first N rows in a virtualized grid
- show column display names, `columnId`, inferred type, and missing counts
- preserve import warnings for display

Acceptance criteria:

- user can load supported internal files
- CSV always imports as one active table
- XLSX allows one active-sheet selection
- malformed files fail gracefully
- export roundtrip works for supported value-only behavior

## Phase 3: validator and executor

Goal:

- make workflows executable independently of the block editor

Deliverables:

- structural validator
- semantic validator
- executor for every V1 step type
- diff/change summary
- worker-based execution

Tasks:

- validate workflow JSON against schema
- validate semantic compatibility against current step-visible schema
- execute each step type deterministically
- return transformed table snapshot, warnings, changed row count, and changed cell count
- add deterministic tests for each step type and cross-step schema evolution

Acceptance criteria:

- every V1 step type has passing tests
- execution is deterministic
- schema changes from earlier valid steps are visible to later steps
- validation errors are concrete and understandable

## Phase 4: block editor

Goal:

- let users author valid workflows visually

Deliverables:

- V1 block catalog
- block-to-IR conversion
- IR-to-block reconstruction
- validation UI in the editor

Tasks:

- create custom blocks for the V1 step catalog
- support transient UI column selection but resolve it to explicit `columnId` references before persistence
- build editors for:
  - target column lists
  - string/number/boolean literals
  - expressions
  - filter condition trees
  - sort directions
  - split output columns
- support reorder / delete / disable step
- show plain-language summary per step

Acceptance criteria:

- all canonical example workflows can be authored in blocks
- saved workflows reload into blocks without loss
- persisted IR never contains symbolic “selected columns”
- invalid workflows are blocked or clearly flagged

## Phase 5: preview and trust features

Goal:

- make users comfortable previewing and running workflows

Deliverables:

- before/after preview
- affected rows/cells summary
- warnings panel
- validation results panel
- step-focused preview

Tasks:

- compute preview on a sample and full metadata summary
- show side-by-side table diff
- show which step affects which columns/rows
- highlight missing-column and type errors clearly
- support session reset / rerun

Acceptance criteria:

- user can tell what will change before export
- user can identify which step caused a change
- preview remains fast on typical internal files

## Phase 6: workflow persistence

Goal:

- let internal users reuse workflows

Deliverables:

- save/load workflow JSON
- workflow metadata
- schema compatibility checks
- optional readable DSL export

Tasks:

- define on-disk workflow file format
- save and reload workflows
- detect missing columns on load/run
- keep JSON as canonical persisted format
- optionally add readable DSL export as a secondary representation only

Acceptance criteria:

- user can reuse workflows across compatible files
- missing-column mismatches fail clearly
- workflow files are versioned from day one

## Phase 7: hardening and polish

Goal:

- make V1 dependable for internal use

Deliverables:

- robust error handling
- edge-case coverage
- example templates
- quick-start documentation

Tasks:

- test duplicate headers
- test blank headers
- test `mixed` columns
- test formula cells with and without cached values
- test split/combine edge cases
- test dedupe after sort
- improve import warnings
- ship built-in templates from canonical example workflows

Acceptance criteria:

- internal users can self-serve common cleanup workflows
- common messy inputs are supported
- top edge cases are documented and unsurprising

---

## Proposed V1 backlog by feature

## A. File handling

Must have:

- upload CSV/XLSX
- active-table / sheet selection
- canonical normalization
- import warnings
- export CSV/XLSX

Nice to have:

- delimiter override
- encoding selector

## B. Data inspection

Must have:

- grid preview
- schema panel
- inferred logical types
- missing counts
- column selection in authoring UI

Nice to have:

- lightweight profiling
- search/filter in the grid

## C. Workflow authoring

Must have:

- block authoring for all 9 V1 step types
- expression editor for `deriveColumn`
- condition editor for `filterRows`
- reorder/delete/disable steps

Nice to have:

- step duplication
- template insertion
- step descriptions

## D. Validation and trust

Must have:

- structural validation
- semantic validation
- preview
- diff
- warnings

Nice to have:

- step-focused impact summary
- intermediate snapshot inspection

## E. Persistence

Must have:

- save/load workflow JSON

Nice to have:

- DSL export
- built-in templates

---

## Suggested milestone sequence

I would structure V1 as 5 milestones.

### Milestone 1: import + table model

- upload CSV/XLSX
- active table selection
- canonical table model
- import warnings
- table preview
- export CSV/XLSX

### Milestone 2: validator + executor

- workflow IR support
- schema validation
- semantic validation
- executor for all V1 step types
- tests

### Milestone 3: block authoring

- custom blocks
- editors for targets, expressions, and conditions
- block ↔ IR mapping
- save/load roundtrip

### Milestone 4: preview + trust

- before/after preview
- affected-row / affected-cell summary
- validation/warnings UI
- step-focused explanation

### Milestone 5: polish + templates

- example workflow templates
- edge-case hardening
- quick-start docs
- internal usability polish

---

## Suggested first templates to ship

Ship these as built-in examples:

1. Fill missing status values
2. Normalize email addresses
3. Rename customer ID for export
4. Create full name
5. Keep only rows with email
6. Split full name into first and last name
7. Create location from city and state
8. Deduplicate by email
9. Sort orders by date then total
10. Messy customer cleanup

---

## Team / implementation order recommendation

For a small internal build, I would work in this order:

1. canonical data model
2. import/export
3. validator
4. executor
5. data grid
6. block editor
7. preview/diff
8. save/load
9. polish

That order matters. It prevents the block editor from driving the runtime model.

---

## What I would deliberately postpone

Even if tempting, postpone:

- multi-table support
- aggregation
- pivots
- generic loops
- generic control flow
- regex-heavy features
- formula preservation
- AI generation
- backend storage

For V1, high-level tabular operations are better than exposing a general language.

---

## One-sentence summary

V1 is a local-first internal tool for applying reusable, block-defined transformations to one uploaded table at a time, with explicit schema-aware workflows, safe preview, and value-only export.