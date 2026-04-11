import { writeFile } from 'node:fs/promises';

import { validateWorkflowSemantics, validateWorkflowStructure, type Workflow } from '../workflow';

import type { WorkflowStepInput } from './types';
import { assignWorkflowStepIds, GEMINI_MAX_OUTPUT_TOKENS } from './index';
import {
  compact,
  extractCandidateText,
  extractResponseErrorMessage,
  loadCustomersMessyTable,
  readGeminiApiKey,
} from './experimentHarness';

const ITERATIONS = 5;
const EMAIL_PROMPT =
  'We just need one email column. We should use the main email column but if its empty we should use the email (2) column. If both are empty we should color red';

export type ReplayStatus =
  | 'valid_draft'
  | 'clarify'
  | 'request_error'
  | 'parse_error'
  | 'structural_failed'
  | 'semantic_failed';

export interface ReplayResult {
  iteration: number;
  status: ReplayStatus;
  mode?: 'clarify' | 'draft';
  issueSummary?: string;
  rawTextPreview?: string;
}

export interface FrozenRequestExport {
  requestUrl: string;
  systemInstructionText: string;
  contents: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }>;
  requestBody: Record<string, unknown>;
}

export interface CanonicalReplayExperimentConfig {
  experimentTitle: string;
  reportPath: string;
  includeCurrentWorkflowSolution: boolean;
  includeCuratedExamples: boolean;
}

export async function executeCanonicalReplayExperiment(config: CanonicalReplayExperimentConfig) {
  const apiKey = await readGeminiApiKey();
  const requestExport = buildOldCanonicalEmailReplayRequest({
    includeCurrentWorkflowSolution: config.includeCurrentWorkflowSolution,
    includeCuratedExamples: config.includeCuratedExamples,
  });
  const table = await loadCustomersMessyTable();
  const results: ReplayResult[] = [];

  for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
    results.push(await runReplayIteration(apiKey, table, requestExport, iteration));
  }

  await writeFile(
    config.reportPath,
    buildReport({
      experimentTitle: config.experimentTitle,
      requestExport,
      results,
      includeCurrentWorkflowSolution: config.includeCurrentWorkflowSolution,
      includeCuratedExamples: config.includeCuratedExamples,
    }),
    'utf8',
  );

  return { results, requestExport };
}

async function runReplayIteration(
  apiKey: string,
  table: Awaited<ReturnType<typeof loadCustomersMessyTable>>,
  requestExport: FrozenRequestExport,
  iteration: number,
): Promise<ReplayResult> {
  try {
    const response = await fetch(requestExport.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(requestExport.requestBody),
    });
    const rawResponseBody = await response.text();

    if (!response.ok) {
      return {
        iteration,
        status: 'request_error',
        issueSummary: `HTTP ${response.status}: ${extractResponseErrorMessage(rawResponseBody)}`,
      };
    }

    const rawText = extractCandidateText(rawResponseBody);

    try {
      const parsed = parseLegacyCanonicalResponse(rawText);

      if (parsed.mode !== 'draft') {
        return {
          iteration,
          status: 'clarify',
          mode: parsed.mode,
          issueSummary: parsed.assistantMessage,
          rawTextPreview: compact(rawText),
        };
      }

      const workflow: Workflow = {
        version: 2,
        workflowId: 'wf_canonical_replay_experiment',
        name: 'Canonical replay experiment',
        steps: assignWorkflowStepIds(parsed.steps),
      };
      const structural = validateWorkflowStructure(workflow);

      if (!structural.valid) {
        return {
          iteration,
          status: 'structural_failed',
          mode: parsed.mode,
          issueSummary: structural.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | '),
          rawTextPreview: compact(rawText),
        };
      }

      const semantic = validateWorkflowSemantics(workflow, table);

      if (!semantic.valid) {
        return {
          iteration,
          status: 'semantic_failed',
          mode: parsed.mode,
          issueSummary: semantic.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | '),
          rawTextPreview: compact(rawText),
        };
      }

      return {
        iteration,
        status: 'valid_draft',
        mode: parsed.mode,
        rawTextPreview: compact(rawText),
      };
    } catch (error) {
      return {
        iteration,
        status: 'parse_error',
        issueSummary: error instanceof Error ? error.message : 'Failed to parse legacy canonical response.',
        rawTextPreview: compact(rawText),
      };
    }
  } catch (error) {
    return {
      iteration,
      status: 'request_error',
      issueSummary: error instanceof Error ? error.message : 'Request failed.',
    };
  }
}

