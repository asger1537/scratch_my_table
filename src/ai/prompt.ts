import { validateWorkflowSemantics, type Workflow } from '../workflow';

import { replaceWorkflowSteps, stripWorkflowStepIds, summarizeWorkflowSteps } from './draft';
import type { AIDraft, AIPromptContext, AIMessage, WorkflowStepInput } from './types';

export interface GeminiContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

const CURATED_EXAMPLES = [
  {
    user: 'If Email is empty, use Email (2), then drop Email (2).',
    assistant: {
      mode: 'draft',
      msg: 'Use Email (2) only when Email is empty, then drop Email (2).',
      ass: [],
      ops: [
        { op: 'fill_empty_from_col', dst: 'col_email', src: 'col_email_2' },
        { op: 'drop_cols', cols: ['col_email_2'] },
      ],
    },
  },
  {
    user: 'We just need one email column. Use Email first, fall back to Email (2), and if both are empty color the final email cell red.',
    assistant: {
      mode: 'draft',
      msg: 'Use Email (2) when Email is empty, color any still-empty Email cells red, then drop Email (2).',
      ass: [],
      ops: [
        { op: 'fill_empty_from_col', dst: 'col_email', src: 'col_email_2' },
        { op: 'color_if_empty', col: 'col_email', color: '#ffc7ce' },
        { op: 'drop_cols', cols: ['col_email_2'] },
      ],
    },
  },
  {
    user: "Let's calculate a priority score based on balance: negative => 3, 0..200 => 2, above => 1.",
    assistant: {
      mode: 'draft',
      msg: 'Create a priority score from Balance using three numeric bands.',
      ass: [],
      ops: [
        {
          op: 'derive_score_bands',
          src: 'col_balance',
          out: { id: 'col_priority_score', name: 'Priority Score' },
          bands: [
            { lo: null, hi: 0, loInc: false, hiInc: false, score: 3 },
            { lo: 0, hi: 200, loInc: true, hiInc: true, score: 2 },
            { lo: 200, hi: null, loInc: false, hiInc: false, score: 1 },
          ],
        },
      ],
    },
  },
  {
    user: 'Clean the name column.',
    assistant: {
      mode: 'clarify',
      msg: 'Which column should be cleaned, and what kind of cleanup do you want?',
      ass: [],
      ops: [],
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
    ? 'The canonical workflow summary below is the last valid snapshot because the live block workspace currently has issues. Use the live workspace snapshot and issue list to infer the intended fix. Applying the draft will replace the broken workspace.'
    : 'The canonical workflow summary below reflects the current valid workflow context.';
  const draftSemanticsNote = context.draft
    ? 'There is an existing AI draft. Return the FULL updated operation list that should replace that AI draft.'
    : 'There is no AI draft yet. Return the FULL updated operation list that should replace the current workflow.';
  const promptSections = [
    'You are an expert Scratch My Table copilot.',
    'Translate the user request into a tiny compiler-friendly operation list.',
    'Local code will compile this operation list into canonical Workflow IR v2 and then run structural/semantic validation.',
    'Return JSON only. Do not use markdown fences.',
    'Do not return canonical AST, Blockly data, workflow envelopes, or step IDs.',
    workflowContextNote,
    draftSemanticsNote,
    '',
    'Response contract:',
    '- mode: "clarify" or "draft"',
    '- msg: short natural-language summary',
    '- ass: array of short strings',
    '- ops: ordered compiler ops',
    '- Always include all four fields.',
    '- Use ops: [] only when mode is "clarify".',
    '- Never return mode "draft" with an empty ops array.',
    '',
    'Allowed ops and exact field shapes:',
    '- fill_empty_from_col: { "op": "fill_empty_from_col", "dst": "col_x", "src": "col_y" }',
    '- color_if_empty: { "op": "color_if_empty", "col": "col_x", "color": "#ffc7ce" }',
    '- drop_cols: { "op": "drop_cols", "cols": ["col_x", "col_y"] }',
    '- derive_score_bands: { "op": "derive_score_bands", "src": "col_balance", "out": { "id": "col_priority_score", "name": "Priority Score" }, "bands": [{ "lo": null|number, "hi": null|number, "loInc": boolean, "hiInc": boolean, "score": number }] }',
    '',
    'Rules:',
    '- Use column ids exactly as provided.',
    '- Keep ops in execution order.',
    '- Use only the allowed op names.',
    '- For email fallback then red formatting: fill_empty_from_col, then color_if_empty, then drop_cols.',
    '- For priority score bucketing: use derive_score_bands.',
    '- In derive_score_bands, a band with lo = null has no lower bound, and hi = null has no upper bound.',
    '- If both lo and hi are null, that band is a fallback and should be last.',
    '',
    'Schema currently available to the returned ops:',
    ...availableSchemaLines,
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
    'Rewrite the FULL operation list so it satisfies these issues.',
    'Return compiler-op JSON only with keys: mode, msg, ass, ops.',
    'Do not return canonical AST or workflow steps.',
    'Use only these op names: fill_empty_from_col, color_if_empty, drop_cols, derive_score_bands.',
    'Do not ask a clarification question in this repair turn. Return mode "draft".',
    'Return at least one op.',
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
