import { validateWorkflowSemantics, type Workflow } from '../workflow';

import { replaceWorkflowSteps, stripWorkflowStepIds, summarizeWorkflowSteps } from './draft';
import type { AIDraft, AIPromptContext, AIMessage, WorkflowStepInput } from './types';

export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

const CURATED_EXAMPLES = [
  {
    user: 'Remove rows where email is empty.',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will drop rows where the email column is empty.',
      assumptions: [],
      steps: [
        {
          type: 'filterRows',
          mode: 'drop',
          condition: {
            kind: 'call',
            name: 'isEmpty',
            args: [{ kind: 'column', columnId: 'col_email' }],
          },
        },
      ],
    },
  },
  {
    user: 'Normalize the email column by trimming and lowercasing it.',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will normalize the email column in place.',
      assumptions: [],
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: {
              kind: 'call',
              name: 'lower',
              args: [
                {
                  kind: 'call',
                  name: 'trim',
                  args: [{ kind: 'value' }],
                },
              ],
            },
          },
        },
      ],
    },
  },
  {
    user: 'If Email is empty, use Email (2), then drop Email (2).',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will create a single email column by using Email (2) only when Email is empty, then drop Email (2).',
      assumptions: [],
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: {
                kind: 'call',
                name: 'isEmpty',
                args: [{ kind: 'value' }],
              },
              then: {
                value: {
                  kind: 'column',
                  columnId: 'col_email_2',
                },
              },
            },
          ],
        },
        {
          type: 'dropColumns',
          columnIds: ['col_email_2'],
        },
      ],
    },
  },
  {
    user: 'We just need one email column. Use Email first, fall back to Email (2), and if both are empty color the final email cell red.',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will fill Email from Email (2) when needed, color the final email cell red when it is still empty, and then drop Email (2).',
      assumptions: [],
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: {
                kind: 'call',
                name: 'isEmpty',
                args: [{ kind: 'value' }],
              },
              then: {
                value: {
                  kind: 'column',
                  columnId: 'col_email_2',
                },
              },
            },
            {
              when: {
                kind: 'call',
                name: 'isEmpty',
                args: [{ kind: 'value' }],
              },
              then: {
                format: {
                  fillColor: '#FFC7CE',
                },
              },
            },
          ],
        },
        {
          type: 'dropColumns',
          columnIds: ['col_email_2'],
        },
      ],
    },
  },
  {
    user: 'Highlight VIP status cells in yellow.',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will highlight the status cells for VIP rows.',
      assumptions: [],
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_status'],
          rowCondition: {
            kind: 'call',
            name: 'equals',
            args: [
              { kind: 'column', columnId: 'col_vip' },
              { kind: 'literal', value: true },
            ],
          },
          defaultPatch: {
            format: {
              fillColor: '#FFEB9C',
            },
          },
        },
      ],
    },
  },
  {
    user: 'Combine First Name and Last Name into Full Name, then drop the originals.',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will create a Full Name column first and only then drop the source name columns.',
      assumptions: [],
      steps: [
        {
          type: 'combineColumns',
          columnIds: ['col_first_name', 'col_last_name'],
          separator: ' ',
          newColumn: {
            columnId: 'col_full_name',
            displayName: 'Full Name',
          },
        },
        {
          type: 'dropColumns',
          columnIds: ['col_first_name', 'col_last_name'],
        },
      ],
    },
  },
  {
    user: 'Clean the name column.',
    assistant: {
      mode: 'clarify',
      assistantMessage: 'Which column should be cleaned, and do you want trimming, lowercasing, uppercasing, or whitespace collapsing?',
      assumptions: [],
    },
  },
  {
    user: 'Update the existing email fallback so cells turn yellow when Email (2) was used.',
    assistant: {
      mode: 'draft',
      assistantMessage: 'I will update the existing email fallback rule so it also colors those cells yellow.',
      assumptions: [],
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: {
                kind: 'call',
                name: 'isEmpty',
                args: [{ kind: 'value' }],
              },
              then: {
                value: {
                  kind: 'column',
                  columnId: 'col_email_2',
                },
                format: {
                  fillColor: '#FFEB9C',
                },
              },
            },
          ],
        },
        {
          type: 'dropColumns',
          columnIds: ['col_email_2'],
        },
      ],
    },
  },
];

