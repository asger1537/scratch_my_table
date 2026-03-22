# Workflow IR v1

This document is retained as historical context only.

The current canonical workflow format is Workflow IR v2:

- `docs/workflow-ir-v2.md`
- `schemas/workflow-ir-v2.schema.json`

Current runtime behavior:

- persisted workflows use `version: 2`
- structural validation targets the v2 schema
- supported legacy `version: 1` workflows are upgraded to v2 on load before structural validation

V1 concepts that changed in v2:

- `fillEmpty` and `normalizeText` are now represented as `scopedTransform`
- the canonical IR now uses an expression AST with `value`, `literal`, `column`, and `call`
- `combineColumns` and `deduplicateRows` now reference `columnIds` directly instead of a `target` wrapper

Use the v2 doc and schema for all current implementation work.
