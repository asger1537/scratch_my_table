# Vertex AI Structured Output

Official sources:
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/multimodal/control-generated-output
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/Schema

This note is a repo-local summary of the official Vertex AI structured output docs and schema reference. It is intended as a working contract for this repository's Gemini structured-output experiments.

## Core contract from the docs

- Structured output uses a response schema to constrain model output.
- The size of the response schema counts toward input tokens.
- Structured output supports only a subset of the Vertex AI schema reference.
- If unsupported fields are used, Vertex AI may ignore them rather than enforce them.

## Supported schema fields called out in the guide

The structured output guide explicitly lists these fields as supported:

- `anyOf`
- `enum`
  - only string enums are supported
- `format`
- `items`
- `maximum`
- `maxItems`
- `minimum`
- `minItems`
- `nullable`
- `properties`
- `propertyOrdering`
- `required`

The guide also states that `propertyOrdering` is specific to structured output and is not part of the normal Vertex AI schema object.

## Important behavioral notes

- Output property order follows the schema order only when `propertyOrdering` is used.
- If prompts, examples, descriptions, or schemas in the prompt show a different property order than `responseSchema`, the docs warn this can confuse the model and produce malformed output.
- By default, fields are optional unless they are listed in `required`.
- The docs recommend including the schema only in `responseSchema` rather than duplicating it in the prompt.

## Complexity guidance from the docs

The guide explicitly warns that complex schemas can produce `InvalidArgument: 400`.

The documented causes include:

- long property names
- long array length limits
- enums with many values
- objects with many optional properties
- combinations of the above

The guide recommends simplifying schemas by:

- shortening property names or enum names
- flattening nested arrays
- reducing constrained properties
- reducing complex formats
- reducing optional properties
- reducing enum cardinality

## What the schema reference adds

The Schema reference describes the full Vertex schema object surface, but the structured output guide is clear that structured output only supports a subset of it.

For this repo, that means:

- a field existing in the schema reference does not mean it is safe or useful for structured output
- the structured output guide takes precedence when deciding what to send in `responseJsonSchema`

## Repo-specific interpretation

These points line up with our experiments:

- Experiment 10:
  - request accepted
  - simple benchmark valid
  - deeper nested shapes still malformed
- Experiment 11:
  - stricter recursive enforcement triggered schema flattening failure
- Experiment 12:
  - another stricter schema variant triggered `400 INVALID_ARGUMENT`

The most important operational conclusion is:

- request-safe schemas in this repo need to stay shallow
- nested object enforcement must be added carefully and empirically
- we should assume that schema complexity limits are a real API constraint, not just a prompt-quality issue

## Working guidance for this codebase

- Prefer shallow step-level schemas.
- Keep recursive or highly discriminated schema structure out of `responseJsonSchema` unless proven safe experimentally.
- Use local parsing, compilation, and validation as the real source of truth.
- Treat `responseJsonSchema` as a shaping hint with a small safe subset, not as the canonical workflow contract.
