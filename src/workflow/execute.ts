import type { Table } from '../domain/model';

import { executeValidatedWorkflow, validateWorkflowSemantics } from './runtime';
import { validateWorkflowStructure } from './structural';
import type { WorkflowExecutionResult } from './types';

export function executeWorkflow(candidate: unknown, table: Table): WorkflowExecutionResult {
  const structuralValidation = validateWorkflowStructure(candidate);

  if (!structuralValidation.valid || !structuralValidation.workflow) {
    return {
      transformedTable: null,
      validationErrors: structuralValidation.issues,
      executionWarnings: [],
      changedRowCount: 0,
      changedCellCount: 0,
      createdColumnIds: [],
      removedRowCount: 0,
      rowOrderChanged: false,
      sortApplied: false,
    };
  }

  const semanticValidation = validateWorkflowSemantics(structuralValidation.workflow, table);

  if (!semanticValidation.valid) {
    return {
      transformedTable: null,
      validationErrors: semanticValidation.issues,
      executionWarnings: [],
      changedRowCount: 0,
      changedCellCount: 0,
      createdColumnIds: [],
      removedRowCount: 0,
      rowOrderChanged: false,
      sortApplied: false,
    };
  }

  const execution = executeValidatedWorkflow(structuralValidation.workflow, table);

  return {
    transformedTable: execution.transformedTable,
    validationErrors: [],
    executionWarnings: execution.executionWarnings,
    changedRowCount: execution.changeSummary.changedRowCount,
    changedCellCount: execution.changeSummary.changedCellCount,
    createdColumnIds: execution.changeSummary.createdColumnIds,
    removedRowCount: execution.changeSummary.removedRowCount,
    rowOrderChanged: execution.changeSummary.rowOrderChanged,
    sortApplied: execution.sortApplied,
  };
}
