# AGENTS.md

## Project overview

This repository is for an internal-only, local-first browser tool for tabular CSV/XLSX data.

The product goal is:

- user uploads CSV/XLSX
- user selects one active table/sheet
- user inspects the normalized data
- user builds simple tabular workflows with block-based UI
- user previews the effect safely before export
- user exports transformed data
- user saves/loads workflows as versioned JSON

This is not a general programming environment.
This is a constrained tabular transformation tool.

## Repository state

Phase 1 is complete and should be treated as frozen unless a clear inconsistency is found.

Phase 1 produced:

- V1 scope and non-goals
- canonical data model
- data semantics
- workflow IR
- validation rules
- example workflows
- fixtures
- JSON schema for workflow IR

Phase 2 / Milestone 1 is implemented.

Milestone 1 includes:

- core domain model/types
- CSV import normalization
- XLSX import normalization
- active table selection
- schema panel
- import warnings panel
- read-only preview grid
- CSV/XLSX export

Phase 2 / Milestone 2 is implemented.

Milestone 2 includes:

- workflow structural validation
- workflow semantic validation
- deterministic execution for all current step types
- execution metadata suitable for later preview/diff UI

Phase 2 / Milestone 3 and the next authoring milestones are partially implemented.

Current repo reality:

- Blockly-based authoring exists under `src/editor/`
- workflows now persist as canonical Workflow IR v2
- scoped cell transforms use `scopedTransform` plus an expression AST
- built-in function blocks are the normal authoring path for scoped transforms
- the authoring UI presents `deriveColumn` as `create new column`, including blank and copy-column initialization modes
- supported legacy Workflow IR v1 JSON is upgraded to v2 on load

Treat the current runtime and canonical IR as stable unless a concrete bug or doc mismatch requires a change.

## Current implementation target

Current target: block-based authoring over canonical Workflow IR v2.

Preserve these boundaries:

- import/normalization remains separate from workflow logic
- workflow validation/execution remains separate from React/UI code
- block editor code stays in editor/UI-specific modules
- canonical workflow JSON remains the contract between authoring and runtime
- future preview/trust UI must consume the existing canonical workflow IR and table model

Not built yet:

- before/after preview UI
- visual diff UI
- step impact highlighting
- workflow templates
- custom/user-defined functions
- DSL authoring
- backend services
- collaboration
- auth

## Canonical sources of truth

When making implementation decisions, consult these first:

- `docs/v1-scope.md`
- `docs/data-model.md`
- `docs/data-semantics.md`
- `docs/workflow-ir-v2.md`
- `docs/validation-rules.md`
- `docs/example-workflows.md`
- `schemas/workflow-ir-v2.schema.json`

Historical references:

- `docs/workflow-ir-v1.md`
- `schemas/workflow-ir-v1.schema.json`

If code and docs disagree, do not silently invent a third interpretation.
Either:

- align code to the docs, or
- update the docs explicitly if the code has revealed a better decision

## Product constraints

- Internal-only tool
- Local-first architecture
- Browser-based
- TypeScript codebase
- One active table at a time
- Workflows must have a typed internal representation
- Blocks are an authoring view over the canonical workflow model, not the source of truth
- Preview/safety is more important than expressiveness
- Prefer deterministic behavior over “smart” behavior

## Current workflow capabilities

These are the current supported tabular capabilities:

- fill empty cells
- trim / normalize text
- drop columns
- rename columns
- create a derived column
- filter rows
- split columns
- combine columns
- deduplicate rows
- sort rows

These map to the current persisted IR step types:

- `scopedTransform`
- `dropColumns`
- `renameColumn`
- `deriveColumn`
- `filterRows`
- `splitColumn`
- `combineColumns`
- `deduplicateRows`
- `sortRows`

Capability-to-IR mapping:

- fill empty cells: `scopedTransform` with `coalesce(value, <literal>)`
- normalize text: `scopedTransform` with built-in string-function composition such as `lower(trim(value))`
- drop columns: `dropColumns`

## Out of scope

Unless explicitly requested, do not design or implement:

