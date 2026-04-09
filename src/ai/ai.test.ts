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
    expect(instruction).toContain('In scopedRule, every expression in cases/defaultPatch must be valid for every targeted column in columnIds.');
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

    expect(requestExport.requestBody.generationConfig.maxOutputTokens).toBe(4096);
    expect(requestExport.requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(requestExport.requestBody.generationConfig.temperature).toBe(0);
    expect(requestExport.requestBody.generationConfig.responseMimeType).toBeUndefined();
    expect(requestExport.requestBody.generationConfig.responseJsonSchema).toBeUndefined();
    expect(requestExport.requestBody.generationConfig).toEqual(
      expect.objectContaining({
        temperature: 0,
        maxOutputTokens: 4096,
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

    expect(repairMessage).toContain('Return JSON only with keys: mode, msg, ass, steps.');
    expect(repairMessage).toContain('Return authoring IR only.');
    expect(repairMessage).toContain('Use authoring value kinds only: nullary, unary, binary, ternary, nary, match.');
    expect(repairMessage).toContain('Use { "source": "caseValue" } only inside match.cases[*].when.');
    expect(repairMessage).not.toContain('fill_empty_from_col');
    expect(repairMessage).toContain('- col_email | Email | string');
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

    expect(() => parseGeminiAuthoringResponse('{"mode":"maybe","msg":"Done.","ass":[],"steps":[]}')).toThrow(
      'Gemini response must include mode "clarify" or "draft".',
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
    expect(result.compiledSteps).toEqual([
      expect.objectContaining({
        type: 'deriveColumn',
      }),
    ]);
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
    expect(result.compiledSteps).toEqual([
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
    ]);
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
          repairCompilationIssues: [],
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