function parseLegacyCanonicalResponse(rawText: string): {
  mode: 'clarify' | 'draft';
  assistantMessage: string;
  assumptions: string[];
  steps: WorkflowStepInput[];
} | {
  mode: 'clarify';
  assistantMessage: string;
  assumptions: string[];
} {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Response must be a JSON object.');
  }

  if (parsed.mode !== 'clarify' && parsed.mode !== 'draft') {
    throw new Error('Response must include mode "clarify" or "draft".');
  }

  if (typeof parsed.assistantMessage !== 'string' || parsed.assistantMessage.trim() === '') {
    throw new Error('Response must include a non-empty assistantMessage.');
  }

  if (!Array.isArray(parsed.assumptions) || parsed.assumptions.some((value) => typeof value !== 'string')) {
    throw new Error('Response must include an assumptions string array.');
  }

  if (parsed.mode === 'clarify') {
    return {
      mode: 'clarify',
      assistantMessage: parsed.assistantMessage,
      assumptions: parsed.assumptions,
    };
  }

  if (!Array.isArray(parsed.steps) || parsed.steps.some((step) => !step || typeof step !== 'object' || Array.isArray(step))) {
    throw new Error('Draft responses must include a steps object array.');
  }

  return {
    mode: 'draft',
    assistantMessage: parsed.assistantMessage,
    assumptions: parsed.assumptions,
    steps: parsed.steps as WorkflowStepInput[],
  };
}

function stripJsonCodeFence(value: string) {
  const trimmed = value.trim();

  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  return trimmed;
}

function buildReport(input: {
  experimentTitle: string;
  requestExport: FrozenRequestExport;
  results: ReplayResult[];
  includeCurrentWorkflowSolution: boolean;
  includeCuratedExamples: boolean;
}) {
  const lines = [
    `# ${input.experimentTitle} Report`,
    '',
    `Generated at: \`${new Date().toISOString()}\``,
    '',
    '## Configuration',
    '',
    '- Request style: old canonical-AST replay',
    `- Iterations: \`${ITERATIONS}\``,
    `- Prefilled workflow solution: \`${String(input.includeCurrentWorkflowSolution)}\``,
    `- Curated examples included: \`${String(input.includeCuratedExamples)}\``,
    '',
    '## Summary',
    '',
    '| Total | Valid | Clarify | Request error | Parse error | Structural failed | Semantic failed |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    `| ${input.results.length} | ${countStatus(input.results, 'valid_draft')} | ${countStatus(input.results, 'clarify')} | ${countStatus(input.results, 'request_error')} | ${countStatus(input.results, 'parse_error')} | ${countStatus(input.results, 'structural_failed')} | ${countStatus(input.results, 'semantic_failed')} |`,
    '',
    '## Detailed Results',
    '',
    '| Run | Status | Mode | Notes |',
    '| ---: | --- | --- | --- |',
  ];

  input.results.forEach((result) => {
    lines.push(
      `| ${result.iteration} | \`${result.status}\` | ${result.mode ?? '-'} | ${escapeTable(result.issueSummary ?? result.rawTextPreview ?? '')} |`,
    );
  });

  const failedResults = input.results.filter((result) => result.status !== 'valid_draft');

  if (failedResults.length > 0) {
    lines.push('', 'Representative raw output previews:', '');

    failedResults.slice(0, 3).forEach((result) => {
      lines.push(`- Run ${result.iteration} (\`${result.status}\`): ${result.rawTextPreview ?? '(no raw text preview)'}`);
    });
  }

  lines.push(
    '',
    '## Frozen Request Snapshot',
    '',
    '```json',
    JSON.stringify(input.requestExport, null, 2),
    '```',
    '',
  );

  return `${lines.join('\n')}\n`;
}

