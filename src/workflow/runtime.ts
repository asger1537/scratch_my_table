import {
  type CellValue,
  type Column,
  type LogicalType,
  type Table,
  type TableRow,
  isMissingValue,
} from '../domain/model';
import { inferLogicalType, isIsoDate, isIsoDateTime, normalizeWhitespace } from '../domain/normalize';

import type {
  Workflow,
  WorkflowColumnTarget,
  WorkflowCondition,
  WorkflowExecutionWarning,
  WorkflowExpression,
  WorkflowExpressionValidationResult,
  WorkflowSemanticStepResult,
  WorkflowSemanticValidationResult,
  WorkflowStep,
  WorkflowValidationIssue,
} from './types';

interface WorkflowStepApplyResult {
  table: Table;
  createdColumnIds: string[];
  warnings: WorkflowExecutionWarning[];
  sortApplied: boolean;
}

interface WorkflowChangeSummary {
  changedRowCount: number;
  changedCellCount: number;
  createdColumnIds: string[];
  removedRowCount: number;
  rowOrderChanged: boolean;
}

const MISSING_CELL = Symbol('missingCell');

export function validateWorkflowSemantics(workflow: Workflow, table: Table): WorkflowSemanticValidationResult {
  let workingTable = cloneTable(table);
  const issues: WorkflowValidationIssue[] = [];
  const stepResults: WorkflowSemanticStepResult[] = [];

  workflow.steps.forEach((step, stepIndex) => {
    const stepIssues = validateWorkflowStep(step, workingTable, stepIndex);
    const valid = stepIssues.length === 0;

    if (valid) {
      workingTable = applyWorkflowStepUnchecked(workingTable, step).table;
    }

    issues.push(...stepIssues);
    stepResults.push({
      stepId: step.id,
      stepType: step.type,
      valid,
      issues: stepIssues,
      schemaAfterStep: cloneSchema(workingTable.schema),
    });
  });

  return {
    valid: issues.length === 0,
    issues,
    stepResults,
    finalSchema: cloneSchema(workingTable.schema),
  };
}

export function executeValidatedWorkflow(workflow: Workflow, table: Table) {
  let workingTable = cloneTable(table);
  const executionWarnings: WorkflowExecutionWarning[] = [];
  let sortApplied = false;

  workflow.steps.forEach((step) => {
    const stepResult = applyWorkflowStepUnchecked(workingTable, step);
    workingTable = stepResult.table;
    executionWarnings.push(...stepResult.warnings);
    sortApplied = sortApplied || stepResult.sortApplied;
  });

  return {
    transformedTable: workingTable,
    executionWarnings,
    sortApplied,
    changeSummary: summarizeWorkflowChanges(table, workingTable),
  };
}

export function cloneTable(table: Table): Table {
  const rowsById: Record<string, TableRow> = {};

  Object.entries(table.rowsById).forEach(([rowId, row]) => {
    rowsById[rowId] = {
      rowId,
      cellsByColumnId: { ...row.cellsByColumnId },
    };
  });

  return {
    ...table,
    schema: cloneSchema(table.schema),
    rowsById,
    rowOrder: [...table.rowOrder],
    importWarnings: [...table.importWarnings],
  };
}

export function summarizeWorkflowChanges(originalTable: Table, transformedTable: Table): WorkflowChangeSummary {
  const originalColumnIds = originalTable.schema.columns.map((column) => column.columnId);
  const transformedColumnIds = transformedTable.schema.columns.map((column) => column.columnId);
  const originalColumnIdSet = new Set(originalColumnIds);
  const transformedColumnIdSet = new Set(transformedColumnIds);
  const comparedColumnIds = [...originalColumnIds, ...transformedColumnIds.filter((columnId) => !originalColumnIdSet.has(columnId))];
  const originalPositions = new Map(originalTable.rowOrder.map((rowId, index) => [rowId, index]));
  const transformedPositions = new Map(transformedTable.rowOrder.map((rowId, index) => [rowId, index]));
  let changedRowCount = 0;
  let changedCellCount = 0;
  let removedRowCount = 0;

  originalTable.rowOrder.forEach((rowId) => {
    const originalRow = originalTable.rowsById[rowId];
    const transformedRow = transformedTable.rowsById[rowId];

    if (!transformedRow) {
      changedRowCount += 1;
      removedRowCount += 1;
      return;
    }

    let rowChanged = originalPositions.get(rowId) !== transformedPositions.get(rowId);

    comparedColumnIds.forEach((columnId) => {
      const originalValue = originalColumnIdSet.has(columnId)
        ? (originalRow.cellsByColumnId[columnId] ?? null)
        : MISSING_CELL;
      const transformedValue = transformedColumnIdSet.has(columnId)
        ? (transformedRow.cellsByColumnId[columnId] ?? null)
        : MISSING_CELL;

      if (!Object.is(originalValue, transformedValue)) {
        changedCellCount += 1;
        rowChanged = true;
      }
    });

    if (rowChanged) {
      changedRowCount += 1;
    }
  });

  return {
    changedRowCount,
    changedCellCount,
    createdColumnIds: transformedColumnIds.filter((columnId) => !originalColumnIdSet.has(columnId)),
    removedRowCount,
    rowOrderChanged: originalTable.rowOrder.length !== transformedTable.rowOrder.length
      || originalTable.rowOrder.some((rowId, index) => rowId !== transformedTable.rowOrder[index]),
  };
}

