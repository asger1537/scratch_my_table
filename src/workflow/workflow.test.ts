import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCsvWorkbook } from '../domain/csv';
import { getActiveTable, type Table } from '../domain/model';
import { executeWorkflow, validateWorkflowSemantics, validateWorkflowStructure, type Workflow } from './index';

describe('Milestone 2 workflow validation and execution', () => {
  it('structurally validates workflow JSON and rejects duplicate step IDs', () => {
    const validWorkflow = {
      version: 1,
      workflowId: 'wf_valid',
      name: 'Valid workflow',
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

    expect(validateWorkflowStructure(validWorkflow).valid).toBe(true);

    const duplicateStepIdWorkflow = {
      version: 1,
      workflowId: 'wf_duplicate_steps',
      name: 'Duplicate steps',
      steps: [
        {
          id: 'step_repeat',
          type: 'fillEmpty',
          target: {
            kind: 'columns',
            columnIds: ['col_status'],
          },
          value: 'unknown',
          treatWhitespaceAsEmpty: false,
        },
        {
          id: 'step_repeat',
          type: 'renameColumn',
          columnId: 'col_status',
          newDisplayName: 'status_clean',
        },
      ],
    };

    const validation = validateWorkflowStructure(duplicateStepIdWorkflow);

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'duplicateStepId')).toBe(true);
  });

  it('reports structural schema violations separately from semantic validation', () => {
    const invalidWorkflow = {
      version: 1,
      workflowId: 'wf_missing_name',
      steps: [],
    };

    const validation = validateWorkflowStructure(invalidWorkflow);

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'schema.required' && issue.path === 'name')).toBe(true);
  });

  it('lets later valid steps see schema changes from earlier valid steps', () => {
    const table = loadCsvTable('first_name,last_name\r\nAlice,Ng\r\n');
    const workflow: Workflow = {
      version: 1,
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
          expression: {
            kind: 'concat',
            parts: [
              { kind: 'column', columnId: 'col_first_name' },
              { kind: 'literal', value: ' ' },
              { kind: 'column', columnId: 'col_last_name' },
            ],
          },
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
    expect(validation.finalSchema.columns.find((column) => column.columnId === 'col_full_name')?.displayName).toBe('display_name');
  });

  it('does not let invalid steps contribute schema changes to later validation', () => {
    const table = loadCsvTable('first_name,last_name\r\nAlice,Ng\r\n');
    const workflow: Workflow = {
      version: 1,
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
          expression: {
            kind: 'literal',
            value: 'Alice Ng',
          },
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

  it('fills empty cells deterministically and validates type compatibility', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const validWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_fill_status',
      name: 'Fill status',
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

    const execution = executeWorkflow(validWorkflow, table);

    expect(execution.validationErrors).toEqual([]);
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_status).toBe('unknown');
    expect(execution.transformedTable?.rowsById.row_5.cellsByColumnId.col_status).toBe('unknown');
    expect(execution.changedCellCount).toBe(2);

    const invalidWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_fill_bad_type',
      name: 'Fill bad type',
      steps: [
        {
          id: 'step_fill_bad_type',
          type: 'fillEmpty',
          target: {
            kind: 'columns',
            columnIds: ['col_status'],
          },
          value: 1,
          treatWhitespaceAsEmpty: false,
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });

  it('normalizes text and rejects non-string targets', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_normalize_text',
      name: 'Normalize text',
      steps: [
        {
          id: 'step_normalize_email',
          type: 'normalizeText',
          target: {
            kind: 'columns',
            columnIds: ['col_email'],
          },
          trim: true,
          collapseWhitespace: false,
          case: 'lower',
        },
        {
          id: 'step_normalize_name',
          type: 'normalizeText',
          target: {
            kind: 'columns',
            columnIds: ['col_full_name'],
          },
          trim: true,
          collapseWhitespace: true,
          case: 'preserve',
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_email).toBe('alice.ng@example.com');
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_full_name).toBe('Alice Ng');

    const invalidWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_normalize_bad_column',
      name: 'Normalize bad column',
      steps: [
        {
          id: 'step_normalize_date',
          type: 'normalizeText',
          target: {
            kind: 'columns',
            columnIds: ['col_signup_date'],
          },
          trim: true,
          collapseWhitespace: false,
          case: 'preserve',
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });

  it('renames a column display name without changing its stable column ID', () => {
    const table = loadCsvTable('customer_id,email\r\nC001,alice@example.com\r\n');
    const workflow: Workflow = {
      version: 1,
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

  it('derives columns from concat and coalesce expressions and rejects incompatible coalesce inputs', () => {
    const table = loadCsvTable('first_name,last_name,nickname,total\r\nAlice,Ng,,1\r\nBob,,Bobby,2\r\n');
    const validWorkflow: Workflow = {
      version: 1,
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
          expression: {
            kind: 'coalesce',
            inputs: [
              { kind: 'column', columnId: 'col_nickname' },
              {
                kind: 'concat',
                parts: [
                  { kind: 'column', columnId: 'col_first_name' },
                  { kind: 'literal', value: ' ' },
                  { kind: 'column', columnId: 'col_last_name' },
                ],
              },
            ],
          },
        },
      ],
    };

    const execution = executeWorkflow(validWorkflow, table);

    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_display_name).toBe('Alice Ng');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_display_name).toBe('Bobby');

    const invalidWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_derive_bad_coalesce',
      name: 'Derive bad coalesce',
      steps: [
        {
          id: 'step_bad_coalesce',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_bad',
            displayName: 'bad',
          },
          expression: {
            kind: 'coalesce',
            inputs: [
              { kind: 'column', columnId: 'col_total' },
              { kind: 'literal', value: 'fallback' },
            ],
          },
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });

  it('filters rows with recursive conditions and rejects incompatible comparators', async () => {
    const table = await readFixtureTable('orders-sample.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_filter_paid_orders',
      name: 'Filter paid orders',
      steps: [
        {
          id: 'step_filter_paid_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: {
            kind: 'and',
            conditions: [
              {
                kind: 'greaterThan',
                columnId: 'col_order_total',
                value: 100,
              },
              {
                kind: 'equals',
                columnId: 'col_order_status',
                value: 'paid',
              },
            ],
          },
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowOrder).toEqual(['row_1', 'row_3', 'row_5']);
    expect(execution.removedRowCount).toBe(3);

    const invalidWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_filter_bad_compare',
      name: 'Filter bad compare',
      steps: [
        {
          id: 'step_filter_bad_compare',
          type: 'filterRows',
          mode: 'keep',
          condition: {
            kind: 'greaterThan',
            columnId: 'col_customer_email',
            value: 100,
          },
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.issues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });

  it('splits columns into explicit outputs and validates output name conflicts', () => {
    const table = loadCsvTable('full_name\r\nAlice Ng\r\nBob\r\nCara Patel Singh\r\n\r\n');
    const workflow: Workflow = {
      version: 1,
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

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_first_name).toBe('Alice');
    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_last_name).toBe('Ng');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_first_name).toBe('Bob');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_last_name).toBe(null);
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_last_name).toBe('Patel Singh');
    expect(execution.transformedTable?.rowsById.row_4.cellsByColumnId.col_first_name).toBe(null);

    const invalidWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_split_name_conflict',
      name: 'Split name conflict',
      steps: [
        {
          id: 'step_split_name_conflict',
          type: 'splitColumn',
          columnId: 'col_full_name',
          delimiter: ' ',
          outputColumns: [
            {
              columnId: 'col_first_name',
              displayName: 'full_name',
            },
            {
              columnId: 'col_last_name',
              displayName: 'last_name',
            },
          ],
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.issues.some((issue) => issue.code === 'nameConflict')).toBe(true);
  });

  it('combines columns deterministically and rejects duplicate source references', () => {
    const table = loadCsvTable('city,state\r\nSeattle,WA\r\n,\"\"\r\n\"   \",CA\r\n');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_combine_location',
      name: 'Combine location',
      steps: [
        {
          id: 'step_combine_location',
          type: 'combineColumns',
          target: {
            kind: 'columns',
            columnIds: ['col_city', 'col_state'],
          },
          separator: ', ',
          newColumn: {
            columnId: 'col_location',
            displayName: 'location',
          },
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowsById.row_1.cellsByColumnId.col_location).toBe('Seattle, WA');
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_location).toBe('');
    expect(execution.transformedTable?.rowsById.row_3.cellsByColumnId.col_location).toBe('   , CA');

    const invalidWorkflow: Workflow = {
      version: 1,
      workflowId: 'wf_combine_duplicate_refs',
      name: 'Combine duplicate refs',
      steps: [
        {
          id: 'step_combine_duplicate_refs',
          type: 'combineColumns',
          target: {
            kind: 'columns',
            columnIds: ['col_city', 'col_city'],
          },
          separator: ', ',
          newColumn: {
            columnId: 'col_location',
            displayName: 'location',
          },
        },
      ],
    };

    const validation = validateWorkflowSemantics(invalidWorkflow, table);

    expect(validation.issues.some((issue) => issue.code === 'duplicateColumnReference')).toBe(true);
  });

  it('deduplicates rows with keep-first semantics based on the current row order', () => {
    const table = loadCsvTable('email,name\r\nalice@example.com,Alice A\r\nalice@example.com,Alice Z\r\nbob@example.com,Bob\r\n');
    const workflow: Workflow = {
      version: 1,
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
          target: {
            kind: 'columns',
            columnIds: ['col_email'],
          },
        },
      ],
    };

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowOrder).toEqual(['row_3', 'row_2']);
    expect(execution.transformedTable?.rowsById.row_2.cellsByColumnId.col_name).toBe('Alice Z');
    expect(execution.removedRowCount).toBe(1);
  });

  it('sorts stably and keeps nulls last regardless of direction', () => {
    const table = loadCsvTable('name,score\r\nA,2\r\nB,\r\nC,2\r\nD,1\r\n');
    const workflow: Workflow = {
      version: 1,
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

    const execution = executeWorkflow(workflow, table);

    expect(execution.transformedTable?.rowOrder).toEqual(['row_1', 'row_3', 'row_4', 'row_2']);
    expect(execution.rowOrderChanged).toBe(true);

    const invalidSortWorkflow: Workflow = {
      version: 1,
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
      version: 1,
      workflowId: 'wf_metadata',
      name: 'Metadata',
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
        {
          id: 'step_make_location',
          type: 'combineColumns',
          target: {
            kind: 'columns',
            columnIds: ['col_city', 'col_state'],
          },
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
          condition: {
            kind: 'isEmpty',
            columnId: 'col_email',
            treatWhitespaceAsEmpty: false,
          },
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