function buildOldCanonicalEmailReplayRequest(options: {
  includeCurrentWorkflowSolution: boolean;
  includeCuratedExamples: boolean;
}): FrozenRequestExport {
  const currentWorkflowSteps = options.includeCurrentWorkflowSolution
    ? `[
  {
    "type": "scopedRule",
    "columnIds": ["col_email"],
    "cases": [
      {
        "when": {
          "kind": "call",
          "name": "isEmpty",
          "args": [{ "kind": "value" }]
        },
        "then": {
          "value": {
            "kind": "column",
            "columnId": "col_email_2"
          }
        }
      },
      {
        "when": {
          "kind": "call",
          "name": "isEmpty",
          "args": [{ "kind": "value" }]
        },
        "then": {
          "format": {
            "fillColor": "#ffc7ce"
          }
        }
      }
    ]
  },
  {
    "type": "dropColumns",
    "columnIds": ["col_email_2"]
  }
]`
    : '[]';
  const currentWorkflowSummary = options.includeCurrentWorkflowSolution
    ? '- 1. scopedRule on col_email with 2 cases\n- 2. dropColumns col_email_2'
    : '- (empty workflow)';
  const curatedExamples = options.includeCuratedExamples
    ? `Curated examples:
Example 3 user: If Email is empty, use Email (2), then drop Email (2).
Example 3 response: {"mode":"draft","assistantMessage":"I will create a single email column by using Email (2) only when Email is empty, then drop Email (2).","assumptions":[],"steps":[{"type":"scopedRule","columnIds":["col_email"],"cases":[{"when":{"kind":"call","name":"isEmpty","args":[{"kind":"value"}]},"then":{"value":{"kind":"column","columnId":"col_email_2"}}}]},{"type":"dropColumns","columnIds":["col_email_2"]}]}
Example 4 user: We just need one email column. Use Email first, fall back to Email (2), and if both are empty color the final email cell red.
Example 4 response: {"mode":"draft","assistantMessage":"I will fill Email from Email (2) when needed, color the final email cell red when it is still empty, and then drop Email (2).","assumptions":[],"steps":[{"type":"scopedRule","columnIds":["col_email"],"cases":[{"when":{"kind":"call","name":"isEmpty","args":[{"kind":"value"}]},"then":{"value":{"kind":"column","columnId":"col_email_2"}}},{"when":{"kind":"call","name":"isEmpty","args":[{"kind":"value"}]},"then":{"format":{"fillColor":"#FFC7CE"}}}]},{"type":"dropColumns","columnIds":["col_email_2"]}]}`
    : 'Curated examples:\n(none)';
  const systemInstructionText = `You are an expert Scratch My Table copilot.
Translate the user request into canonical Workflow IR v2 draft steps.
Return JSON only. Do not use markdown fences.
Never return a workflow envelope or step IDs. Return only the structured response object.
If the request is ambiguous or missing a required choice, return mode "clarify" and ask a short targeted question.
If you can act, return mode "draft" and include the FULL updated workflow step list.
Never return mode "draft" with an empty steps array. If you cannot produce at least one valid workflow step, return mode "clarify" instead.
The returned steps are a full workflow replacement candidate.
You may rewrite, reorder, insert, or remove steps as needed.
If a later step drops a column, any logic that depends on that column must happen before the drop or be folded into an earlier step.
The canonical workflow summary below reflects the current valid workflow context.
There is no AI draft yet. Return the FULL updated workflow step list that should replace the current workflow.

Response contract:
- mode: "clarify" or "draft"
- assistantMessage: short natural-language explanation
- assumptions: array of short strings
- steps: required only when mode = "draft", and must contain at least one step

Canonical step types:
- comment
- scopedRule
- dropColumns

Expression AST rules:
- expression kinds: value, literal, column, call
- "value" is only valid inside scopedRule.cases[*].when, scopedRule.cases[*].then.value, and scopedRule.defaultPatch.value
- "value" is represented exactly as { "kind": "value" } with no extra properties
- null is represented as { "kind": "literal", "value": null }
- scopedRule cases are checked top to bottom and every matching case applies in order
- later matching scopedRule cases see the current cell value after earlier matching cases have already applied
- format patches currently support format.fillColor only, as a hex color like "#FFEB9C"

Built-in call names:
- logic: isEmpty

Schema currently available to the returned workflow steps:
- col_customer_id | Customer ID | string
- col_first_name | First Name | string
- col_last_name | Last Name | string
- col_email | Email | string
- col_column | Column | string
- col_status | Status | string
- col_sign_up_date | Sign Up Date | string
- col_notes | Notes | string
- col_balance | Balance | mixed
- col_vip | VIP? | boolean

Current workflow/editor issues:
- (none)

Current workflow steps without IDs:
${currentWorkflowSteps}

Current workflow summary:
${currentWorkflowSummary}

Current AI draft workflow steps without IDs:
(no draft yet)

${curatedExamples}`;
  const contents: FrozenRequestExport['contents'] = [
    {
      role: 'user',
      parts: [{ text: EMAIL_PROMPT }],
    },
    {
      role: 'model',
      parts: [
        {
          text: 'I will consolidate the email columns by using Email (2) as a fallback for Email, and then highlight any remaining empty email cells in red before dropping the secondary email column.',
        },
      ],
    },
    {
      role: 'user',
      parts: [{ text: EMAIL_PROMPT }],
    },
  ];

  return {
    requestUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent',
    systemInstructionText,
    contents,
    requestBody: {
      systemInstruction: {
        parts: [{ text: systemInstructionText }],
      },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: buildOldCanonicalEmailReplayResponseJsonSchema(),
        temperature: 0.2,
        maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
        thinkingConfig: {
          thinkingLevel: 'minimal',
        },
      },
    },
  };
}

