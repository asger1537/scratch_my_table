import { describe, expect, it, vi } from 'vitest';

import { assignWorkflowStepIds, buildGeminiRequestExport, buildGeminiSystemInstruction, generateGeminiDraftTurn, parseGeminiWorkflowResponse, replaceWorkflowSteps, runGeminiDraftTurn, type AISettings, type AIPromptContext } from './index';
import type { Table } from '../domain/model';
import type { Workflow, WorkflowValidationIssue } from '../workflow';

describe('AI workflow copilot helpers', () => {
  it('builds prompt context from schema and workflow without leaking raw row values', () => {
    const context = createPromptContext();

    const instruction = buildGeminiSystemInstruction(context);

    expect(instruction).toContain('col_email | Email | string');
    expect(instruction).toContain('Current block workspace snapshot:');
    expect(instruction).toContain('Current workflow/editor issues:');
    expect(instruction).toContain('Current workflow steps without IDs:');
    expect(instruction).toContain('Current workflow summary:');
    expect(instruction).toContain('scopedRule on col_email');
    expect(instruction).toContain('Never return mode "draft" with an empty steps array.');
    expect(instruction).toContain('If Email is empty, use Email (2), then drop Email (2).');
    expect(instruction).toContain('The returned steps are a full workflow replacement candidate.');
    expect(instruction).not.toContain('alice@example.com');
  });

  it('includes live workspace issues when the canonical workflow falls back to the last valid snapshot', () => {
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
    expect(instruction).toContain("missingColumns: Block 'scoped_rule_cases_step' must target at least one column.");
    expect(instruction).toContain('"type": "scoped_rule_cases_step"');
  });

  it('builds a replayable Gemini request export without including the API key in the payload', () => {
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

    expect(requestExport.phase).toBe('initial');
    expect(requestExport.model).toBe('gemini-2.5-flash');
    expect(requestExport.systemInstructionText).toContain('Current workflow summary:');
    expect(requestExport.contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Normalize the email column.' }],
      },
    ]);
    expect(requestExport.requestBody.systemInstruction.parts[0]?.text).toBe(requestExport.systemInstructionText);
    expect(requestExport.requestBody.contents).toEqual(requestExport.contents);
    expect(requestExport.requestBody.generationConfig.maxOutputTokens).toBe(1024);
    expect(requestExport.requestBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
    const responseJsonSchema = requestExport.requestBody.generationConfig.responseJsonSchema as {
      oneOf?: Array<Record<string, unknown>>;
    };
    const draftResponseSchema = responseJsonSchema.oneOf?.[1];
    const draftStepSchemas = (draftResponseSchema?.properties as {
      steps?: { items?: { oneOf?: Array<Record<string, unknown>> } };
    } | undefined)?.steps?.items?.oneOf;

    expect(draftStepSchemas).toHaveLength(10);
    expect(
      draftStepSchemas?.every((variant) => {
        const required = Array.isArray(variant.required) ? variant.required : [];
        const properties = variant.properties as Record<string, unknown> | undefined;
        const typeProperty = properties?.type as { const?: string } | undefined;

        return required.includes('type') && !required.includes('id') && !properties?.id && typeof typeProperty?.const === 'string';
      }),
    ).toBe(true);
    expect(JSON.stringify(requestExport)).not.toContain(settings.apiKey);
  });

  it('surfaces malformed Gemini HTTP bodies with a compact preview', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '{"candidates":[{"content":{"parts":[{"text":"ok"}]}}',
    } as Response);

    await expect(
      generateGeminiDraftTurn(
        {
          settings: createAISettings(),
          context: createPromptContext(),
          userMessage: {
            role: 'user',
            text: 'Normalize the email column.',
            timestamp: '2026-03-31T09:00:00.000Z',
          },
          phase: 'initial',
        },
        fetchFn,
      ),
    ).rejects.toThrow('Gemini returned an invalid JSON HTTP response body.');
  });

  it('parses clarify and draft Gemini responses and rejects malformed payloads', () => {
    expect(
      parseGeminiWorkflowResponse('{"mode":"clarify","assistantMessage":"Which email column should I use?","assumptions":[]}'),
    ).toEqual({
      mode: 'clarify',
      assistantMessage: 'Which email column should I use?',
      assumptions: [],
    });

    expect(
      parseGeminiWorkflowResponse('```json\n{"mode":"draft","assistantMessage":"Done.","assumptions":[],"steps":[]}\n```'),
    ).toEqual({
      mode: 'draft',
      assistantMessage: 'Done.',
      assumptions: [],
      steps: [],
    });

    expect(() => parseGeminiWorkflowResponse('{"mode":"draft","assistantMessage":"Missing steps","assumptions":[]}')).toThrow(
      'Gemini draft responses must include a steps array.',
    );
  });

  it('assigns deterministic draft step ids and replaces the workflow step list', () => {
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

  it('validates AI drafts as full workflow replacements instead of appending them', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        createGeminiResponse(
          '{"mode":"draft","assistantMessage":"I will update the existing fallback rule so it colors those cells yellow.","assumptions":[],"steps":[{"type":"scopedRule","columnIds":["col_email"],"cases":[{"when":{"kind":"call","name":"isEmpty","args":[{"kind":"value"}]},"then":{"value":{"kind":"column","columnId":"col_email_2"},"format":{"fillColor":"#FFF2CC"}}}]},{"type":"dropColumns","columnIds":["col_email_2"]}]}',
        ),
      );
    const validateCandidateWorkflow = vi.fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>().mockResolvedValueOnce([]);
    const context = createPromptContext();

    context.workflow.steps = [
      {
        id: 'step_scoped_rule_1',
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
        id: 'step_drop_columns_1',
        type: 'dropColumns',
        columnIds: ['col_email_2'],
      },
    ];
    context.table.schema.columns.push({
      columnId: 'col_email_2',
      displayName: 'Email (2)',
      logicalType: 'string',
      nullable: true,
      sourceIndex: 2,
      missingCount: 2,
    });

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context,
      userText: 'Color cells yellow when Email (2) was used.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(validateCandidateWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [
          expect.objectContaining({ id: 'step_scoped_rule_1', type: 'scopedRule' }),
          expect.objectContaining({ id: 'step_drop_columns_1', type: 'dropColumns' }),
        ],
      }),
    );
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: false,
        draft: expect.objectContaining({
          steps: [
            expect.objectContaining({ id: 'step_scoped_rule_1', type: 'scopedRule' }),
            expect.objectContaining({ id: 'step_drop_columns_1', type: 'dropColumns' }),
          ],
        }),
      }),
    );
  });

  it('repairs one invalid Gemini draft turn and keeps the validated draft only after the retry passes', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createGeminiResponse('{"mode":"draft","assistantMessage":"I will remove invalid emails.","assumptions":[],"steps":[{"type":"filterRows","mode":"drop","condition":{"kind":"call","name":"isEmpty","args":[{"kind":"column","columnId":"col_missing"}]}}]}'))
      .mockResolvedValueOnce(createGeminiResponse('{"mode":"draft","assistantMessage":"I corrected the email filter to use the real email column.","assumptions":["Using the primary email column."],"steps":[{"type":"filterRows","mode":"drop","condition":{"kind":"call","name":"not","args":[{"kind":"call","name":"matchesRegex","args":[{"kind":"column","columnId":"col_email"},{"kind":"literal","value":"^[^@\\\\s]+@[^@\\\\s]+\\\\.[^@\\\\s]+$"}]}]}}]}'));
    const validateCandidateWorkflow = vi
      .fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing' does not exist.",
          path: 'steps[0].condition.args[0].columnId',
          phase: 'semantic',
        },
      ])
      .mockResolvedValueOnce([]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Remove invalid emails.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(validateCandidateWorkflow).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: true,
        debugTrace: expect.objectContaining({
          outcomeKind: 'draft',
          repaired: true,
          initialResponse: expect.objectContaining({ mode: 'draft' }),
          repairResponse: expect.objectContaining({ mode: 'draft' }),
          initialValidationIssues: [
            expect.objectContaining({
              code: 'missingColumn',
            }),
          ],
        }),
        draft: expect.objectContaining({
          assumptions: ['Using the primary email column.'],
          steps: [
            expect.objectContaining({
              id: 'step_filter_rows_1',
              type: 'filterRows',
            }),
          ],
        }),
      }),
    );
  });

  it('surfaces validation issues after a failed repair without updating the live draft', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createGeminiResponse('{"mode":"draft","assistantMessage":"First attempt.","assumptions":[],"steps":[{"type":"dropColumns","columnIds":["col_missing"]}]}'))
      .mockResolvedValueOnce(createGeminiResponse('{"mode":"draft","assistantMessage":"Second attempt.","assumptions":[],"steps":[{"type":"dropColumns","columnIds":["col_missing_again"]}]}'));
    const validateCandidateWorkflow = vi
      .fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>()
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing' does not exist.",
          path: 'steps[0].columnIds[0]',
          phase: 'semantic',
        },
      ])
      .mockResolvedValueOnce([
        {
          code: 'missingColumn',
          severity: 'error',
          message: "Column 'col_missing_again' does not exist.",
          path: 'steps[0].columnIds[0]',
          phase: 'semantic',
        },
      ]);

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context: createPromptContext(),
      userText: 'Drop the bad column.',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'invalidDraft',
        repaired: true,
        debugTrace: expect.objectContaining({
          outcomeKind: 'invalidDraft',
          repaired: true,
          repairResponse: expect.objectContaining({ mode: 'draft' }),
          repairValidationIssues: [
            expect.objectContaining({
              code: 'missingColumn',
            }),
          ],
        }),
        validationIssues: [
          expect.objectContaining({
            code: 'missingColumn',
            path: 'steps[0].columnIds[0]',
          }),
        ],
      }),
    );
  });

  it('treats empty draft step arrays as invalid and sends them through repair', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(createGeminiResponse('{"mode":"draft","assistantMessage":"I will fix the email columns.","assumptions":[],"steps":[]}'))
      .mockResolvedValueOnce(createGeminiResponse('{"mode":"draft","assistantMessage":"I added the actual cleanup steps.","assumptions":[],"steps":[{"type":"scopedRule","columnIds":["col_email"],"defaultPatch":{"value":{"kind":"call","name":"coalesce","args":[{"kind":"value"},{"kind":"column","columnId":"col_email_2"}]}}},{"type":"dropColumns","columnIds":["col_email_2"]}]}'));
    const validateCandidateWorkflow = vi.fn<(_workflow: Workflow) => Promise<WorkflowValidationIssue[]>>().mockResolvedValueOnce([]);

    const context = createPromptContext();
    context.table.schema.columns.push({
      columnId: 'col_email_2',
      displayName: 'Email (2)',
      logicalType: 'string',
      nullable: true,
      sourceIndex: 2,
      missingCount: 2,
    });

    const outcome = await runGeminiDraftTurn({
      settings: createAISettings(),
      context,
      userText: 'Use Email (2) when Email is empty, then drop Email (2).',
      validateCandidateWorkflow,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(outcome).toEqual(
      expect.objectContaining({
        kind: 'draft',
        repaired: true,
        debugTrace: expect.objectContaining({
          initialValidationIssues: [
            expect.objectContaining({
              code: 'emptyDraft',
              path: 'steps',
            }),
          ],
        }),
        draft: expect.objectContaining({
          steps: [
            expect.objectContaining({ id: 'step_scoped_rule_1', type: 'scopedRule' }),
            expect.objectContaining({ id: 'step_drop_columns_1', type: 'dropColumns' }),
          ],
        }),
      }),
    );
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
          columnId: 'col_status',
          displayName: 'Status',
          logicalType: 'string',
          nullable: false,
          sourceIndex: 1,
          missingCount: 0,
        },
      ],
    },
    rowsById: {
      row_1: {
        rowId: 'row_1',
        cellsByColumnId: {
          col_email: 'alice@example.com',
          col_status: 'active',
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