export function buildGeminiSystemInstruction(context: AIPromptContext): string {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);
  const workflowSummary = summarizeWorkflowSteps(context.workflow);
  const workflowSteps = context.workflow.steps.length > 0 ? JSON.stringify(stripWorkflowStepIds(context.workflow.steps), null, 2) : '(no steps yet)';
  const draftSummary = context.draft ? JSON.stringify(stripWorkflowStepIds(context.draft.steps), null, 2) : '(no draft yet)';
  const currentIssues = context.currentIssues.length > 0
    ? context.currentIssues.map((issue) => `- ${issue.code}: ${issue.message}`)
    : ['- (none)'];
  const workflowContextNote = context.workflowContextSource === 'lastValidSnapshot'
    ? 'The canonical workflow summary below is the last valid snapshot because the live block workspace currently has issues. Use the live workspace snapshot and issue list to infer the intended fix. Applying the draft will replace the broken workspace with the drafted workflow.'
    : 'The canonical workflow summary below reflects the current valid workflow context.';
  const draftSemanticsNote = context.draft
    ? 'There is an existing AI draft. Return the FULL updated workflow step list that should replace that AI draft.'
    : 'There is no AI draft yet. Return the FULL updated workflow step list that should replace the current workflow.';
  const promptSections = [
    'You are an expert Scratch My Table copilot.',
    'Translate the user request into canonical Workflow IR v2 draft steps.',
    'Return JSON only. Do not use markdown fences.',
    'Never return a workflow envelope or step IDs. Return only the structured response object.',
    'If the request is ambiguous or missing a required choice, return mode "clarify" and ask a short targeted question.',
    'If you can act, return mode "draft" and include the FULL updated workflow step list.',
    'Never return mode "draft" with an empty steps array. If you cannot produce at least one valid workflow step, return mode "clarify" instead.',
    'The returned steps are a full workflow replacement candidate.',
    'You may rewrite, reorder, insert, or remove steps as needed.',
    'If a later step drops a column, any logic that depends on that column must happen before the drop or be folded into an earlier step.',
    workflowContextNote,
    draftSemanticsNote,
    '',
    'Response contract:',
    '- mode: "clarify" or "draft"',
    '- assistantMessage: short natural-language explanation',
    '- assumptions: array of short strings',
    '- steps: required only when mode = "draft", and must contain at least one step',
    '',
    'Canonical step types:',
    '- comment',
    '- scopedRule',
    '- dropColumns',
    '- renameColumn',
    '- deriveColumn',
    '- filterRows',
    '- splitColumn',
    '- combineColumns',
    '- deduplicateRows',
    '- sortRows',
    '',
    'Expression AST rules:',
    '- expression kinds: value, literal, column, call',
    '- "value" is only valid inside scopedRule.cases[*].when, scopedRule.cases[*].then.value, and scopedRule.defaultPatch.value',
    '- DO NOT use { "kind": "value" } in deriveColumn.expression, filterRows.condition, or scopedRule.rowCondition; use { "kind": "column", "columnId": "..." } to read row data there',
    '- sortRows, splitColumn, combineColumns, and deduplicateRows must reference columns through their columnId fields, never through { "kind": "value" }',
    '- "value" is represented exactly as { "kind": "value" } with no extra properties',
    '- null is represented as { "kind": "literal", "value": null }',
    '- filterRows.condition and scopedRule.rowCondition must resolve to boolean expressions',
    '- scopedRule is the only canonical cell-level step',
    '- scopedRule cases are checked top to bottom and every matching case applies in order',
    '- later matching scopedRule cases see the current cell value after earlier matching cases have already applied',
    '- format patches currently support format.fillColor only, as a hex color like "#FFEB9C"',
    '- CRITICAL: When writing regex patterns in JSON string literals, double-escape backslashes for JSON serialization. Example: the regex \\d+ must appear in JSON as "\\\\d+", and whitespace \\s must appear as "\\\\s"',
    '',
    'Built-in call names:',
    '- logic: equals, contains, startsWith, endsWith, matchesRegex, greaterThan, lessThan, and, or, not, isEmpty',
    '- string/list: trim, lower, upper, collapseWhitespace, substring, replace, extractRegex, replaceRegex, split, atIndex, first, last, coalesce, concat, switch',
    '- casting: toNumber, toString, toBoolean',
    '- math: add, subtract, multiply, divide, modulo, round, floor, ceil, abs',
    '- date/time: now, datePart, dateDiff, dateAdd',
    '',
    'Schema currently available to the returned workflow steps:',
    ...availableSchemaLines,
    '- Columns marked "mixed" contain incompatible runtime values. Do not use them directly for sortRows or numeric/date math until earlier steps normalize them to one logical type.',
    '- Columns marked "unknown" may be entirely empty or unresolved. Do not assume numeric or date semantics unless your draft first creates or normalizes those values.',
    '',
    'Current workflow/editor issues:',
    ...currentIssues,
    '',
    'Current workflow steps without IDs:',
    workflowSteps,
    '',
    'Current workflow summary:',
    ...workflowSummary.map((line) => `- ${line}`),
    '',
    'Current AI draft workflow steps without IDs:',
    draftSummary,
    '',
    'Curated examples:',
    ...CURATED_EXAMPLES.flatMap((example, index) => [
      `Example ${index + 1} user: ${example.user}`,
      `Example ${index + 1} response: ${JSON.stringify(example.assistant)}`,
    ]),
  ];

  if (context.workflowContextSource === 'lastValidSnapshot') {
    promptSections.splice(
      promptSections.indexOf('Current workflow/editor issues:'),
      0,
      'Current block workspace snapshot:',
      context.workspacePromptSnapshot || '(live workspace snapshot unavailable)',
      '',
    );
  }

  return promptSections.join('\n');
}

