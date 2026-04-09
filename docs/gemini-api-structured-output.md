# Gemini API Structured Output

Official source:
- https://ai.google.dev/gemini-api/docs/structured-output?example=recipe

This note is a repo-local summary of the official Gemini API structured output guide. It is intended as a quick working reference for this codebase, not a verbatim copy of the source page.

## What the page says

- Gemini can be configured to return output that follows a provided schema.
- The primary use cases called out are:
  - data extraction
  - structured classification
  - structured outputs for agent or tool workflows
- The page shows structured output examples with:
  - basic JSON objects and arrays
  - enum-like constrained outputs
  - recursive structures
- The SDKs can define schemas through higher-level libraries such as:
  - `Pydantic` in Python
  - `Zod` in JavaScript

## What matters for this repo

- The public Gemini docs establish that structured output is a supported feature and that recursive structures are possible in principle.
- They do not provide a practical contract for every request-time failure mode we have seen in the API.
- For this repo, the Gemini API page is useful mainly as:
  - confirmation that structured output is a first-class feature
  - examples of the intended request shape
  - confirmation that nested and recursive schemas are part of the product surface

## Practical interpretation

- The Gemini API docs are not sufficient on their own to explain our `400 INVALID_ARGUMENT` and schema-flattening failures.
- For day-to-day debugging, the Vertex AI structured output guidance is the more operationally useful source because it explicitly documents:
  - supported schema fields
  - complexity-related failures
  - property ordering behavior

## Current repo takeaway

- Treat the Gemini API structured output page as the high-level capability reference.
- Treat the Vertex AI structured output guide as the closer thing to an operational contract for schema design constraints.
