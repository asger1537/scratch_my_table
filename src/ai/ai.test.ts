import { describe, expect, it, vi } from 'vitest';

import {
  assignWorkflowStepIds,
  buildDraftPreviewWorkflow,
  buildGeminiRequestExport,
  buildGeminiSystemInstruction,
  buildRepairUserMessage,
  formatDraftStepsForDebug,
  generateGeminiDraftTurn,
  parseGeminiAuthoringResponse,
  replaceWorkflowSteps,
  runGeminiDraftTurn,
  type AISettings,
  type AIPromptContext,
} from './index';
import type { Table } from '../domain/model';
import type { Workflow, WorkflowValidationIssue } from '../workflow';
import { evaluateDraftQuality } from './evaluateDraftQuality';

describe('AI workflow copilot helpers', () => {
  it('builds prompt context for authoring IR without leaking raw row values', () => {
    const context = createPromptContext();
    const instruction = buildGeminiSystemInstruction(context);

    expect(instruction).toContain('Translate the user request into the Scratch My Table AI authoring IR.');
    expect(instruction).toContain('steps: ordered authoring steps');
    expect(instruction).toContain('Authoring operands:');
    expect(instruction).toContain('{ "source": "value" }');
    expect(instruction).toContain('{ "source": "caseValue" }');
    expect(instruction).toContain('"kind": "match"');
    expect(instruction).toContain('replaceRegex');
    expect(instruction).toContain('Use explicit casts like toString(...) or toNumber(...) when mixed columns need text or numeric treatment.');
    expect(instruction).toContain('Operator input type requirements (critical):');
    expect(instruction).toContain('trim/lower/upper/collapseWhitespace require string-like input.');
    expect(instruction).toContain('Operator literal and behavior specifics (critical):');
    expect(instruction).toContain('datePart unit literals are singular: "year", "month", "day", "dayOfWeek", "hour", "minute", "second".');
    expect(instruction).toContain('dateDiff and dateAdd duration unit literals are plural: "years", "months", "days", "hours", "minutes", "seconds".');
    expect(instruction).toContain('For account age in days, use dateDiff(now(), <signup date>, "days"). Do not use "day" for dateDiff.');
    expect(instruction).toContain('dateDiff(a, b, unit) returns a - b. For elapsed age since a past date, put now() first and the past date second.');
    expect(instruction).toContain('substring(text, start, length) uses a zero-based start and a length, not an end index.');
    expect(instruction).toContain('replace uses exact literal text. replaceRegex, extractRegex, and matchesRegex use regex pattern strings.');
    expect(instruction).toContain('concat joins values with no separator. Include literal separators like " " when needed.');
    expect(instruction).toContain('coalesce requires one or more scalar items of one compatible non-mixed type.');
    expect(instruction).toContain('coalesce is always nary: { "kind": "nary", "op": "coalesce", "items": [a, b, ...] }. Never emit coalesce as kind "unary", "binary", or "ternary".');
    expect(instruction).toContain('Use match/isEmpty on trimmed values when whitespace-only strings should count as missing.');
    expect(instruction).toContain('contains, startsWith, endsWith, and matchesRegex are case-sensitive.');
    expect(instruction).toContain('Comment guidance:');
    expect(instruction).toContain('Add concise comment steps to explain non-trivial implementations.');
    expect(instruction).toContain('For requests with 3 or more distinct goals or phases, include a short comment before each major phase.');
    expect(instruction).toContain('Longer workflows should usually have 2 to 5 comment steps, not just one comment at the start.');
    expect(instruction).toContain('Typical phases are normalize/fill, derive/classify, format/highlight, cleanup/drop, and filter/sort.');
    expect(instruction).toContain('For multi-step implementations, include concise comment steps so the workflow stays readable and the phase boundaries are obvious in the editor.');
    expect(instruction).toContain('"type":"comment"');
    expect(instruction).toContain('Normalize contact fields.');
    expect(instruction).toContain('Derive contact method.');
    expect(instruction).toContain('Drop helpers and filter rows.');
    expect(instruction).toContain('Default fill-color word map (use exact palette hex values):');
    expect(instruction).toContain('- red -> #FFC7CE');
    expect(instruction).toContain('In scopedRule, every expression in cases/defaultPatch must be valid for every targeted column in columnIds.');
    expect(instruction).toContain('If you must fill from a fallback column and then normalize or further transform the final result, use separate sequential steps.');
    expect(instruction).toContain('If the user explicitly names a column like Phone or Email (2), use that exact provided column id');
    expect(instruction).toContain('First, inspect "Schema currently available to the returned steps" and ground every referenced input/source column against that list before drafting.');
    expect(instruction).toContain('If the request depends on an input/source column that is not listed in the current schema, return mode "clarify" and ask which listed column to use.');
    expect(instruction).toContain('If the user names match outputs like return "email", return "sms", and return "none"');
    expect(instruction).not.toContain('fill_empty_from_col');
    expect(instruction).not.toContain('normalize_text_col');
    expect(instruction).not.toContain('alice@example.com');
  });

  it('includes live workspace issues when using the last valid workflow snapshot', () => {
    const context = createPromptContext();

    context.workflowContextSource = 'lastValidSnapshot';
    context.currentIssues = [
      {
        code: 'missingColumns',
        message: "Block 'scoped_rule_cases_step' must target at least one column.",
      },
    ];

    const instruction = buildGeminiSystemInstruction(context);

    expect(instruction).toContain('last valid snapshot');
    expect(instruction).toContain('Current block workspace snapshot:');
    expect(instruction).toContain("missingColumns: Block 'scoped_rule_cases_step' must target at least one column.");
    expect(instruction).toContain('"type": "scoped_rule_cases_step"');
  });

  it('builds a replayable Gemini request export without structured-output schema by default', () => {
    const context = createPromptContext();
    const settings = createAISettings();
    const userMessage = {
      role: 'user' as const,
      text: 'Normalize the email column.',
      timestamp: '2026-03-31T09:00:00.000Z',
    };

    const requestExport = buildGeminiRequestExport({
      settings,
      context,
      userMessage,
      phase: 'initial',
    });

    expect(requestExport.requestBody.generationConfig.maxOutputTokens).toBe(16_384);
    expect(requestExport.requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(requestExport.requestBody.generationConfig.temperature).toBe(0);
    expect(requestExport.requestBody.generationConfig.responseMimeType).toBeUndefined();
    expect(requestExport.requestBody.generationConfig.responseJsonSchema).toBeUndefined();
    expect(requestExport.requestBody.generationConfig).toEqual(
      expect.objectContaining({
        temperature: 0,
        maxOutputTokens: 16_384,
      }),
    );
    expect(JSON.stringify(requestExport)).not.toContain(settings.apiKey);
  });

  it('includes structured-output fields only when an explicit schema override is provided', () => {
    const context = createPromptContext();
    const settings = createAISettings();
    const userMessage = {
      role: 'user' as const,
      text: 'Normalize the email column.',
      timestamp: '2026-03-31T09:00:00.000Z',
    };
    const schemaOverride = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['clarify', 'draft'] },
      },
      required: ['mode'],
    };

    const requestExport = buildGeminiRequestExport(
      {
        settings,
        context,
        userMessage,
        phase: 'initial',
      },
      {
        responseJsonSchema: schemaOverride,
      },
    );

    expect(requestExport.requestBody.generationConfig.responseMimeType).toBe('application/json');
    expect(requestExport.requestBody.generationConfig.responseJsonSchema).toEqual(schemaOverride);
  });

  it('builds repair prompts for authoring IR', () => {
    const context = createPromptContext();

    const repairMessage = buildRepairUserMessage(
      '{"mode":"draft","msg":"Draft.","ass":[],"steps":[{"type":"deriveColumn","newColumn":{"columnId":"col_priority_score","displayName":"Priority Score"},"derive":{"kind":"match","subject":{"kind":"unary","op":"toNumber","input":{"source":"column","columnId":"col_balance"}},"cases":[{"kind":"when","when":{"kind":"compare","op":"gteish","left":{"source":"caseValue"},"right":{"source":"literal","value":0}},"then":{"source":"literal","value":2}}]}}]}',
      [
        {
          code: 'authoringUnsupportedOp',
          path: 'steps[0].derive.cases[0].when.op',
          message: "Unsupported compare op 'gteish'.",
        },
      ],
      context,
    );

    expect(repairMessage).toContain('Return JSON only with the same mode shape as the previous invalid response: draft uses mode/msg/ass/steps; workflowSetDraft uses mode/msg/ass/applyMode/workflows/runOrderWorkflowIds.');
    expect(repairMessage).toContain('Return authoring IR only.');
    expect(repairMessage).toContain('Use authoring value kinds only: nullary, unary, binary, ternary, nary, match.');
    expect(repairMessage).toContain('Use { "source": "caseValue" } only inside match.cases[*].when and match.cases[*].then.');
    expect(repairMessage).toContain('datePart units are singular: year, month, day, dayOfWeek, hour, minute, second.');
    expect(repairMessage).toContain('dateDiff/dateAdd units are plural: years, months, days, hours, minutes, seconds. For account age in days, use dateDiff(now(), <signup date>, "days").');
    expect(repairMessage).toContain('dateDiff(a, b, unit) returns a - b; put now() first and the past date second for elapsed age.');
    expect(repairMessage).toContain('substring uses zero-based start plus length. atIndex uses a zero-based index.');
    expect(repairMessage).toContain('replace uses literal exact text; replaceRegex, extractRegex, and matchesRegex use regex pattern strings.');
    expect(repairMessage).toContain('concat has no separator unless you include a literal separator.');
    expect(repairMessage).toContain('coalesce is always nary: { "kind": "nary", "op": "coalesce", "items": [a, b, ...] }. Never emit coalesce as kind "unary", "binary", or "ternary".');
    expect(repairMessage).toContain('coalesce checks null/empty-string, not whitespace-only strings. Use match/isEmpty on trimmed values for whitespace fallback.');
    expect(repairMessage).toContain('Preserve or add concise comment steps when the implementation has multiple phases.');
    expect(repairMessage).toContain('Check the listed schema columns before drafting. Use only listed schema columns plus columns derived earlier in the workflow.');
    expect(repairMessage).toContain('If a workflow must fill from a fallback column and then normalize the final result, use separate sequential steps.');
    expect(repairMessage).toContain('If the user explicitly names a column like Phone or Email (2), use that exact provided column id.');
    expect(repairMessage).toContain('If the original request depends on a source column that is not listed in the current schema, do not substitute a different column just because it seems similar.');
    expect(repairMessage).toContain('If the user names match outputs like "email", "sms", and "none", include those named outputs explicitly.');
    expect(repairMessage).not.toContain('fill_empty_from_col');
    expect(repairMessage).toContain('- col_email | Email | string');
  });

  it('flags task-quality issues for missing phases, missing named branches, wrong column grounding, and compressed fallback normalization', () => {
    const qualityIssues = evaluateDraftQuality({
      context: createPromptContext(),
      userText: [
        'Goal 1: Normalize the primary Email column. If Email is empty or whitespace, fall back to Email (2). Then trim it and lowercase it.',
        'Goal 2: Normalize the Phone column by removing spaces, dashes, parentheses, and other non-digit characters.',
        'Goal 3: Derive a new column called Preferred Contact Method using a match:',
        'return "email" if the final Email contains @',
        'return "sms" if there is no usable email but Phone has 10 digits',
        'return "none" otherwise',
        'Goal 6: Drop helper columns like Email (2) once they are no longer needed.',
        'Goal 7: Filter rows to keep only customers where Preferred Contact Method is not "none".',
      ].join('\n'),
      steps: assignWorkflowStepIds([
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
        {
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_preferred_contact_method',
            displayName: 'Preferred Contact Method',
          },
          expression: {
            kind: 'match',
            subject: {
              kind: 'column',
              columnId: 'col_email',
            },
            cases: [
              {
                kind: 'when',
                when: {
                  kind: 'call',
                  name: 'contains',
                  args: [
                    { kind: 'caseValue' },
                    { kind: 'literal', value: '@' },
                  ],
                },
                then: { kind: 'literal', value: 'email' },
              },
              {
                kind: 'otherwise',
                then: { kind: 'literal', value: 'none' },
              },
            ],
          },
        },
      ]),
    });

    expect(qualityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'taskQualityFallbackThenNormalizeCompressed' }),
        expect.objectContaining({ code: 'taskQualityPromptColumnMentionedButUnused' }),
        expect.objectContaining({ code: 'taskQualityNamedBranchMissing' }),
        expect.objectContaining({ code: 'taskQualityPhaseMissing' }),
      ]),
    );
  });

  it('does not treat row-dropping language as a missing dropColumns phase', () => {
    const qualityIssues = evaluateDraftQuality({
      context: createPromptContext(),
      userText: 'Drop rows where VIP is not true.',
      steps: assignWorkflowStepIds([
        {
          type: 'filterRows',
          mode: 'drop',
          condition: {
            kind: 'call',
            name: 'not',
            args: [
              {
                kind: 'call',
                name: 'equals',
                args: [
                  { kind: 'column', columnId: 'col_vip' },
                  { kind: 'literal', value: true },
                ],
              },
            ],
          },
        },
      ]),
    });

    expect(qualityIssues.filter((issue) => issue.code === 'taskQualityPhaseMissing')).toEqual([]);
  });

  it('still treats explicit known-column dropping as a missing dropColumns phase', () => {
    const qualityIssues = evaluateDraftQuality({
      context: createPromptContext(),
      userText: 'After filling the main email, drop Email (2).',
      steps: assignWorkflowStepIds([
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
      ]),
    });

    expect(qualityIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'taskQualityPhaseMissing',
          details: expect.objectContaining({
            missingPhases: expect.arrayContaining(['drop columns']),
          }),
        }),
      ]),
    );
  });

  it('parses clarify and draft authoring responses and rejects malformed payloads', () => {
    expect(
      parseGeminiAuthoringResponse('{"mode":"clarify","msg":"Which email column should I use?","ass":[],"steps":[]}'),
    ).toEqual({
      mode: 'clarify',
      msg: 'Which email column should I use?',
      ass: [],
      steps: [],
    });

    expect(
      parseGeminiAuthoringResponse(
        '```json\n{"mode":"draft","msg":"Done.","ass":[],"steps":[{"type":"dropColumns","columnIds":["col_email_2"]}]}\n```',
      ),
    ).toEqual({
      mode: 'draft',
      msg: 'Done.',
      ass: [],
      steps: [{ type: 'dropColumns', columnIds: ['col_email_2'] }],
    });

    expect(
      parseGeminiAuthoringResponse(
        '{"mode":"workflowSetDraft","msg":"Split it.","ass":[],"applyMode":"append","workflows":[{"workflowId":"wf_prepare","name":"Prepare","steps":[{"type":"comment","text":"Prepare data."}]}],"runOrderWorkflowIds":["wf_prepare"]}',
      ),
    ).toEqual({
      mode: 'workflowSetDraft',
      msg: 'Split it.',
      ass: [],
      applyMode: 'append',
      workflows: [
        {
          workflowId: 'wf_prepare',
          name: 'Prepare',
          steps: [{ type: 'comment', text: 'Prepare data.' }],
        },
      ],
      runOrderWorkflowIds: ['wf_prepare'],
    });

    expect(() => parseGeminiAuthoringResponse('{"mode":"maybe","msg":"Done.","ass":[],"steps":[]}')).toThrow(
      'Gemini response must include mode "clarify", "draft", or "workflowSetDraft".',
    );
    expect(() => parseGeminiAuthoringResponse('{"mode":"clarify","msg":"   ","ass":[],"steps":[]}')).toThrow(
      'Gemini response must include a non-empty msg string.',
    );
    expect(() => parseGeminiAuthoringResponse('{"mode":"clarify","msg":"Done.","steps":[]}')).toThrow(
      'Gemini response must include ass as a string array.',
    );
    expect(() => parseGeminiAuthoringResponse('{"mode":"draft","msg":"Missing steps","ass":[],"steps":[]}')).toThrow(
      'Gemini draft responses must include a non-empty steps array.',
    );
  });

  it('lets Gemini decide whether to clarify when a named prompt column is absent from the schema', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'clarify',
            msg: 'I can’t find a Phone column in the current schema. Which existing column should I use instead?',
            ass: [],
            steps: [],
          }),
        ),
      );
    const validateCandidateWorkflow = vi.fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>();

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContextWithoutPhone(),
      userText: [
        'Goal 1: Normalize the primary Email column. If Email is empty or whitespace, fall back to Email (2). Then trim it and lowercase it.',
        'Goal 2: Normalize the Phone column by removing spaces, dashes, parentheses, and other non-digit characters.',
      ].join('\n'),
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(validateCandidateWorkflow).not.toHaveBeenCalled();
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'clarify',
        repaired: false,
        assistantMessage: expect.objectContaining({
          text: expect.stringContaining('Phone column'),
        }),
        debugTrace: expect.objectContaining({
          initialValidationIssues: [],
        }),
      }),
    );
  });

  it('generates and compiles valid authoring drafts from Gemini', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'Create priority score.',
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
                      kind: 'otherwise',
                      then: { source: 'literal', value: 1 },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      );

    const result = await generateGeminiDraftTurn(
      {
        settings: createAISettings(),
        context: createPromptContext(),
        userMessage: {
          role: 'user',
          text: 'Add a score column.',
          timestamp: '2026-03-31T09:00:00.000Z',
        },
        phase: 'initial',
      },
      fetchFn,
    );

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.response).toEqual(
      expect.objectContaining({
        mode: 'draft',
        msg: 'Create priority score.',
      }),
    );
    expect(result.compilationIssues).toEqual([]);
    expect(result.compiledDraft).toEqual({
      kind: 'singleWorkflow',
      steps: [
        expect.objectContaining({
          type: 'deriveColumn',
        }),
      ],
    });
  });

  it('compiles authoring drafts with scopedRule normalization, dropColumns, and filterRows into canonical steps', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'Clean and filter email.',
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
          }),
        ),
      );

    const result = await generateGeminiDraftTurn(
      {
        settings: createAISettings(),
        context: createPromptContext(),
        userMessage: {
          role: 'user',
          text: 'Fallback email, normalize, and keep rows with @.',
          timestamp: '2026-03-31T09:00:00.000Z',
        },
        phase: 'initial',
      },
      fetchFn,
    );

    expect(result.compilationIssues).toEqual([]);
    expect(result.compiledDraft).toEqual({
      kind: 'singleWorkflow',
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
      {
        type: 'dropColumns',
        columnIds: ['col_email_2'],
      },
      {
        type: 'filterRows',
        mode: 'keep',
        condition: {
          kind: 'call',
          name: 'contains',
          args: [
            { kind: 'column', columnId: 'col_email' },
            { kind: 'literal', value: '@' },
          ],
        },
        },
      ],
    });
  });

  it('logs request export and raw API error payload when Gemini rejects the request', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createGeminiErrorResponse('Request contains an invalid argument.'));
    const events: Array<Record<string, unknown>> = [];

    await expect(
      generateGeminiDraftTurn(
        {
          settings: createAISettings(),
          context: createPromptContext(),
          userMessage: {
            role: 'user',
            text: 'Add a priority score.',
            timestamp: '2026-03-31T09:00:00.000Z',
          },
          phase: 'initial',
          onLogEvent: (event) => {
            events.push(event as unknown as Record<string, unknown>);
          },
        },
        fetchFn,
      ),
    ).rejects.toThrow('Request contains an invalid argument.');

    const requestStartedEvent = events.find((event) => event.kind === 'request_started');
    const requestFailedEvent = events.find((event) => event.kind === 'request_failed');

    expect(requestStartedEvent?.requestExport).toEqual(
      expect.objectContaining({
        phase: 'initial',
        model: 'gemini-2.5-flash',
        requestBody: expect.any(Object),
      }),
    );
    expect(JSON.stringify(requestStartedEvent?.requestExport ?? {})).not.toContain('test-key');
    expect(requestFailedEvent).toEqual(
      expect.objectContaining({
        error: 'Request contains an invalid argument.',
        statusCode: 400,
      }),
    );
  });

  it('routes authoring compile errors into repair before canonical workflow validation', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'First attempt.',
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
                        op: 'gteish',
                        left: { source: 'caseValue' },
                        right: { source: 'literal', value: 0 },
                      },
                      then: { source: 'literal', value: 2 },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'I corrected the match conditions.',
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
          }),
        ),
      );
    const validateCandidateWorkflow = vi.fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>().mockResolvedValueOnce([]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Add a priority score.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(validateCandidateWorkflow).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: true,
        debugTrace: expect.objectContaining({
          initialCompilationIssues: [
            expect.objectContaining({
              code: 'authoringUnsupportedOp',
            }),
          ],
          repairAttempts: [
            expect.objectContaining({
              compilationIssues: [],
            }),
          ],
        }),
      }),
    );
  });

  it('validates compiled drafts as full workflow replacements and repairs semantic validation failures', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'First attempt.',
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
                      value: { source: 'column', columnId: 'col_missing' },
                    },
                  },
                ],
              },
              {
                type: 'dropColumns',
                columnIds: ['col_email_2'],
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'I fixed the source column.',
            ass: ['Using Email (2) as fallback.'],
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
          }),
        ),
      );
    const validateCandidateWorkflow = vi
      .fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing' does not exist.",
          path: 'steps[0].cases[0].then.value.columnId',
          phase: 'semantic',
        },
      ])
      .mockResolvedValueOnce([]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Use Email (2) as fallback then drop it.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(validateCandidateWorkflow).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: true,
        draft: expect.objectContaining({
          assumptions: ['Using Email (2) as fallback.'],
          steps: [
            expect.objectContaining({
              id: 'step_scoped_rule_1',
              type: 'scopedRule',
            }),
            expect.objectContaining({
              id: 'step_drop_columns_1',
              type: 'dropColumns',
            }),
          ],
        }),
      }),
    );
  });

  it('can recover after a second repair attempt and targets the first repair raw response', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createGeminiResponse(createEmailFallbackResponse('Initial invalid fallback.', 'col_missing_initial')))
      .mockResolvedValueOnce(createGeminiResponse(createEmailFallbackResponse('Repair one is still invalid.', 'col_missing_repair_one')))
      .mockResolvedValueOnce(createGeminiResponse(createEmailFallbackResponse('Repair two fixed the fallback.', 'col_email_2')));
    const validateCandidateWorkflow = vi
      .fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing_initial' does not exist.",
          path: 'steps[0].cases[0].then.value.columnId',
          phase: 'semantic',
          stepId: 'step_scoped_rule_1',
          details: { columnId: 'col_missing_initial' },
        },
      ])
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing_repair_one' does not exist.",
          path: 'steps[0].cases[0].then.value.columnId',
          phase: 'semantic',
          stepId: 'step_scoped_rule_1',
          details: { columnId: 'col_missing_repair_one' },
        },
      ])
      .mockResolvedValueOnce([]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Use Email (2) as fallback then drop it.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(validateCandidateWorkflow).toHaveBeenCalledTimes(3);
    const repairTwoRequest = JSON.stringify(JSON.parse(fetchFn.mock.calls[2][1]?.body as string));
    expect(repairTwoRequest).toContain('Repair one is still invalid.');
    expect(repairTwoRequest).toContain('col_missing_repair_one');
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: true,
        debugTrace: expect.objectContaining({
          repairAttempts: [
            expect.objectContaining({
              attempt: 1,
              validationIssues: [
                expect.objectContaining({
                  code: 'missingColumn',
                }),
              ],
            }),
            expect.objectContaining({
              attempt: 2,
              validationIssues: [],
            }),
          ],
        }),
      }),
    );
  });

  it('returns the final repair issues after both repair attempts fail', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createGeminiResponse(createEmailFallbackResponse('Initial invalid fallback.', 'col_missing_initial')))
      .mockResolvedValueOnce(createGeminiResponse(createEmailFallbackResponse('Repair one is invalid.', 'col_missing_repair_one')))
      .mockResolvedValueOnce(createGeminiResponse(createEmailFallbackResponse('Repair two is invalid.', 'col_missing_repair_two')));
    const validateCandidateWorkflow = vi
      .fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing_initial' does not exist.",
          path: 'steps[0].cases[0].then.value.columnId',
          phase: 'semantic',
          stepId: 'step_scoped_rule_1',
          details: { columnId: 'col_missing_initial' },
        },
      ])
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing_repair_one' does not exist.",
          path: 'steps[0].cases[0].then.value.columnId',
          phase: 'semantic',
          stepId: 'step_scoped_rule_1',
          details: { columnId: 'col_missing_repair_one' },
        },
      ])
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing_repair_two' does not exist.",
          path: 'steps[0].cases[0].then.value.columnId',
          phase: 'semantic',
          stepId: 'step_scoped_rule_1',
          details: { columnId: 'col_missing_repair_two' },
        },
      ]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Use Email (2) as fallback then drop it.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(validateCandidateWorkflow).toHaveBeenCalledTimes(3);
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'invalidDraft',
        repaired: true,
        validationIssues: [
          expect.objectContaining({
            message: expect.stringContaining('col_missing_repair_two'),
          }),
        ],
        debugTrace: expect.objectContaining({
          repairAttempts: [
            expect.objectContaining({ attempt: 1 }),
            expect.objectContaining({
              attempt: 2,
              validationIssues: [
                expect.objectContaining({
                  message: expect.stringContaining('col_missing_repair_two'),
                }),
              ],
            }),
          ],
        }),
      }),
    );
  });

  it('routes task-quality issues into repair even when canonical validation passes', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'First attempt.',
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
          }),
        ),
      )
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'draft',
            msg: 'I split fallback and normalization into separate steps.',
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
          }),
        ),
      );
    const validateCandidateWorkflow = vi.fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Make Email use Email (2) when empty, then trim and lowercase the final Email, drop Email (2), then keep only rows where Email contains @.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(validateCandidateWorkflow).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: true,
        debugTrace: expect.objectContaining({
          initialValidationIssues: [
            expect.objectContaining({
              code: 'taskQualityFallbackThenNormalizeCompressed',
            }),
          ],
        }),
        draft: expect.objectContaining({
          steps: [
            expect.objectContaining({ type: 'scopedRule' }),
            expect.objectContaining({ type: 'scopedRule' }),
            expect.objectContaining({ type: 'dropColumns' }),
            expect.objectContaining({ type: 'filterRows' }),
          ],
        }),
      }),
    );
  });

  it('validates workflowSetDraft responses through the sequence-aware workflow-set callback', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          JSON.stringify({
            mode: 'workflowSetDraft',
            msg: 'Split contact cleanup into prepare and filter workflows.',
            ass: [],
            applyMode: 'append',
            workflows: [
              {
                workflowId: 'wf_prepare_contacts',
                name: 'Prepare contacts',
                steps: [
                  {
                    type: 'deriveColumn',
                    newColumn: {
                      columnId: 'col_email_clean',
                      displayName: 'Email Clean',
                    },
                    derive: {
                      kind: 'unary',
                      op: 'lower',
                      input: {
                        kind: 'unary',
                        op: 'trim',
                        input: { source: 'column', columnId: 'col_email' },
                      },
                    },
                  },
                ],
              },
              {
                workflowId: 'wf_filter_contacts',
                name: 'Filter contacts',
                steps: [
                  {
                    type: 'filterRows',
                    mode: 'keep',
                    where: {
                      kind: 'compare',
                      op: 'contains',
                      left: { source: 'column', columnId: 'col_email_clean' },
                      right: { source: 'literal', value: '@' },
                    },
                  },
                ],
              },
            ],
            runOrderWorkflowIds: ['wf_prepare_contacts', 'wf_filter_contacts'],
          }),
        ),
      );
    const validateCandidateWorkflow = vi.fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>();
    const validateCandidateWorkflowSet = vi.fn<(_workflows: Workflow[], _runOrderWorkflowIds: string[]) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Split this into contact preparation and contact filtering workflows, and append them.',
      validateCandidateWorkflow,
      validateCandidateWorkflowSet,
      fetchFn,
    });

    expect(validateCandidateWorkflow).not.toHaveBeenCalled();
    expect(validateCandidateWorkflowSet).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          workflowId: 'wf_prepare_contacts',
          steps: [
            expect.objectContaining({
              id: 'step_derive_column_1',
              type: 'deriveColumn',
            }),
          ],
        }),
        expect.objectContaining({
          workflowId: 'wf_filter_contacts',
          steps: [
            expect.objectContaining({
              id: 'step_filter_rows_1',
              type: 'filterRows',
            }),
          ],
        }),
      ],
      ['wf_prepare_contacts', 'wf_filter_contacts'],
    );
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        draft: expect.objectContaining({
          kind: 'workflowSet',
          applyMode: 'append',
          runOrderWorkflowIds: ['wf_prepare_contacts', 'wf_filter_contacts'],
        }),
      }),
    );
  });

  it('builds draft preview workflows from compiled canonical drafts and formats debug JSON', () => {
    const currentWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_preview_current',
      name: 'Current workflow',
      description: 'Uses the current workflow context.',
      steps: [
        {
          id: 'step_comment_1',
          type: 'comment',
          text: 'Old step',
        },
      ],
    };
    const lastValidWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_preview_last_valid',
      name: 'Last valid workflow',
      description: 'Fallback workflow snapshot.',
      steps: [
        {
          id: 'step_drop_columns_1',
          type: 'dropColumns',
          columnIds: ['col_status'],
        },
      ],
    };
    const draft = {
      kind: 'singleWorkflow' as const,
      assistantMessage: 'Replace the workflow with a filter.',
      assumptions: ['Using the known email column.'],
      validationIssues: [],
      steps: assignWorkflowStepIds([
        {
          type: 'filterRows',
          mode: 'drop',
          condition: {
            kind: 'call',
            name: 'isEmpty',
            args: [{ kind: 'column', columnId: 'col_email' }],
          },
        },
      ]),
    };

    expect(buildDraftPreviewWorkflow(currentWorkflow, draft)).toEqual({
      ...currentWorkflow,
      steps: draft.steps,
    });
    expect(buildDraftPreviewWorkflow(lastValidWorkflow, draft)).toEqual({
      ...lastValidWorkflow,
      steps: draft.steps,
    });
    expect(buildDraftPreviewWorkflow(currentWorkflow, null)).toBeNull();
    expect(buildDraftPreviewWorkflow(null, draft)).toBeNull();
    expect(formatDraftStepsForDebug(draft)).toContain('"type": "filterRows"');
    expect(formatDraftStepsForDebug(null)).toBe('No AI draft steps.');
  });

  it('assigns deterministic draft step ids and replaces workflow steps', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_ai',
      name: 'AI test',
      steps: [
        {
          id: 'step_filter_rows_1',
          type: 'filterRows',
          mode: 'drop',
          condition: {
            kind: 'call',
            name: 'isEmpty',
            args: [{ kind: 'column', columnId: 'col_email' }],
          },
        },
      ],
    };
    const draftSteps = assignWorkflowStepIds([
      {
        type: 'filterRows',
        mode: 'keep',
        condition: {
          kind: 'call',
          name: 'matchesRegex',
          args: [
            { kind: 'column', columnId: 'col_email' },
            { kind: 'literal', value: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
          ],
        },
      },
    ]);
    const replacedWorkflow = replaceWorkflowSteps(workflow, draftSteps);

    expect(draftSteps).toEqual([
      expect.objectContaining({
        id: 'step_filter_rows_1',
        type: 'filterRows',
      }),
    ]);
    expect(replacedWorkflow.steps).toHaveLength(1);
    expect(replacedWorkflow.workflowId).toBe('wf_ai');
    expect(replacedWorkflow.steps[0].id).toBe('step_filter_rows_1');
  });
});