- joins / multi-table workflows
- group-by / aggregation
- pivots
- AI workflow generation
- collaboration
- auth / backend services
- spreadsheet formatting fidelity
- macro support
- formula preservation as formulas
- full spreadsheet editing
- arbitrary scripting
- generic user-authored loops / control flow
- user-defined/custom functions

## Modeling rules

Use the following design principles:

- treat uploaded data as one active table at a time
- separate display names from stable internal column IDs
- separate row identity from visible row order
- make null/empty behavior explicit
- prefer deterministic operations
- avoid ambiguous semantics
- make workflow steps composable and serializable
- version the workflow schema from day one
- persist workflows using explicit `columnId` references, not symbolic UI selections
- keep the canonical IR editor-agnostic

## Canonical data model requirements

The runtime model must preserve:

- `workbookId`
- `tableId`
- `activeTableId`
- schema with stable `columnId`
- rows with stable `rowId`
- `rowsById`
- `rowOrder`
- import warnings
- inferred logical types

Current import rules:

- CSV -> one workbook with one table
- XLSX -> one workbook with one table per sheet
- first row is used as headers
- formulas are imported as values only
- formatting/styling is ignored

## Workflow runtime rules

Preserve these behaviors unless the docs are updated explicitly:

- structural validation is separate from semantic validation
- semantic validation runs in step order
- earlier valid steps change the schema seen by later steps
- invalid steps do not contribute schema changes to later validation
- missing columns are errors
- incompatible types are errors
- workflow-authored display-name conflicts are errors
- created `columnId` conflicts are errors
- execution is deterministic and UI-independent
- sort is stable and keeps nulls last regardless of direction
- deduplicate keeps the first row in current `rowOrder`
- `renameColumn` changes display/export name, not `columnId`
- `scopedTransform` evaluates one expression per selected cell
- `value` is scoped-transform-only
- `column` reads an existing column from the current row and is valid in both `scopedTransform` and `deriveColumn`
- built-in functions are pure and deterministic

## Current code boundaries

The repo currently has these main implementation areas:

- `src/domain/`
  - canonical table model and helper functions
  - import normalization
  - CSV/XLSX import and export
- `src/workflow/`
  - workflow IR TypeScript types
  - structural validation
  - semantic validation
  - deterministic executor
- `src/editor/`
  - Blockly block definitions
  - schema-aware editor options
  - block <-> IR conversion
  - editor integration helpers
- `src/App.tsx`
  - current import/inspection shell plus workflow editor integration
- `scripts/build-local-dist.mjs`
  - single-file local-file production build

Keep those boundaries intact unless the user explicitly asks for a restructure.

Avoid:

- mixing workflow logic into import/export code
- mixing React/UI concerns into domain/runtime code
- coupling executor logic to Blockly behavior
- persisting Blockly-specific workspace state as the canonical workflow format

## Current build and test commands

Use the current scripts rather than inventing new entrypoints:

- `npm test`
- `npm run build`
  - produces a single-file `dist/index.html` intended to work directly from disk
- `npm run build:web`
  - produces a normal Vite web build

## How to work

When doing work in this repo:

1. Read the canonical docs first.
2. Inspect the existing implementation before restructuring.
3. Extend the current architecture instead of replacing it.
4. Keep terminology consistent across docs, schema, code, tests, and examples.
5. Add focused tests for new behavior.
6. Prefer fixtures and concrete examples over abstract discussion.
7. End with a concise summary:
   - files changed
   - decisions made
   - unresolved questions

## What not to do

- Do not re-open Phase 1 scope casually.
- Do not introduce backend architecture.
- Do not expand to multi-table workflows.
- Do not introduce generic programming concepts as the primary user model.
- Do not persist symbolic selections such as “currently selected columns”.
- Do not re-couple execution logic to UI/editor state.
- Do not over-engineer for hypothetical V2+ features.

## Working definition of done for the current authoring/runtime shape

The current workflow stack is in a good state when:

- workflow JSON validates structurally against Workflow IR v2
- semantic validation exists for every current step type
- all current step types execute deterministically
- block-authored workflows serialize to canonical IR v2
- canonical IR v2 can be loaded back into blocks
- supported legacy v1 workflows upgrade cleanly to v2
- tests cover authoring, validation, execution, and roundtrip behavior
- no backend or collaboration work has been introduced