export function buildGeminiContents(messages: AIMessage[], userMessage: AIMessage): GeminiContent[] {
  return [...messages, userMessage].map((message) => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: message.text }],
  }));
}

export function buildRepairUserMessage(
  previousRawText: string,
  issues: Array<{ code: string; path: string; message: string; stepId?: string }>,
  context: AIPromptContext,
) {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);

  return [
    'Your previous draft did not validate locally.',
    'Rewrite the FULL updated workflow step list so it satisfies these issues.',
    'Use only the available schema and allowed canonical step/function names.',
    'You may rewrite, reorder, insert, or remove earlier steps.',
    'If a validation issue says a column does not exist, do not reference it after it has been dropped. Move that logic before the drop or fold it into an earlier step.',
    'Do not ask a clarification question in this repair turn. Return mode "draft".',
    'Return at least one workflow step. Do not return an empty steps array.',
    '',
    'Previous invalid response:',
    previousRawText,
    '',
    'Validation issues:',
    JSON.stringify(
      issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
        ...(issue.stepId ? { stepId: issue.stepId } : {}),
      })),
      null,
      2,
    ),
    '',
    'Reminder of available columns:',
    ...availableSchemaLines,
  ].join('\n');
}

function getAvailableSchemaContextWorkflow(context: AIPromptContext) {
  const workflowForSchema = context.draft ? replaceWorkflowSteps(context.workflow, context.draft.steps) : context.workflow;
  const validation = validateWorkflowSemantics(workflowForSchema, context.table);

  return validation.valid ? validation.finalSchema.columns : context.table.schema.columns;
}

function getAvailableSchemaPromptLines(context: AIPromptContext) {
  return getAvailableSchemaContextWorkflow(context).map((column) => `- ${column.columnId} | ${column.displayName} | ${column.logicalType}`);
}

export function summarizeDraftStepsForDisplay(draft: AIDraft | null) {
  if (!draft || draft.steps.length === 0) {
    return 'No AI draft steps.';
  }

  return JSON.stringify(stripWorkflowStepIds(draft.steps), null, 2);
}

export function summarizeWorkflowForPrompt(workflow: Workflow, draft: AIDraft | null) {
  return {
    workflow: summarizeWorkflowSteps(workflow),
    draft: draft ? stripWorkflowStepIds(draft.steps) : [],
  };
}

export function stripDraftStepIds(steps: WorkflowStepInput[] | Workflow['steps']) {
  return 'length' in steps && steps.length > 0 && 'id' in steps[0]
    ? stripWorkflowStepIds(steps as Workflow['steps'])
    : (steps as WorkflowStepInput[]);
}
