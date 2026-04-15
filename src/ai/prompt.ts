import { validateWorkflowSemantics, type Workflow } from '../workflow';
import { flattenWorkflowSequence } from '../workflowPackage';

import { replaceWorkflowSteps, stripWorkflowStepIds, summarizeWorkflowSteps } from './draft';
import {
  AI_AUTHORING_IR_DOCUMENTATION_LINES,
  AI_CANONICAL_RUNTIME_DOCUMENTATION_LINES,
  AI_COLOR_DOCUMENTATION_LINES,
  AI_OPERATOR_DOCUMENTATION_LINES,
  buildSharedImplementationDocumentation,
} from './promptDocumentation';
import type {
  AIChecklistVerificationIssue,
  AIRequirementPlanResponse,
  AIDraft,
  AIRepairIssueSummary,
  AIPromptContext,
  AIMessage,
  WorkflowStepInput,
} from './types';

export interface GeminiPromptOptions {
  includeCuratedExamples?: boolean;
  requirementPlan?: Extract<AIRequirementPlanResponse, { mode: 'plan' }>;
}

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
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: {
                kind: 'predicate',
                op: 'isEmpty',
                input: { source: 'value' },
              },
              then: {
                value: { source: 'column', columnId: 'col_email_2' },
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
      msg: 'Fill Email from Email (2) when needed, color any still-empty Email cells red, then drop Email (2).',
      ass: [],
      steps: [
        {
          type: 'comment',
          text: 'Consolidate Email and flag missing final values.',
        },
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: {
                kind: 'predicate',
                op: 'isEmpty',
                input: { source: 'value' },
              },
              then: {
                value: { source: 'column', columnId: 'col_email_2' },
              },
            },
            {
              when: {
                kind: 'predicate',
                op: 'isEmpty',
                input: { source: 'value' },
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
    user: 'Make Email use Email (2) when empty, then trim and lowercase the final Email, drop Email (2), then keep only rows where Email contains @.',
    assistant: {
      mode: 'draft',
      msg: 'Fill Email from Email (2), normalize the final Email, drop Email (2), then keep only rows where Email contains @.',
      ass: [],
      steps: [
        {
          type: 'comment',
          text: 'Normalize Email before filtering rows.',
        },
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: {
                kind: 'predicate',
                op: 'isEmpty',
                input: { source: 'value' },
              },
              then: {
                value: { source: 'column', columnId: 'col_email_2' },
              },
            },
          ],
        },
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: {
              kind: 'unary',
              op: 'lower',
              input: {
                kind: 'unary',
                op: 'trim',
                input: { source: 'value' },
              },
            },
          },
        },
        {
          type: 'dropColumns',
          columnIds: ['col_email_2'],
        },
        {
          type: 'filterRows',
          mode: 'keep',
          where: {
            kind: 'compare',
            op: 'contains',
            left: { source: 'column', columnId: 'col_email' },
            right: { source: 'literal', value: '@' },
          },
        },
      ],
    },
  },
  {
    user: 'Normalize Email and Phone, derive Preferred Contact Method, then keep only contactable rows.',
    assistant: {
      mode: 'draft',
      msg: 'Normalize contact fields, derive Preferred Contact Method, then keep only contactable rows.',
      ass: [],
      steps: [
        {
          type: 'comment',
          text: 'Normalize contact fields.',
        },
        {
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: {
              kind: 'unary',
              op: 'lower',
              input: {
                kind: 'unary',
                op: 'trim',
                input: { source: 'value' },
              },
            },
          },
        },
        {
          type: 'scopedRule',
          columnIds: ['col_phone'],
          defaultPatch: {
            value: {
              kind: 'ternary',
              op: 'replaceRegex',
              first: {
                kind: 'unary',
                op: 'toString',
                input: { source: 'value' },
              },
              second: { source: 'literal', value: '[^0-9]+' },
              third: { source: 'literal', value: '' },
            },
          },
        },
        {
          type: 'comment',
          text: 'Derive contact method.',
        },
        {
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_preferred_contact_method',
            displayName: 'Preferred Contact Method',
          },
          derive: {
            kind: 'match',
            subject: { source: 'column', columnId: 'col_email' },
            cases: [
              {
                kind: 'when',
                when: {
                  kind: 'compare',
                  op: 'contains',
                  left: { source: 'caseValue' },
                  right: { source: 'literal', value: '@' },
                },
                then: { source: 'literal', value: 'email' },
              },
              {
                kind: 'when',
                when: {
                  kind: 'boolean',
                  op: 'and',
                  items: [
                    {
                      kind: 'boolean',
                      op: 'not',
                      item: {
                        kind: 'compare',
                        op: 'contains',
                        left: { source: 'caseValue' },
                        right: { source: 'literal', value: '@' },
                      },
                    },
                    {
                      kind: 'compare',
                      op: 'matchesRegex',
                      left: { source: 'column', columnId: 'col_phone' },
                      right: { source: 'literal', value: '^\\d{10}$' },
                    },
                  ],
                },
                then: { source: 'literal', value: 'sms' },
              },
              {
                kind: 'otherwise',
                then: { source: 'literal', value: 'none' },
              },
            ],
          },
        },
        {
          type: 'comment',
          text: 'Drop helpers and filter rows.',
        },
        {
          type: 'dropColumns',
          columnIds: ['col_email_2'],
        },
        {
          type: 'filterRows',
          mode: 'keep',
          where: {
            kind: 'boolean',
            op: 'not',
            item: {
              kind: 'compare',
              op: 'eq',
              left: { source: 'column', columnId: 'col_preferred_contact_method' },
              right: { source: 'literal', value: 'none' },
            },
          },
        },
      ],
    },
  },
  {
    user: 'Normalize the Phone column by removing every non-digit character.',
    assistant: {
      mode: 'draft',
      msg: 'Normalize Phone in place by keeping only digits.',
      ass: [],
      steps: [
        {
          type: 'scopedRule',
          columnIds: ['col_phone'],
          defaultPatch: {
            value: {
              kind: 'ternary',
              op: 'replaceRegex',
              first: {
                kind: 'unary',
                op: 'toString',
                input: { source: 'value' },
              },
              second: { source: 'literal', value: '[^0-9]+' },
              third: { source: 'literal', value: '' },
            },
          },
        },
      ],
    },
  },
  {
    user: "Let's calculate a priority score based on balance: negative => 3, 0..200 => 2, above => 1.",
    assistant: {
      mode: 'draft',
      msg: 'Create a priority score from Balance using ordered match cases on the numeric balance.',
      ass: [],
      steps: [
        {
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_priority_score',
            displayName: 'Priority Score',
          },
          derive: {
            kind: 'match',
            subject: {
              kind: 'unary',
              op: 'toNumber',
              input: { source: 'column', columnId: 'col_balance' },
            },
            cases: [
              {
                kind: 'when',
                when: {
                  kind: 'compare',
                  op: 'lt',
                  left: { source: 'caseValue' },
                  right: { source: 'literal', value: 0 },
                },
                then: { source: 'literal', value: 3 },
              },
              {
                kind: 'when',
                when: {
                  kind: 'between',
                  input: { source: 'caseValue' },
                  min: { source: 'literal', value: 0 },
                  max: { source: 'literal', value: 200 },
                  inclusiveMin: true,
                  inclusiveMax: true,
                },
                then: { source: 'literal', value: 2 },
              },
              {
                kind: 'otherwise',
                then: { source: 'literal', value: 1 },
              },
            ],
          },
        },
      ],
    },
  },
  {
    user: 'Map status values to readable labels.',
    assistant: {
      mode: 'draft',
      msg: 'Derive a status label using ordered match cases over normalized status text.',
      ass: [],
      steps: [
        {
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_status_label',
            displayName: 'Status Label',
          },
          derive: {
            kind: 'match',
            subject: {
              kind: 'unary',
              op: 'lower',
              input: {
                kind: 'unary',
                op: 'trim',
                input: { source: 'column', columnId: 'col_status' },
              },
            },
            cases: [
              {
                kind: 'when',
                when: {
                  kind: 'compare',
                  op: 'eq',
                  left: { source: 'caseValue' },
                  right: { source: 'literal', value: 'active' },
                },
                then: { source: 'literal', value: 'Active customer' },
              },
              {
                kind: 'when',
                when: {
                  kind: 'boolean',
                  op: 'or',
                  items: [
                    {
                      kind: 'compare',
                      op: 'eq',
                      left: { source: 'caseValue' },
                      right: { source: 'literal', value: 'pending' },
                    },
                    {
                      kind: 'compare',
                      op: 'eq',
                      left: { source: 'caseValue' },
                      right: { source: 'literal', value: 'queued' },
                    },
                  ],
                },
                then: { source: 'literal', value: 'Pending customer' },
              },
              {
                kind: 'otherwise',
                then: { source: 'literal', value: 'Other' },
              },
            ],
          },
        },
      ],
    },
  },
  {
    user: 'Clean the name column.',
    assistant: {
      mode: 'clarify',
      msg: 'Which column should be cleaned, and what cleanup do you want applied?',
      ass: [],
      steps: [],
    },
  },
  {
    user: 'Normalize contact fields, derive customer tiers, highlight risk, clean up helpers, filter contactable rows, and sort the final output.',
    assistant: {
      mode: 'clarify',
      msg: 'This is a large multi-part task. I recommend splitting it into workflows named "Contact normalization", "Customer classification", and "Final cleanup and ordering", run in that order. Should I append these workflows or replace the active workflow/package?',
      ass: [],
      steps: [],
    },
  },
  {
    user: 'Yes, split it and append the workflows.',
    assistant: {
      mode: 'workflowSetDraft',
      msg: 'Create a three-workflow sequence for contact cleanup, classification, and final presentation.',
      ass: [],
      applyMode: 'append',
      workflows: [
        {
          workflowId: 'wf_contact_normalization',
          name: 'Contact normalization',
          description: 'Normalize contact columns and remove helper contact columns.',
          steps: [
            {
              type: 'comment',
              text: 'Normalize Email.',
            },
            {
              type: 'scopedRule',
              columnIds: ['col_email'],
              defaultPatch: {
                value: {
                  kind: 'unary',
                  op: 'lower',
                  input: {
                    kind: 'unary',
                    op: 'trim',
                    input: { source: 'value' },
                  },
                },
              },
            },
          ],
        },
        {
          workflowId: 'wf_customer_classification',
          name: 'Customer classification',
          description: 'Derive customer-facing classification columns.',
          steps: [
            {
              type: 'deriveColumn',
              newColumn: {
                columnId: 'col_status_label',
                displayName: 'Status Label',
              },
              derive: {
                kind: 'match',
                subject: {
                  kind: 'unary',
                  op: 'lower',
                  input: {
                    kind: 'unary',
                    op: 'trim',
                    input: { source: 'column', columnId: 'col_status' },
                  },
                },
                cases: [
                  {
                    kind: 'when',
                    when: {
                      kind: 'compare',
                      op: 'eq',
                      left: { source: 'caseValue' },
                      right: { source: 'literal', value: 'active' },
                    },
                    then: { source: 'literal', value: 'Active customer' },
                  },
                  {
                    kind: 'otherwise',
                    then: { source: 'literal', value: 'Other' },
                  },
                ],
              },
            },
          ],
        },
        {
          workflowId: 'wf_final_cleanup_ordering',
          name: 'Final cleanup and ordering',
          description: 'Filter and sort the final table.',
          steps: [
            {
              type: 'filterRows',
              mode: 'keep',
              where: {
                kind: 'compare',
                op: 'contains',
                left: { source: 'column', columnId: 'col_email' },
                right: { source: 'literal', value: '@' },
              },
            },
          ],
        },
      ],
      runOrderWorkflowIds: ['wf_contact_normalization', 'wf_customer_classification', 'wf_final_cleanup_ordering'],
    },
  },
] as const;