function validateWorkflowStep(step: WorkflowStep, table: Table, stepIndex: number): WorkflowValidationIssue[] {
  const basePath = `steps[${stepIndex}]`;

  switch (step.type) {
    case 'fillEmpty':
      return validateFillEmptyStep(step, table, basePath);
    case 'normalizeText':
      return validateNormalizeTextStep(step, table, basePath);
    case 'renameColumn':
      return validateRenameColumnStep(step, table, basePath);
    case 'deriveColumn':
      return validateDeriveColumnStep(step, table, basePath);
    case 'filterRows':
      return validateFilterRowsStep(step, table, basePath);
    case 'splitColumn':
      return validateSplitColumnStep(step, table, basePath);
    case 'combineColumns':
      return validateCombineColumnsStep(step, table, basePath);
    case 'deduplicateRows':
      return validateDeduplicateRowsStep(step, table, basePath);
    case 'sortRows':
      return validateSortRowsStep(step, table, basePath);
    default:
      return [];
  }
}

function validateFillEmptyStep(step: Extract<WorkflowStep, { type: 'fillEmpty' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  const columns = resolveTargetColumns(step.target, table, `${basePath}.target.columnIds`, step.id, issues);

  if (step.target.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one column.`, `${basePath}.target.columnIds`, step.id));
  }

  columns.forEach((column, columnIndex) => {
    if (column.logicalType === 'mixed') {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Column '${column.columnId}' has logical type 'mixed' and cannot be used by step '${step.id}'.`,
          `${basePath}.target.columnIds[${columnIndex}]`,
          step.id,
          { columnId: column.columnId, logicalType: column.logicalType },
        ),
      );
    } else if (!isFillValueCompatible(step.value, column.logicalType)) {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Fill value is incompatible with column '${column.columnId}' of type '${column.logicalType}'.`,
          `${basePath}.value`,
          step.id,
          { columnId: column.columnId, logicalType: column.logicalType, value: step.value },
        ),
      );
    }

    if (step.treatWhitespaceAsEmpty && !isStringLikeType(column.logicalType)) {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Whitespace-only matching is only valid for string or unknown columns, but '${column.columnId}' is '${column.logicalType}'.`,
          `${basePath}.treatWhitespaceAsEmpty`,
          step.id,
          { columnId: column.columnId, logicalType: column.logicalType },
        ),
      );
    }
  });

  return issues;
}

function validateNormalizeTextStep(step: Extract<WorkflowStep, { type: 'normalizeText' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  const columns = resolveTargetColumns(step.target, table, `${basePath}.target.columnIds`, step.id, issues);

  if (step.target.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one column.`, `${basePath}.target.columnIds`, step.id));
  }

  columns.forEach((column, columnIndex) => {
    if (!isStringLikeType(column.logicalType)) {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Column '${column.columnId}' has type '${column.logicalType}' and cannot be normalized as text.`,
          `${basePath}.target.columnIds[${columnIndex}]`,
          step.id,
          { columnId: column.columnId, logicalType: column.logicalType },
        ),
      );
    }
  });

  return issues;
}

