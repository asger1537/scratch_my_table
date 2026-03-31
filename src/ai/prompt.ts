import { validateWorkflowSemantics, type Workflow } from '../workflow';

import { appendDraftStepsToWorkflow, stripWorkflowStepIds, summarizeWorkflowSteps } from './draft';
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
              fillColor: '#FFF2CC',
            },
          },
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
];

export function buildGeminiSystemInstruction(context: AIPromptContext): string {
  const availableSchema = getAvailableSchemaContextWorkflow(context);
  const workflowSummary = summarizeWorkflowSteps(context.workflow);
  const draftSummary = context.draft ? JSON.stringify(stripWorkflowStepIds(context.draft.steps), null, 2) : '(no draft yet)';

  return [
    'You are an expert Scratch My Table copilot.',
    'Translate the user request into canonical Workflow IR v2 draft steps.',
    'Return JSON only. Do not use markdown fences.',
    'Never return a workflow envelope or step IDs. Return only the structured response object.',
    'If the request is ambiguous or missing a required choice, return mode "clarify" and ask a short targeted question.',
    'If you can act, return mode "draft" and include the FULL updated draft step list that should replace the current AI draft.',
    'Never return mode "draft" with an empty steps array. If you cannot produce at least one valid workflow step, return mode "clarify" instead.',
    'The draft is append-only relative to the existing workflow. Do not rewrite existing workflow steps.',
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
    '- filterRows.condition and scopedRule.rowCondition must resolve to boolean expressions',
    '- scopedRule is the only canonical cell-level step',
    '- format patches currently support format.fillColor only, as a hex color like "#FFF2CC"',
    '',
    'Built-in call names:',
    '- logic: equals, contains, startsWith, endsWith, matchesRegex, greaterThan, lessThan, and, or, not, isEmpty',
    '- string/list: trim, lower, upper, collapseWhitespace, substring, replace, extractRegex, replaceRegex, split, atIndex, first, last, coalesce, concat, switch',
    '- math: add, subtract, multiply, divide, modulo, round, floor, ceil, abs',
    '- date/time: now, datePart, dateDiff, dateAdd',
    '',
    'Schema currently available to appended steps:',
    ...availableSchema.map((column) => `- ${column.columnId} | ${column.displayName} | ${column.logicalType}`),
    '',
    'Current workflow summary:',
    ...workflowSummary.map((line) => `- ${line}`),
    '',
    'Current AI draft steps without IDs:',
    draftSummary,
    '',
    'Curated examples:',
    ...CURATED_EXAMPLES.flatMap((example, index) => [
      `Example ${index + 1} user: ${example.user}`,
      `Example ${index + 1} response: ${JSON.stringify(example.assistant)}`,
    ]),
  ].join('\n');
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
) {
  return [
    'Your previous draft did not validate locally.',
    'Rewrite the FULL updated draft so it satisfies these issues.',
    'Use only the available schema and allowed canonical step/function names.',
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
  ].join('\n');
}

function getAvailableSchemaContextWorkflow(context: AIPromptContext) {
  const workflowForSchema = context.draft ? appendDraftStepsToWorkflow(context.workflow, context.draft.steps) : context.workflow;
  const validation = validateWorkflowSemantics(workflowForSchema, context.table);

  return validation.valid ? validation.finalSchema.columns : context.table.schema.columns;
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
