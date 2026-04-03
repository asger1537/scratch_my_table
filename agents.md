# Instructions for AI Agents

This file contains strict architectural guidelines and coding philosophies for any AI agents contributing to the **Scratch My Table** repository. 

Read these rules carefully before suggesting or implementing any code changes.

## 1. NEVER Aim for Backward Compatibility
The absolute highest priority constraint in this repository is that **we do not maintain backward compatibility**. 

*   **No Legacy Support:** Do not write migration scripts, legacy adapters, versioned upgrade paths (e.g., `v1_to_v2` mappers), or fallback logic for older data shapes.
*   **One Single Version:** We aim for exactly one single, clean, current version of the code. The codebase must reflect only the present architectural truth.
*   **If it changes, it breaks:** If we decide to change the schema or the AST (e.g., merging `Condition` into `Expression`), we do not support both simultaneously. We replace the old concept entirely.

## 2. Current Workflow Runtime Truth

The current canonical workflow format is **Workflow IR v2** with a single shared `Expression` AST.

Rules:

*   **No `Condition` AST:** Logical checks for `filterRows.condition`, `scopedRule.rowCondition`, and `scopedRule.cases[*].when` use the same `Expression` AST as transforms.
*   **Boolean logic is functional:** Predicates are represented with boolean-returning `call` nodes such as `and`, `or`, `not`, `equals`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `greaterThan`, `lessThan`, and `isEmpty`.
*   **One canonical cell-level step:** Value changes and formatting changes are both represented with `scopedRule`. Do not reintroduce separate `scopedTransform` or `colorCells` runtime steps.
*   **Editor is not the source of truth:** Blockly is an authoring layer over canonical workflow JSON. Runtime validation and execution operate on canonical IR only.
*   **Whitespace emptiness is built into `isEmpty`:** Do not introduce special predicate flags for whitespace emptiness. `isEmpty(...)` treats whitespace-only strings as empty.

## 3. Current Build And Dev Commands

The repository now uses a standard Vite web build. Do not reintroduce the old single-file `file://` packaging flow.

Commands:

*   `npm run dev`: start the Vite development server.
*   `npm run build`: create the production web build in `dist/`.
*   `npm run preview`: serve the built `dist/` output locally.
*   `npm test`: run the Vitest suite.

Notes:

*   The production build emits normal web assets, including the workflow validation worker bundle.
*   Use `npm run dev` or `npm run preview` to run the app. Do not assume `dist/index.html` is meant to be opened directly via `file://`.
