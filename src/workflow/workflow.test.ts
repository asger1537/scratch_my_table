import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCsvWorkbook } from '../domain/csv';
import { getActiveTable, type Table } from '../domain/model';
import { importXlsxWorkbook } from '../domain/xlsx';
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
          type: 'scopedTransform',
          columnIds: ['col_status'],
          expression: coalesce(value(), literal('unknown')),
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
          type: 'scopedTransform',
          columnIds: ['col_status'],
          expression: coalesce(value(), literal('unknown')),
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
          type: 'scopedTransform',
          columnIds: ['col_email'],
          expression: {
            kind: 'call',
            name: 'lower',
            args: [value(), literal('extra')],
          },
        },
      ],
    };

    const invalidValidation = validateWorkflowStructure(invalidWorkflow);

    expect(invalidValidation.valid).toBe(false);
    expect(invalidValidation.issues.some((issue) => issue.code === 'schema.maxItems')).toBe(true);
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

  it('structurally validates switch expressions', () => {
    const workflow = {
      version: 2,
      workflowId: 'wf_switch_structure',
      name: 'Switch structure',
      steps: [
        {
          id: 'step_switch_status',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_status_label',
            displayName: 'status_label',
          },
          expression: call(
            'switch',
            column('col_status'),
            literal('active'),
            literal('A'),
            literal('inactive'),
            literal('I'),
            literal('other'),
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
      const workflow = JSON.parse(await readFile(path.join(exampleDirectory, fileName), 'utf8')) as Workflow;
      const structural = validateWorkflowStructure(workflow);
      const semantic = validateWorkflowSemantics(workflow, table);
      const execution = executeWorkflow(workflow, table);

      expect(structural.valid, `${fileName} should pass structural validation`).toBe(true);
      expect(semantic.valid, `${fileName} should pass semantic validation`).toBe(true);
      expect(execution.validationErrors, `${fileName} should execute without validation errors`).toEqual([]);
      expect(execution.transformedTable, `${fileName} should produce a transformed table`).not.toBeNull();
    }
  }, 20000);

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

  it('executes scoped transforms with row conditions, multi-column targets, and explicit coalesce emptiness semantics', () => {
    const table = loadCsvTable('first_name,last_name,status,region\r\nAlice,Ng,,west\r\nAmy,Adams,  ,west\r\nBen,Ortiz,,east\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_scoped_fill',
      name: 'Scoped fill',
      steps: [
        {
          id: 'step_fill_unknown',
          type: 'scopedTransform',
          columnIds: ['col_first_name', 'col_last_name', 'col_status'],
          rowCondition: call('equals', column('col_region'), literal('west')),
          expression: coalesce(value(), literal('unknown')),
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

  it('allows scoped transforms to read another column from the same row', () => {
    const table = loadCsvTable('customer_id,email\r\nC001,\r\nC002,bob@example.com\r\nC003,   \r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_fill_email_from_customer_id',
      name: 'Fill email from customer id',
      steps: [
        {
          id: 'step_fill_email',
          type: 'scopedTransform',
          columnIds: ['col_email'],
          expression: coalesce(value(), column('col_customer_id')),
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

  it('executes nested built-in scoped-transform functions deterministically', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_transform_text',
      name: 'Transform text',
      steps: [
        {
          id: 'step_normalize_email',
          type: 'scopedTransform',
          columnIds: ['col_email'],
          expression: call('lower', call('trim', value())),
        },
        {
          id: 'step_clean_full_name',
          type: 'scopedTransform',
          columnIds: ['col_full_name'],
          expression: call('replace', call('collapseWhitespace', call('trim', value())), literal('Ng'), literal('NG')),
        },
        {
          id: 'step_abbreviate_status',
          type: 'scopedTransform',
          columnIds: ['col_status'],
          rowCondition: call('not', call('isEmpty', call('trim', column('col_status')))),
          expression: call('substring', call('upper', call('trim', value())), literal(0), literal(3)),
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

  it('rejects incompatible scoped-transform expressions and invalid value references', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const incompatibleWorkflow: Workflow = {
      version: 2,
      workflowId: 'wf_bad_lower',
      name: 'Bad lower',
      steps: [
        {
          id: 'step_bad_lower',
          type: 'scopedTransform',
          columnIds: ['col_signup_date'],
          expression: call('lower', value()),
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

  it('evaluates switch deterministically with ordered cases and a default result', () => {
    const table = loadCsvTable('status\r\nactive\r\ninactive\r\npending\r\n');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_switch_status_label',
      name: 'Switch status label',
      steps: [
        {
          id: 'step_switch_status_label',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_status_label',
            displayName: 'status_label',
          },
          expression: call(
            'switch',
            column('col_status'),
            literal('active'),
            literal('A'),
            literal('inactive'),
            literal('I'),
            literal('other'),
          ),
        },
      ],
    };

    const validation = validateWorkflowSemantics(workflow, table);
    const execution = executeWorkflow(workflow, table);

    expect(validation.valid).toBe(true);
    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_status_label).toBe('A');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_status_label).toBe('I');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_status_label).toBe('other');
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
          type: 'scopedTransform',
          columnIds: ['col_status'],
          expression: coalesce(value(), literal('unknown')),
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

function call(
  name:
    | 'now'
    | 'datePart'
    | 'dateDiff'
    | 'dateAdd'
    | 'trim'
    | 'lower'
    | 'upper'
    | 'collapseWhitespace'
    | 'substring'
    | 'replace'
    | 'extractRegex'
    | 'replaceRegex'
    | 'split'
    | 'atIndex'
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
    | 'switch'
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

function coalesce(first: WorkflowExpression, second: WorkflowExpression): WorkflowExpression {
  return call('coalesce', first, second);
}

function concat(...args: WorkflowExpression[]): WorkflowExpression {
  return call('concat', ...args);
}