export function buildGeminiSystemInstruction(
  context: AIPromptContext,
  options: GeminiPromptOptions = {},
): string {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);
  const workflowSummary = summarizeWorkflowSteps(context.workflow);
  const workflowSteps = context.workflow.steps.length > 0 ? JSON.stringify(stripWorkflowStepIds(context.workflow.steps), null, 2) : '(no steps yet)';
  const draftSummary = context.draft ? JSON.stringify(formatDraftForPrompt(context.draft), null, 2) : '(no draft yet)';
  const currentIssues = context.currentIssues.length > 0
    ? context.currentIssues.map((issue) => `- ${issue.code}: ${issue.message}`)
    : ['- (none)'];
  const workflowContextNote = context.workflowContextSource === 'lastValidSnapshot'
    ? 'The canonical workflow summary below is the last valid snapshot because the live block workspace currently has issues. Use the live workspace snapshot and issue list to infer the intended fix. Applying the draft will replace the broken workspace.'
    : 'The canonical workflow summary below reflects the current valid workflow context.';
  const draftSemanticsNote = context.draft
    ? context.draft.kind === 'workflowSet'
      ? 'There is an existing AI workflow-set draft. Return the FULL updated workflow-set draft that should replace that AI draft.'
      : 'There is an existing AI draft. Return the FULL updated authoring step list that should replace that AI draft.'
    : 'There is no AI draft yet. Return the FULL updated authoring step list or workflow-set draft that should replace the current workflow context.';
  const includeCuratedExamples = options.includeCuratedExamples !== false;
  const requirementPlanSections = options.requirementPlan
    ? [
        '',
        'Approved requirement checklist:',
        `- Planned draft kind: ${options.requirementPlan.draftKind}`,
        ...options.requirementPlan.checklist.flatMap((item) => [
          `- ${item.id}: ${item.requirement}`,
          ...item.acceptanceCriteria.map((criterion) => `  - acceptance: ${criterion}`),
        ]),
        ...(options.requirementPlan.workflowPlan
          ? [
              'Approved workflow split plan:',
              JSON.stringify(options.requirementPlan.workflowPlan, null, 2),
            ]
          : []),
        'Implement every checklist item. Do not ask to split again when the checklist already plans a workflowSet draft.',
      ]
    : [];
  const promptSections = [
    'You are an expert Scratch My Table copilot.',
    'Translate the user request into the Scratch My Table AI authoring IR.',
    'Local code will compile your authoring IR into canonical Workflow IR v2 and then run structural and semantic validation.',
    'Return JSON only. Do not use markdown fences.',
    'Do not return canonical Workflow IR v2, Blockly data, workflow-package envelopes, or step IDs.',
    'Never emit canonical { "kind": "call" }, { "kind": "column" }, { "kind": "value" }, or { "kind": "caseValue" } nodes directly. Use the authoring shapes below.',
    workflowContextNote,
    draftSemanticsNote,
    '',
    'Response contract:',
    '- mode: "clarify", "draft", or "workflowSetDraft"',
    '- msg: short natural-language summary',
    '- ass: array of short strings',
    '- For clarify and draft, include steps: ordered authoring steps. Use steps: [] only when mode is "clarify".',
    '- For workflowSetDraft, include applyMode, workflows, and runOrderWorkflowIds instead of top-level steps.',
    '- Never return mode "draft" with an empty steps array.',
    '- Never return mode "workflowSetDraft" with empty workflows, empty workflow steps, or empty runOrderWorkflowIds.',
    '',
    'Workflow-set draft shape:',
    '- { "mode": "workflowSetDraft", "msg": "...", "ass": [], "applyMode": "append"|"replaceActive"|"replacePackage", "workflows": [<workflow draft>, ...], "runOrderWorkflowIds": ["wf_a", "wf_b"] }',
    '- workflow draft: { "workflowId": "wf_short_slug", "name": "Readable name", "description"?: "...", "steps": [<authoring step>, ...] }',
    '- runOrderWorkflowIds must contain workflow IDs from workflows in execution order.',
    '- append keeps existing workflows and adds the generated workflows.',
    '- replaceActive replaces the active workflow with the first generated workflow and adds the remaining generated workflows.',
    '- replacePackage replaces the whole workflow package with the generated workflows.',
    '',
    'Multi-workflow split behavior:',
    '- If a request is large, has several independent concerns, or has many phases such as normalize, derive/classify, format, cleanup, filter, dedupe, and sort, prefer proposing a workflow split first.',
    '- When proposing a split, return mode "clarify" and name the proposed workflows, their run order, and ask whether to append them or replace existing workflow(s).',
    '- If the user clearly approves a split and chooses append, replace active, or replace package, return mode "workflowSetDraft".',
    '- If the user explicitly asks for one workflow, return mode "draft" even for large requests.',
    '- Workflow-set drafts are validated as one run-order sequence, so later workflows may use columns created by earlier workflows.',
    '',
    'Authoring step shapes:',
    '- comment: { "type": "comment", "text": "..." }',
    '- scopedRule: { "type": "scopedRule", "columnIds": ["col_x"], "rowWhere"?: <boolean expression>, "cases"?: [{ "when": <boolean expression>, "then": <cell patch> }], "defaultPatch"?: <cell patch> }',
    '- dropColumns: { "type": "dropColumns", "columnIds": ["col_x", "col_y"] }',
    '- renameColumn: { "type": "renameColumn", "columnId": "col_x", "newDisplayName": "New name" }',
    '- deriveColumn: { "type": "deriveColumn", "newColumn": { "columnId": "col_new", "displayName": "New" }, "derive": <value expression> }',
    '- filterRows: { "type": "filterRows", "mode": "keep"|"drop", "where": <boolean expression> }',
    '- splitColumn: { "type": "splitColumn", "columnId": "col_x", "delimiter": ",", "outputColumns": [{ "columnId": "col_a", "displayName": "A" }, { "columnId": "col_b", "displayName": "B" }] }',
    '- combineColumns: { "type": "combineColumns", "columnIds": ["col_a", "col_b"], "separator": " ", "newColumn": { "columnId": "col_full_name", "displayName": "Full Name" } }',
    '- deduplicateRows: { "type": "deduplicateRows", "columnIds": ["col_x"] }',
    '- sortRows: { "type": "sortRows", "sorts": [{ "columnId": "col_x", "direction": "asc"|"desc" }] }',
    '',
    'Cell patch shape:',
    '- { "value"?: <value expression>, "format"?: { "fillColor": "#FFEB9C" } }',
    '',
    'Comment guidance:',
    '- Add concise comment steps to explain non-trivial implementations.',
    '- For requests with 3 or more distinct goals or phases, include a short comment before each major phase.',
    '- Typical phases are normalize/fill, derive/classify, format/highlight, cleanup/drop, and filter/sort.',
    '- Longer workflows should usually have 2 to 5 comment steps, not just one comment at the start.',
    '- Keep comment text action-oriented and brief, usually 3 to 8 words.',
    '- Do not add comments for every single step, and skip comments for trivial one-step drafts.',
    '',
    ...AI_COLOR_DOCUMENTATION_LINES,
    '',
    ...AI_AUTHORING_IR_DOCUMENTATION_LINES,
    '',
    ...AI_OPERATOR_DOCUMENTATION_LINES,
    '',
    ...AI_CANONICAL_RUNTIME_DOCUMENTATION_LINES,
    '',
    'Rules:',
    '- First, inspect "Schema currently available to the returned steps" and ground every referenced input/source column against that list before drafting.',
    '- Use only columns that are listed in the current schema, plus new columns that you derive earlier in your own steps.',
    '- Use column ids exactly as provided.',
    '- Keep steps in execution order.',
    '- Inside workflowSetDraft, keep each workflow focused and keep the generated run order in dependency order.',
    '- If a later step drops a column, any logic that depends on that column must happen before the drop or be folded into an earlier step.',
    '- Use explicit casts like toString(...) or toNumber(...) when mixed columns need text or numeric treatment. Do not refuse mixed columns just because they are mixed.',
    '- In scopedRule, every expression in cases/defaultPatch must be valid for every targeted column in columnIds. If types differ, split into separate scopedRule steps per column group.',
    '- If you must fill from a fallback column and then normalize or further transform the final result, use separate sequential steps. Do not assume scopedRule.defaultPatch also runs after a matched fallback case.',
    '- If the user explicitly names a column like Phone or Email (2), use that exact provided column id rather than substituting a different column.',
    '- If the request depends on an input/source column that is not listed in the current schema, return mode "clarify" and ask which listed column to use. Do not guess, reinterpret, or substitute a different column just because it seems similar.',
    '- Do not treat generic words like "column", "field", "region-like field", or free-form clause fragments as schema columns unless they exactly match a listed column name or id.',
    '- If the user names match outputs like return "email", return "sms", and return "none", include those named outputs explicitly in the classification logic.',
    '- isEmpty(...) already treats whitespace-only strings as empty.',
    '- For multi-step implementations, include concise comment steps so the workflow stays readable and the phase boundaries are obvious in the editor.',
    '- When an approved requirement checklist is present, treat it as the acceptance contract and implement every item.',
    '- Use match for exclusive classification and bucketing. Match is ordered and first-match-wins.',
    '- Use scopedRule for cumulative cell rewrite behavior. Multiple scopedRule cases may apply in order to the evolving current cell value.',
    '- scopedRule uses { "source": "value" }. match case conditions and result expressions may use { "source": "caseValue" }. Do not mix them up.',
    '- For regex patterns in JSON string literals, double-escape backslashes for JSON serialization. Example: \\d+ must appear as "\\\\d+".',
    '',
    'Schema currently available to the returned steps:',
    ...availableSchemaLines,
    ...requirementPlanSections,
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

  if (includeCuratedExamples) {
    promptSections.push(
      '',
      'Curated examples:',
      ...CURATED_EXAMPLES.flatMap((example, index) => [
        `Example ${index + 1} user: ${example.user}`,
        `Example ${index + 1} response: ${JSON.stringify(example.assistant)}`,
      ]),
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

export function buildRequirementPlanSystemInstruction(context: AIPromptContext): string {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);
  const currentIssues = context.currentIssues.length > 0
    ? context.currentIssues.map((issue) => `- ${issue.code}: ${issue.message}`)
    : ['- (none)'];

  return [
    'You are an expert Scratch My Table task planner.',
    'Convert the user request and conversation into a concise acceptance checklist before implementation.',
    'Return JSON only. Do not use markdown fences.',
    'Do not return workflow steps, authoring IR steps, canonical Workflow IR, or Blockly data.',
    '',
    'Response contract:',
    '- clarify: { "mode": "clarify", "msg": "...", "ass": [] }',
    '- plan: { "mode": "plan", "msg": "...", "ass": [], "draftKind": "singleWorkflow"|"workflowSet", "checklist": [<item>, ...], "workflowPlan"?: <workflow plan> }',
    '- checklist item: { "id": "req_short_slug", "requirement": "One concise requirement.", "acceptanceCriteria": ["Concrete criterion.", "..."] }',
    '- workflowPlan for workflowSet: { "applyMode"?: "append"|"replaceActive"|"replacePackage", "workflows"?: [{ "workflowId": "wf_slug", "name": "Name", "description"?: "..." }], "runOrderWorkflowIds"?: ["wf_a"] }',
    '',
    'Planning rules:',
    '- If the request is ambiguous, missing a required source column, or needs a user-controlled split/apply choice, return clarify.',
    '- For large multi-concern requests, return clarify proposing named workflows and run order unless the user has already clearly approved the split and apply mode in this conversation.',
    '- Treat numbered requests with 5 or more goals/phases, such as "Goal 1" through "Goal 5", as large multi-concern requests.',
    '- Treat requests that combine 5 or more major phases such as normalize, derive/classify, format/highlight, cleanup/drop, filter, dedupe, and sort as large multi-concern requests.',
    '- A large multi-concern request should not return a singleWorkflow plan unless the user explicitly says to keep it as one workflow.',
    '- Split clarification must ask the user to choose append, replace active workflow, or replace package. Do not silently infer that choice.',
    '- If the user has approved append, replace active, or replace package, return plan with draftKind "workflowSet" and workflowPlan.applyMode set accordingly.',
    '- If the user explicitly wants one workflow, return plan with draftKind "singleWorkflow".',
    '- Checklist items must be concrete and verifiable from the final compiled draft.',
    '- Checklist acceptance criteria must describe required observable outcomes, not preferred implementation primitives.',
    '- Do not prescribe operators like coalesce, match, replaceRegex, or length unless the user explicitly requested that operator.',
    '- For exact text length requirements, write outcome criteria such as "Phone has exactly 10 digits" and let implementation choose length(...) or matchesRegex(...).',
    '- Preserve exact named outputs, derived column names, sort/dedupe keys, filter conditions, cleanup/drop requests, and formatting requirements as checklist items.',
    '- Do not invent requirements not present in the conversation.',
    '',
    ...buildSharedImplementationDocumentation(),
    '',
    'Schema currently available:',
    ...availableSchemaLines,
    '',
    'Current workflow/editor issues:',
    ...currentIssues,
  ].join('\n');
}

export function buildChecklistVerificationSystemInstruction(context: AIPromptContext): string {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);

  return [
    'You are a strict Scratch My Table implementation reviewer.',
    'Verify whether the compiled canonical draft satisfies the approved checklist.',
    'Return JSON only. Do not use markdown fences.',
    '',
    'Response contract:',
    '- { "status": "pass"|"fail", "issues": [<issue>, ...] }',
    '- issue: { "checklistId": "req_id", "code": "short_code", "message": "Actionable repair instruction." }',
    '',
    'Review rules:',
    '- Return pass only when every checklist item is materially satisfied by the compiled draft.',
    '- Do not fail for harmless implementation differences.',
    '- Do fail when a requested derived column, label, filter, formatting rule, drop, dedupe key, sort key/direction, or normalization is missing or contradictory.',
    '- Messages must tell the repair model exactly what to change.',
    '- Use checklist IDs exactly as provided.',
    '',
    ...buildSharedImplementationDocumentation(),
    '- Do not fail a checklist item for missing whitespace handling when isEmpty is used.',
    '- Do not require an alternative implementation when the compiled draft already satisfies the checklist under these semantics.',
    '',
    'Schema context:',
    ...availableSchemaLines,
  ].join('\n');
}

export function buildChecklistVerificationUserMessage(input: {
  userText: string;
  requirementPlan: Extract<AIRequirementPlanResponse, { mode: 'plan' }>;
  draft: AIDraft;
}) {
  return [
    'Verify this compiled draft against the approved checklist.',
    '',
    'Latest user message:',
    input.userText,
    '',
    'Approved checklist:',
    JSON.stringify(input.requirementPlan.checklist, null, 2),
    '',
    'Workflow plan:',
    JSON.stringify(input.requirementPlan.workflowPlan ?? null, null, 2),
    '',
    'Compiled canonical draft:',
    JSON.stringify(formatDraftForPrompt(input.draft), null, 2),
  ].join('\n');
}

export function buildRepairUserMessage(
  previousRawText: string,
  issues: AIRepairIssueSummary[],
  context: AIPromptContext,
  requirementPlan?: Extract<AIRequirementPlanResponse, { mode: 'plan' }>,
) {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);

  return [
    'Your previous draft did not validate locally.',
    'Rewrite the FULL authoring draft so it satisfies these issues.',
    'Return JSON only with the same mode shape as the previous invalid response: draft uses mode/msg/ass/steps; workflowSetDraft uses mode/msg/ass/applyMode/workflows/runOrderWorkflowIds.',
    'Return authoring IR only. Do not return canonical Workflow IR v2, canonical call nodes, or step IDs.',
    ...(requirementPlan
      ? [
          'You must satisfy this approved requirement checklist:',
          JSON.stringify(requirementPlan.checklist, null, 2),
          ...(requirementPlan.workflowPlan ? ['Approved workflow plan:', JSON.stringify(requirementPlan.workflowPlan, null, 2)] : []),
        ]
      : []),
    ...AI_AUTHORING_IR_DOCUMENTATION_LINES,
    '',
    ...buildSharedImplementationDocumentation(),
    'Preserve or add concise comment steps when the implementation has multiple phases.',
    'Check the listed schema columns before drafting. Use only listed schema columns plus columns derived earlier in the workflow.',
    'If a workflow must fill from a fallback column and then normalize the final result, use separate sequential steps. Do not rely on scopedRule.defaultPatch after a matched fallback case.',
    'If the user explicitly names a column like Phone or Email (2), use that exact provided column id.',
    'If the original request depends on a source column that is not listed in the current schema, do not substitute a different column just because it seems similar.',
    'If the user names match outputs like "email", "sms", and "none", include those named outputs explicitly.',
    'Do not ask a clarification question in this repair turn. Return mode "draft" or "workflowSetDraft".',
    'Return at least one step for every generated workflow.',
    '',
    'Previous invalid response:',
    previousRawText,
    '',
    'Root-cause validation/task-quality issues and cascade notes:',
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
  const workflowForSchema = getWorkflowForPromptSchema(context);
  const validation = validateWorkflowSemantics(workflowForSchema, context.table);

  return validation.valid ? validation.finalSchema.columns : context.table.schema.columns;
}

function getWorkflowForPromptSchema(context: AIPromptContext) {
  if (!context.draft) {
    return context.workflow;
  }

  if (context.draft.kind === 'workflowSet') {
    return flattenWorkflowSequence(context.draft.workflows, context.draft.runOrderWorkflowIds).workflow;
  }

  return replaceWorkflowSteps(context.workflow, context.draft.steps);
}

function getAvailableSchemaPromptLines(context: AIPromptContext) {
  return getAvailableSchemaContextWorkflow(context).map((column) => `- ${column.columnId} | ${column.displayName} | ${column.logicalType}`);
}

export function summarizeWorkflowForPrompt(workflow: Workflow, draft: AIDraft | null) {
  return {
    workflow: summarizeWorkflowSteps(workflow),
    draft: draft ? formatDraftForPrompt(draft) : [],
  };
}

function formatDraftForPrompt(draft: AIDraft) {
  if (draft.kind === 'workflowSet') {
    return {
      mode: 'workflowSetDraft',
      applyMode: draft.applyMode,
      workflows: draft.workflows.map((workflow) => ({
        workflowId: workflow.workflowId,
        name: workflow.name,
        ...(workflow.description ? { description: workflow.description } : {}),
        steps: stripWorkflowStepIds(workflow.steps),
      })),
      runOrderWorkflowIds: draft.runOrderWorkflowIds,
    };
  }

  return stripWorkflowStepIds(draft.steps);
}

export function stripDraftStepIds(steps: WorkflowStepInput[] | Workflow['steps']) {
  return 'length' in steps && steps.length > 0 && 'id' in steps[0]
    ? stripWorkflowStepIds(steps as Workflow['steps'])
    : (steps as WorkflowStepInput[]);
}