function validateRenameColumnStep(step: Extract<WorkflowStep, { type: 'renameColumn' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  const column = findColumn(table, step.columnId);

  if (!column) {
    issues.push(makeIssue('missingColumn', `Column '${step.columnId}' does not exist at step '${step.id}'.`, `${basePath}.columnId`, step.id, { columnId: step.columnId }));
    return issues;
  }

  const normalizedDisplayName = normalizeWorkflowDisplayName(step.newDisplayName);

  if (normalizedDisplayName === '') {
    issues.push(makeIssue('invalidDisplayName', `Step '${step.id}' must provide a non-empty display name.`, `${basePath}.newDisplayName`, step.id));
    return issues;
  }

  const conflictingColumn = table.schema.columns.find(
    (candidate) => candidate.columnId !== column.columnId && getDisplayNameKey(candidate.displayName) === getDisplayNameKey(normalizedDisplayName),
  );

  if (conflictingColumn) {
    issues.push(
      makeIssue(
        'nameConflict',
        `Display name '${normalizedDisplayName}' conflicts with column '${conflictingColumn.columnId}'.`,
        `${basePath}.newDisplayName`,
        step.id,
        { displayName: normalizedDisplayName, conflictingColumnId: conflictingColumn.columnId },
      ),
    );
  }

  return issues;
}

function validateDeriveColumnStep(step: Extract<WorkflowStep, { type: 'deriveColumn' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];

  validateNewColumn(table, step.newColumn.columnId, step.newColumn.displayName, `${basePath}.newColumn`, step.id, issues);

  const expressionResult = validateExpression(step.expression, table, `${basePath}.expression`, step.id);
  issues.push(...expressionResult.issues);

  return issues;
}

function validateFilterRowsStep(step: Extract<WorkflowStep, { type: 'filterRows' }>, table: Table, basePath: string) {
  return validateCondition(step.condition, table, `${basePath}.condition`, step.id);
}

function validateSplitColumnStep(step: Extract<WorkflowStep, { type: 'splitColumn' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  const sourceColumn = findColumn(table, step.columnId);

  if (!sourceColumn) {
    issues.push(makeIssue('missingColumn', `Column '${step.columnId}' does not exist at step '${step.id}'.`, `${basePath}.columnId`, step.id, { columnId: step.columnId }));
  } else if (!isStringLikeType(sourceColumn.logicalType)) {
    issues.push(
      makeIssue(
        'incompatibleType',
        `Column '${step.columnId}' has type '${sourceColumn.logicalType}' and cannot be split.`,
        `${basePath}.columnId`,
        step.id,
        { columnId: step.columnId, logicalType: sourceColumn.logicalType },
      ),
    );
  }

  if (step.delimiter === '') {
    issues.push(makeIssue('invalidDelimiter', `Step '${step.id}' requires a non-empty delimiter.`, `${basePath}.delimiter`, step.id));
  }

  if (step.outputColumns.length < 2) {
    issues.push(makeIssue('invalidExpression', `Step '${step.id}' must define at least two output columns.`, `${basePath}.outputColumns`, step.id));
  }

  validateNewColumns(table, step.outputColumns, `${basePath}.outputColumns`, step.id, issues);

  return issues;
}

function validateCombineColumnsStep(step: Extract<WorkflowStep, { type: 'combineColumns' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  resolveTargetColumns(step.target, table, `${basePath}.target.columnIds`, step.id, issues);
  validateUniqueReferences(step.target.columnIds, `${basePath}.target.columnIds`, step.id, issues);

  if (step.target.columnIds.length < 2) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least two source columns.`, `${basePath}.target.columnIds`, step.id));
  }

  validateNewColumn(table, step.newColumn.columnId, step.newColumn.displayName, `${basePath}.newColumn`, step.id, issues);

  return issues;
}

function validateDeduplicateRowsStep(step: Extract<WorkflowStep, { type: 'deduplicateRows' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  resolveTargetColumns(step.target, table, `${basePath}.target.columnIds`, step.id, issues);
  validateUniqueReferences(step.target.columnIds, `${basePath}.target.columnIds`, step.id, issues);

  if (step.target.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one key column.`, `${basePath}.target.columnIds`, step.id));
  }

  return issues;
}

function validateSortRowsStep(step: Extract<WorkflowStep, { type: 'sortRows' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  const seen = new Set<string>();

  if (step.sorts.length === 0) {
    issues.push(makeIssue('emptySort', `Step '${step.id}' must define at least one sort key.`, `${basePath}.sorts`, step.id));
  }

  step.sorts.forEach((sort, sortIndex) => {
    const column = findColumn(table, sort.columnId);

    if (!column) {
      issues.push(
        makeIssue(
          'missingColumn',
          `Column '${sort.columnId}' does not exist at step '${step.id}'.`,
          `${basePath}.sorts[${sortIndex}].columnId`,
          step.id,
          { columnId: sort.columnId },
        ),
      );
      return;
    }

    if (column.logicalType === 'mixed') {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Column '${sort.columnId}' has type 'mixed' and cannot be used as a sort key.`,
          `${basePath}.sorts[${sortIndex}].columnId`,
          step.id,
          { columnId: sort.columnId, logicalType: column.logicalType },
        ),
      );
    }

    if (seen.has(sort.columnId)) {
      issues.push(
        makeIssue(
          'duplicateColumnReference',
          `Column '${sort.columnId}' is used more than once in sort step '${step.id}'.`,
          `${basePath}.sorts[${sortIndex}].columnId`,
          step.id,
          { columnId: sort.columnId },
        ),
      );
    } else {
      seen.add(sort.columnId);
    }
  });

  return issues;
}

function validateExpression(
  expression: WorkflowExpression,
  table: Table,
  path: string,
  stepId: string,
): WorkflowExpressionValidationResult {
  switch (expression.kind) {
    case 'literal':
      return {
        logicalType: inferLiteralLogicalType(expression.value),
        issues: [],
      };
    case 'column': {
      const column = findColumn(table, expression.columnId);

      if (!column) {
        return {
          logicalType: 'unknown',
          issues: [makeIssue('missingColumn', `Column '${expression.columnId}' does not exist at step '${stepId}'.`, `${path}.columnId`, stepId, { columnId: expression.columnId })],
        };
      }

      return {
        logicalType: column.logicalType,
        issues: [],
      };
    }
    case 'concat': {
      const issues = expression.parts.flatMap((part, index) => validateExpression(part, table, `${path}.parts[${index}]`, stepId).issues);
      return {
        logicalType: 'string',
        issues,
      };
    }
    case 'coalesce': {
      const results = expression.inputs.map((input, index) => validateExpression(input, table, `${path}.inputs[${index}]`, stepId));
      const issues = results.flatMap((result) => result.issues);
      const concreteTypes = [...new Set(results.map((result) => result.logicalType).filter((logicalType) => logicalType !== 'unknown'))];

      if (concreteTypes.includes('mixed')) {
        issues.push(makeIssue('incompatibleType', `Coalesce inputs in step '${stepId}' must not include mixed types.`, path, stepId));
      } else if (concreteTypes.length > 1) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Coalesce inputs in step '${stepId}' must resolve to one compatible type.`,
            path,
            stepId,
            { logicalTypes: concreteTypes },
          ),
        );
      }

      return {
        logicalType: (concreteTypes[0] ?? 'unknown') as LogicalType,
        issues,
      };
    }
    default:
      return {
        logicalType: 'unknown',
        issues: [makeIssue('invalidExpression', `Unsupported expression kind in step '${stepId}'.`, path, stepId)],
      };
  }
}

