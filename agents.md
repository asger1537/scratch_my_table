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

*   **No `Condition` AST:** Logical checks for `filterRows.condition` and `scopedTransform.rowCondition` use the same `Expression` AST as transforms.
*   **Boolean logic is functional:** Predicates are represented with boolean-returning `call` nodes such as `and`, `or`, `not`, `equals`, `contains`, `startsWith`, `endsWith`, `matchesRegex`, `greaterThan`, `lessThan`, and `isEmpty`.
*   **Editor is not the source of truth:** Blockly is an authoring layer over canonical workflow JSON. Runtime validation and execution operate on canonical IR only.
*   **Whitespace-sensitive logic is explicit:** Do not introduce special predicate flags for whitespace emptiness. Use function composition such as `isEmpty(trim(column("email")))`.
