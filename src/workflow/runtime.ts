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
  WorkflowCallExpression,
  WorkflowCombineColumnsStep,
  WorkflowCondition,
  WorkflowDeduplicateRowsStep,
  WorkflowExecutionWarning,
  WorkflowExpression,
  WorkflowExpressionValidationResult,
  WorkflowScopedTransformStep,
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

interface ExpressionContext {
  scope: 'scopedTransform' | 'deriveColumn';
  valueLogicalType?: LogicalType;
}

interface ExpressionExecutionContext {
  scope: 'scopedTransform' | 'deriveColumn';
  row: TableRow;
  currentValue: CellValue;
  treatWhitespaceAsEmpty: boolean;
}

type ExpressionRuntimeValue = CellValue | string[];

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
    case 'scopedTransform':
      return validateScopedTransformStep(step, table, basePath);
    case 'dropColumns':
      return validateDropColumnsStep(step, table, basePath);
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

function validateScopedTransformStep(step: WorkflowScopedTransformStep, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  const columns = resolveColumnIds(step.columnIds, table, `${basePath}.columnIds`, step.id, issues);

  if (step.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one column.`, `${basePath}.columnIds`, step.id));
  }

  validateUniqueReferences(step.columnIds, `${basePath}.columnIds`, step.id, issues);

  if (step.rowCondition) {
    issues.push(...validateCondition(step.rowCondition, table, `${basePath}.rowCondition`, step.id));
  }

  columns.forEach((column, columnIndex) => {
    const expressionResult = validateExpression(
      step.expression,
      table,
      `${basePath}.expression`,
      step.id,
      {
        scope: 'scopedTransform',
        valueLogicalType: column.logicalType,
      },
    );

    issues.push(
      ...expressionResult.issues.map((issue) =>
        issue.code === 'incompatibleValueReference'
          ? {
              ...issue,
              path: `${basePath}.columnIds[${columnIndex}]`,
              details: {
                ...issue.details,
                columnId: column.columnId,
              },
            }
          : issue,
      ),
    );

    if (expressionResult.valueKind === 'list') {
      issues.push(
        makeIssue(
          'invalidExpression',
          `Scoped transform expression in step '${step.id}' must resolve to a scalar cell value.`,
          `${basePath}.expression`,
          step.id,
        ),
      );
    }

    if (step.treatWhitespaceAsEmpty && !isStringLikeType(column.logicalType) && expressionUsesCoalesce(step.expression)) {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Whitespace-only empty matching is only valid for string or unknown columns, but '${column.columnId}' is '${column.logicalType}'.`,
          `${basePath}.treatWhitespaceAsEmpty`,
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

function validateDropColumnsStep(step: Extract<WorkflowStep, { type: 'dropColumns' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  resolveColumnIds(step.columnIds, table, `${basePath}.columnIds`, step.id, issues);
  validateUniqueReferences(step.columnIds, `${basePath}.columnIds`, step.id, issues);

  if (step.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one column.`, `${basePath}.columnIds`, step.id));
    return issues;
  }

  const existingDropCount = new Set(step.columnIds.filter((columnId) => findColumn(table, columnId))).size;

  if (existingDropCount >= table.schema.columns.length) {
    issues.push(
      makeIssue(
        'emptySchema',
        `Step '${step.id}' must leave at least one column in the table.`,
        `${basePath}.columnIds`,
        step.id,
      ),
    );
  }

  return issues;
}

function validateDeriveColumnStep(step: Extract<WorkflowStep, { type: 'deriveColumn' }>, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];

  validateNewColumn(table, step.newColumn.columnId, step.newColumn.displayName, `${basePath}.newColumn`, step.id, issues);

  const expressionResult = validateExpression(step.expression, table, `${basePath}.expression`, step.id, {
    scope: 'deriveColumn',
  });
  issues.push(...expressionResult.issues);

  if (expressionResult.valueKind === 'list') {
    issues.push(
      makeIssue(
        'invalidExpression',
        `deriveColumn expression in step '${step.id}' must resolve to a scalar cell value.`,
        `${basePath}.expression`,
        step.id,
      ),
    );
  }

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

function validateCombineColumnsStep(step: WorkflowCombineColumnsStep, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  resolveColumnIds(step.columnIds, table, `${basePath}.columnIds`, step.id, issues);
  validateUniqueReferences(step.columnIds, `${basePath}.columnIds`, step.id, issues);

  if (step.columnIds.length < 2) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least two source columns.`, `${basePath}.columnIds`, step.id));
  }

  validateNewColumn(table, step.newColumn.columnId, step.newColumn.displayName, `${basePath}.newColumn`, step.id, issues);

  return issues;
}

function validateDeduplicateRowsStep(step: WorkflowDeduplicateRowsStep, table: Table, basePath: string) {
  const issues: WorkflowValidationIssue[] = [];
  resolveColumnIds(step.columnIds, table, `${basePath}.columnIds`, step.id, issues);
  validateUniqueReferences(step.columnIds, `${basePath}.columnIds`, step.id, issues);

  if (step.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one key column.`, `${basePath}.columnIds`, step.id));
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
      return;
    }

    seen.add(sort.columnId);
  });

  return issues;
}

function validateExpression(
  expression: WorkflowExpression,
  table: Table,
  path: string,
  stepId: string,
  context: ExpressionContext,
): WorkflowExpressionValidationResult {
  switch (expression.kind) {
    case 'value':
      if (context.scope !== 'scopedTransform') {
        return {
          logicalType: 'unknown',
          valueKind: 'scalar',
          issues: [makeIssue('invalidExpression', `Value references are only valid inside scoped transforms.`, path, stepId)],
        };
      }

      return {
        logicalType: context.valueLogicalType ?? 'unknown',
        valueKind: 'scalar',
        issues: [],
      };
    case 'literal':
      return {
        logicalType: inferLiteralLogicalType(expression.value),
        valueKind: 'scalar',
        issues: [],
      };
    case 'column': {
      const column = findColumn(table, expression.columnId);

      if (!column) {
        return {
          logicalType: 'unknown',
          valueKind: 'scalar',
          issues: [makeIssue('missingColumn', `Column '${expression.columnId}' does not exist at step '${stepId}'.`, `${path}.columnId`, stepId, { columnId: expression.columnId })],
        };
      }

      return {
        logicalType: column.logicalType,
        valueKind: 'scalar',
        issues: [],
      };
    }
    case 'call':
      return validateCallExpression(expression, table, path, stepId, context);
    default:
      return {
        logicalType: 'unknown',
        valueKind: 'scalar',
        issues: [makeIssue('invalidExpression', `Unsupported expression kind in step '${stepId}'.`, path, stepId)],
      };
  }
}

function validateCallExpression(
  expression: WorkflowCallExpression,
  table: Table,
  path: string,
  stepId: string,
  context: ExpressionContext,
): WorkflowExpressionValidationResult {
  const results = expression.args.map((argument, index) => validateExpression(argument, table, `${path}.args[${index}]`, stepId, context));
  const issues = results.flatMap((result) => result.issues);

  switch (expression.name) {
    case 'trim':
    case 'lower':
    case 'upper':
    case 'collapseWhitespace': {
      const [input] = results;

      if (results.length !== 1) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly one argument.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (input.valueKind !== 'scalar' || !isStringLikeType(input.logicalType)) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Function '${expression.name}' requires a string input but received '${input.logicalType}'.`,
            `${path}.args[0]`,
            stepId,
            { logicalType: input.logicalType, functionName: expression.name },
          ),
        );
      }

      return {
        logicalType: input.logicalType === 'string' ? 'string' : 'unknown',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'substring': {
      if (results.length !== 3) {
        issues.push(makeIssue('invalidExpression', `Function 'substring' requires exactly three arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (results[0].valueKind !== 'scalar' || !isStringLikeType(results[0].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'substring' requires a string input.`, `${path}.args[0]`, stepId));
      }

      if (results[1].valueKind !== 'scalar' || !isNumberLikeType(results[1].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'substring' requires a numeric start value.`, `${path}.args[1]`, stepId));
      }

      if (results[2].valueKind !== 'scalar' || !isNumberLikeType(results[2].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'substring' requires a numeric length value.`, `${path}.args[2]`, stepId));
      }

      return {
        logicalType: results[0].logicalType === 'string' ? 'string' : 'unknown',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'replace': {
      if (results.length !== 3) {
        issues.push(makeIssue('invalidExpression', `Function 'replace' requires exactly three arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (results[0].valueKind !== 'scalar' || !isStringLikeType(results[0].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'replace' requires a string input.`, `${path}.args[0]`, stepId));
      }

      if (results[1].valueKind !== 'scalar' || !isStringLikeType(results[1].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'replace' requires a string 'from' value.`, `${path}.args[1]`, stepId));
      }

      if (results[2].valueKind !== 'scalar' || !isStringLikeType(results[2].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'replace' requires a string 'to' value.`, `${path}.args[2]`, stepId));
      }

      return {
        logicalType: results[0].logicalType === 'string' ? 'string' : 'unknown',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'split': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function 'split' requires exactly two arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'list', issues };
      }

      if (results[0].valueKind !== 'scalar' || !isStringLikeType(results[0].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'split' requires a string input.`, `${path}.args[0]`, stepId));
      }

      if (results[1].valueKind !== 'scalar' || !isStringLikeType(results[1].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'split' requires a string delimiter.`, `${path}.args[1]`, stepId));
      }

      return {
        logicalType: results[0].logicalType === 'string' ? 'string' : 'unknown',
        valueKind: 'list',
        issues,
      };
    }
    case 'first':
    case 'last': {
      if (results.length !== 1) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly one argument.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      const [input] = results;

      if (input.valueKind === 'list') {
        return {
          logicalType: 'string',
          valueKind: 'scalar',
          issues,
        };
      }

      if (!isStringLikeType(input.logicalType)) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Function '${expression.name}' requires a string or list input but received '${input.logicalType}'.`,
            `${path}.args[0]`,
            stepId,
            { logicalType: input.logicalType, functionName: expression.name },
          ),
        );
      }

      return {
        logicalType: input.logicalType === 'string' ? 'string' : 'unknown',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'coalesce': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function 'coalesce' requires exactly two arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (results.some((result) => result.valueKind !== 'scalar')) {
        issues.push(makeIssue('invalidExpression', `Function 'coalesce' only accepts scalar inputs.`, path, stepId));
      }

      const concreteTypes = [...new Set(results.map((result) => result.logicalType).filter((logicalType) => logicalType !== 'unknown'))];

      if (concreteTypes.includes('mixed')) {
        issues.push(makeIssue('incompatibleType', `Function 'coalesce' must not include mixed inputs.`, path, stepId));
      } else if (concreteTypes.length > 1) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Function 'coalesce' inputs must resolve to one compatible type.`,
            path,
            stepId,
            { logicalTypes: concreteTypes },
          ),
        );
      }

      return {
        logicalType: (concreteTypes[0] ?? 'unknown') as LogicalType,
        valueKind: 'scalar',
        issues,
      };
    }
    case 'concat':
      if (results.length < 2) {
        issues.push(makeIssue('invalidExpression', `Function 'concat' requires at least two arguments.`, path, stepId));
      }

      if (results.some((result) => result.valueKind !== 'scalar')) {
        issues.push(makeIssue('invalidExpression', `Function 'concat' only accepts scalar inputs.`, path, stepId));
      }

      return {
        logicalType: 'string',
        valueKind: 'scalar',
        issues,
      };
    default:
      return {
        logicalType: 'unknown',
        valueKind: 'scalar',
        issues: [...issues, makeIssue('invalidExpression', `Unsupported function '${expression.name}' in step '${stepId}'.`, path, stepId)],
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
    case 'or':
      if (condition.conditions.length < 2) {
        return [makeIssue('invalidCondition', `Condition '${condition.kind}' in step '${stepId}' requires at least two child conditions.`, path, stepId)];
      }

      return condition.conditions.flatMap((child, index) => validateCondition(child, table, `${path}.conditions[${index}]`, stepId));
    case 'not':
      return validateCondition(condition.condition, table, `${path}.condition`, stepId);
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

function resolveColumnIds(
  columnIds: string[],
  table: Table,
  path: string,
  stepId: string,
  issues: WorkflowValidationIssue[],
) {
  return columnIds.flatMap((columnId, index) => {
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
    case 'scopedTransform':
      return applyScopedTransformStep(table, step);
    case 'dropColumns':
      return applyDropColumnsStep(table, step);
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

function applyScopedTransformStep(table: Table, step: WorkflowScopedTransformStep): WorkflowStepApplyResult {
  const rowsById = mapRows(table, (row) => {
    if (step.rowCondition && !evaluateCondition(step.rowCondition, row)) {
      return {
        rowId: row.rowId,
        cellsByColumnId: { ...row.cellsByColumnId },
      };
    }

    const cellsByColumnId = { ...row.cellsByColumnId };

    step.columnIds.forEach((columnId) => {
      const currentValue = cellsByColumnId[columnId] ?? null;
      const nextValue = toCellValue(evaluateExpression(step.expression, {
        scope: 'scopedTransform',
        row,
        currentValue,
        treatWhitespaceAsEmpty: step.treatWhitespaceAsEmpty,
      }));

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

function applyDropColumnsStep(table: Table, step: Extract<WorkflowStep, { type: 'dropColumns' }>): WorkflowStepApplyResult {
  const removedColumnIds = new Set(step.columnIds);
  const columns = table.schema.columns
    .filter((column) => !removedColumnIds.has(column.columnId))
    .map((column, index) => ({
      ...column,
      sourceIndex: index,
    }));
  const rowsById = mapRows(table, (row) => ({
    rowId: row.rowId,
    cellsByColumnId: Object.fromEntries(
      Object.entries(row.cellsByColumnId).filter(([columnId]) => !removedColumnIds.has(columnId)),
    ),
  }));

  return {
    table: refreshTableSchema({
      ...table,
      schema: {
        columns,
      },
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
      [newColumn.columnId]: toCellValue(evaluateExpression(step.expression, {
        scope: 'deriveColumn',
        row,
        currentValue: null,
        treatWhitespaceAsEmpty: false,
      })),
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

function applyCombineColumnsStep(table: Table, step: WorkflowCombineColumnsStep): WorkflowStepApplyResult {
  const newColumn = buildCreatedColumn(step.newColumn.columnId, step.newColumn.displayName, table.schema.columns.length);
  const rowsById = mapRows(table, (row) => {
    const values = step.columnIds
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

function applyDeduplicateRowsStep(table: Table, step: WorkflowDeduplicateRowsStep): WorkflowStepApplyResult {
  const seenKeys = new Set<string>();
  const keptRowIds: string[] = [];

  table.rowOrder.forEach((rowId) => {
    const row = table.rowsById[rowId];
    const key = JSON.stringify(step.columnIds.map((columnId) => row.cellsByColumnId[columnId] ?? null));

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

function evaluateExpression(expression: WorkflowExpression, context: ExpressionExecutionContext): ExpressionRuntimeValue {
  switch (expression.kind) {
    case 'value':
      return context.currentValue;
    case 'literal':
      return expression.value;
    case 'column':
      return context.row.cellsByColumnId[expression.columnId] ?? null;
    case 'call':
      return evaluateCallExpression(expression, context);
    default:
      return null;
  }
}

function evaluateCallExpression(expression: WorkflowCallExpression, context: ExpressionExecutionContext): ExpressionRuntimeValue {
  switch (expression.name) {
    case 'trim': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'string' ? value.trim() : value;
    }
    case 'lower': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'string' ? value.toLocaleLowerCase() : value;
    }
    case 'upper': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'string' ? value.toLocaleUpperCase() : value;
    }
    case 'collapseWhitespace': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'string' ? value.replace(/\s+/g, ' ') : value;
    }
    case 'substring': {
      const value = evaluateExpression(expression.args[0], context);
      const start = evaluateExpression(expression.args[1], context);
      const length = evaluateExpression(expression.args[2], context);

      if (typeof value !== 'string' || typeof start !== 'number' || typeof length !== 'number') {
        return value;
      }

      const safeStart = Math.max(0, Math.trunc(start));
      const safeLength = Math.max(0, Math.trunc(length));
      return value.slice(safeStart, safeStart + safeLength);
    }
    case 'replace': {
      const value = evaluateExpression(expression.args[0], context);
      const from = evaluateExpression(expression.args[1], context);
      const to = evaluateExpression(expression.args[2], context);

      if (typeof value !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
        return value;
      }

      if (from === '') {
        return value;
      }

      return value.split(from).join(to);
    }
    case 'split': {
      const value = evaluateExpression(expression.args[0], context);
      const delimiter = evaluateExpression(expression.args[1], context);

      if (value === null) {
        return [];
      }

      if (typeof value !== 'string' || typeof delimiter !== 'string') {
        return [];
      }

      return value.split(delimiter);
    }
    case 'first': {
      const value = evaluateExpression(expression.args[0], context);

      if (Array.isArray(value)) {
        return value[0] ?? null;
      }

      if (typeof value === 'string') {
        return value.length > 0 ? value[0] : null;
      }

      return value;
    }
    case 'last': {
      const value = evaluateExpression(expression.args[0], context);

      if (Array.isArray(value)) {
        return value.length > 0 ? value[value.length - 1] : null;
      }

      if (typeof value === 'string') {
        return value.length > 0 ? value[value.length - 1] : null;
      }

      return value;
    }
    case 'coalesce': {
      const first = evaluateExpression(expression.args[0], context);

      if (Array.isArray(first) || !shouldTreatAsEmptyForCoalesce(first, context.treatWhitespaceAsEmpty)) {
        return first;
      }

      return evaluateExpression(expression.args[1], context);
    }
    case 'concat':
      return expression.args
        .map((argument) => evaluateExpression(argument, context))
        .map((value) => (Array.isArray(value) || value === null ? '' : String(value)))
        .join('');
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

function shouldTreatAsEmptyForCoalesce(value: CellValue, treatWhitespaceAsEmpty: boolean) {
  return shouldTreatAsEmpty(value, treatWhitespaceAsEmpty);
}

function toCellValue(value: ExpressionRuntimeValue): CellValue {
  return Array.isArray(value) ? null : value;
}

function isStringLikeType(logicalType: LogicalType) {
  return logicalType === 'string' || logicalType === 'unknown';
}

function isNumberLikeType(logicalType: LogicalType) {
  return logicalType === 'number' || logicalType === 'unknown';
}

function isOrderingType(logicalType: LogicalType) {
  return logicalType === 'number' || logicalType === 'date' || logicalType === 'datetime' || logicalType === 'unknown';
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
    case 'unknown':
      return String(left) === String(right) ? 0 : String(left) < String(right) ? -1 : 1;
    default:
      return 0;
  }
}

function expressionUsesCoalesce(expression: WorkflowExpression): boolean {
  if (expression.kind === 'call' && expression.name === 'coalesce') {
    return true;
  }

  if (expression.kind !== 'call') {
    return false;
  }

  return expression.args.some((argument) => expressionUsesCoalesce(argument));
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
