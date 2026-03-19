# AGENTS.md

## Project overview
This repository is for an internal-only, local-first browser tool for tabular CSV/XLSX data.

The product goal is:
- user uploads CSV/XLSX
- user selects one table/sheet
- user builds simple tabular workflows with block-based UI
- workflows are stored in a structured internal representation
- user previews the effect safely before export

This is not a general programming environment.
This is a constrained tabular transformation tool.

## Current phase
We are currently in Phase 1: foundations and decisions.

Phase 1 is specification work, not feature implementation.
Do not build UI components or runtime code unless explicitly asked.
Prefer writing clear design docs, schemas, examples, and tests/spec fixtures.

## Phase 1 goals
Codify the V1 product scope and runtime model.

Required outputs for this phase:
- V1 scope document
- canonical table model
- data semantics document
- workflow IR v1 schema
- validation rules for V1 operations
- example workflows represented in IR
- sample datasets or fixtures
- explicit out-of-scope list

## V1 capabilities
These are the V1 workflow capabilities:
- fill empty cells
- trim / normalize text
- rename columns
- create a derived column
- filter rows
- split columns
- combine columns
- deduplicate rows
- sort rows

## Out of scope for V1
Unless explicitly requested, do not design or implement:
- joins / multi-table workflows
- group-by / aggregation
- pivots
- AI workflow generation
- collaboration
- auth / backend services
- spreadsheet formatting fidelity
- Excel macros
- formula preservation as formulas
- full spreadsheet editing

## Product constraints
- Internal-only tool
- Local-first architecture
- Browser-based
- TypeScript codebase
- Prefer a simple, distributable frontend architecture
- Workflows must have a typed internal representation
- Blocks and text are views over the workflow model, not the source of truth
- Preview/safety is more important than expressiveness

## Modeling rules
Use the following design principles:
- Treat uploaded data as one active table at a time
- Separate display names from stable internal column IDs
- Separate row identity from visible row order
- Make null/empty behavior explicit
- Prefer deterministic operations
- Avoid ambiguous semantics
- Make workflow steps composable and serializable
- Version the workflow schema from day one

## Phase 1 semantics to define
You must make explicit decisions for:
- what counts as empty
- how whitespace-only values are handled
- how types are inferred
- whether formulas are imported as values
- how duplicate column names are normalized
- how deduplication chooses which row to keep
- where nulls sort by default
- how split-column output columns are named
- how validation behaves when referenced columns are missing

## Deliverable quality bar
Documents must be specific, opinionated, and implementation-ready.
Avoid vague product writing.
Every design choice should either:
- define a rule, or
- record an open question with a recommended default

## Preferred repo structure
When adding Phase 1 outputs, prefer:

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

## How to work
When doing Phase 1 work:
1. Read existing docs first
2. Propose the minimum coherent V1
3. Write/modify docs and schema files
4. Keep terminology consistent across files
5. Create examples that exercise all V1 operations
6. Add a short completion summary listing:
   - files changed
   - design decisions made
   - unresolved questions

## What not to do
- Do not introduce unnecessary abstractions
- Do not expand scope beyond the listed V1 operations
- Do not add backend architecture
- Do not design for collaboration yet
- Do not switch to a generic programming-language framing
- Do not use loops/conditionals as the primary user abstraction if a higher-level tabular operation is clearer

## Definition of done for Phase 1
Phase 1 is done when:
- V1 scope is explicitly documented
- canonical table model is documented
- data semantics are documented
- workflow IR v1 is defined and versioned
- all V1 operations are representable in IR
- validation rules exist for every V1 operation
- at least 10 concrete example workflows exist
- at least 3 sample datasets/fixtures exist
- unresolved questions are listed separately