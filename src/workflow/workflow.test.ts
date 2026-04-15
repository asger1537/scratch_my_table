import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCsvWorkbook } from '../domain/csv';
import { getActiveTable, type Table } from '../domain/model';
import { importXlsxWorkbook } from '../domain/xlsx';
import { parseWorkflowPackageJson } from '../workflowPackage';
import { executeValidatedWorkflow, executeWorkflow, validateWorkflowSemantics, validateWorkflowStructure, type Workflow, type WorkflowExpression } from './index';

describe('workflow validation and execution', () => {
  it('structurally validates canonical v2 workflows and rejects non-v2 workflow versions', () => {
    const validWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_valid',
      name: 'Valid workflow',
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
      ],
    };

    expect(validateWorkflowStructure(validWorkflow)).toEqual({
      valid: true,
      workflow: validWorkflow,
      issues: [],
    });

    const unsupportedWorkflow = {
      version: 1,
      workflowId: 'wf_unsupported',
      name: 'Unsupported workflow',
      steps: [
        {
          id: 'step_fill_status',
          type: 'fillEmpty',
          target: {
            kind: 'columns',
            columnIds: ['col_status'],
          },
          value: 'unknown',
          treatWhitespaceAsEmpty: true,
        },
      ],
    };

    const rejected = validateWorkflowStructure(unsupportedWorkflow);

    expect(rejected.valid).toBe(false);
    expect(rejected.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'schema.const',
          path: 'version',
        }),
      ]),
    );
  });

  it('rejects duplicate step IDs and schema-invalid expression shapes', () => {
    const duplicateStepIdWorkflow = {
      version: 2,
      workflowId: 'wf_duplicate_steps',
      name: 'Duplicate steps',
      steps: [
        {
          id: 'step_repeat',
          type: 'scopedRule',
          columnIds: ['col_status'],
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
        {
          id: 'step_repeat',
          type: 'renameColumn',
          columnId: 'col_status',
          newDisplayName: 'status_clean',
        },
      ],
    };

    const duplicateValidation = validateWorkflowStructure(duplicateStepIdWorkflow);

    expect(duplicateValidation.valid).toBe(false);
    expect(duplicateValidation.issues.some((issue) => issue.code === 'duplicateStepId')).toBe(true);

    const invalidWorkflow = {
      version: 2,
      workflowId: 'wf_bad_call',
      name: 'Bad call',
      steps: [
        {
          id: 'step_bad_call',
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: {
              kind: 'call',
              name: 'lower',
              args: [value(), literal('extra')],
            },
          },
        },
      ],
    };

    const invalidValidation = validateWorkflowStructure(invalidWorkflow);

    expect(invalidValidation.valid).toBe(false);
    expect(invalidValidation.issues.some((issue) => issue.code === 'schema.maxItems')).toBe(true);

    const unsupportedFunctionWorkflow = {
      version: 2,
      workflowId: 'wf_bad_cast_name',
      name: 'Bad cast name',
      steps: [
        {
          id: 'step_bad_cast_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad',
            displayName: 'bad',
          },
          expression: {
            kind: 'call',
            name: 'toMaybe',
            args: [column('col_email')],
          },
        },
      ],
    };

    const unsupportedFunctionValidation = validateWorkflowStructure(unsupportedFunctionWorkflow);

    expect(unsupportedFunctionValidation.valid).toBe(false);
    expect(unsupportedFunctionValidation.issues.some((issue) => issue.code.startsWith('schema.'))).toBe(true);
  });

  it('structurally validates boolean expression filters', () => {
    const workflow = {
      version: 2,
      workflowId: 'wf_regex_structure',
      name: 'Regex structure',
      steps: [
        {
          id: 'step_filter_email',
          type: 'filterRows',
          mode: 'keep',
          condition: call('matchesRegex', column('col_email'), literal('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')),
        },
      ],
    };

    expect(validateWorkflowStructure(workflow)).toEqual({
      valid: true,
      workflow,
      issues: [],
    });
  });

  it('treats comment steps as canonical no-ops during validation and execution', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_comment_noop',
      name: 'Comment noop',
      steps: [
        {
          id: 'step_note_status_cleanup',
          type: 'comment',
          text: 'Fill missing status values before sorting customers.',
        },
        {
          id: 'step_fill_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
      ],
    };

    expect(validateWorkflowStructure(workflow)).toEqual({
      valid: true,
      workflow,
      issues: [],
    });

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(validation.stepResults[0]).toEqual(
      expect.objectContaining({
        stepType: 'comment',
        valid: true,
        issues: [],
        schemaAfterStep: table.schema,
      }),
    );
    expect(execution.validationErrors).toEqual([]);
    expect(execution.changedRowCount).toBeGreaterThan(0);
    expect(execution.transformedTable?.schema.columns).toHaveLength(table.schema.columns.length);
  });

  it('validates and applies format-only scoped rules deterministically', () => {
    const table = loadCsvTable('status,vip\r\nactive,true\r\npending,false\r\ninactive,true\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_color_status',
      name: 'Color status',
      steps: [
        {
          id: 'step_color_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          rowCondition: call('equals', column('col_vip'), literal(true)),
          defaultPatch: {
            format: {
              fillColor: '#ffeb9c',
            },
          },
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.changedRowCount).toBe(2);
    expect(execution.changedCellCount).toBe(2);
    expect(execution.transformedTable?.rowsById.row_1.stylesByColumnId.col_status).toEqual({ fillColor: '#ffeb9c' });
    expect(execution.transformedTable?.rowsById.row_2.stylesByColumnId.col_status).toBeUndefined();
    expect(execution.transformedTable?.rowsById.row_3.stylesByColumnId.col_status).toEqual({ fillColor: '#ffeb9c' });
  });

  it('treats whitespace-only strings as empty for isEmpty filters', () => {
    const table = loadCsvTable('email\r\n   \r\nalice@example.com\r\n""\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_whitespace_is_empty',
      name: 'Whitespace is empty',
      steps: [
        {
          id: 'step_keep_empty_email',
          type: 'filterRows',
          mode: 'keep',
          condition: call('isEmpty', column('col_email')),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowOrder).toEqual(['row_1', 'row_3']);
    expect(execution.removedRowCount).toBe(1);
  });

  it('applies multiple matching scoped-rule cases in order so later matches can add formatting', () => {
    const table = loadCsvTable('email,email_2\r\n,backup@example.com\r\n,\r\nprimary@example.com,\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_email_fallback_and_highlight',
      name: 'Email fallback and highlight',
      steps: [
        {
          id: 'step_email_rule',
          type: 'scopedRule',
          columnIds: ['col_email'],
          cases: [
            {
              when: call('isEmpty', value()),
              then: {
                value: column('col_email_2'),
              },
            },
            {
              when: call(
                'and',
                call('isEmpty', value()),
                call('isEmpty', column('col_email_2')),
              ),
              then: {
                value: value(),
                format: {
                  fillColor: '#ff0000',
                },
              },
            },
          ],
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.changedRowCount).toBe(2);
    expect(execution.changedCellCount).toBe(2);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_email).toBe('backup@example.com');
    expect(execution.transformedTable?.rowsById.row_1.stylesByColumnId.col_email).toBeUndefined();
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_email).toBeNull();
    expect(execution.transformedTable?.rowsById.row_2.stylesByColumnId.col_email).toEqual({ fillColor: '#ff0000' });
    expect(execution.transformedTable?.rowsById.row_3.stylesByColumnId.col_email).toBeUndefined();
  });

  it('structurally validates match expressions with when, otherwise, and caseValue conditions', () => {
    const workflow = {
      version: 2,
      workflowId: 'wf_match_structure',
      name: 'Match structure',
      steps: [
        {
          id: 'step_match_status',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_status_label',
            displayName: 'status_label',
          },
          expression: match(
            call('lower', call('trim', column('col_status'))),
            [
              matchWhen(
                call('equals', caseValue(), literal('active')),
                literal('A'),
              ),
              matchWhen(
                call(
                  'and',
                  call(
                    'or',
                    call('equals', caseValue(), literal('inactive')),
                    call('equals', caseValue(), literal('disabled')),
                  ),
                  call('equals', column('col_region'), literal('west')),
                ),
                literal('West inactive'),
              ),
              matchOtherwise(literal('Other')),
            ],
          ),
        },
        {
          id: 'step_match_priority',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_priority_score',
            displayName: 'priority_score',
          },
          expression: match(
            call('toNumber', column('col_balance')),
            [
              matchWhen(
                call('lessThan', caseValue(), literal(0)),
                literal(3),
              ),
              matchWhen(
                call(
                  'and',
                  call(
                    'or',
                    call('greaterThan', caseValue(), literal(0)),
                    call('equals', caseValue(), literal(0)),
                  ),
                  call(
                    'or',
                    call('lessThan', caseValue(), literal(200)),
                    call('equals', caseValue(), literal(200)),
                  ),
                ),
                literal(2),
              ),
              matchOtherwise(literal(1)),
            ],
          ),
        },
      ],
    };

    expect(validateWorkflowStructure(workflow)).toEqual({
      valid: true,
      workflow,
      issues: [],
    });
  });

  it('structurally validates math expressions', () => {
    const workflow = {
      version: 2,
      workflowId: 'wf_math_structure',
      name: 'Math structure',
      steps: [
        {
          id: 'step_total',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total',
            displayName: 'total',
          },
          expression: call('round', call('divide', call('add', column('col_price'), literal(2)), literal(3))),
        },
      ],
    };

    expect(validateWorkflowStructure(workflow)).toEqual({
      valid: true,
      workflow,
      issues: [],
    });
  });

  it('structurally validates date math expressions', () => {
    const workflow = {
      version: 2,
      workflowId: 'wf_date_math_structure',
      name: 'Date math structure',
      steps: [
        {
          id: 'step_signup_year',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_signup_year',
            displayName: 'signup_year',
          },
          expression: call('datePart', column('col_sign_up_date'), literal('year')),
        },
        {
          id: 'step_follow_up_at',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_follow_up_at',
            displayName: 'follow_up_at',
          },
          expression: call('dateAdd', call('now'), literal(7), literal('days')),
        },
      ],
    };

    expect(validateWorkflowStructure(workflow)).toEqual({
      valid: true,
      workflow,
      issues: [],
    });
  });

  it('structurally validates explicit cast expressions', () => {
    const workflow = {
      version: 2,
      workflowId: 'wf_cast_structure',
      name: 'Cast structure',
      steps: [
        {
          id: 'step_number',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total_number',
            displayName: 'total_number',
          },
          expression: call('toNumber', column('col_total')),
        },
        {
          id: 'step_string',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total_text',
            displayName: 'total_text',
          },
          expression: call('toString', column('col_total')),
        },
        {
          id: 'step_boolean',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_paid_flag',
            displayName: 'paid_flag',
          },
          expression: call('toBoolean', column('col_paid')),
        },
      ],
    };

    expect(validateWorkflowStructure(workflow)).toEqual({
      valid: true,
      workflow,
      issues: [],
    });
  });

  it('runs every example workflow against Customers_Messy.xlsx', async () => {
    const workbookPath = path.resolve(process.cwd(), 'Customers_Messy.xlsx');
    const workbookBytes = await readFile(workbookPath);
    const arrayBuffer = workbookBytes.buffer.slice(
      workbookBytes.byteOffset,
      workbookBytes.byteOffset + workbookBytes.byteLength,
    ) as ArrayBuffer;
    const workbook = importXlsxWorkbook('Customers_Messy.xlsx', arrayBuffer);
    const table = getActiveTable(workbook);

    if (!table) {
      throw new Error('Expected active table for Customers_Messy.xlsx.');
    }

    const exampleDirectory = path.resolve(process.cwd(), 'examples', 'workflows');
    const exampleFiles = (await readdir(exampleDirectory))
      .filter((fileName) => fileName.endsWith('.workflow.json'))
      .sort();

    for (const fileName of exampleFiles) {
      const parsed = parseWorkflowPackageJson(await readFile(path.join(exampleDirectory, fileName), 'utf8'));

      expect(parsed.issues, `${fileName} should parse as a workflow package`).toEqual([]);
      expect(parsed.workflowPackage, `${fileName} should contain a workflow package`).not.toBeNull();
      expect(parsed.workflowPackage?.workflows, `${fileName} should contain exactly one workflow`).toHaveLength(1);

      const workflow = parsed.workflowPackage!.workflows[0];
      const structural = validateWorkflowStructure(workflow);
      const semantic = validateWorkflowSemantics(workflow, table);
      const execution = executeWorkflow(workflow, table);

      expect(structural.valid, `${fileName} should pass structural validation`).toBe(true);
      expect(semantic.valid, `${fileName} should pass semantic validation`).toBe(true);
      expect(execution.validationErrors, `${fileName} should execute without validation errors`).toEqual([]);
      expect(execution.transformedTable, `${fileName} should produce a transformed table`).not.toBeNull();
    }
  }, 40000);

  it('lets later valid steps see schema changes from earlier valid steps', () => {
    const table = loadCsvTable('first_name,last_name\r\nAlice,Ng\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_schema_evolution',
      name: 'Schema evolution',
      steps: [
        {
          id: 'step_derive_full_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_full_name',
            displayName: 'full_name',
          },
          expression: concat(column('col_first_name'), literal(' '), column('col_last_name')),
        },
        {
          id: 'step_rename_full_name',
          type: 'renameColumn',
          columnId: 'col_full_name',
          newDisplayName: 'display_name',
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);

    expect(validation.valid).toBe(true);
    expect(validation.finalSchema.columns.find((entry) => entry.columnId === 'col_full_name')?.displayName).toBe('display_name');
  });

  it('does not let invalid steps contribute schema changes to later validation', () => {
    const table = loadCsvTable('first_name,last_name\r\nAlice,Ng\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_invalid_schema_change',
      name: 'Invalid schema change',
      steps: [
        {
          id: 'step_bad_derive',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_full_name',
            displayName: 'first_name',
          },
          expression: literal('Alice Ng'),
        },
        {
          id: 'step_rename_missing',
          type: 'renameColumn',
          columnId: 'col_full_name',
          newDisplayName: 'display_name',
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'nameConflict' && issue.stepId === 'step_bad_derive')).toBe(true);
    expect(validation.issues.some((issue) => issue.code === 'missingColumn' && issue.stepId === 'step_rename_missing')).toBe(true);
  });

  it('validates the 27-email-hard example against mixed phone values', async () => {
    const examplePath = path.resolve(process.cwd(), 'examples', 'workflows', '27-email-hard.json');
    const parsed = parseWorkflowPackageJson(await readFile(examplePath, 'utf8'));
    const table = loadCsvTable([
      'Customer ID,First Name,Last Name,Email,Email (2),Column,Status,Sign Up Date,Notes,Balance,VIP?,Phone',
      'C-001,Alice,Ng,alice@example.com,alice.alt@example.com,north,active,02/01/2026,prefers email,120.5,TRUE,202-555-0141',
      'C-002,Bob,Smith-Jones,,,west,,15/01/2026,,,FALSE,-695',
    ].join('\r\n'));

    expect(parsed.issues).toEqual([]);
    expect(parsed.workflowPackage?.workflows).toHaveLength(1);

    const workflow = parsed.workflowPackage!.workflows[0];
    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable).not.toBeNull();
  });

  it('executes scoped rules with row conditions, multi-column targets, and explicit coalesce emptiness semantics', () => {
    const table = loadCsvTable('first_name,last_name,status,region\r\nAlice,Ng,,west\r\nAmy,Adams,  ,west\r\nBen,Ortiz,,east\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_scoped_fill',
      name: 'Scoped fill',
      steps: [
        {
          id: 'step_fill_unknown',
          type: 'scopedRule',
          columnIds: ['col_first_name', 'col_last_name', 'col_status'],
          rowCondition: call('equals', column('col_region'), literal('west')),
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_first_name).toBe('Alice');
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_status).toBe('unknown');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_status).toBe('  ');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_status).toBe(null);
    expect(execution.changedCellCount).toBe(1);
  });

  it('allows scoped rules to read another column from the same row', () => {
    const table = loadCsvTable('customer_id,email\r\nC001,\r\nC002,bob@example.com\r\nC003,   \r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_fill_email_from_customer_id',
      name: 'Fill email from customer id',
      steps: [
        {
          id: 'step_fill_email',
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: coalesce(value(), column('col_customer_id')),
          },
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_email).toBe('C001');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_email).toBe('bob@example.com');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_email).toBe('   ');
  });

  it('executes nested built-in scoped-rule functions deterministically', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_transform_text',
      name: 'Transform text',
      steps: [
        {
          id: 'step_normalize_email',
          type: 'scopedRule',
          columnIds: ['col_email'],
          defaultPatch: {
            value: call('lower', call('trim', value())),
          },
        },
        {
          id: 'step_clean_full_name',
          type: 'scopedRule',
          columnIds: ['col_full_name'],
          defaultPatch: {
            value: call('replace', call('collapseWhitespace', call('trim', value())), literal('Ng'), literal('NG')),
          },
        },
        {
          id: 'step_abbreviate_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          rowCondition: call('not', call('isEmpty', call('trim', column('col_status')))),
          defaultPatch: {
            value: call('substring', call('upper', call('trim', value())), literal(0), literal(3)),
          },
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_email).toBe('alice.ng@example.com');
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_full_name).toBe('Alice NG');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_status).toBe('ACT');
    expect(execution.transformedTable?.rowsById.row_5.cellsByColumnId.col_status).toBe('   ');
  });

  it('rejects incompatible scoped-rule expressions and invalid value references', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const incompatibleWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_bad_lower',
      name: 'Bad lower',
      steps: [
        {
          id: 'step_bad_lower',
          type: 'scopedRule',
          columnIds: ['col_signup_date'],
          defaultPatch: {
            value: call('lower', value()),
          },
        },
      ],
    };

    const incompatibleValidation = validateWorkflowSemantics(incompatibleWorkflow, table);

    expect(incompatibleValidation.valid).toBe(false);
    expect(incompatibleValidation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);

    const invalidValueReferenceWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_bad_value_reference',
      name: 'Bad value reference',
      steps: [
        {
          id: 'step_bad_value_reference',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad',
            displayName: 'bad',
          },
          expression: value(),
        },
      ],
    };

    const invalidValueValidation = validateWorkflowSemantics(invalidValueReferenceWorkflow, table);

    expect(invalidValueValidation.valid).toBe(false);
    expect(invalidValueValidation.issues.some((issue) => issue.code === 'invalidExpression')).toBe(true);
  });

  it('validates casts on mixed and unknown scalar sources but rejects list-valued cast inputs', () => {
    const mixedTable = loadCsvTable('value,flag\r\n1,yes\r\nhello,0\r\n,maybe\r\n');
    const validWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_cast_validation',
      name: 'Cast validation',
      steps: [
        {
          id: 'step_value_number',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_value_number',
            displayName: 'value_number',
          },
          expression: call('toNumber', column('col_value')),
        },
        {
          id: 'step_flag_boolean',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_flag_boolean',
            displayName: 'flag_boolean',
          },
          expression: call('toBoolean', column('col_flag')),
        },
        {
          id: 'step_value_string',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_value_string',
            displayName: 'value_string',
          },
          expression: call('toString', column('col_value')),
        },
      ],
    };

    const validValidation = validateWorkflowSemantics(validWorkflow, mixedTable);

    expect(mixedTable.schema.columns.find((column) => column.columnId === 'col_value')?.logicalType).toBe('mixed');
    expect(validValidation.valid).toBe(true);

    const invalidWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_cast_list_validation',
      name: 'Cast list validation',
      steps: [
        {
          id: 'step_bad_cast',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_cast',
            displayName: 'bad_cast',
          },
          expression: call('toNumber', call('split', column('col_value'), literal(','))),
        },
      ],
    };

    const invalidValidation = validateWorkflowSemantics(invalidWorkflow, mixedTable);

    expect(invalidValidation.valid).toBe(false);
    expect(
      invalidValidation.issues.some((issue) => issue.code === 'invalidExpression' && issue.path === 'steps[0].expression.args[0]'),
    ).toBe(true);
  });

  it('renames a column display name without changing its stable column ID', () => {
    const table = loadCsvTable('customer_id,email\r\nC001,alice@example.com\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_rename',
      name: 'Rename',
      steps: [
        {
          id: 'step_rename_customer_id',
          type: 'renameColumn',
          columnId: 'col_customer_id',
          newDisplayName: 'external_customer_id',
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);
    const renamedColumn = execution.transformedTable?.schema.columns.find((column) => column.columnId === 'col_customer_id');

    expect(renamedColumn?.columnId).toBe('col_customer_id');
    expect(renamedColumn?.displayName).toBe('external_customer_id');
  });

  it('drops columns deterministically and rejects dropping every visible column', () => {
    const table = loadCsvTable('customer_id,email,notes\r\nC001,alice@example.com,internal\r\nC002,bob@example.com,\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_drop_columns',
      name: 'Drop columns',
      steps: [
        {
          id: 'step_drop_columns',
          type: 'dropColumns',
          columnIds: ['col_notes'],
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.schema.columns.map((column) => column.columnId)).toEqual(['col_customer_id', 'col_email']);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_notes).toBeUndefined();
    expect(execution.rowOrderChanged).toBe(false);

    const invalidWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_drop_all_columns',
      name: 'Drop all columns',
      steps: [
        {
          id: 'step_drop_all_columns',
          type: 'dropColumns',
          columnIds: ['col_customer_id', 'col_email', 'col_notes'],
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'emptySchema')).toBe(true);
  });

  it('derives columns from concat and coalesce expressions', () => {
    const table = loadCsvTable('first_name,last_name,nickname,total\r\nAlice,Ng,,1\r\nBob,,Bobby,2\r\n');
    const validWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_derive_display_name',
      name: 'Derive display name',
      steps: [
        {
          id: 'step_derive_display_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_display_name',
            displayName: 'display_name',
          },
          expression: coalesce(
            column('col_nickname'),
            concat(column('col_first_name'), literal(' '), column('col_last_name')),
          ),
        },
      ],
    };

    const execution = executeWorkflow(validWorkflow, table);

    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_display_name).toBe('Alice Ng');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_display_name).toBe('Bobby');
  });

  it('derives initials with first and last over strings and split lists', () => {
    const table = loadCsvTable('first_name,last_name\r\nAlice,Ng\r\nCara,Patel Singh\r\nDiego,Ramirez Lopez\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_derive_initials',
      name: 'Derive initials',
      steps: [
        {
          id: 'step_derive_initials',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_initials',
            displayName: 'initials',
          },
          expression: concat(
            call('upper', call('first', column('col_first_name'))),
            call('upper', call('first', call('last', call('split', column('col_last_name'), literal(' '))))),
          ),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_initials).toBe('AN');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_initials).toBe('CS');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_initials).toBe('DL');
  });

  it('derives length over strings and split lists', () => {
    const table = loadCsvTable('phrase\r\nabc def\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_derive_lengths',
      name: 'Derive lengths',
      steps: [
        {
          id: 'step_derive_phrase_length',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_phrase_length',
            displayName: 'phrase_length',
          },
          expression: call('length', column('col_phrase')),
        },
        {
          id: 'step_derive_word_count',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_word_count',
            displayName: 'word_count',
          },
          expression: call('length', call('split', column('col_phrase'), literal(' '))),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_phrase_length).toBe(7);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_word_count).toBe(2);
  });

  it('evaluates atIndex on strings and split lists deterministically', () => {
    const table = loadCsvTable('full_name\r\nFirst Middle Last\r\nSolo\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_extract_name_parts',
      name: 'Extract name parts',
      steps: [
        {
          id: 'step_extract_middle_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_middle_name',
            displayName: 'middle_name',
          },
          expression: call('atIndex', call('split', column('col_full_name'), literal(' ')), literal(1)),
        },
        {
          id: 'step_extract_out_of_bounds',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_missing_part',
            displayName: 'missing_part',
          },
          expression: call('atIndex', call('split', column('col_full_name'), literal(' ')), literal(10)),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_middle_name).toBe('Middle');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_middle_name).toBe(null);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_missing_part).toBe(null);
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_missing_part).toBe(null);
  });

  it('evaluates extractRegex and replaceRegex deterministically', () => {
    const table = loadCsvTable('note\r\nOrder: ORD-1234 (urgent)\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_regex_transforms',
      name: 'Regex transforms',
      steps: [
        {
          id: 'step_extract_order_id',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_order_id',
            displayName: 'order_id',
          },
          expression: call('extractRegex', column('col_note'), literal('ORD-\\d+')),
        },
        {
          id: 'step_compact_note',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_note_compact',
            displayName: 'note_compact',
          },
          expression: call('replaceRegex', column('col_note'), literal('\\s+'), literal('_')),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_order_id).toBe('ORD-1234');
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_note_compact).toBe('Order:_ORD-1234_(urgent)');

    const malformedWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_regex_transforms_malformed',
      name: 'Regex transforms malformed',
      steps: [
        {
          id: 'step_bad_extract',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_extract',
            displayName: 'bad_extract',
          },
          expression: call('extractRegex', column('col_note'), literal('[abc')),
        },
        {
          id: 'step_bad_replace',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_replace',
            displayName: 'bad_replace',
          },
          expression: call('replaceRegex', column('col_note'), literal('[abc'), literal('_')),
        },
      ],
    };

    const malformedExecution = executeValidatedWorkflow(malformedWorkflow, table);

    expect(malformedExecution.transformedTable.rowsById.row_1.cellsByColumnId.col_bad_extract).toBe(null);
    expect(malformedExecution.transformedTable.rowsById.row_1.cellsByColumnId.col_bad_replace).toBe('Order: ORD-1234 (urgent)');
  });

  it('evaluates match deterministically with caseValue conditions, compound logic, and otherwise fallback', () => {
    const table = loadCsvTable('status,region,balance,email\r\nactive,west,-5,alice@example.com\r\ninactive,west,120,bob@example.com\r\npending,east,900,\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_match_runtime',
      name: 'Match runtime',
      steps: [
        {
          id: 'step_status_label',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_status_label',
            displayName: 'status_label',
          },
          expression: match(
            call('lower', call('trim', column('col_status'))),
            [
              matchWhen(
                call('equals', caseValue(), literal('active')),
                literal('Active customer'),
              ),
              matchWhen(
                call(
                  'and',
                  call(
                    'or',
                    call('equals', caseValue(), literal('inactive')),
                    call('equals', caseValue(), literal('disabled')),
                  ),
                  call('equals', column('col_region'), literal('west')),
                ),
                literal('Inactive west customer'),
              ),
              matchOtherwise(literal('Other')),
            ],
          ),
        },
        {
          id: 'step_priority_score',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_priority_score',
            displayName: 'priority_score',
          },
          expression: match(
            call('toNumber', column('col_balance')),
            [
              matchWhen(
                call('lessThan', caseValue(), literal(0)),
                literal(3),
              ),
              matchWhen(
                call(
                  'and',
                  call(
                    'and',
                    call(
                      'or',
                      call('greaterThan', caseValue(), literal(0)),
                      call('equals', caseValue(), literal(0)),
                    ),
                    call(
                      'or',
                      call('lessThan', caseValue(), literal(200)),
                      call('equals', caseValue(), literal(200)),
                    ),
                  ),
                  call('not', call('isEmpty', column('col_email'))),
                ),
                literal(2),
              ),
              matchOtherwise(literal(1)),
            ],
          ),
        },
        {
          id: 'step_unmatched_status',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_unmatched_status',
            displayName: 'unmatched_status',
          },
          expression: match(
            call('lower', call('trim', column('col_status'))),
            [
              matchWhen(
                call('equals', caseValue(), literal('vip')),
                literal('VIP'),
              ),
            ],
          ),
        },
        {
          id: 'step_return_case_value',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_return_case_value',
            displayName: 'return_case_value',
          },
          expression: match(
            call('lower', call('trim', column('col_status'))),
            [
              matchWhen(
                call('equals', caseValue(), literal('active')),
                caseValue(),
              ),
              matchOtherwise(caseValue()),
            ],
          ),
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_status_label).toBe('Active customer');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_status_label).toBe('Inactive west customer');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_status_label).toBe('Other');
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_priority_score).toBe(3);
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_priority_score).toBe(2);
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_priority_score).toBe(1);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_unmatched_status).toBeNull();
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_return_case_value).toBe('active');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_return_case_value).toBe('inactive');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_return_case_value).toBe('pending');
  });

  it('rejects malformed or incompatible match expressions', () => {
    const table = loadCsvTable('status,balance,email\r\nactive,100,alice@example.com\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_match_invalid',
      name: 'Match invalid',
      steps: [
        {
          id: 'step_bad_otherwise_order',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_otherwise_order',
            displayName: 'bad_otherwise_order',
          },
          expression: match(
            column('col_status'),
            [
              matchOtherwise(literal('first')),
              matchWhen(call('equals', caseValue(), literal('active')), literal('second')),
              matchOtherwise(literal('third')),
            ],
          ),
        },
        {
          id: 'step_bad_when_type',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_when_type',
            displayName: 'bad_when_type',
          },
          expression: match(
            column('col_status'),
            [
              matchWhen(literal('not_boolean'), literal('A')),
              matchOtherwise(literal('Other')),
            ],
          ),
        },
        {
          id: 'step_bad_result_types',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_result_types',
            displayName: 'bad_result_types',
          },
          expression: match(
            call('toNumber', column('col_balance')),
            [
              matchWhen(call('lessThan', caseValue(), literal(0)), literal(3)),
              matchOtherwise(literal('other')),
            ],
          ),
        },
        {
          id: 'step_bad_subject_value',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_subject_value',
            displayName: 'bad_subject_value',
          },
          expression: match(
            value(),
            [
              matchWhen(call('equals', caseValue(), literal('active')), literal('A')),
              matchOtherwise(literal('Other')),
            ],
          ),
        },
        {
          id: 'step_bad_subject_case_value',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_subject_case_value',
            displayName: 'bad_subject_case_value',
          },
          expression: match(
            caseValue(),
            [
              matchWhen(call('equals', caseValue(), literal('active')), literal('A')),
              matchOtherwise(literal('Other')),
            ],
          ),
        },
        {
          id: 'step_bad_case_value_scope',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_case_value_scope',
            displayName: 'bad_case_value_scope',
          },
          expression: call(
            'coalesce',
            caseValue(),
            literal('missing'),
          ),
        },
        {
          id: 'step_bad_non_scalar_then',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad_non_scalar_then',
            displayName: 'bad_non_scalar_then',
          },
          expression: match(
            column('col_status'),
            [
              matchWhen(
                call('equals', caseValue(), literal('active')),
                call('split', column('col_email'), literal('@')),
              ),
              matchOtherwise(literal('Other')),
            ],
          ),
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);

    expect(validation.valid).toBe(false);
    expect(validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalidExpression',
          path: 'steps[0].expression.cases[1]',
          stepId: 'step_bad_otherwise_order',
        }),
        expect.objectContaining({
          code: 'invalidExpression',
          path: 'steps[0].expression.cases[2]',
          stepId: 'step_bad_otherwise_order',
        }),
        expect.objectContaining({
          code: 'incompatibleType',
          path: 'steps[1].expression.cases[0].when',
          stepId: 'step_bad_when_type',
        }),
        expect.objectContaining({
          code: 'incompatibleType',
          path: 'steps[2].expression',
          stepId: 'step_bad_result_types',
        }),
        expect.objectContaining({
          code: 'invalidExpression',
          path: 'steps[3].expression.subject',
          stepId: 'step_bad_subject_value',
        }),
        expect.objectContaining({
          code: 'invalidExpression',
          path: 'steps[4].expression.subject',
          stepId: 'step_bad_subject_case_value',
        }),
        expect.objectContaining({
          code: 'invalidExpression',
          path: 'steps[5].expression.args[0]',
          stepId: 'step_bad_case_value_scope',
        }),
        expect.objectContaining({
          code: 'invalidExpression',
          path: 'steps[6].expression.cases[0].then',
          stepId: 'step_bad_non_scalar_then',
        }),
      ]),
    );
  });

  it('evaluates math functions deterministically and returns null for invalid numeric cases', () => {
    const table = loadCsvTable('price,quantity,discount\r\n10.2,3,2\r\n,4,0\r\n7,0,0\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_math_functions',
      name: 'Math functions',
      steps: [
        {
          id: 'step_total',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total',
            displayName: 'total',
          },
          expression: call('multiply', column('col_price'), column('col_quantity')),
        },
        {
          id: 'step_total_minus_discount',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total_minus_discount',
            displayName: 'total_minus_discount',
          },
          expression: call('subtract', column('col_total'), column('col_discount')),
        },
        {
          id: 'step_total_rounded',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total_rounded',
            displayName: 'total_rounded',
          },
          expression: call('round', column('col_total_minus_discount')),
        },
        {
          id: 'step_total_abs',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_total_abs',
            displayName: 'total_abs',
          },
          expression: call('abs', column('col_total_minus_discount')),
        },
        {
          id: 'step_unit_price_floor',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_unit_price_floor',
            displayName: 'unit_price_floor',
          },
          expression: call('floor', call('divide', column('col_total_minus_discount'), literal(2))),
        },
        {
          id: 'step_unit_price_ceil',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_unit_price_ceil',
            displayName: 'unit_price_ceil',
          },
          expression: call('ceil', call('divide', column('col_total_minus_discount'), literal(2))),
        },
        {
          id: 'step_remainder',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_remainder',
            displayName: 'remainder',
          },
          expression: call('modulo', column('col_total_rounded'), literal(4)),
        },
        {
          id: 'step_safe_sum',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_safe_sum',
            displayName: 'safe_sum',
          },
          expression: call('add', column('col_price'), column('col_discount')),
        },
        {
          id: 'step_divide_by_zero',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_divide_by_zero',
            displayName: 'divide_by_zero',
          },
          expression: call('divide', column('col_total_rounded'), literal(0)),
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_total).toBeCloseTo(30.6);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_total_minus_discount).toBeCloseTo(28.6);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_total_rounded).toBe(29);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_total_abs).toBeCloseTo(28.6);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_unit_price_floor).toBe(14);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_unit_price_ceil).toBe(15);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_remainder).toBe(1);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_safe_sum).toBeCloseTo(12.2);
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_total).toBe(null);
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_safe_sum).toBe(null);
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_divide_by_zero).toBe(null);
  });

  it('evaluates date math deterministically with a stable now timestamp per execution', () => {
    const table = loadCsvTable('sign_up_date\r\n2026-01-02\r\nbad-date\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_date_math',
      name: 'Date math',
      steps: [
        {
          id: 'step_run_started',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_run_started',
            displayName: 'run_started',
          },
          expression: call('now'),
        },
        {
          id: 'step_run_started_again',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_run_started_again',
            displayName: 'run_started_again',
          },
          expression: call('now'),
        },
        {
          id: 'step_signup_year',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_signup_year',
            displayName: 'signup_year',
          },
          expression: call('datePart', column('col_sign_up_date'), literal('year')),
        },
        {
          id: 'step_follow_up_at',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_follow_up_at',
            displayName: 'follow_up_at',
          },
          expression: call('dateAdd', column('col_sign_up_date'), literal(7), literal('days')),
        },
        {
          id: 'step_days_diff',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_days_diff',
            displayName: 'days_diff',
          },
          expression: call(
            'dateDiff',
            call('dateAdd', column('col_sign_up_date'), literal(7), literal('days')),
            column('col_sign_up_date'),
            literal('days'),
          ),
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);
    const row1 = execution.transformedTable?.rowsById.row_1.cellsByColumnId;
    const row2 = execution.transformedTable?.rowsById.row_2.cellsByColumnId;

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(row1?.col_run_started).toBe(row1?.col_run_started_again);
    expect(typeof row1?.col_run_started).toBe('string');
    expect(row1?.col_signup_year).toBe(2026);
    expect(row1?.col_follow_up_at).toBe('2026-01-09T00:00:00.000Z');
    expect(row1?.col_days_diff).toBe(7);
    expect(row2?.col_signup_year).toBe(null);
    expect(row2?.col_follow_up_at).toBe(null);
    expect(row2?.col_days_diff).toBe(null);
  });

  it('evaluates explicit casts deterministically and enables downstream numeric sorting', () => {
    const table = loadCsvTable('value,flag,created_at\r\n 42 ,YES,2026-01-02\r\n0,no,2026-01-03\r\nhello,maybe,\r\n,1,2026-01-04\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_cast_runtime',
      name: 'Cast runtime',
      steps: [
        {
          id: 'step_value_number',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_value_number',
            displayName: 'value_number',
          },
          expression: call('toNumber', column('col_value')),
        },
        {
          id: 'step_flag_boolean',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_flag_boolean',
            displayName: 'flag_boolean',
          },
          expression: call('toBoolean', column('col_flag')),
        },
        {
          id: 'step_value_text',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_value_text',
            displayName: 'value_text',
          },
          expression: call('toString', column('col_value_number')),
        },
        {
          id: 'step_created_at_number',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_created_at_number',
            displayName: 'created_at_number',
          },
          expression: call('toNumber', column('col_created_at')),
        },
        {
          id: 'step_created_at_boolean',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_created_at_boolean',
            displayName: 'created_at_boolean',
          },
          expression: call('toBoolean', column('col_created_at')),
        },
        {
          id: 'step_sort_value_number',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'col_value_number',
              direction: 'asc',
            },
          ],
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);
    const row2 = execution.transformedTable?.rowsById.row_2.cellsByColumnId;
    const row1 = execution.transformedTable?.rowsById.row_1.cellsByColumnId;
    const row3 = execution.transformedTable?.rowsById.row_3.cellsByColumnId;
    const row4 = execution.transformedTable?.rowsById.row_4.cellsByColumnId;

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowOrder).toEqual(['row_2', 'row_1', 'row_3', 'row_4']);
    expect(row1?.col_value_number).toBe(42);
    expect(row2?.col_value_number).toBe(0);
    expect(row3?.col_value_number).toBe(null);
    expect(row4?.col_value_number).toBe(null);
    expect(row1?.col_flag_boolean).toBe(true);
    expect(row2?.col_flag_boolean).toBe(false);
    expect(row3?.col_flag_boolean).toBe(null);
    expect(row4?.col_flag_boolean).toBe(true);
    expect(row1?.col_value_text).toBe('42');
    expect(row2?.col_value_text).toBe('0');
    expect(row3?.col_value_text).toBe(null);
    expect(row4?.col_value_text).toBe(null);
    expect(row1?.col_created_at_number).toBe(null);
    expect(row1?.col_created_at_boolean).toBe(null);
  });

  it('filters rows with boolean call expressions and rejects incompatible comparators', async () => {
    const table = await readFixtureTable('orders-sample.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_filter_paid_orders',
      name: 'Filter paid orders',
      steps: [
        {
          id: 'step_filter_paid_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: call(
            'and',
            call('greaterThan', column('col_order_total'), literal(100)),
            call('equals', column('col_order_status'), literal('paid')),
          ),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowOrder).toEqual(['row_1', 'row_3', 'row_5']);
    expect(execution.removedRowCount).toBe(3);

    const invalidWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_filter_bad_compare',
      name: 'Filter bad compare',
      steps: [
        {
          id: 'step_filter_bad_compare',
          type: 'filterRows',
          mode: 'keep',
          condition: call('greaterThan', column('col_customer_email'), literal(100)),
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });

  it('filters rows with matchesRegex expressions and rejects invalid or incompatible regex inputs', () => {
    const table = loadCsvTable('email,order_total\r\nalice@example.com,100\r\nbob,200\r\ncarol@example.com,300\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_filter_regex',
      name: 'Filter regex',
      steps: [
        {
          id: 'step_filter_regex',
          type: 'filterRows',
          mode: 'keep',
          condition: call('matchesRegex', column('col_email'), literal('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')),
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowOrder).toEqual(['row_1', 'row_3']);

    const invalidRegexWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_filter_invalid_regex',
      name: 'Filter invalid regex',
      steps: [
        {
          id: 'step_filter_invalid_regex',
          type: 'filterRows',
          mode: 'keep',
          condition: call('matchesRegex', column('col_email'), literal('[a-z')),
        },
      ],
    };

    const invalidRegexValidation = validateWorkflowSemantics(invalidRegexWorkflow, table);

    expect(invalidRegexValidation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalidRegex',
          path: 'steps[0].condition.args[1]',
          stepId: 'step_filter_invalid_regex',
        }),
      ]),
    );

    const incompatibleWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_filter_numeric_regex',
      name: 'Filter numeric regex',
      steps: [
        {
          id: 'step_filter_numeric_regex',
          type: 'filterRows',
          mode: 'keep',
          condition: call('matchesRegex', column('col_order_total'), literal('^\\d+$')),
        },
      ],
    };

    const incompatibleValidation = validateWorkflowSemantics(incompatibleWorkflow, table);

    expect(incompatibleValidation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'incompatibleType',
          path: 'steps[0].condition.args[0]',
          stepId: 'step_filter_numeric_regex',
        }),
      ]),
    );
  });

  it('splits and combines columns deterministically and validates duplicate source references', () => {
    const splitTable = loadCsvTable('full_name\r\nAlice Ng\r\nBob\r\nCara Patel Singh\r\n\r\n');
    const splitWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_split_name',
      name: 'Split name',
      steps: [
        {
          id: 'step_split_name',
          type: 'splitColumn',
          columnId: 'col_full_name',
          delimiter: ' ',
          outputColumns: [
            {
              columnId: 'col_first_name',
              displayName: 'first_name',
            },
            {
              columnId: 'col_last_name',
              displayName: 'last_name',
            },
          ],
        },
      ],
    };

    const splitExecution = executeWorkflow(splitWorkflow, splitTable);

    expect(splitExecution.transformedTable?.rowsById.row_1.cellsByColumnId.col_first_name).toBe('Alice');
    expect(splitExecution.transformedTable?.rowsById.row_1.cellsByColumnId.col_last_name).toBe('Ng');
    expect(splitExecution.transformedTable?.rowsById.row_2.cellsByColumnId.col_first_name).toBe('Bob');
    expect(splitExecution.transformedTable?.rowsById.row_2.cellsByColumnId.col_last_name).toBe(null);
    expect(splitExecution.transformedTable?.rowsById.row_3.cellsByColumnId.col_last_name).toBe('Patel Singh');

    const combineTable = loadCsvTable('city,state\r\nSeattle,WA\r\n,\"\"\r\n\"   \",CA\r\n');
    const combineWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_combine_location',
      name: 'Combine location',
      steps: [
        {
          id: 'step_combine_location',
          type: 'combineColumns',
          columnIds: ['col_city', 'col_state'],
          separator: ', ',
          newColumn: {
            columnId: 'col_location',
            displayName: 'location',
          },
        },
      ],
    };

    const combineExecution = executeWorkflow(combineWorkflow, combineTable);

    expect(combineExecution.transformedTable?.rowsById.row_1.cellsByColumnId.col_location).toBe('Seattle, WA');
    expect(combineExecution.transformedTable?.rowsById.row_2.cellsByColumnId.col_location).toBe('');
    expect(combineExecution.transformedTable?.rowsById.row_3.cellsByColumnId.col_location).toBe('   , CA');

    const invalidWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_combine_duplicate_refs',
      name: 'Combine duplicate refs',
      steps: [
        {
          id: 'step_combine_duplicate_refs',
          type: 'combineColumns',
          columnIds: ['col_city', 'col_city'],
          separator: ', ',
          newColumn: {
            columnId: 'col_location',
            displayName: 'location',
          },
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, combineTable);

    expect(validation.issues.some((issue) => issue.code === 'duplicateColumnReference')).toBe(true);
  });

  it('deduplicates rows with keep-first semantics after sorting and keeps nulls last', () => {
    const dedupeTable = loadCsvTable('email,name\r\nalice@example.com,Alice A\r\nalice@example.com,Alice Z\r\nbob@example.com,Bob\r\n');
    const dedupeWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_sort_then_dedupe',
      name: 'Sort then dedupe',
      steps: [
        {
          id: 'step_sort_name_desc',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'col_name',
              direction: 'desc',
            },
          ],
        },
        {
          id: 'step_dedupe_email',
          type: 'deduplicateRows',
          columnIds: ['col_email'],
        },
      ],
    };

    const dedupeExecution = executeWorkflow(dedupeWorkflow, dedupeTable);

    expect(dedupeExecution.transformedTable?.rowOrder).toEqual(['row_3', 'row_2']);
    expect(dedupeExecution.transformedTable?.rowsById.row_2.cellsByColumnId.col_name).toBe('Alice Z');
    expect(dedupeExecution.removedRowCount).toBe(1);

    const sortTable = loadCsvTable('name,score\r\nA,2\r\nB,\r\nC,2\r\nD,1\r\n');
    const sortWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_sort_scores',
      name: 'Sort scores',
      steps: [
        {
          id: 'step_sort_scores',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'col_score',
              direction: 'desc',
            },
          ],
        },
      ],
    };

    const sortExecution = executeWorkflow(sortWorkflow, sortTable);

    expect(sortExecution.transformedTable?.rowOrder).toEqual(['row_1', 'row_3', 'row_4', 'row_2']);
    expect(sortExecution.rowOrderChanged).toBe(true);

    const invalidSortWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_sort_mixed',
      name: 'Sort mixed',
      steps: [
        {
          id: 'step_sort_mixed',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'col_value',
              direction: 'asc',
            },
          ],
        },
      ],
    };

    const mixedTable = loadCsvTable('value\r\n1\r\nhello\r\n');
    const validation = validateWorkflowSemantics(invalidSortWorkflow, mixedTable);

    expect(validation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });

  it('returns execution metadata suitable for later preview and diff work', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_metadata',
      name: 'Metadata',
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedRule',
          columnIds: ['col_status'],
          defaultPatch: {
            value: coalesce(value(), literal('unknown')),
          },
        },
        {
          id: 'step_make_location',
          type: 'combineColumns',
          columnIds: ['col_city', 'col_state'],
          separator: ', ',
          newColumn: {
            columnId: 'col_location',
            displayName: 'location',
          },
        },
        {
          id: 'step_drop_missing_email',
          type: 'filterRows',
          mode: 'drop',
          condition: call('isEmpty', column('col_email')),
        },
        {
          id: 'step_sort_signup',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'col_signup_date',
              direction: 'desc',
            },
          ],
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable).not.toBeNull();
    expect(execution.createdColumnIds).toEqual(['col_location']);
    expect(execution.removedRowCount).toBe(1);
    expect(execution.changedRowCount).toBeGreaterThan(0);
    expect(execution.changedCellCount).toBeGreaterThan(0);
    expect(execution.rowOrderChanged).toBe(true);
    expect(execution.sortApplied).toBe(true);
  });
});

