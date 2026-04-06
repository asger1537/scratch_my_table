import { describe, expect, it } from 'vitest';

import type { Table } from './domain/model';
import { executeWorkflow, type Workflow, type WorkflowExpression } from './workflow';
import {
  addWorkflowToPackage,
  buildExportWorkflowPackage,
  createNewPackageWorkflow,
  createWorkflowPackage,
  deleteWorkflowFromPackage,
  flattenWorkflowSequence,
  mergeWorkflowPackages,
  renameWorkflowInPackage,
  setActiveWorkflowInPackage,
  validateWorkflowPackageStructure,
  workflowPackageToJson,
  parseWorkflowPackageJson,
} from './workflowPackage';

describe('workflow packages', () => {
  it('roundtrips valid package JSON and preserves tab and run-order state', () => {
    const workflowPackage = createWorkflowPackage(
      [createWorkflowA(), createWorkflowB()],
      'wf_clean',
      ['wf_clean', 'wf_sort'],
    );

    const parsed = parseWorkflowPackageJson(workflowPackageToJson(workflowPackage));

    expect(parsed.valid).toBe(true);
    expect(parsed.workflowPackage).toEqual(workflowPackage);
  });

  it('rejects packages with missing active workflows, missing run-order workflows, or duplicate ids', () => {
    const duplicateWorkflow = createWorkflowA();
    const missingReferences = validateWorkflowPackageStructure({
      version: 1,
      type: 'workflowPackage',
      activeWorkflowId: 'wf_missing',
      workflows: [createWorkflowA()],
      runOrderWorkflowIds: ['wf_missing'],
    });
    const duplicateIds = validateWorkflowPackageStructure({
      version: 1,
      type: 'workflowPackage',
      activeWorkflowId: duplicateWorkflow.workflowId,
      workflows: [duplicateWorkflow, { ...duplicateWorkflow, name: 'Duplicate' }],
      runOrderWorkflowIds: [duplicateWorkflow.workflowId],
    });

    expect(missingReferences.valid).toBe(false);
    expect(missingReferences.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missingActiveWorkflow', 'missingRunOrderWorkflow']),
    );
    expect(duplicateIds.valid).toBe(false);
    expect(duplicateIds.issues.some((issue) => issue.code === 'duplicateWorkflowId')).toBe(true);
  });

  it('reports a clear error when a standalone workflow JSON is imported as a package', () => {
    const parsed = parseWorkflowPackageJson(`${JSON.stringify(createWorkflowA(), null, 2)}\n`);

    expect(parsed.valid).toBe(false);
    expect(parsed.issues).toEqual([
      expect.objectContaining({
        code: 'standaloneWorkflowNotSupported',
        path: '$',
        message: expect.stringContaining('standalone workflow'),
      }),
    ]);
  });

  it('creates uniquely named workflows, renames by name only, and deletes active tabs leftward', () => {
    const baseWorkflow = createWorkflowA();
    const secondWorkflow = createWorkflowB();
    const createdWorkflow = createNewPackageWorkflow([baseWorkflow, secondWorkflow]);
    const workflowPackage = createWorkflowPackage([baseWorkflow, secondWorkflow, createdWorkflow], secondWorkflow.workflowId);
    const renamedPackage = renameWorkflowInPackage(workflowPackage, secondWorkflow.workflowId, 'Sorted rows');
    const deletedPackage = deleteWorkflowFromPackage(setActiveWorkflowInPackage(renamedPackage, secondWorkflow.workflowId), secondWorkflow.workflowId);

    expect(createdWorkflow.workflowId).toMatch(/^wf_/);
    expect(createdWorkflow.name).not.toBe(baseWorkflow.name);
    expect(renamedPackage.workflows.find((workflow) => workflow.workflowId === secondWorkflow.workflowId)?.name).toBe('Sorted rows');
    expect(deletedPackage.activeWorkflowId).toBe(baseWorkflow.workflowId);
    expect(deletedPackage.workflows.map((workflow) => workflow.workflowId)).not.toContain(secondWorkflow.workflowId);
  });

  it('does not add newly created workflows to the saved run order by default', () => {
    const workflowPackage = createWorkflowPackage([createWorkflowA()], 'wf_clean', ['wf_clean']);
    const createdWorkflow = createNewPackageWorkflow(workflowPackage.workflows);
    const nextPackage = addWorkflowToPackage(workflowPackage, createdWorkflow, true);

    expect(nextPackage.activeWorkflowId).toBe(createdWorkflow.workflowId);
    expect(nextPackage.runOrderWorkflowIds).toEqual(['wf_clean']);
  });

  it('builds subset exports with filtered run order and active workflow fallback', () => {
    const workflowPackage = createWorkflowPackage(
      [createWorkflowA(), createWorkflowB(), createWorkflowC()],
      'wf_sort',
      ['wf_clean', 'wf_sort'],
    );

    const exportedPackage = buildExportWorkflowPackage(workflowPackage, ['wf_clean', 'wf_archive']);

    expect(exportedPackage.workflows.map((workflow) => workflow.workflowId)).toEqual(['wf_clean', 'wf_archive']);
    expect(exportedPackage.runOrderWorkflowIds).toEqual(['wf_clean']);
    expect(exportedPackage.activeWorkflowId).toBe('wf_clean');
  });

  it('merges packages by rewriting colliding ids and appending imported run order', () => {
    const currentPackage = createWorkflowPackage([createWorkflowA(), createWorkflowB()], 'wf_clean', ['wf_clean']);
    const importedPackage = createWorkflowPackage(
      [
        createWorkflowA(),
        {
          ...createWorkflowC(),
          workflowId: 'wf_sort',
          name: 'Sort imported',
        },
      ],
      'wf_clean',
      ['wf_clean', 'wf_sort'],
    );

    const mergedPackage = mergeWorkflowPackages(currentPackage, importedPackage);

    expect(mergedPackage.workflows).toHaveLength(4);
    expect(new Set(mergedPackage.workflows.map((workflow) => workflow.workflowId)).size).toBe(4);
    expect(mergedPackage.runOrderWorkflowIds).toEqual([
      'wf_clean',
      expect.stringMatching(/^wf_clean(_\d+)?$/),
      expect.stringMatching(/^wf_sort(_\d+)?$/),
    ]);
  });

  it('flattens saved run order into a unique executable workflow and preserves schema evolution', () => {
    const workflowPackage = createWorkflowPackage(
      [
        {
          version: 2,
          workflowId: 'wf_normalize_amount',
          name: 'Normalize amount',
          steps: [
            {
              id: 'step_amount_num',
              type: 'deriveColumn',
              newColumn: {
                columnId: 'col_amount_num',
                displayName: 'Amount number',
              },
              expression: call('toNumber', column('col_amount')),
            },
          ],
        },
        {
          version: 2,
          workflowId: 'wf_sort_amount',
          name: 'Sort amount',
          steps: [
            {
              id: 'step_sort_amount',
              type: 'sortRows',
              sorts: [
                {
                  columnId: 'col_amount_num',
                  direction: 'asc',
                },
              ],
            },
          ],
        },
      ],
      'wf_normalize_amount',
      ['wf_normalize_amount', 'wf_sort_amount'],
    );
    const flattenedSequence = flattenWorkflowSequence(workflowPackage.workflows, workflowPackage.runOrderWorkflowIds);
    const executionResult = executeWorkflow(flattenedSequence.workflow, createTestTable());

    expect(flattenedSequence.workflow.steps.map((step) => step.id)).toEqual([
      'wf_normalize_amount__step_amount_num',
      'wf_sort_amount__step_sort_amount',
    ]);
    expect(flattenedSequence.workflowNames).toEqual(['Normalize amount', 'Sort amount']);
    expect(executionResult.validationErrors).toEqual([]);
    expect(executionResult.transformedTable?.rowOrder).toEqual(['row_2', 'row_1', 'row_3']);
  });
});

