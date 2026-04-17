# Scratch My Table

Clean up messy spreadsheets with reusable visual workflows.

Scratch My Table helps turn one-off spreadsheet cleanup work into repeatable workflows. Upload a CSV or XLSX file, build transformations with blocks, validate them against the table schema, preview the transformed result, and export the cleaned table back to CSV or XLSX. You can also ask Gemini to draft workflow steps from a plain-English request, then review and apply the draft yourself.

## Demo

https://github.com/user-attachments/assets/f3c07650-121d-45df-a6bb-98664b039ad0

## What it does

Scratch My Table is designed for messy spreadsheet and CSV cleanup workflows such as:

- filling missing values
- trimming and normalizing text
- deriving new columns
- filtering rows
- splitting and combining columns
- deduplicating records
- sorting results
- applying cell formatting highlights in XLSX exports

The app lets you upload a table, define a workflow visually, run it, inspect the result, and export the transformed output.

## Core features

- **CSV and XLSX import**
  - Upload CSV or XLSX files directly in the app.
  - XLSX imports support one table per sheet, with a selected active table.
  - XLSX import is value-focused; source workbook formatting, charts, comments, and macros are not preserved.
- **Visual workflow editor**
  - Build workflows with Blockly blocks instead of hand-authoring JSON.
  - The editor is an authoring layer over a deterministic workflow model.
- **Canonical workflow runtime**
  - Workflows compile to a small custom language designed for tabular data tasks.
  - Validation and execution operate on that canonical workflow representation, not on editor state.
- **Validation before execution**
  - Structural validation runs against the workflow schema.
  - Semantic validation checks the workflow against the active table schema.
- **Preview and export**
  - Run a workflow, inspect the transformed table, then export as CSV or XLSX.
  - Generated cell fill highlights are preserved in XLSX exports.
- **Reusable workflow packages**
  - Import and export canonical workflow package JSON.
  - Run a single workflow or an ordered workflow sequence.
- **AI-assisted drafting**
  - Use the **Ask AI** dialog to describe workflow steps in natural language.
  - AI drafts stay separate until you explicitly apply them.

## Typical flow

1. Upload a CSV or XLSX file.
2. Choose or confirm the active table.
3. Build a workflow in the visual editor.
4. Optionally ask AI to draft workflow steps from a plain-English prompt.
5. Validate and run the workflow.
6. Review the transformed table preview.
7. Export the result as CSV or XLSX.

## Example workflow operations

The repository includes example workflows that demonstrate common cleanup patterns, including:

- filling empty or whitespace-only status fields
- normalizing email addresses
- deriving full names and initials
- filtering rows with usable emails
- deduplicating by email
- sorting by signup date
- applying highlight colors to important cells

A representative example is **Customers Messy Cleanup**, which normalizes text, fills fallback email values, fills missing status, derives `full_name`, removes unusable rows, deduplicates, and sorts the result.

## Getting started

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Run the app

```bash
npm run dev
```

Then open the local Vite URL shown in the terminal.

### Build for production

```bash
npm run build
```

### Preview the production build

```bash
npm run preview
```

### Run tests

```bash
npm test
```

## Using AI drafting

The app includes an **Ask AI** flow for natural-language workflow authoring.

1. Open **Ask AI** in the editor.
2. Paste your Gemini API key.
3. Describe the workflow you want.
4. Review the generated draft.
5. Apply it only if it looks right.

This keeps AI suggestions reviewable instead of mutating the live workflow immediately.

## Project structure

```text
src/
  ai/         Gemini-assisted workflow drafting and related tooling
  domain/     import, normalization, workbook and table model logic
  editor/     Blockly-based workflow editor and authoring integration
  workflow/   canonical workflow runtime, execution, and validation

docs/
  data-model.md
  data-semantics.md
  validation-rules.md
  workflow-ir-v2.md
  example-workflows.md
```

## Architecture notes

A few design choices shape the project:

- **One current workflow format:** workflows are lowered into one small canonical language for table operations.
- **Editor is not the runtime:** Blockly is the authoring UI, not the source of truth.
- **Validation matters:** workflows are structurally and semantically validated before execution.
- **Stable references:** workflows refer to canonical `columnId` values instead of transient UI selections.
- **Modern web build:** this is a standard Vite web app, not a `file://` single-file workflow.

## Why this project is interesting

Scratch My Table sits at the intersection of spreadsheet cleanup, workflow authoring, and structured execution:

- it gives non-programmer-friendly workflow authoring through blocks
- it preserves a clean canonical runtime model under the hood
- it supports reuse through workflow packages and run sequences
- it combines deterministic execution with optional AI-assisted authoring


