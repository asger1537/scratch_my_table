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
- workflow IR v1
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
- tests for import/export normalization behavior

Phase 2 / Milestone 2 is implemented.

Milestone 2 includes:
- workflow IR TypeScript types
- structural validation against `schemas/workflow-ir-v1.schema.json`
- semantic validation against the active table schema in step order
- deterministic execution for all V1 step types
- execution metadata suitable for later preview/diff UI
- tests for structural validation, semantic validation, schema evolution, and execution behavior

Phase 2 / Milestone 3 is in progress.

Milestone 3 work currently present in the repo includes:
- Blockly dependency and editor-specific modules under `src/editor/`
- custom block definitions for the V1 workflow surface
- block workspace <-> canonical workflow IR mapping
- JSON import/export helpers for workflows
- initial app integration for block authoring, validation wiring, and run-through-executor flow
- headless editor mapping tests

Treat Milestone 3 as active work until it has been explicitly verified and closed out.

## Current implementation target
Current target: Phase 2 / Milestone 3 block authoring.

Preserve the current runtime boundaries:
- import/normalization remains separate from workflow logic
- workflow validation/execution remains separate from React/UI code
- block editor code stays in editor/UI-specific modules
- future preview/trust UI must consume the existing canonical workflow IR and table model

Not built yet:
- before/after preview UI
- visual diff UI
- step impact highlighting
- workflow templates
- DSL authoring
- backend services
- collaboration
- auth

## Canonical sources of truth
When making implementation decisions, consult these first:

- `docs/v1-scope.md`
- `docs/data-model.md`
- `docs/data-semantics.md`
- `docs/workflow-ir-v1.md`
- `docs/validation-rules.md`
- `docs/example-workflows.md`
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
- Blocks and text are views over the workflow model, not the source of truth
- Preview/safety is more important than expressiveness
- Prefer deterministic behavior over "smart" behavior

## V1 workflow capabilities
These are the only V1 workflow capabilities:

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

## Out of scope for V1
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
  - current import/inspection shell plus in-progress editor integration
- `scripts/build-local-dist.mjs`
  - single-file local-file production build

Keep those boundaries intact unless the user explicitly asks for a restructure.

Avoid:
- mixing workflow logic into import/export code
- mixing React/UI concerns into domain/runtime code
- coupling executor logic to future Blockly UI behavior
- persisting Blockly-specific workspace state as the canonical workflow format

## Current build and test commands
Use the current scripts rather than inventing new entrypoints:

- `npm test`
- `npm run build`
  - produces a single-file `dist/index.html` intended to work directly from disk
- `npm run build:web`
  - produces a normal Vite web build

## Workflow runtime rules already implemented
Preserve these Milestone 2 behaviors unless the docs are updated explicitly:

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

## Milestone 3 authoring rules
For block editor work, preserve these rules:

- blocks are an authoring view over the canonical workflow IR
- persisted workflows must use explicit `columnId` references
- do not introduce generic loops, variables, or control flow
- keep the toolbox focused on the V1 step catalog and editor support blocks only
- fail clearly if a saved workflow cannot be reconstructed faithfully in blocks
- keep validation and execution driven by the existing workflow runtime, not Blockly-specific logic

## Preferred repo structure
Prefer extending the existing structure rather than renaming everything:

docs/
  v1-scope.md
  data-model.md
  data-semantics.md
  workflow-ir-v1.md
  validation-rules.md
  example-workflows.md
  out-of-scope.md

schemas/
  workflow-ir-v1.schema.json

fixtures/
  simple-customers.csv
  messy-customers.csv
  orders-sample.csv

src/
  domain/
  workflow/
  editor/

scripts/
  build-local-dist.mjs

## How to work
When doing work in this repo:
1. Read the canonical docs first.
2. Inspect the existing implementation before restructuring.
3. Extend the current architecture instead of replacing it.
4. Keep terminology consistent across docs, schema, code, and tests.
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
- Do not persist symbolic selections such as "currently selected columns".
- Do not over-engineer for hypothetical V2 features.

## Milestone 2 status
Milestone 2 is done when:
- workflow JSON can be structurally validated
- semantic validation exists for every V1 step type
- all V1 step types execute deterministically
- execution respects the canonical data semantics
- tests cover happy paths and edge cases
- execution results include summary metadata for later preview UI
- no block editor or backend work has been introduced yet

That status has been reached in the current repo.

## Milestone 3 status
Milestone 3 is done when:
- a user can author all V1 workflow step types in blocks
- the editor uses schema-aware field choices from the active table
- block-authored workflows serialize to canonical IR
- canonical IR can be loaded back into blocks
- persisted workflows never contain symbolic selections
- invalid workflows are clearly surfaced
- a user can import/export workflow JSON and roundtrip it successfully
- a user can run a block-authored workflow through the existing validator/executor
- no full preview/diff UI or backend work has been introduced

As of now, treat Milestone 3 as in progress, not complete.