function validateCondition(condition: WorkflowCondition, table: Table, path: string, stepId: string): WorkflowValidationIssue[] {
  switch (condition.kind) {
    case 'isEmpty':
      return validateColumnCondition(condition.columnId, table, `${path}.columnId`, stepId);
    case 'equals': {
      const column = findColumn(table, condition.columnId);

      if (!column) {
        return [makeIssue('missingColumn', `Column '${condition.columnId}' does not exist at step '${stepId}'.`, `${path}.columnId`, stepId, { columnId: condition.columnId })];
      }

      if (column.logicalType === 'mixed') {
        return [makeIssue('incompatibleType', `Column '${condition.columnId}' has type 'mixed' and cannot be compared with equals.`, `${path}.columnId`, stepId, { columnId: condition.columnId })];
      }

      if (!isEqualsLiteralCompatible(condition.value, column.logicalType)) {
        return [
          makeIssue(
            'incompatibleType',
            `Literal value is incompatible with column '${condition.columnId}' of type '${column.logicalType}'.`,
            `${path}.value`,
            stepId,
            { columnId: condition.columnId, logicalType: column.logicalType, value: condition.value },
          ),
        ];
      }

      return [];
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith': {
      const column = findColumn(table, condition.columnId);

      if (!column) {
        return [makeIssue('missingColumn', `Column '${condition.columnId}' does not exist at step '${stepId}'.`, `${path}.columnId`, stepId, { columnId: condition.columnId })];
      }

      if (!isStringLikeType(column.logicalType)) {
        return [
          makeIssue(
            'incompatibleType',
            `Column '${condition.columnId}' has type '${column.logicalType}' and cannot use string comparator '${condition.kind}'.`,
            `${path}.columnId`,
            stepId,
            { columnId: condition.columnId, logicalType: column.logicalType, comparator: condition.kind },
          ),
        ];
      }

      return [];
    }
    case 'greaterThan':
    case 'lessThan': {
      const column = findColumn(table, condition.columnId);

      if (!column) {
        return [makeIssue('missingColumn', `Column '${condition.columnId}' does not exist at step '${stepId}'.`, `${path}.columnId`, stepId, { columnId: condition.columnId })];
      }

      if (!isOrderingType(column.logicalType)) {
        return [
          makeIssue(
            'incompatibleType',
            `Column '${condition.columnId}' has type '${column.logicalType}' and cannot use comparator '${condition.kind}'.`,
            `${path}.columnId`,
            stepId,
            { columnId: condition.columnId, logicalType: column.logicalType, comparator: condition.kind },
          ),
        ];
      }

      if (!isOrderingLiteralCompatible(condition.value, column.logicalType)) {
        return [
          makeIssue(
            'incompatibleType',
            `Literal value is incompatible with ordering comparator '${condition.kind}' on column '${condition.columnId}'.`,
            `${path}.value`,
            stepId,
            { columnId: condition.columnId, logicalType: column.logicalType, value: condition.value },
          ),
        ];
      }

      return [];
    }
    case 'and':
    case 'or': {
      const issues = condition.conditions.flatMap((child, index) => validateCondition(child, table, `${path}.conditions[${index}]`, stepId));

      if (condition.conditions.length < 2) {
        issues.push(makeIssue('invalidCondition', `Condition '${condition.kind}' in step '${stepId}' requires at least two child conditions.`, `${path}.conditions`, stepId));
      }

      return issues;
    }
    case 'not': {
      const issues = validateCondition(condition.condition, table, `${path}.condition`, stepId);

      if (!condition.condition) {
        issues.push(makeIssue('invalidCondition', `Condition 'not' in step '${stepId}' requires one child condition.`, `${path}.condition`, stepId));
      }

      return issues;
    }
    default:
      return [makeIssue('invalidCondition', `Unsupported condition kind in step '${stepId}'.`, path, stepId)];
  }
}

