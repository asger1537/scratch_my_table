import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCsvWorkbook } from '../domain/csv';
import { getActiveTable, type Table } from '../domain/model';
import { type Workflow } from '../workflow';

import { BLOCK_TYPES } from './blocks';
import { runWorkspaceWorkflow, validateWorkspaceWorkflow } from './integration';
import {
  collectWorkflowColumnIds,
  createDefaultWorkflow,
  createHeadlessWorkflowWorkspace,
  parseWorkflowJson,
  setEditorSchemaColumns,
  workflowToJson,
  workflowToWorkspace,
  workspaceToWorkflow,
} from './index';

describe('Milestone 3 block editor mapping and integration', () => {
  it('serializes block-authored workflows to canonical IR across all V1 step types', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow = buildAllStepsWorkflow();
    const workspace = buildWorkspace(table, workflow);

    const result = workspaceToWorkflow(workspace);

    expect(result.issues).toEqual([]);
    expect(result.workflow).toEqual(workflow);
  });

  it('reconstructs a representative canonical workflow back into blocks and roundtrips without semantic loss', async () => {
    const table = await readFixtureTable('orders-sample.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_orders_cleanup',
      name: 'Orders cleanup',
      description: 'Keep paid orders, build ship location, and sort newest first.',
      steps: [
        {
          id: 'step_keep_paid_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: {
            kind: 'equals',
            columnId: 'col_order_status',
            value: 'paid',
          },
        },
        {
          id: 'step_ship_location',
          type: 'combineColumns',
          target: {
            kind: 'columns',
            columnIds: ['col_ship_city', 'col_ship_state'],
          },
          separator: ', ',
          newColumn: {
            columnId: 'col_ship_location',
            displayName: 'ship_location',
          },
        },
        {
          id: 'step_sort_orders',
          type: 'sortRows',
          sorts: [
            {
              columnId: 'col_ordered_at',
              direction: 'desc',
            },
            {
              columnId: 'col_order_total',
              direction: 'desc',
            },
          ],
        },
      ],
    };
    const workspace = buildWorkspace(table, workflow);

    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('roundtrips canonical example workflows through JSON import and export helpers', () => {
    const workflow = buildAllStepsWorkflow();
    const json = workflowToJson(workflow);
    const parsed = parseWorkflowJson(json);

    expect(parsed.issues).toEqual([]);
    expect(parsed.workflow).toEqual(workflow);
  });

  it('surfaces incomplete block workspaces clearly instead of silently producing mutated IR', () => {
    const table = loadCsvTable('email,status\r\nalice@example.com,\r\n');
    const workspace = buildWorkspace(table, createDefaultWorkflow(table));
    const root = workspace.getTopBlocks(false).find((block) => block.type === BLOCK_TYPES.workflowRoot);

    if (!root) {
      throw new Error('Expected workflow root block.');
    }

    const fillStep = workspace.newBlock(BLOCK_TYPES.fillEmptyStep);
    fillStep.setFieldValue('step_fill_status', 'STEP_ID');
    const rootConnection = root.getInput('STEPS')?.connection;

    if (!fillStep.previousConnection || !rootConnection) {
      throw new Error('Expected workflow root statement connection.');
    }

    fillStep.previousConnection.connect(rootConnection);

    const result = workspaceToWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues.some((issue) => issue.code === 'missingInput')).toBe(true);
  });

  it('keeps authored column selections as explicit columnId references in serialized workflows', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_column_resolution',
      name: 'Column resolution',
      steps: [
        {
          id: 'step_target_columns',
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
    const workspace = buildWorkspace(table, workflow);

    const result = workspaceToWorkflow(workspace);

    expect(result.workflow?.steps[0]).toEqual(workflow.steps[0]);
    expect(JSON.stringify(result.workflow)).not.toContain('Seattle');
  });

  it('serializes derive expressions and filter condition trees from the block workspace', async () => {
    const table = await readFixtureTable('orders-sample.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_expression_condition',
      name: 'Expression and condition',
      steps: [
        {
          id: 'step_derive_label',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_order_label',
            displayName: 'order_label',
          },
          expression: {
            kind: 'concat',
            parts: [
              { kind: 'literal', value: 'Order ' },
              { kind: 'column', columnId: 'col_order_id' },
              { kind: 'literal', value: ' - ' },
              {
                kind: 'coalesce',
                inputs: [
                  { kind: 'column', columnId: 'col_customer_email' },
                  { kind: 'literal', value: 'missing email' },
                ],
              },
            ],
          },
        },
        {
          id: 'step_filter_orders',
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
                kind: 'not',
                condition: {
                  kind: 'isEmpty',
                  columnId: 'col_customer_email',
                  treatWhitespaceAsEmpty: false,
                },
              },
            ],
          },
        },
      ],
    };
    const workspace = buildWorkspace(table, workflow);

    const result = workspaceToWorkflow(workspace);

    expect(result.issues).toEqual([]);
    expect(result.workflow).toEqual(workflow);
  });

  it('runs a block-authored workflow through the existing validator and executor', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_run_from_blocks',
      name: 'Run from blocks',
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
          id: 'step_drop_missing_email',
          type: 'filterRows',
          mode: 'drop',
          condition: {
            kind: 'isEmpty',
            columnId: 'col_email',
            treatWhitespaceAsEmpty: false,
          },
        },
      ],
    };
    const workspace = buildWorkspace(table, workflow);
    const run = runWorkspaceWorkflow(workspace, table);

    expect(run.editorIssues).toEqual([]);
    expect(run.validationIssues).toEqual([]);
    expect(run.executionResult?.transformedTable).not.toBeNull();
    expect(run.executionResult?.removedRowCount).toBe(1);
    expect(run.executionResult?.changedCellCount).toBeGreaterThan(0);
  });

  it('flags editor-authored workflows that are structurally complete but semantically invalid for the active table', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 1,
      workflowId: 'wf_bad_semantics',
      name: 'Bad semantics',
      steps: [
        {
          id: 'step_normalize_signup_date',
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
    const workspace = buildWorkspace(table, workflow);
    const validation = validateWorkspaceWorkflow(workspace, table);

    expect(validation.editorIssues).toEqual([]);
    expect(validation.validationIssues.some((issue) => issue.code === 'incompatibleType')).toBe(true);
  });
});

