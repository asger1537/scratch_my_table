# Canonical Data Model

## Purpose

V1 operates on one active table at a time. Imported files, authoring state, preview state, and run results all normalize to the same canonical model so validation and execution do not depend on UI shape.

## Core Entities

### Workbook

A `workbook` is the import container for one uploaded file.

Required fields:

- `workbookId`: stable identifier for the uploaded file instance
- `sourceFileName`: original file name
- `sourceFormat`: `csv` or `xlsx`
- `tables`: ordered list of imported tables
- `activeTableId`: the one table selected for workflow authoring and execution
- `importWarnings`: warnings raised during import that are not specific to a single table

Rules:

- A CSV file becomes a workbook with exactly one table.
- An XLSX file becomes a workbook with one table per imported sheet.
- V1 workflows run against `activeTableId` only.

### Active Table

A `table` is the only runtime unit for V1 workflows.

Required fields:

- `tableId`: stable identifier for the table
- `sourceName`: CSV file name or XLSX sheet name shown to the user
- `schema`: canonical schema object
- `rowsById`: map of `row ID` to row object
- `rowOrder`: ordered list of `row ID` values representing the current visible row order
- `importWarnings`: warnings scoped to this table

Rules:

- `rowOrder` is the source of visible row order.
- `row ID` is stable even when the table is sorted or filtered.
- A workflow step may change `rowOrder`, add columns, or create a derived table snapshot for preview, but it does not mutate row identity.

### Schema

A `schema` describes the active table columns in visible order.

Required fields:

- `columns`: ordered list of column definitions

Each column definition contains:

- `columnId`: stable internal identifier used by the workflow IR
- `displayName`: user-facing column label
- `logicalType`: one of `unknown`, `string`, `number`, `boolean`, `date`, `datetime`, or `mixed`
- `nullable`: boolean
- `sourceIndex`: zero-based source column position at import time

Rules:

- `columnId` is stable and never changes after import or workflow creation.
- `displayName` may change through `renameColumn`.
- Created columns must define a new `columnId` and `displayName`.
- Column order is the order of the `columns` array.

### Column

A `column` is identified by `columnId`, not by `displayName`.

V1 identifier rule:

- Imported columns receive deterministic IDs derived from the normalized import display name.
- The format is `col_<slug>`, where the slug is lowercase and uses underscores between alphanumeric segments.
- Duplicate imported columns receive numeric suffixes such as `col_email`, `col_email_2`, and `col_email_3`.
- Blank imported headers normalize to `Column`, which becomes `col_column`, `col_column_2`, and so on.
- Workflow-created columns follow the same rule from the proposed new display name unless the authoring layer already supplies an explicit unique `columnId`.
- Once assigned, a `columnId` never changes when the display name changes.

### Row

A `row` is a stable record keyed by `row ID`.

Required fields:

- `rowId`: stable internal identifier
- `cellsByColumnId`: map of `columnId` to cell value

V1 identifier rule:

- Imported rows receive deterministic IDs based on source order, such as `row_1`, `row_2`, and `row_3`.
- The `row ID` remains stable even if the row later moves in `rowOrder`.

### Cell

A `cell` is the intersection of one `row ID` and one `columnId`.

Canonical cell values are JSON-compatible scalars:

- `null`
- `string`
- `number`
- `boolean`

Rules:

- Dates and datetimes are stored as ISO-8601 strings and distinguished by column `logicalType`.
- A cell has no separate user-visible identifier in V1.
- Formula text is not part of the canonical cell model for V1; only imported values are preserved.

### Selection

A `selection` is transient authoring state, not the source of truth.

V1 selection shapes:

- column selection: ordered `columnId[]`
- row selection: ordered `rowId[]`
- cell selection: one or more `(row ID, columnId)` pairs for preview/highlighting only

Rules:

- Persisted workflows must reference explicit `columnId` values.
- The workflow IR must not contain symbolic targets such as “currently selected columns”.

### Workflow

A `workflow` is a versioned, serializable description of tabular changes.

Required fields:

- `version`: workflow IR version number
- `workflowId`: stable workflow identifier
- `name`: workflow name
- `steps`: ordered list of workflow steps

Rules:

- A workflow is independent of any specific workbook file.
- A workflow step may reference imported columns and columns created by earlier workflow steps.
- Blocks and any future text view are projections of the workflow IR, not alternative sources of truth.
- Workflow reuse across files depends on the imported active table producing the same `columnId` values after header normalization; otherwise validation raises missing-column errors.

### Run

A `run` is one validation or execution attempt of a workflow against one active table.

Required fields:

- `runId`: stable identifier for the attempt
- `workflowId`: workflow being used
- `tableId`: active table being processed
- `mode`: `preview` or `run`
- `validationErrors`: semantic errors found against the current table schema
- `warnings`: non-fatal issues raised during preview or execution

Run outputs:

- transformed table snapshot
- changed row count
- changed cell count
- exportable result table if validation passes

## Import Mapping

### CSV

CSV import rules:

- One CSV file becomes one workbook with one table.
- The first row is treated as the header row.
- Subsequent rows become data rows.
- Blank header cells receive generated display names.
- The single imported table is the active table automatically.

### XLSX

XLSX import rules:

- One XLSX file becomes one workbook with one table per sheet.
- Each sheet uses its first row as the header row.
- The user selects exactly one sheet as the active table.
- V1 ignores workbook formulas, formatting, charts, macros, and sheet relationships beyond cell values.

## Stable Identity Requirements

### Column Identity

- `columnId` is the only stable way to reference a column in a workflow.
- `displayName` exists for UI readability and export headers.
- Renaming a column changes `displayName` only.

### Row Identity

- `rowId` identifies the logical row across preview, sort, filter, and deduplicate operations.
- `rowOrder` controls visible order.
- Deduplication removes rows from the output table snapshot but does not redefine the identity of surviving rows.

## Import Warnings

Import warnings do not block authoring or preview, but they must be preserved and shown to the user.

Minimum warning object:

- `code`: stable machine-readable code
- `message`: human-readable explanation
- `scope`: `workbook`, `table`, `column`, or `cell`
- `tableId`: optional when scope is narrower than workbook
- `columnId`: optional when warning is column-specific
- `rowId`: optional when warning is cell-specific

Required warning scenarios for V1:

- duplicate header names were normalized
- blank header names were generated
- formulas were imported as values
- a formula cell had no cached value and was imported as `null`
- a column inferred as `mixed`
- spreadsheet formatting or macros were ignored

## Minimal Example

```json
{
  "tableId": "tbl_customers",
  "sourceName": "simple-customers.csv",
  "schema": {
    "columns": [
      {
        "columnId": "col_customer_id",
        "displayName": "customer_id",
        "logicalType": "string",
        "nullable": false,
        "sourceIndex": 0
      },
      {
        "columnId": "col_email",
        "displayName": "email",
        "logicalType": "string",
        "nullable": false,
        "sourceIndex": 3
      }
    ]
  },
  "rowsById": {
    "row_1": {
      "rowId": "row_1",
      "cellsByColumnId": {
        "col_customer_id": "C001",
        "col_email": "alice.ng@example.com"
      }
    }
  },
  "rowOrder": ["row_1"],
  "importWarnings": []
}
```
