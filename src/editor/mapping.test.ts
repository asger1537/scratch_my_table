import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { importCsvWorkbook } from '../domain/csv';
import { getActiveTable, type Table } from '../domain/model';
import { executeWorkflow, type Workflow, type WorkflowExpression } from '../workflow';

import { type AuthoringWorkflow, authoringWorkflowToWorkflow, workflowToAuthoringWorkflow } from './authoring';
import { formatColumnSelectionSummary, getSelectableColumnTypeGroups, getSelectableColumns, serializeColumnSelectionValue } from './FieldColumnMultiSelect';
import { BLOCK_TYPES } from './blocks';
import { runWorkspaceWorkflow, validateWorkspaceWorkflow } from './integration';
import {
  collectWorkflowColumnIds,
  createHeadlessWorkflowWorkspace,
  getWorkspaceMetadata,
  parseWorkflowJson,
  setEditorSchemaColumns,
  workflowToJson,
  workflowToWorkspace,
  workspaceToAuthoringWorkflow,
  workspaceToWorkflow,
} from './index';

describe('block-based workflow authoring', () => {
  it('loads a simple scoped transform as one compact step block with nested function blocks', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_normalize_email',
      name: 'Normalize email',
      description: 'Lowercase trimmed email values.',
      steps: [
        {
          id: 'step_normalize_email',
          type: 'scopedTransform',
          columnIds: ['col_email'],
          expression: call('lower', call('trim', value())),
          treatWhitespaceAsEmpty: false,
        },
      ],
    };
    const workspace = buildWorkspaceFromTable(table, workflow);
    const authored = workspaceToAuthoringWorkflow(workspace);
    const [topBlock] = workspace.getTopBlocks(false);
    const authoredStep = authored.workflow?.steps[0];

    if (!authoredStep || authoredStep.kind !== 'scopedTransform') {
      throw new Error('Expected a scoped transform authoring step.');
    }

    expect(workspace.getTopBlocks(false)).toHaveLength(1);
    expect(workspace.getAllBlocks(false).map((block) => block.type).sort()).toEqual([
      BLOCK_TYPES.currentValueExpression,
      BLOCK_TYPES.lowerFunction,
      BLOCK_TYPES.scopedTransformStep,
      BLOCK_TYPES.trimFunction,
    ]);
    expect(topBlock?.type).toBe(BLOCK_TYPES.scopedTransformStep);
    expect(getWorkspaceMetadata(workspace)).toEqual({
      workflowId: workflow.workflowId,
      name: workflow.name,
      description: workflow.description,
    });
    expect(authored.issues).toEqual([]);
    expect(authoredStep.columnIds).toEqual(['col_email']);
    expect(authoredStep.expression).toEqual(call('lower', call('trim', value())));
  });

  it('compiles multi-select scoped transforms with row conditions directly to canonical v2 IR', () => {
    const authoringWorkflow: AuthoringWorkflow = {
      metadata: {
        workflowId: 'wf_scoped_transform',
        name: 'Scoped transform',
      },
      steps: [
        {
          kind: 'scopedTransform',
          columnIds: ['col_first_name', 'col_last_name'],
          rowCondition: {
            kind: 'and',
            conditions: [
              {
                kind: 'startsWith',
                columnId: 'col_first_name',
                value: 'A',
              },
              {
                kind: 'startsWith',
                columnId: 'col_last_name',
                value: 'A',
              },
            ],
          },
          expression: call('substring', value(), literal(0), literal(3)),
          treatWhitespaceAsEmpty: false,
        },
      ],
    };

    const compiled = authoringWorkflowToWorkflow(authoringWorkflow);

    expect(compiled.issues).toEqual([]);
    expect(compiled.workflow).toEqual({
      version: 2,
      workflowId: 'wf_scoped_transform',
      name: 'Scoped transform',
      description: undefined,
      steps: [
        {
          id: 'step_scoped_transform_1',
          type: 'scopedTransform',
          columnIds: ['col_first_name', 'col_last_name'],
          rowCondition: {
            kind: 'and',
            conditions: [
              {
                kind: 'startsWith',
                columnId: 'col_first_name',
                value: 'A',
              },
              {
                kind: 'startsWith',
                columnId: 'col_last_name',
                value: 'A',
              },
            ],
          },
          expression: call('substring', value(), literal(0), literal(3)),
          treatWhitespaceAsEmpty: false,
        },
      ],
    });
  });

  it('roundtrips canonical workflows through the authoring model without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_roundtrip',
      name: 'Roundtrip',
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedTransform',
          columnIds: ['col_status'],
          expression: coalesce(value(), literal('unknown')),
          treatWhitespaceAsEmpty: true,
        },
        {
          id: 'step_derive_display_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_display_name',
            displayName: 'display_name',
          },
          expression: concat(column('col_first_name'), literal(' '), column('col_last_name')),
        },
      ],
    };

    const authored = workflowToAuthoringWorkflow(workflow);
    const roundtrip = authoringWorkflowToWorkflow(authored);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('roundtrips scoped transforms that mix value() and same-row column() references', () => {
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
          treatWhitespaceAsEmpty: true,
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_email', 'col_customer_id'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.columnExpression);
  });

  it('reconstructs split, first, and last function trees in derive-column blocks', () => {
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
            call('first', column('col_first_name')),
            call('first', call('last', call('split', column('col_last_name'), literal(' ')))),
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_first_name', 'col_last_name', 'col_initials'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.splitFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.firstFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.lastFunction);
  });

  it('reconstructs drop-columns steps as a dedicated multi-select table-operation block', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_drop_columns',
      name: 'Drop columns',
      steps: [
        {
          id: 'step_drop_columns',
          type: 'dropColumns',
          columnIds: ['col_notes', 'col_internal_flag'],
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_notes', 'col_internal_flag'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getTopBlocks(false)[0]?.type).toBe(BLOCK_TYPES.dropColumnsStep);
  });

  it('roundtrips example workflows through the block workspace without semantic loss', async () => {
    const exampleDir = path.resolve(process.cwd(), 'examples', 'workflows');
    const exampleFiles = (await readdir(exampleDir))
      .filter((fileName) => fileName.endsWith('.workflow.json'))
      .sort();

    for (const fileName of exampleFiles) {
      const parsed = parseWorkflowJson(await readFile(path.join(exampleDir, fileName), 'utf8'));

      expect(parsed.issues, fileName).toEqual([]);
      expect(parsed.workflow, fileName).not.toBeNull();

      const workflow = parsed.workflow!;
      const workspace = buildWorkspaceFromColumnIds(collectWorkflowColumnIds(workflow), workflow);
      const roundtrip = workspaceToWorkflow(workspace);

      expect(roundtrip.issues, fileName).toEqual([]);
      expect(roundtrip.workflow, fileName).toEqual(workflow);
    }
  });

  it('keeps validation and execution wired to canonical IR after block serialization', async () => {
    const table = await readFixtureTable('messy-customers.csv');
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_run_from_editor',
      name: 'Run from editor',
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedTransform',
          columnIds: ['col_status'],
          expression: coalesce(value(), literal('unknown')),
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
    const workspace = buildWorkspaceFromTable(table, workflow);
    const validation = validateWorkspaceWorkflow(workspace, table);
    const run = runWorkspaceWorkflow(workspace, table);
    const expected = executeWorkflow(workflow, table);

    expect(validation.editorIssues).toEqual([]);
    expect(validation.validationIssues).toEqual([]);
    expect(run.editorIssues).toEqual([]);
    expect(run.validationIssues).toEqual([]);
    expect(run.executionResult).toEqual(expected);
  });

  it('upgrades legacy workflow JSON on import and reconstructs equivalent block trees', () => {
    const legacyJson = JSON.stringify({
      version: 1,
      workflowId: 'wf_legacy_fill',
      name: 'Legacy fill',
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
    });

    const parsed = parseWorkflowJson(legacyJson);

    expect(parsed.issues).toEqual([]);
    expect(parsed.workflow).toEqual({
      version: 2,
      workflowId: 'wf_legacy_fill',
      name: 'Legacy fill',
      description: undefined,
      steps: [
        {
          id: 'step_fill_status',
          type: 'scopedTransform',
          columnIds: ['col_status'],
          expression: coalesce(value(), literal('unknown')),
          treatWhitespaceAsEmpty: true,
        },
      ],
    });

    const workspace = buildWorkspaceFromColumnIds(['col_status'], parsed.workflow!);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(parsed.workflow);
  });

  it('surfaces invalid editor blocks clearly when required inputs are missing', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const block = workspace.newBlock(BLOCK_TYPES.scopedTransformStep);

    block.setFieldValue(serializeColumnSelectionValue(['col_email']), 'COLUMN_IDS');

    const result = workspaceToWorkflow(workspace);

    expect(result.workflow).toBeNull();
    expect(result.issues).toEqual([
      {
        code: 'missingInput',
        message: `Block '${BLOCK_TYPES.scopedTransformStep}' is missing required input 'EXPRESSION'.`,
        blockId: block.id,
        blockType: BLOCK_TYPES.scopedTransformStep,
      },
    ]);
  });

  it('still roundtrips canonical workflow JSON without editor-only data leaking into persistence', () => {
    const workflow = buildAllStepsWorkflow();
    const json = workflowToJson(workflow);
    const parsed = parseWorkflowJson(json);

    expect(parsed.issues).toEqual([]);
    expect(parsed.workflow).toEqual(workflow);
    expect(json).toContain('"version": 2');
    expect(json).toContain('"type": "scopedTransform"');
    expect(json).toContain('"name": "lower"');
    expect(json).not.toContain('sourceBlockId');
  });

  it('defaults whitespace-empty handling to true in new editor blocks', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const transformBlock = workspace.newBlock(BLOCK_TYPES.scopedTransformStep);
    const isEmptyBlock = workspace.newBlock(BLOCK_TYPES.isEmptyCondition);

    expect(transformBlock.getFieldValue('TREAT_WHITESPACE_AS_EMPTY')).toBe('TRUE');
    expect(isEmptyBlock.getFieldValue('TREAT_WHITESPACE_AS_EMPTY')).toBe('TRUE');
  });

  it('exposes schema-aware explicit column IDs for multi-select fields', async () => {
    const table = await readFixtureTable('messy-customers.csv');

    setEditorSchemaColumns(table.schema.columns);

    expect(getSelectableColumns().map((entry) => entry.columnId)).toEqual(table.schema.columns.map((column) => column.columnId));
  });

  it('exposes bulk type selections for schema-aware multi-select fields', () => {
    setEditorSchemaColumns([
      createColumn('col_email', 'email', 'string'),
      createColumn('col_city', 'city', 'string'),
      createColumn('col_order_total', 'order_total', 'number'),
      createColumn('col_is_active', 'is_active', 'boolean'),
      createColumn('col_ordered_at', 'ordered_at', 'datetime'),
    ]);

    expect(getSelectableColumnTypeGroups()).toEqual([
      {
        logicalType: 'string',
        label: 'All string columns',
        columnIds: ['col_email', 'col_city'],
      },
      {
        logicalType: 'number',
        label: 'All numeric columns',
        columnIds: ['col_order_total'],
      },
      {
        logicalType: 'boolean',
        label: 'All boolean columns',
        columnIds: ['col_is_active'],
      },
      {
        logicalType: 'datetime',
        label: 'All datetime columns',
        columnIds: ['col_ordered_at'],
      },
    ]);
    expect(formatColumnSelectionSummary(['col_email', 'col_city'])).toBe('All string columns (2)');
  });
});

