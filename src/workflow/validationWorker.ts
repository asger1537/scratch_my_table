import type { Schema, Table } from '../domain/model';

import { validateWorkflowSemantics } from './runtime';
import { validateWorkflowStructure } from './structural';
import type { Workflow, WorkflowValidationIssue } from './types';

export interface ValidationWorkerTableSnapshot {
  tableId: string;
  sourceName: string;
  schema: Schema;
}

export interface ValidationWorkerRequest {
  requestId: number;
  workflow: Workflow;
  table: ValidationWorkerTableSnapshot;
}

export interface ValidationWorkerResponse {
  requestId: number;
  issues: WorkflowValidationIssue[];
}

export function validateWorkflowAgainstSchemaSnapshot(
  workflow: Workflow,
  tableSnapshot: ValidationWorkerTableSnapshot,
): WorkflowValidationIssue[] {
  const structural = validateWorkflowStructure(workflow);

  if (!structural.valid || !structural.workflow) {
    return structural.issues;
  }

  const table = buildValidationTable(tableSnapshot);
  return validateWorkflowSemantics(structural.workflow, table).issues;
}

function buildValidationTable(snapshot: ValidationWorkerTableSnapshot): Table {
  return {
    tableId: snapshot.tableId,
    sourceName: snapshot.sourceName,
    schema: {
      columns: snapshot.schema.columns.map((column) => ({ ...column })),
    },
    rowsById: {},
    rowOrder: [],
    importWarnings: [],
  };
}
