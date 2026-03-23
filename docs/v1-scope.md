# V1 Scope

## Product Definition

V1 is an internal-only, local-first browser tool for applying reusable, block-defined transformations to one uploaded table at a time, with safe preview and export.

## Target User

V1 is for internal users cleaning and transforming tabular CSV/XLSX data. It is not a spreadsheet editor, notebook, or general programming environment.

## V1 Capabilities

The V1 workflow step catalog is exactly:

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

No additional workflow step types are in scope beyond this catalog.

## User Flow

The canonical V1 user flow is:

1. Upload a CSV or XLSX file.
2. Inspect the import result and select the active table.
   - CSV imports as one table.
   - XLSX imports as a workbook, auto-detects one header row per sheet by default, allows a per-sheet header-row override, and lets the user select one sheet as the active table.
3. Inspect the active table.
   - Show column display names, inferred types, row count, sample rows, and import warnings.
4. Build a workflow with blocks.
   - Blocks are an authoring view over a typed workflow IR.
   - The workflow IR is the source of truth.
5. Preview the result before applying it.
   - Show validation errors, warnings, affected rows/cells, and a before/after sample.
6. Run the workflow against the active table.
7. Export the transformed table.
   - V1 export is table data only, not workbook formatting or formulas.
8. Save or load the workflow as versioned JSON.

## Product Boundaries

V1 is intentionally narrow:

- The runtime unit is one active table at a time.
- Workflows are deterministic, serializable, and schema-aware.
- Preview and validation take priority over expressiveness.
- The system models tabular operations directly instead of exposing a generic programming language.

## Explicit Non-Goals

V1 does not attempt to provide:

- joins or multi-table workflows
- group-by or aggregation
- pivots
- AI workflow generation
- collaboration
- auth or backend services
- spreadsheet style or formatting fidelity
- formula preservation
- Excel macros
- full spreadsheet editing
- arbitrary scripting, loops, or user-authored control flow
- batch processing across many files in one run
- a text DSL as the execution source of truth