function buildWorkspaceFromTable(table: Table, workflow: Workflow) {
  return buildWorkspaceFromColumnIds(
    [
      ...table.schema.columns.map((column) => column.columnId),
      ...collectWorkflowColumnIds(workflow),
    ],
    workflow,
    table.schema.columns,
  );
}

function buildWorkspaceFromColumnIds(columnIds: string[], workflow: Workflow, columns: Table['schema']['columns'] = []) {
  const workspace = createHeadlessWorkflowWorkspace();

  setEditorSchemaColumns(columns, columnIds);
  workflowToWorkspace(workspace, workflow);

  return workspace;
}

function buildAllStepsWorkflow(): Workflow {
  return {
    version: 2,
    workflowId: 'wf_all_steps',
    name: 'All steps',
    description: 'Covers every current step type.',
    steps: [
      {
        id: 'step_fill_status',
        type: 'scopedTransform',
        columnIds: ['col_status'],
        expression: coalesce(value(), literal('unknown')),
        treatWhitespaceAsEmpty: true,
      },
      {
        id: 'step_normalize_text',
        type: 'scopedTransform',
        columnIds: ['col_email', 'col_city'],
        expression: call('lower', call('collapseWhitespace', call('trim', value()))),
        treatWhitespaceAsEmpty: false,
      },
      {
        id: 'step_drop_columns',
        type: 'dropColumns',
        columnIds: ['col_internal_notes'],
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
        expression: concat(
          column('col_city'),
          literal(', '),
          coalesce(column('col_state'), literal('unknown')),
        ),
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
        columnIds: ['col_city', 'col_state'],
        separator: ', ',
        newColumn: {
          columnId: 'col_location',
          displayName: 'location',
        },
      },
      {
        id: 'step_dedupe_rows',
        type: 'deduplicateRows',
        columnIds: ['col_email'],
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
  name: 'trim' | 'lower' | 'upper' | 'collapseWhitespace' | 'substring' | 'replace' | 'split' | 'first' | 'last' | 'coalesce' | 'concat',
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

function createColumn(columnId: string, displayName: string, logicalType: Table['schema']['columns'][number]['logicalType']): Table['schema']['columns'][number] {
  return {
    columnId,
    displayName,
    logicalType,
    nullable: true,
    sourceIndex: 0,
    missingCount: 0,
  };
}