function buildOldCanonicalEmailReplayResponseJsonSchema() {
  const expressionSchema = {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'value' },
        },
        required: ['kind'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'literal' },
          value: {
            type: ['string', 'number', 'boolean', 'null'],
          },
        },
        required: ['kind', 'value'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'column' },
          columnId: { type: 'string', minLength: 1 },
        },
        required: ['kind', 'columnId'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'call' },
          name: { type: 'string', const: 'isEmpty' },
          args: {
            type: 'array',
            minItems: 1,
            maxItems: 1,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', const: 'value' },
              },
              required: ['kind'],
            },
          },
        },
        required: ['kind', 'name', 'args'],
      },
    ],
  };
  const cellPatchSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      value: expressionSchema,
      format: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fillColor: { type: 'string' },
        },
      },
    },
  };

  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', const: 'clarify' },
          assistantMessage: { type: 'string', minLength: 1 },
          assumptions: {
            type: 'array',
            items: { type: 'string' },
          },
        },
        required: ['mode', 'assistantMessage', 'assumptions'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', const: 'draft' },
          assistantMessage: { type: 'string', minLength: 1 },
          assumptions: {
            type: 'array',
            items: { type: 'string' },
          },
          steps: {
            type: 'array',
            minItems: 1,
            items: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', const: 'comment' },
                    text: { type: 'string', minLength: 1 },
                  },
                  required: ['type', 'text'],
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', const: 'scopedRule' },
                    columnIds: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string', minLength: 1 },
                    },
                    cases: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          when: expressionSchema,
                          then: cellPatchSchema,
                        },
                        required: ['when', 'then'],
                      },
                    },
                    defaultPatch: cellPatchSchema,
                  },
                  required: ['type', 'columnIds'],
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    type: { type: 'string', const: 'dropColumns' },
                    columnIds: {
                      type: 'array',
                      minItems: 1,
                      items: { type: 'string', minLength: 1 },
                    },
                  },
                  required: ['type', 'columnIds'],
                },
              ],
            },
          },
        },
        required: ['mode', 'assistantMessage', 'assumptions', 'steps'],
      },
    ],
  };
}

function countStatus(results: ReplayResult[], status: ReplayStatus) {
  return results.filter((result) => result.status === status).length;
}

function escapeTable(value: string) {
  return value.replace(/\|/g, '\\|');
}