function validateColumnCondition(columnId: string, table: Table, path: string, stepId: string) {
  const column = findColumn(table, columnId);

  if (!column) {
    return [makeIssue('missingColumn', `Column '${columnId}' does not exist at step '${stepId}'.`, path, stepId, { columnId })];
  }

  return [];
}

function resolveTargetColumns(
  target: WorkflowColumnTarget,
  table: Table,
  path: string,
  stepId: string,
  issues: WorkflowValidationIssue[],
) {
  return target.columnIds.flatMap((columnId, index) => {
    const column = findColumn(table, columnId);

    if (!column) {
      issues.push(makeIssue('missingColumn', `Column '${columnId}' does not exist at step '${stepId}'.`, `${path}[${index}]`, stepId, { columnId }));
      return [];
    }

    return [column];
  });
}

function validateUniqueReferences(columnIds: string[], path: string, stepId: string, issues: WorkflowValidationIssue[]) {
  const seen = new Set<string>();

  columnIds.forEach((columnId, index) => {
    if (seen.has(columnId)) {
      issues.push(
        makeIssue(
          'duplicateColumnReference',
          `Column '${columnId}' is referenced more than once in step '${stepId}'.`,
          `${path}[${index}]`,
          stepId,
          { columnId },
        ),
      );
      return;
    }

    seen.add(columnId);
  });
}

function validateNewColumns(
  table: Table,
  newColumns: Array<{ columnId: string; displayName: string }>,
  basePath: string,
  stepId: string,
  issues: WorkflowValidationIssue[],
) {
  const existingIds = new Set(table.schema.columns.map((column) => column.columnId));
  const existingNameKeys = new Set(table.schema.columns.map((column) => getDisplayNameKey(column.displayName)));
  const seenIds = new Set<string>();
  const seenNameKeys = new Set<string>();

  newColumns.forEach((newColumn, index) => {
    const normalizedDisplayName = normalizeWorkflowDisplayName(newColumn.displayName);
    const namePath = `${basePath}[${index}].displayName`;
    const idPath = `${basePath}[${index}].columnId`;

    if (newColumn.columnId === '') {
      issues.push(makeIssue('duplicateColumnId', `Step '${stepId}' must provide a non-empty new column ID.`, idPath, stepId));
    } else if (existingIds.has(newColumn.columnId) || seenIds.has(newColumn.columnId)) {
      issues.push(
        makeIssue(
          'duplicateColumnId',
          `Column ID '${newColumn.columnId}' already exists at step '${stepId}'.`,
          idPath,
          stepId,
          { columnId: newColumn.columnId },
        ),
      );
    } else {
      seenIds.add(newColumn.columnId);
    }

    if (normalizedDisplayName === '') {
      issues.push(makeIssue('invalidDisplayName', `Step '${stepId}' must provide a non-empty display name.`, namePath, stepId));
      return;
    }

    const displayNameKey = getDisplayNameKey(normalizedDisplayName);

    if (existingNameKeys.has(displayNameKey) || seenNameKeys.has(displayNameKey)) {
      issues.push(
        makeIssue(
          'nameConflict',
          `Display name '${normalizedDisplayName}' conflicts with an existing column at step '${stepId}'.`,
          namePath,
          stepId,
          { displayName: normalizedDisplayName },
        ),
      );
      return;
    }

    seenNameKeys.add(displayNameKey);
  });
}

function validateNewColumn(
  table: Table,
  columnId: string,
  displayName: string,
  basePath: string,
  stepId: string,
  issues: WorkflowValidationIssue[],
) {
  validateNewColumns(table, [{ columnId, displayName }], basePath, stepId, issues);
}

function applyWorkflowStepUnchecked(table: Table, step: WorkflowStep): WorkflowStepApplyResult {
  switch (step.type) {
    case 'fillEmpty':
      return applyFillEmptyStep(table, step);
    case 'normalizeText':
      return applyNormalizeTextStep(table, step);
    case 'renameColumn':
      return applyRenameColumnStep(table, step);
    case 'deriveColumn':
      return applyDeriveColumnStep(table, step);
    case 'filterRows':
      return applyFilterRowsStep(table, step);
    case 'splitColumn':
      return applySplitColumnStep(table, step);
    case 'combineColumns':
      return applyCombineColumnsStep(table, step);
    case 'deduplicateRows':
      return applyDeduplicateRowsStep(table, step);
    case 'sortRows':
      return applySortRowsStep(table, step);
    default:
      return {
        table,
        createdColumnIds: [],
        warnings: [],
        sortApplied: false,
      };
  }
}

