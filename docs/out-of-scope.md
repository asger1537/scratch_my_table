# Out of Scope for V1

## Boundary Rule

If a feature requires more than one active table, introduces a general programming model, or depends on preserving spreadsheet presentation instead of tabular values, it is out of scope for V1.

## Explicit Non-Goals

### Multi-Table and Analytical Features

V1 does not include:

- joins or multi-table workflows
- group-by or aggregation
- pivots
- rollups, subtotals, or summary tables

Reason:

- V1 is deliberately scoped to one active table and row-by-row deterministic transformations.

### Programming-Language Features

V1 does not include:

- arbitrary scripting
- user-authored loops
- user-authored variables
- generic control flow

Reason:

- The product goal is a constrained tabular workflow tool, not a general programming environment.

### Spreadsheet Fidelity Features

V1 does not include:

- formula preservation
- Excel macro support
- formatting or style fidelity
- merged-cell fidelity
- charts, comments, or workbook metadata preservation

Reason:

- V1 preserves table values only.

### Collaboration and Backend Features

V1 does not include:

- collaboration
- auth
- backend services
- cloud persistence
- remote execution

Reason:

- The tool is internal-only and local-first.

### Editing and Authoring Features Outside the Core Workflow Model

V1 does not include:

- full spreadsheet editing
- freeform cell editing in the grid
- manual row-by-row editing workflows
- block types outside the V1 step catalog
- a text DSL as the execution source of truth

Reason:

- Phase 1 is defining a typed workflow model, not building a spreadsheet editor.

### Batch and Automation Features

V1 does not include:

- batch processing many files at once
- scheduled runs
- workflow triggers
- AI workflow generation

Reason:

- V1 is an interactive local tool for one uploaded table at a time.