async function readFixtureTable(fileName: string): Promise<Table> {
  const fixturePath = path.resolve(process.cwd(), 'fixtures', fileName);
  const workbook = importCsvWorkbook(fileName, await readFile(fixturePath, 'utf8'));
  const table = getActiveTable(workbook);

  if (!table) {
    throw new Error(`Expected active table for fixture '${fileName}'.`);
  }

  return table;
}

function loadCsvTable(text: string): Table {
  const workbook = importCsvWorkbook('inline.csv', text);
  const table = getActiveTable(workbook);

  if (!table) {
    throw new Error('Expected active table for inline CSV.');
  }

  return table;
}

function value(): WorkflowExpression {
  return { kind: 'value' };
}

function literal(cellValue: string | number | boolean | null): WorkflowExpression {
  return {
    kind: 'literal',
    value: cellValue,
  };
}

function column(columnId: string): WorkflowExpression {
  return {
    kind: 'column',
    columnId,
  };
}

type MatchCase = Extract<WorkflowExpression, { kind: 'match' }>['cases'][number];

function call(
  name:
    | 'now'
    | 'datePart'
    | 'dateDiff'
    | 'dateAdd'
    | 'trim'
    | 'lower'
    | 'upper'
    | 'toNumber'
    | 'toString'
    | 'toBoolean'
    | 'collapseWhitespace'
    | 'substring'
    | 'replace'
    | 'extractRegex'
    | 'replaceRegex'
    | 'split'
    | 'atIndex'
    | 'length'
    | 'round'
    | 'floor'
    | 'ceil'
    | 'abs'
    | 'add'
    | 'subtract'
    | 'multiply'
    | 'divide'
    | 'modulo'
    | 'first'
    | 'last'
    | 'coalesce'
    | 'concat'
    | 'equals'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'matchesRegex'
    | 'greaterThan'
    | 'lessThan'
    | 'and'
    | 'or'
    | 'not'
    | 'isEmpty',
  ...args: WorkflowExpression[]
): WorkflowExpression {
  return {
    kind: 'call',
    name,
    args,
  };
}

function match(subject: WorkflowExpression, cases: MatchCase[]): WorkflowExpression {
  return {
    kind: 'match',
    subject,
    cases,
  };
}

function caseValue(): WorkflowExpression {
  return {
    kind: 'caseValue',
  };
}

function matchWhen(when: WorkflowExpression, then: WorkflowExpression): MatchCase {
  return {
    kind: 'when',
    when,
    then,
  };
}

function matchOtherwise(then: WorkflowExpression): MatchCase {
  return {
    kind: 'otherwise',
    then,
  };
}

function coalesce(first: WorkflowExpression, second: WorkflowExpression): WorkflowExpression {
  return call('coalesce', first, second);
}

function concat(...args: WorkflowExpression[]): WorkflowExpression {
  return call('concat', ...args);
}