function applyFillEmptyStep(table: Table, step: Extract<WorkflowStep, { type: 'fillEmpty' }>): WorkflowStepApplyResult {
  const rowsById = mapRows(table, (row) => {
    const cellsByColumnId = { ...row.cellsByColumnId };

    step.target.columnIds.forEach((columnId) => {
      const currentValue = cellsByColumnId[columnId] ?? null;

      if (shouldTreatAsEmpty(currentValue, step.treatWhitespaceAsEmpty) && !Object.is(currentValue, step.value)) {
        cellsByColumnId[columnId] = step.value;
      }
    });

    return {
      rowId: row.rowId,
      cellsByColumnId,
    };
  });

  return {
    table: refreshTableSchema({
      ...table,
      rowsById,
    }),
    createdColumnIds: [],
    warnings: [],
    sortApplied: false,
  };
}

function applyNormalizeTextStep(table: Table, step: Extract<WorkflowStep, { type: 'normalizeText' }>): WorkflowStepApplyResult {
  const rowsById = mapRows(table, (row) => {
    const cellsByColumnId = { ...row.cellsByColumnId };

    step.target.columnIds.forEach((columnId) => {
      const currentValue = cellsByColumnId[columnId];

      if (typeof currentValue !== 'string') {
        return;
      }

      let nextValue = currentValue;

      if (step.trim) {
        nextValue = nextValue.trim();
      }

      if (step.collapseWhitespace) {
        nextValue = nextValue.replace(/\s+/g, ' ');
      }

      if (step.case === 'lower') {
        nextValue = nextValue.toLocaleLowerCase();
      } else if (step.case === 'upper') {
        nextValue = nextValue.toLocaleUpperCase();
      }

      cellsByColumnId[columnId] = nextValue;
    });

    return {
      rowId: row.rowId,
      cellsByColumnId,
    };
  });

  return {
    table: refreshTableSchema({
      ...table,
      rowsById,
    }),
    createdColumnIds: [],
    warnings: [],
    sortApplied: false,
  };
}

function applyRenameColumnStep(table: Table, step: Extract<WorkflowStep, { type: 'renameColumn' }>): WorkflowStepApplyResult {
  const columns = table.schema.columns.map((column) =>
    column.columnId === step.columnId
      ? {
          ...column,
          displayName: normalizeWorkflowDisplayName(step.newDisplayName),
        }
      : { ...column },
  );

  return {
    table: {
      ...table,
      schema: {
        columns,
      },
    },
    createdColumnIds: [],
    warnings: [],
    sortApplied: false,
  };
}

function applyDeriveColumnStep(table: Table, step: Extract<WorkflowStep, { type: 'deriveColumn' }>): WorkflowStepApplyResult {
  const newColumn = buildCreatedColumn(step.newColumn.columnId, step.newColumn.displayName, table.schema.columns.length);
  const rowsById = mapRows(table, (row) => ({
    rowId: row.rowId,
    cellsByColumnId: {
      ...row.cellsByColumnId,
      [newColumn.columnId]: evaluateExpression(step.expression, row),
    },
  }));

  return {
    table: refreshTableSchema({
      ...table,
      schema: {
        columns: [...table.schema.columns.map((column) => ({ ...column })), newColumn],
      },
      rowsById,
    }),
    createdColumnIds: [newColumn.columnId],
    warnings: [],
    sortApplied: false,
  };
}

function applyFilterRowsStep(table: Table, step: Extract<WorkflowStep, { type: 'filterRows' }>): WorkflowStepApplyResult {
  const keptRowIds = table.rowOrder.filter((rowId) => {
    const row = table.rowsById[rowId];
    const matches = evaluateCondition(step.condition, row);

    return step.mode === 'keep' ? matches : !matches;
  });

  return {
    table: refreshTableSchema({
      ...table,
      rowsById: cloneRowsById(table, keptRowIds),
      rowOrder: keptRowIds,
    }),
    createdColumnIds: [],
    warnings: [],
    sortApplied: false,
  };
}

function applySplitColumnStep(table: Table, step: Extract<WorkflowStep, { type: 'splitColumn' }>): WorkflowStepApplyResult {
  const newColumns = step.outputColumns.map((outputColumn, index) =>
    buildCreatedColumn(outputColumn.columnId, outputColumn.displayName, table.schema.columns.length + index),
  );
  const rowsById = mapRows(table, (row) => {
    const sourceValue = row.cellsByColumnId[step.columnId];
    const nextCells = { ...row.cellsByColumnId };

    if (sourceValue === null) {
      newColumns.forEach((column) => {
        nextCells[column.columnId] = null;
      });
    } else {
      const parts = String(sourceValue).split(step.delimiter);

      newColumns.forEach((column, index) => {
        if (index === newColumns.length - 1) {
          nextCells[column.columnId] = parts.length > index ? parts.slice(index).join(step.delimiter) : null;
          return;
        }

        nextCells[column.columnId] = parts[index] ?? null;
      });
    }

    return {
      rowId: row.rowId,
      cellsByColumnId: nextCells,
    };
  });

  return {
    table: refreshTableSchema({
      ...table,
      schema: {
        columns: [...table.schema.columns.map((column) => ({ ...column })), ...newColumns],
      },
      rowsById,
    }),
    createdColumnIds: newColumns.map((column) => column.columnId),
    warnings: [],
    sortApplied: false,
  };
}