function buildWorkspace(table: Table, workflow: Workflow) {
  const workspace = createHeadlessWorkflowWorkspace();

  setEditorSchemaColumns(table.schema.columns, collectWorkflowColumnIds(workflow));
  workflowToWorkspace(workspace, workflow);

  return workspace;
}

function buildAllStepsWorkflow(): Workflow {
  return {
    version: 1,
    workflowId: 'wf_all_steps',
    name: 'All steps',
    description: 'Covers every V1 step type.',
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
        id: 'step_normalize_text',
        type: 'normalizeText',
        target: {
          kind: 'columns',
          columnIds: ['col_email', 'col_city'],
        },
        trim: true,
        collapseWhitespace: true,
        case: 'lower',
      },
      {
        id: 'step_rename_customer_id',
        type: 'renameColumn',
        columnId: 'col_customer_id',
        newDisplayName: 'external_customer_id',
      },
      {
        id: 'step_derive_location',
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_display_location',
          displayName: 'display_location',
        },
        expression: {
          kind: 'concat',
          parts: [
            { kind: 'column', columnId: 'col_city' },
            { kind: 'literal', value: ', ' },
            {
              kind: 'coalesce',
              inputs: [
                { kind: 'column', columnId: 'col_state' },
                { kind: 'literal', value: 'unknown' },
              ],
            },
          ],
        },
      },
      {
        id: 'step_filter_rows',
        type: 'filterRows',
        mode: 'keep',
        condition: {
          kind: 'and',
          conditions: [
            {
              kind: 'not',
              condition: {
                kind: 'isEmpty',
                columnId: 'col_email',
                treatWhitespaceAsEmpty: false,
              },
            },
            {
              kind: 'contains',
              columnId: 'col_email',
              value: '@',
            },
          ],
        },
      },
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
      {
        id: 'step_combine_columns',
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
        id: 'step_dedupe_rows',
        type: 'deduplicateRows',
        target: {
          kind: 'columns',
          columnIds: ['col_email'],
        },
      },
      {
        id: 'step_sort_rows',
        type: 'sortRows',
        sorts: [
          {
            columnId: 'col_signup_date',
            direction: 'desc',
          },
          {
            columnId: 'col_full_name',
            direction: 'asc',
          },
        ],
      },
    ],
  };
}

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