function createPromptContext(): AIPromptContext {
  const workflow: Workflow = {
    version: 2,
    workflowId: 'wf_ai',
    name: 'AI test',
    steps: [
      {
        id: 'step_scoped_rule_1',
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
  };

  return {
    table: createTable(),
    workflow,
    draft: null,
    messages: [],
    currentIssues: [],
    workflowContextSource: 'current',
    workspacePromptSnapshot: `${JSON.stringify(
      {
        metadata: {
          workflowId: 'wf_ai',
          name: 'AI test',
          description: '',
        },
        topBlocks: [
          {
            type: 'scoped_rule_cases_step',
            fields: {
              COLUMN_IDS: 'col_email',
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  };
}

function createPromptContextWithoutPhone(): AIPromptContext {
  const context = createPromptContext();

  return {
    ...context,
    table: {
      ...context.table,
      schema: {
        columns: context.table.schema.columns
          .filter((column) => column.columnId !== 'col_phone')
          .concat([
            {
              columnId: 'col_column',
              displayName: 'Column',
              logicalType: 'string',
              nullable: true,
              sourceIndex: 6,
              missingCount: 0,
            },
          ]),
      },
      rowsById: {
        ...context.table.rowsById,
        row_1: {
          ...context.table.rowsById.row_1,
          cellsByColumnId: {
            ...context.table.rowsById.row_1.cellsByColumnId,
            col_column: 'sample',
          },
        },
      },
    },
  };
}

function createTable(): Table {
  return {
    tableId: 'table_customers',
    sourceName: 'Customers',
    schema: {
      columns: [
        {
          columnId: 'col_email',
          displayName: 'Email',
          logicalType: 'string',
          nullable: true,
          sourceIndex: 0,
          missingCount: 1,
        },
        {
          columnId: 'col_email_2',
          displayName: 'Email (2)',
          logicalType: 'string',
          nullable: true,
          sourceIndex: 1,
          missingCount: 2,
        },
        {
          columnId: 'col_phone',
          displayName: 'Phone',
          logicalType: 'mixed',
          nullable: true,
          sourceIndex: 2,
          missingCount: 1,
        },
        {
          columnId: 'col_status',
          displayName: 'Status',
          logicalType: 'string',
          nullable: false,
          sourceIndex: 3,
          missingCount: 0,
        },
        {
          columnId: 'col_balance',
          displayName: 'Balance',
          logicalType: 'mixed',
          nullable: true,
          sourceIndex: 4,
          missingCount: 2,
        },
        {
          columnId: 'col_vip',
          displayName: 'VIP',
          logicalType: 'boolean',
          nullable: true,
          sourceIndex: 5,
          missingCount: 0,
        },
      ],
    },
    rowsById: {
      row_1: {
        rowId: 'row_1',
        cellsByColumnId: {
          col_email: 'alice@example.com',
          col_email_2: null,
          col_phone: '(555) 123-4567',
          col_status: 'active',
          col_balance: '15',
          col_vip: true,
        },
        stylesByColumnId: {},
      },
    },
    rowOrder: ['row_1'],
    importWarnings: [],
  };
}

function createAISettings(): AISettings {
  return {
    apiKey: 'test-key',
    model: 'gemini-2.5-flash',
    thinkingEnabled: false,
  };
}

function createEmailFallbackResponse(msg: string, fallbackColumnId: string) {
  return JSON.stringify({
    mode: 'draft',
    msg,
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
              value: { source: 'column', columnId: fallbackColumnId },
            },
          },
        ],
      },
      {
        type: 'dropColumns',
        columnIds: ['col_email_2'],
      },
    ],
  });
}

function createGeminiResponse(text: string): Response {
  const payload = {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
  };

  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as Response;
}

function createGeminiErrorResponse(message: string, status = 400): Response {
  const payload = {
    error: {
      message,
    },
  };

  return {
    ok: false,
    status,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  } as Response;
}