function applyCombineColumnsStep(table: Table, step: Extract<WorkflowStep, { type: 'combineColumns' }>): WorkflowStepApplyResult {
  const newColumn = buildCreatedColumn(step.newColumn.columnId, step.newColumn.displayName, table.schema.columns.length);
  const rowsById = mapRows(table, (row) => {
    const values = step.target.columnIds
      .map((columnId) => row.cellsByColumnId[columnId])
      .filter((value): value is Exclude<CellValue, null> => value !== null && value !== '');

    return {
      rowId: row.rowId,
      cellsByColumnId: {
        ...row.cellsByColumnId,
        [newColumn.columnId]: values.map((value) => String(value)).join(step.separator),
      },
    };
  });

  return {
    table: refreshTableSchema({
      ...table,
      schema: {
        columns: [...table.schema.columns.map((column) => ({ ...column })), newColumn],
      },
      rowsById,
    }),
    createdColumnIds: [newColumn.columnId],
    warnings: [],
    sortApplied: false,
  };
}

function applyDeduplicateRowsStep(table: Table, step: Extract<WorkflowStep, { type: 'deduplicateRows' }>): WorkflowStepApplyResult {
  const seenKeys = new Set<string>();
  const keptRowIds: string[] = [];

  table.rowOrder.forEach((rowId) => {
    const row = table.rowsById[rowId];
    const key = JSON.stringify(step.target.columnIds.map((columnId) => row.cellsByColumnId[columnId] ?? null));

    if (seenKeys.has(key)) {
      return;
    }

    seenKeys.add(key);
    keptRowIds.push(rowId);
  });

  return {
    table: refreshTableSchema({
      ...table,
      rowsById: cloneRowsById(table, keptRowIds),
      rowOrder: keptRowIds,
    }),
    createdColumnIds: [],
    warnings: [],
    sortApplied: false,
  };
}

function applySortRowsStep(table: Table, step: Extract<WorkflowStep, { type: 'sortRows' }>): WorkflowStepApplyResult {
  const columnTypes = new Map(table.schema.columns.map((column) => [column.columnId, column.logicalType]));
  const sortedRowIds = table.rowOrder
    .map((rowId, index) => ({ rowId, index }))
    .sort((left, right) => {
      const leftRow = table.rowsById[left.rowId];
      const rightRow = table.rowsById[right.rowId];

      for (const sortKey of step.sorts) {
        const leftValue = leftRow.cellsByColumnId[sortKey.columnId] ?? null;
        const rightValue = rightRow.cellsByColumnId[sortKey.columnId] ?? null;
        const comparison = compareSortValues(
          leftValue,
          rightValue,
          columnTypes.get(sortKey.columnId) ?? 'unknown',
        );

        if (comparison !== 0) {
          if (leftValue === null || rightValue === null) {
            return comparison;
          }

          return sortKey.direction === 'asc' ? comparison : -comparison;
        }
      }

      return left.index - right.index;
    })
    .map((entry) => entry.rowId);

  return {
    table: refreshTableSchema({
      ...table,
      rowOrder: sortedRowIds,
    }),
    createdColumnIds: [],
    warnings: [],
    sortApplied: true,
  };
}

function evaluateExpression(expression: WorkflowExpression, row: TableRow): CellValue {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'column':
      return row.cellsByColumnId[expression.columnId] ?? null;
    case 'concat':
      return expression.parts
        .map((part) => evaluateExpression(part, row))
        .map((value) => (value === null ? '' : String(value)))
        .join('');
    case 'coalesce':
      for (const input of expression.inputs) {
        const value = evaluateExpression(input, row);

        if (value !== null) {
          return value;
        }
      }

      return null;
    default:
      return null;
  }
}

function evaluateCondition(condition: WorkflowCondition, row: TableRow): boolean {
  switch (condition.kind) {
    case 'isEmpty':
      return shouldTreatAsEmpty(row.cellsByColumnId[condition.columnId] ?? null, condition.treatWhitespaceAsEmpty);
    case 'equals':
      return Object.is(row.cellsByColumnId[condition.columnId] ?? null, condition.value);
    case 'contains': {
      const value = row.cellsByColumnId[condition.columnId];
      return typeof value === 'string' ? value.includes(condition.value) : false;
    }
    case 'startsWith': {
      const value = row.cellsByColumnId[condition.columnId];
      return typeof value === 'string' ? value.startsWith(condition.value) : false;
    }
    case 'endsWith': {
      const value = row.cellsByColumnId[condition.columnId];
      return typeof value === 'string' ? value.endsWith(condition.value) : false;
    }
    case 'greaterThan':
      return compareConditionValues(row.cellsByColumnId[condition.columnId] ?? null, condition.value) > 0;
    case 'lessThan':
      return compareConditionValues(row.cellsByColumnId[condition.columnId] ?? null, condition.value) < 0;
    case 'and':
      return condition.conditions.every((child) => evaluateCondition(child, row));
    case 'or':
      return condition.conditions.some((child) => evaluateCondition(child, row));
    case 'not':
      return !evaluateCondition(condition.condition, row);
    default:
      return false;
  }
}

