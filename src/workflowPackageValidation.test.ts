import { describe, expect, it } from 'vitest';

import type { Table } from './domain/model';
import type { Workflow, WorkflowValidationIssue } from './workflow';
import { createWorkflowPackage } from './workflowPackage';
import { getWorkflowInputTableForRunOrder, mapFlattenedSequenceIssuesToWorkflows } from './workflowPackageValidation';

describe('mapFlattenedSequenceIssuesToWorkflows', () => {
  it('maps flattened run-order issues back to the owning workflow and local step references', () => {
    const workflowPackage = createWorkflowPackage(
      [
        createWorkflow('wf_prepare', 'Prepare', [
          {
            id: 'step_derive_column_1',
            type: 'deriveColumn',
            newColumn: {
              columnId: 'col_email_clean',
              displayName: 'Email Clean',
            },
            expression: {
              kind: 'column',
              columnId: 'col_email',
            },
          },
        ]),
        createWorkflow('wf_filter', 'Filter', [
          {
            id: 'step_filter_rows_1',
            type: 'filterRows',
            mode: 'keep',
            condition: {
              kind: 'column',
              columnId: 'col_email_clean',
            },
          },
        ]),
      ],
      'wf_prepare',
      ['wf_prepare', 'wf_filter'],
    );
    const issues: WorkflowValidationIssue[] = [
      {
        code: 'missingColumn',
        severity: 'error',
        message: "Column 'col_email_clean' does not exist.",
        path: 'steps[1].condition.columnId',
        phase: 'semantic',
        stepId: 'wf_filter__step_filter_rows_1',
      },
    ];

    const mapped = mapFlattenedSequenceIssuesToWorkflows(workflowPackage, workflowPackage.runOrderWorkflowIds, issues);

    expect(mapped.get('wf_prepare')).toEqual([]);
    expect(mapped.get('wf_filter')).toEqual([
      {
        ...issues[0],
        path: 'steps[0].condition.columnId',
        stepId: 'step_filter_rows_1',
      },
    ]);
  });
});

describe('getWorkflowInputTableForRunOrder', () => {
  it('includes columns created by earlier run-order workflows in the active workflow input schema', () => {
    const workflowPackage = createWorkflowPackage(
      [
        createWorkflow('wf_prepare', 'Prepare', [
          {
            id: 'step_derive_email_clean',
            type: 'deriveColumn',
            newColumn: {
              columnId: 'col_email_clean',
              displayName: 'Email Clean',
            },
            expression: {
              kind: 'column',
              columnId: 'col_email',
            },
          },
        ]),
        createWorkflow('wf_filter', 'Filter', [
          {
            id: 'step_filter_email_clean',
            type: 'filterRows',
            mode: 'keep',
            condition: {
              kind: 'column',
              columnId: 'col_email_clean',
            },
          },
        ]),
      ],
      'wf_filter',
      ['wf_prepare', 'wf_filter'],
    );

    const inputTable = getWorkflowInputTableForRunOrder(workflowPackage, 'wf_filter', createTable());

    expect(inputTable.schema.columns.map((column) => column.columnId)).toEqual(['col_email', 'col_email_clean']);
  });

  it('keeps the raw table schema for workflows that are first in the run order', () => {
    const workflowPackage = createWorkflowPackage(
      [
        createWorkflow('wf_prepare', 'Prepare', [
          {
            id: 'step_derive_email_clean',
            type: 'deriveColumn',
            newColumn: {
              columnId: 'col_email_clean',
              displayName: 'Email Clean',
            },
            expression: {
              kind: 'column',
              columnId: 'col_email',
            },
          },
        ]),
      ],
      'wf_prepare',
      ['wf_prepare'],
    );
    const table = createTable();

    const inputTable = getWorkflowInputTableForRunOrder(workflowPackage, 'wf_prepare', table);

    expect(inputTable).toBe(table);
  });
});

function createWorkflow(workflowId: string, name: string, steps: Workflow['steps']): Workflow {
  return {
    version: 2,
    workflowId,
    name,
    steps,
  };
}

function createTable(): Table {
  return {
    tableId: 'tbl_customers',
    sourceName: 'Customers',
    schema: {
      columns: [
        {
          columnId: 'col_email',
          displayName: 'Email',
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
          col_email: 'alice@example.com',
        },
        stylesByColumnId: {},
      },
    },
    rowOrder: ['row_1'],
    importWarnings: [],
  };
}
