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
  getSchemaColumnOptions,
  getWorkspaceMetadata,
  parseWorkflowJson,
  projectWorkspaceStepSchemas,
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
          rowCondition: call(
            'and',
            call('startsWith', column('col_first_name'), literal('A')),
            call('startsWith', column('col_last_name'), literal('A')),
          ),
          expression: call('substring', value(), literal(0), literal(3)),
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
          rowCondition: call(
            'and',
            call('startsWith', column('col_first_name'), literal('A')),
            call('startsWith', column('col_last_name'), literal('A')),
          ),
          expression: call('substring', value(), literal(0), literal(3)),
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

  it('compiles create-column blank and copy modes to canonical deriveColumn expressions', () => {
    const workspace = createHeadlessWorkflowWorkspace();

    setEditorSchemaColumns([createColumn('col_first_name', 'first_name', 'string')], ['col_first_name']);

    const blankBlock = workspace.newBlock(BLOCK_TYPES.deriveColumnStep);
    blankBlock.setFieldValue('col_notes', 'NEW_COLUMN_ID');
    blankBlock.setFieldValue('notes', 'NEW_DISPLAY_NAME');

    const copyBlock = workspace.newBlock(BLOCK_TYPES.deriveColumnStep);
    copyBlock.setFieldValue('col_first_name_copy', 'NEW_COLUMN_ID');
    copyBlock.setFieldValue('first_name_copy', 'NEW_DISPLAY_NAME');
    copyBlock.setFieldValue('copy', 'CREATE_MODE');
    copyBlock.setFieldValue('col_first_name', 'COPY_COLUMN_ID');

    blankBlock.nextConnection?.connect(copyBlock.previousConnection!);

    const result = workspaceToWorkflow(workspace);

    expect(result.issues).toEqual([]);
    expect(result.workflow?.steps).toEqual([
      expect.objectContaining({
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_notes',
          displayName: 'notes',
        },
        expression: literal(null),
      }),
      expect.objectContaining({
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_first_name_copy',
          displayName: 'first_name_copy',
        },
        expression: column('col_first_name'),
      }),
    ]);
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

  it('reconstructs atIndex function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_extract_middle_name',
      name: 'Extract middle name',
      steps: [
        {
          id: 'step_extract_middle_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_middle_name',
            displayName: 'middle_name',
          },
          expression: call('atIndex', call('split', column('col_name'), literal(' ')), literal(1)),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_name', 'col_middle_name'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.atIndexFunction);
  });

  it('reconstructs extractRegex and replaceRegex function trees', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_regex_transform_blocks',
      name: 'Regex transform blocks',
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
          id: 'step_clean_note',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_note_compact',
            displayName: 'note_compact',
          },
          expression: call('replaceRegex', column('col_note'), literal('\\s+'), literal('_')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_note', 'col_order_id', 'col_note_compact'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.extractRegexFunction);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.replaceRegexFunction);
  });

  it('reconstructs switch function trees with dynamic case inputs', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_switch_roundtrip',
      name: 'Switch roundtrip',
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

    const workspace = buildWorkspaceFromColumnIds(['col_status', 'col_status_label'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);
    const switchBlock = workspace.getAllBlocks(false).find((block) => block.type === BLOCK_TYPES.switchFunction);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(switchBlock).toBeTruthy();
    expect(switchBlock?.getInput('TARGET')).toBeTruthy();
    expect(switchBlock?.getInput('MATCH0')).toBeTruthy();
    expect(switchBlock?.getInput('RETURN0')).toBeTruthy();
    expect(switchBlock?.getInput('MATCH1')).toBeTruthy();
    expect(switchBlock?.getInput('RETURN1')).toBeTruthy();
    expect(switchBlock?.getInput('DEFAULT')).toBeTruthy();
  });

  it('reconstructs deriveColumn workflows as create-column blank and copy modes when possible', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_create_column_modes',
      name: 'Create column modes',
      steps: [
        {
          id: 'step_create_blank_notes',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_notes',
            displayName: 'notes',
          },
          expression: literal(null),
        },
        {
          id: 'step_copy_first_name',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'col_first_name_copy',
            displayName: 'first_name_copy',
          },
          expression: column('col_first_name'),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_first_name', 'col_notes', 'col_first_name_copy'], workflow);
    const [firstBlock] = workspace.getTopBlocks(false);
    const secondBlock = firstBlock?.getNextBlock();
    const roundtrip = workspaceToWorkflow(workspace);

    expect(firstBlock?.type).toBe(BLOCK_TYPES.deriveColumnStep);
    expect(firstBlock?.getFieldValue('CREATE_MODE')).toBe('blank');
    expect(secondBlock?.type).toBe(BLOCK_TYPES.deriveColumnStep);
    expect(secondBlock?.getFieldValue('CREATE_MODE')).toBe('copy');
    expect(secondBlock?.getFieldValue('COPY_COLUMN_ID')).toBe('col_first_name');
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('roundtrips matchesRegex logic expressions through Blockly blocks without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_regex_roundtrip',
      name: 'Regex roundtrip',
      steps: [
        {
          id: 'step_filter_regex',
          type: 'filterRows',
          mode: 'keep',
          condition: call('matchesRegex', column('col_email'), literal('^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$')),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_email'], workflow);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
    expect(workspace.getAllBlocks(false).map((block) => block.type)).toContain(BLOCK_TYPES.predicateFunction);
  });

  it('roundtrips symbolic comparator operators without semantic loss', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_symbolic_comparators',
      name: 'Symbolic comparators',
      steps: [
        {
          id: 'step_filter_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: call(
            'and',
            call('or',
              call('lessThan', column('col_order_total'), literal(100)),
              call('equals', column('col_order_total'), literal(100)),
            ),
            call('not', call('equals', column('col_order_status'), literal('cancelled'))),
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_order_total', 'col_order_status'], workflow);
    const comparisonBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.comparisonFunction);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(comparisonBlocks.map((block) => block.getFieldValue('OPERATOR')).sort()).toEqual(['lte', 'ne']);
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
  });

  it('reconstructs flat multi-argument logical groups as one horizontal block', () => {
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_flat_logic_group',
      name: 'Flat logic group',
      steps: [
        {
          id: 'step_filter_orders',
          type: 'filterRows',
          mode: 'keep',
          condition: call(
            'and',
            call('greaterThan', column('col_order_total'), literal(100)),
            call('equals', column('col_order_status'), literal('paid')),
            call('not', call('isEmpty', column('col_customer_id'))),
          ),
        },
      ],
    };

    const workspace = buildWorkspaceFromColumnIds(['col_order_total', 'col_order_status', 'col_customer_id'], workflow);
    const logicalBlocks = workspace.getAllBlocks(false).filter((block) => block.type === BLOCK_TYPES.logicalBinaryFunction);
    const roundtrip = workspaceToWorkflow(workspace);

    expect(logicalBlocks).toHaveLength(1);
    expect(logicalBlocks[0]?.getFieldValue('OPERATOR')).toBe('and');
    expect(logicalBlocks[0]?.getInput('ITEM0')).toBeTruthy();
    expect(logicalBlocks[0]?.getInput('ITEM1')).toBeTruthy();
    expect(logicalBlocks[0]?.getInput('ITEM2')).toBeTruthy();
    expect(roundtrip.issues).toEqual([]);
    expect(roundtrip.workflow).toEqual(workflow);
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
        },
        {
          id: 'step_drop_missing_email',
          type: 'filterRows',
          mode: 'drop',
          condition: call('isEmpty', column('col_email')),
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

  it('rejects non-canonical workflow JSON versions on import', () => {
    const unsupportedJson = JSON.stringify({
      version: 1,
      workflowId: 'wf_unsupported_fill',
      name: 'Unsupported fill',
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

    const parsed = parseWorkflowJson(unsupportedJson);

    expect(parsed.workflow).toBeNull();
    expect(parsed.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'schema.const',
        }),
      ]),
    );
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

  it('uses expression-based logic blocks instead of legacy condition blocks', () => {
    const workspace = createHeadlessWorkflowWorkspace();
    const transformBlock = workspace.newBlock(BLOCK_TYPES.scopedTransformStep);
    const comparisonBlock = workspace.newBlock(BLOCK_TYPES.comparisonFunction);
    const predicateBlock = workspace.newBlock(BLOCK_TYPES.predicateFunction);
    const logicalBlock = workspace.newBlock(BLOCK_TYPES.logicalBinaryFunction);

    expect(transformBlock.getInput('ROW_CONDITION')?.connection?.getCheck()).toEqual(['EXPRESSION']);
    expect(predicateBlock.outputConnection?.getCheck()).toEqual(['EXPRESSION']);
    expect(comparisonBlock.getFieldValue('OPERATOR')).toBe('eq');
    expect(predicateBlock.getFieldValue('OPERATOR')).toBe('contains');
    expect(logicalBlock.getFieldValue('OPERATOR')).toBe('and');
    expect(comparisonBlock.inputsInline).toBe(true);
    expect(predicateBlock.inputsInline).toBe(true);
    expect(logicalBlock.inputsInline).toBe(false);
    expect(logicalBlock.getInput('HEADER')).toBeTruthy();
    expect(logicalBlock.getField('ADD_ITEM')).toBeTruthy();
    expect(logicalBlock.getField('REMOVE_ITEM')).toBeTruthy();
    expect(predicateBlock.getInput('FIRST')).toBeTruthy();
    expect(predicateBlock.getInput('SECOND')).toBeTruthy();
    expect(logicalBlock.getInput('ITEM0')).toBeTruthy();
    expect(logicalBlock.getInput('ITEM1')).toBeTruthy();
  });

  it('exposes schema-aware explicit column IDs for multi-select fields', async () => {
    const table = await readFixtureTable('messy-customers.csv');

    setEditorSchemaColumns(table.schema.columns);

    expect(getSelectableColumns().map((entry) => entry.columnId)).toEqual(table.schema.columns.map((column) => column.columnId));
  });

  it('projects created columns into later step selectors based on authored step order', () => {
    const baseColumns = [createColumn('col_email', 'Email', 'string')];
    const workflow: Workflow = {
      version: 2,
      workflowId: 'wf_modify_copied_column',
      name: 'Modify copied column',
      steps: [
        {
          id: 'step_copy_email',
          type: 'deriveColumn',
          newColumn: {
            columnId: 'email_safe',
            displayName: 'Email (safe)',
          },
          expression: column('col_email'),
        },
        {
          id: 'step_fill_email_safe',
          type: 'scopedTransform',
          columnIds: ['email_safe'],
          expression: coalesce(value(), literal('NA')),
        },
      ],
    };
    const workspace = buildWorkspaceFromColumnIds(['col_email', 'email_safe'], workflow, baseColumns);
    const deriveBlock = workspace.getTopBlocks(false)[0];
    const transformBlock = deriveBlock?.getNextBlock();
    const schemaByBlockId = projectWorkspaceStepSchemas(workspace, {
      tableId: 'table_test',
      sourceName: 'test.csv',
      schema: {
        columns: baseColumns,
      },
      rowsById: {},
      rowOrder: [],
      importWarnings: [],
    });

    setEditorSchemaColumns(baseColumns, ['col_email', 'email_safe'], schemaByBlockId);

    expect(transformBlock?.type).toBe(BLOCK_TYPES.scopedTransformStep);
    expect(getSchemaColumnOptions(transformBlock?.id)).toContainEqual(['Email (safe) [email_safe]', 'email_safe']);
    expect(getSelectableColumns(transformBlock?.id).map((entry) => entry.columnId)).toContain('email_safe');
    expect(transformBlock?.getField('COLUMN_IDS')?.getText()).toContain('Email (safe)');
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
      },
      {
        id: 'step_normalize_text',
        type: 'scopedTransform',
        columnIds: ['col_email', 'col_city'],
        expression: call('lower', call('collapseWhitespace', call('trim', value()))),
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
        condition: call(
          'and',
          call('not', call('isEmpty', column('col_email'))),
          call('contains', column('col_email'), literal('@')),
        ),
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
  name:
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