function refreshTableSchema(table: Table): Table {
  const columns = table.schema.columns.map((column) => {
    const values = table.rowOrder.map((rowId) => table.rowsById[rowId]?.cellsByColumnId[column.columnId] ?? null);

    return {
      ...column,
      logicalType: inferLogicalType(values),
      nullable: values.some((value) => value === null),
      missingCount: values.filter(isMissingValue).length,
    };
  });

  return {
    ...table,
    schema: {
      columns,
    },
  };
}

function cloneSchema(schema: Table['schema']) {
  return {
    columns: schema.columns.map((column) => ({ ...column })),
  };
}

function cloneRowsById(table: Table, rowIds: string[]) {
  return Object.fromEntries(
    rowIds.map((rowId) => [
      rowId,
      {
        rowId,
        cellsByColumnId: { ...table.rowsById[rowId].cellsByColumnId },
      },
    ]),
  );
}

function mapRows(table: Table, mapper: (row: TableRow) => TableRow) {
  return Object.fromEntries(
    table.rowOrder.map((rowId) => {
      const row = table.rowsById[rowId];
      return [rowId, mapper(row)];
    }),
  );
}

function findColumn(table: Table, columnId: string) {
  return table.schema.columns.find((column) => column.columnId === columnId);
}

function buildCreatedColumn(columnId: string, displayName: string, sourceIndex: number): Column {
  return {
    columnId,
    displayName: normalizeWorkflowDisplayName(displayName),
    logicalType: 'unknown',
    nullable: true,
    sourceIndex,
    missingCount: 0,
  };
}

function normalizeWorkflowDisplayName(displayName: string) {
  return normalizeWhitespace(displayName);
}

function getDisplayNameKey(displayName: string) {
  return normalizeWorkflowDisplayName(displayName).toLocaleLowerCase();
}

function shouldTreatAsEmpty(value: CellValue, treatWhitespaceAsEmpty: boolean) {
  if (value === null || value === '') {
    return true;
  }

  return treatWhitespaceAsEmpty && typeof value === 'string' && value.trim() === '';
}

function isStringLikeType(logicalType: LogicalType) {
  return logicalType === 'string' || logicalType === 'unknown';
}

function isOrderingType(logicalType: LogicalType) {
  return logicalType === 'number' || logicalType === 'date' || logicalType === 'datetime' || logicalType === 'unknown';
}

function isFillValueCompatible(value: CellValue, logicalType: LogicalType) {
  switch (logicalType) {
    case 'unknown':
      return value !== null;
    case 'string':
      return typeof value === 'string';
    case 'date':
      return typeof value === 'string' && isIsoDate(value);
    case 'datetime':
      return typeof value === 'string' && isIsoDateTime(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'mixed':
      return false;
    default:
      return false;
  }
}

function inferLiteralLogicalType(value: CellValue): LogicalType {
  if (value === null) {
    return 'unknown';
  }

  if (typeof value === 'number') {
    return 'number';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  if (isIsoDate(value)) {
    return 'date';
  }

  if (isIsoDateTime(value)) {
    return 'datetime';
  }

  return 'string';
}

function isEqualsLiteralCompatible(value: CellValue, logicalType: LogicalType) {
  switch (logicalType) {
    case 'unknown':
      return value !== null;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && isIsoDate(value);
    case 'datetime':
      return typeof value === 'string' && isIsoDateTime(value);
    case 'mixed':
      return false;
    default:
      return false;
  }
}

function isOrderingLiteralCompatible(value: CellValue, logicalType: LogicalType) {
  switch (logicalType) {
    case 'unknown':
      return (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && (isIsoDate(value) || isIsoDateTime(value)));
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'date':
      return typeof value === 'string' && isIsoDate(value);
    case 'datetime':
      return typeof value === 'string' && isIsoDateTime(value);
    default:
      return false;
  }
}

function compareConditionValues(left: CellValue, right: CellValue) {
  if (left === null) {
    return -1;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }

  return 0;
}

function compareSortValues(left: CellValue, right: CellValue, logicalType: LogicalType) {
  if (left === null && right === null) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  switch (logicalType) {
    case 'number':
      return Number(left) - Number(right);
    case 'boolean':
      return Number(left) - Number(right);
    case 'date':
    case 'datetime':
    case 'string':
      return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
    case 'unknown':
      return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
    default:
      return 0;
  }
}

function makeIssue(
  code: string,
  message: string,
  path: string,
  stepId?: string,
  details?: Record<string, unknown>,
): WorkflowValidationIssue {
  return {
    code,
    severity: 'error',
    message,
    path,
    phase: 'semantic',
    stepId,
    details,
  };
}