function createWorkflowA(): Workflow {
  return {
    version: 2,
    workflowId: 'wf_clean',
    name: 'Clean values',
    steps: [
      {
        id: 'step_fill_status',
        type: 'scopedRule',
        columnIds: ['col_status'],
        defaultPatch: {
          value: call('coalesce', column('col_status'), literal('unknown')),
        },
      },
    ],
  };
}

function createWorkflowB(): Workflow {
  return {
    version: 2,
    workflowId: 'wf_sort',
    name: 'Sort rows',
    steps: [
      {
        id: 'step_sort_status',
        type: 'sortRows',
        sorts: [
          {
            columnId: 'col_status',
            direction: 'asc',
          },
        ],
      },
    ],
  };
}

function createWorkflowC(): Workflow {
  return {
    version: 2,
    workflowId: 'wf_archive',
    name: 'Archive',
    steps: [
      {
        id: 'step_comment_archive',
        type: 'comment',
        text: 'Archive after cleanup.',
      },
    ],
  };
}

function createTestTable(): Table {
  return {
    tableId: 'tbl_amounts',
    sourceName: 'Amounts',
    schema: {
      columns: [
        {
          columnId: 'col_amount',
          displayName: 'Amount',
          logicalType: 'string',
          nullable: false,
          sourceIndex: 0,
          missingCount: 0,
        },
      ],
    },
    rowsById: {
      row_1: {
        rowId: 'row_1',
        cellsByColumnId: {
          col_amount: '10',
        },
        stylesByColumnId: {},
      },
      row_2: {
        rowId: 'row_2',
        cellsByColumnId: {
          col_amount: '2',
        },
        stylesByColumnId: {},
      },
      row_3: {
        rowId: 'row_3',
        cellsByColumnId: {
          col_amount: '30',
        },
        stylesByColumnId: {},
      },
    },
    rowOrder: ['row_1', 'row_2', 'row_3'],
    importWarnings: [],
  };
}

function literal(value: string | number | boolean | null): WorkflowExpression {
  return {
    kind: 'literal',
    value,
  };
}

function column(columnId: string): WorkflowExpression {
  return {
    kind: 'column',
    columnId,
  };
}

function call(name: 'coalesce' | 'toNumber', ...args: WorkflowExpression[]): WorkflowExpression {
  return {
    kind: 'call',
    name,
    args,
  };
}
