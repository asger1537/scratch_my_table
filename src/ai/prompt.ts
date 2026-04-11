import { validateWorkflowSemantics, type Workflow } from '../workflow';

import { replaceWorkflowSteps, stripWorkflowStepIds, summarizeWorkflowSteps } from './draft';
import type { AIDraft, AIRepairIssueSummary, AIPromptContext, AIMessage, WorkflowStepInput } from './types';

export interface GeminiPromptOptions {
  includeCuratedExamples?: boolean;
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
] as const;

export function buildGeminiSystemInstruction(
  context: AIPromptContext,
  options: GeminiPromptOptions = {},
): string {
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
    ? 'There is an existing AI draft. Return the FULL updated authoring step list that should replace that AI draft.'
    : 'There is no AI draft yet. Return the FULL updated authoring step list that should replace the current workflow.';
  const includeCuratedExamples = options.includeCuratedExamples !== false;
  const promptSections = [
    'You are an expert Scratch My Table copilot.',
    'Translate the user request into the Scratch My Table AI authoring IR.',
    'Local code will compile your authoring IR into canonical Workflow IR v2 and then run structural and semantic validation.',
    'Return JSON only. Do not use markdown fences.',
    'Do not return canonical Workflow IR v2, Blockly data, workflow envelopes, or step IDs.',
    'Never emit canonical { "kind": "call" }, { "kind": "column" }, { "kind": "value" }, or { "kind": "caseValue" } nodes directly. Use the authoring shapes below.',
    workflowContextNote,
    draftSemanticsNote,
    '',
    'Response contract:',
    '- mode: "clarify" or "draft"',
    '- msg: short natural-language summary',
    '- ass: array of short strings',
    '- steps: ordered authoring steps',
    '- Always include all four fields.',
    '- Use steps: [] only when mode is "clarify".',
    '- Never return mode "draft" with an empty steps array.',
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
    'Default fill-color word map (use exact palette hex values):',
    '- white -> #FFFFFF',
    '- green -> #C6EFCE',
    '- yellow -> #FFEB9C',
    '- orange -> #F4B183',
    '- red -> #FFC7CE',
    '- purple -> #D9C2E9',
    '- blue -> #BDD7EE',
    '- If the user asks for a named color, emit the mapped hex exactly. Do not substitute another color.',
    '',
    'Authoring operands:',
    '- column operand: { "source": "column", "columnId": "col_x" }',
    '- scoped current-cell operand: { "source": "value" }',
    '- current match subject operand: { "source": "caseValue" }',
    '- literal operand: { "source": "literal", "value": "text" | 123 | true | false | null }',
    '- Use { "source": "value" } only inside scopedRule conditions and cell patch values.',
    '- Use { "source": "caseValue" } only inside match.cases[*].when and match.cases[*].then.',
    '',
    'Value expression shapes:',
    '- nullary: { "kind": "nullary", "op": "now" }',
    '- unary: { "kind": "unary", "op": "trim"|"lower"|"upper"|"toNumber"|"toString"|"toBoolean"|"collapseWhitespace"|"first"|"last"|"round"|"floor"|"ceil"|"abs", "input": <value expression> }',
    '- binary: { "kind": "binary", "op": "split"|"atIndex"|"extractRegex"|"add"|"subtract"|"multiply"|"divide"|"modulo"|"datePart", "left": <value expression>, "right": <value expression> }',
    '- ternary: { "kind": "ternary", "op": "substring"|"replace"|"replaceRegex"|"dateDiff"|"dateAdd", "first": <value expression>, "second": <value expression>, "third": <value expression> }',
    '- nary: { "kind": "nary", "op": "concat"|"coalesce", "items": [<value expression>, ...] }',
    '- match: { "kind": "match", "subject": <value expression>, "cases": [{ "kind": "when", "when": <boolean expression>, "then": <value expression> }, { "kind": "otherwise", "then": <value expression> }] }',
    '',
    'Boolean expression shapes:',
    '- predicate: { "kind": "predicate", "op": "isEmpty", "input": <value expression> }',
    '- compare: { "kind": "compare", "op": "eq"|"gt"|"lt"|"gte"|"lte"|"contains"|"startsWith"|"endsWith"|"matchesRegex", "left": <value expression>, "right": <value expression> }',
    '- between: { "kind": "between", "input": <value expression>, "min": <value expression>, "max": <value expression>, "inclusiveMin": true|false, "inclusiveMax": true|false }',
    '- boolean group: { "kind": "boolean", "op": "and"|"or", "items": [<boolean expression>, ...] }',
    '- boolean not: { "kind": "boolean", "op": "not", "item": <boolean expression> }',
    '',
    'Operator input type requirements (critical):',
    '- String-like means logical type string or unknown. Number-like means logical type number or unknown.',
    '- trim/lower/upper/collapseWhitespace require string-like input.',
    '- toNumber/toString/toBoolean require scalar input.',
    '- first/last require a string-like input or a list input.',
    '- split requires (string-like text, string-like delimiter).',
    '- atIndex requires (string-like or list input, number-like index).',
    '- extractRegex requires (string-like text, string-like pattern).',
    '- substring requires (string-like text, number-like start, number-like length).',
    '- replace and replaceRegex require three string-like inputs.',
    '- add/subtract/multiply/divide/modulo require number-like left and right inputs.',
    '- round/floor/ceil/abs require a number-like input.',
    '- datePart requires (date/datetime/string-like value, string-like unit literal).',
    '- dateDiff requires (date/datetime/string-like left, date/datetime/string-like right, string-like unit literal).',
    '- dateAdd requires (date/datetime/string-like value, number-like amount, string-like unit literal).',
    '- isEmpty requires scalar input. not requires boolean-like input. and/or require boolean-like inputs.',
    '- eq requires comparable scalar inputs. gt/lt/gte/lte/between require comparable ordered scalar inputs.',
    '- contains/startsWith/endsWith/matchesRegex require string-like inputs.',
    '- concat requires at least two scalar inputs. coalesce requires one or more scalar items of one compatible non-mixed type.',
    '',
    'Operator literal and behavior specifics (critical):',
    '- datePart unit literals are singular: "year", "month", "day", "dayOfWeek", "hour", "minute", "second".',
    '- dateDiff and dateAdd duration unit literals are plural: "years", "months", "days", "hours", "minutes", "seconds".',
    '- For account age in days, use dateDiff(now(), <signup date>, "days"). Do not use "day" for dateDiff.',
    '- dateDiff(a, b, unit) returns a - b. For elapsed age since a past date, put now() first and the past date second.',
    '- substring(text, start, length) uses a zero-based start and a length, not an end index.',
    '- atIndex(textOrList, index) uses a zero-based index.',
    '- replace uses exact literal text. replaceRegex, extractRegex, and matchesRegex use regex pattern strings.',
    '- concat joins values with no separator. Include literal separators like " " when needed.',
    '- coalesce is always nary: { "kind": "nary", "op": "coalesce", "items": [a, b, ...] }. Never emit coalesce as kind "unary", "binary", or "ternary".',
    '- coalesce selects the first value that is not null and not "". Use match/isEmpty on trimmed values when whitespace-only strings should count as missing.',
    '- contains, startsWith, endsWith, and matchesRegex are case-sensitive. Normalize with lower(...) when matching case-insensitively.',
    '',
    'Rules:',
    '- First, inspect "Schema currently available to the returned steps" and ground every referenced input/source column against that list before drafting.',
    '- Use only columns that are listed in the current schema, plus new columns that you derive earlier in your own steps.',
    '- Use column ids exactly as provided.',
    '- Keep steps in execution order.',
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
    '- Use match for exclusive classification and bucketing. Match is ordered and first-match-wins.',
    '- Use scopedRule for cumulative cell rewrite behavior. Multiple scopedRule cases may apply in order to the evolving current cell value.',
    '- scopedRule uses { "source": "value" }. match case conditions and result expressions may use { "source": "caseValue" }. Do not mix them up.',
    '- For regex patterns in JSON string literals, double-escape backslashes for JSON serialization. Example: \\d+ must appear as "\\\\d+".',
    '',
    'Schema currently available to the returned steps:',
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

export function buildRepairUserMessage(
  previousRawText: string,
  issues: AIRepairIssueSummary[],
  context: AIPromptContext,
) {
  const availableSchemaLines = getAvailableSchemaPromptLines(context);

  return [
    'Your previous draft did not validate locally.',
    'Rewrite the FULL authoring step list so it satisfies these issues.',
    'Return JSON only with keys: mode, msg, ass, steps.',
    'Return authoring IR only. Do not return canonical Workflow IR v2, canonical call nodes, or step IDs.',
    'Use authoring operands only: { "source": "column" }, { "source": "value" }, { "source": "caseValue" }, { "source": "literal" }.',
    'Use authoring value kinds only: nullary, unary, binary, ternary, nary, match.',
    'Use authoring boolean kinds only: predicate, compare, between, boolean.',
    'Use this exact fill-color word map: white=#FFFFFF, green=#C6EFCE, yellow=#FFEB9C, orange=#F4B183, red=#FFC7CE, purple=#D9C2E9, blue=#BDD7EE.',
    'If the user asks for a named color, emit the mapped hex exactly.',
    'datePart units are singular: year, month, day, dayOfWeek, hour, minute, second.',
    'dateDiff/dateAdd units are plural: years, months, days, hours, minutes, seconds. For account age in days, use dateDiff(now(), <signup date>, "days").',
    'dateDiff(a, b, unit) returns a - b; put now() first and the past date second for elapsed age.',
    'substring uses zero-based start plus length. atIndex uses a zero-based index.',
    'replace uses literal exact text; replaceRegex, extractRegex, and matchesRegex use regex pattern strings.',
    'concat has no separator unless you include a literal separator.',
    'coalesce is always nary: { "kind": "nary", "op": "coalesce", "items": [a, b, ...] }. Never emit coalesce as kind "unary", "binary", or "ternary".',
    'coalesce checks null/empty-string, not whitespace-only strings. Use match/isEmpty on trimmed values for whitespace fallback.',
    'Preserve or add concise comment steps when the implementation has multiple phases.',
    'Use { "source": "value" } only inside scopedRule conditions and cell patch values.',
    'Use { "source": "caseValue" } only inside match.cases[*].when and match.cases[*].then.',
    'Check the listed schema columns before drafting. Use only listed schema columns plus columns derived earlier in the workflow.',
    'If a workflow must fill from a fallback column and then normalize the final result, use separate sequential steps. Do not rely on scopedRule.defaultPatch after a matched fallback case.',
    'If the user explicitly names a column like Phone or Email (2), use that exact provided column id.',
    'If the original request depends on a source column that is not listed in the current schema, do not substitute a different column just because it seems similar.',
    'If the user names match outputs like "email", "sms", and "none", include those named outputs explicitly.',
    'Do not ask a clarification question in this repair turn. Return mode "draft".',
    'Return at least one step.',
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
