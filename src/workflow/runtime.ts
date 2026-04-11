import {
  type CellValue,
  type CellStyle,
  type Column,
  type LogicalType,
  type Table,
  type TableRow,
  isValidFillColor,
  normalizeFillColor,
  isMissingValue,
} from '../domain/model';
import { inferLogicalType, isIsoDate, isIsoDateTime, normalizeWhitespace } from '../domain/normalize';

import type {
  WorkflowCellFormatPatch,
  WorkflowCellPatch,
  Workflow,
  WorkflowCallExpression,
  WorkflowCombineColumnsStep,
  WorkflowDeduplicateRowsStep,
  WorkflowExecutionWarning,
  WorkflowExpression,
  WorkflowExpressionValidationResult,
  WorkflowMatchCase,
  WorkflowMatchExpression,
  WorkflowRuleCase,
  WorkflowSemanticStepResult,
  WorkflowSemanticValidationResult,
  WorkflowStepExecutionSummary,
  WorkflowStep,
  WorkflowValidationIssue,
} from './types';

interface WorkflowStepApplyResult {
  table: Table;
  createdColumnIds: string[];
  warnings: WorkflowExecutionWarning[];
  sortApplied: boolean;
  summary: WorkflowStepExecutionSummary;
}

interface WorkflowChangeSummary {
  changedRowCount: number;
  changedCellCount: number;
  createdColumnIds: string[];
  removedRowCount: number;
  rowOrderChanged: boolean;
}

interface ExpressionContext {
  runTimestamp: string;
  allowValueReference: boolean;
  valueLogicalType?: LogicalType;
  allowCaseValueReference?: boolean;
  caseValueLogicalType?: LogicalType;
}

interface ExpressionExecutionContext {
  runTimestamp: string;
  row: TableRow;
  currentValue: CellValue;
  caseValue?: CellValue;
}

type ExpressionRuntimeValue = CellValue | string[];

const MISSING_CELL = Symbol('missingCell');
const DATE_PART_UNITS = new Set(['year', 'month', 'day', 'dayOfWeek', 'hour', 'minute', 'second']);
const DATE_DURATION_UNITS = new Set(['years', 'months', 'days', 'hours', 'minutes', 'seconds']);
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND;
const MILLISECONDS_PER_HOUR = 60 * MILLISECONDS_PER_MINUTE;
const MILLISECONDS_PER_DAY = 24 * MILLISECONDS_PER_HOUR;
const MILLISECONDS_PER_MONTH = 30 * MILLISECONDS_PER_DAY;
const MILLISECONDS_PER_YEAR = 365 * MILLISECONDS_PER_DAY;
const SCHEMA_PROJECTION_RUN_TIMESTAMP = '2000-01-01T00:00:00.000Z';

export function validateWorkflowSemantics(workflow: Workflow, table: Table): WorkflowSemanticValidationResult {
  const runTimestamp = new Date().toISOString();
  let workingTable = cloneTableWithSchema(table, cloneSchema(table.schema));
  const issues: WorkflowValidationIssue[] = [];
  const stepResults: WorkflowSemanticStepResult[] = [];

  workflow.steps.forEach((step, stepIndex) => {
    const stepIssues = validateWorkflowStep(step, workingTable, stepIndex, runTimestamp);
    const valid = stepIssues.length === 0;

    if (valid) {
      workingTable = projectValidatedWorkflowStep(workingTable, step, runTimestamp);
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
  const runTimestamp = new Date().toISOString();
  let workingTable = cloneTable(table);
  const executionWarnings: WorkflowExecutionWarning[] = [];
  const stepSummaries: WorkflowStepExecutionSummary[] = [];
  let sortApplied = false;

  workflow.steps.forEach((step) => {
    const stepResult = applyWorkflowStepUnchecked(workingTable, step, runTimestamp);
    workingTable = stepResult.table;
    executionWarnings.push(...stepResult.warnings);
    stepSummaries.push(stepResult.summary);
    sortApplied = sortApplied || stepResult.sortApplied;
  });

  return {
    transformedTable: workingTable,
    executionWarnings,
    sortApplied,
    changeSummary: summarizeWorkflowChanges(table, workingTable),
    stepSummaries,
  };
}

export function cloneTable(table: Table): Table {
  const rowsById: Record<string, TableRow> = {};

  Object.entries(table.rowsById).forEach(([rowId, row]) => {
    rowsById[rowId] = {
      rowId,
      cellsByColumnId: { ...row.cellsByColumnId },
      stylesByColumnId: cloneStylesByColumnId(row.stylesByColumnId),
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
      const originalStyle = originalColumnIdSet.has(columnId)
        ? getComparableCellStyle(originalRow.stylesByColumnId[columnId])
        : MISSING_CELL;
      const transformedStyle = transformedColumnIdSet.has(columnId)
        ? getComparableCellStyle(transformedRow.stylesByColumnId[columnId])
        : MISSING_CELL;

      if (!Object.is(originalValue, transformedValue) || !Object.is(originalStyle, transformedStyle)) {
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

function validateWorkflowStep(step: WorkflowStep, table: Table, stepIndex: number, runTimestamp: string): WorkflowValidationIssue[] {
  const basePath = `steps[${stepIndex}]`;

  switch (step.type) {
    case 'comment':
      return [];
    case 'scopedRule':
      return validateScopedRuleStep(step, table, basePath, runTimestamp);
    case 'dropColumns':
      return validateDropColumnsStep(step, table, basePath);
    case 'renameColumn':
      return validateRenameColumnStep(step, table, basePath);
    case 'deriveColumn':
      return validateDeriveColumnStep(step, table, basePath, runTimestamp);
    case 'filterRows':
      return validateFilterRowsStep(step, table, basePath, runTimestamp);
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

function validateScopedRuleStep(
  step: Extract<WorkflowStep, { type: 'scopedRule' }>,
  table: Table,
  basePath: string,
  runTimestamp: string,
) {
  const issues: WorkflowValidationIssue[] = [];
  const columns = resolveColumnIds(step.columnIds, table, `${basePath}.columnIds`, step.id, issues);

  if (step.columnIds.length === 0) {
    issues.push(makeIssue('emptyTarget', `Step '${step.id}' must target at least one column.`, `${basePath}.columnIds`, step.id));
  }

  validateUniqueReferences(step.columnIds, `${basePath}.columnIds`, step.id, issues);

  if (step.rowCondition) {
    issues.push(...validateBooleanExpressionWithContext(step.rowCondition, table, `${basePath}.rowCondition`, step.id, {
      runTimestamp,
      allowValueReference: false,
    }));
  }

  columns.forEach((column, columnIndex) => {
    const projectedTypes: LogicalType[] = [];

    if (scopedRuleRetainsOriginalValueType(step)) {
      projectedTypes.push(column.logicalType);
    }

    (step.cases ?? []).forEach((ruleCase, caseIndex) => {
      issues.push(...validateBooleanExpressionWithContext(ruleCase.when, table, `${basePath}.cases[${caseIndex}].when`, step.id, {
        runTimestamp,
        allowValueReference: true,
        valueLogicalType: column.logicalType,
      }));

      const patchResult = validateCellPatch(ruleCase.then, table, `${basePath}.cases[${caseIndex}].then`, step.id, {
        runTimestamp,
        allowValueReference: true,
        valueLogicalType: column.logicalType,
      });

      issues.push(...patchResult.issues);

      if (patchResult.valueLogicalType) {
        projectedTypes.push(patchResult.valueLogicalType);
      }
    });

    if (step.defaultPatch) {
      const patchResult = validateCellPatch(step.defaultPatch, table, `${basePath}.defaultPatch`, step.id, {
        runTimestamp,
        allowValueReference: true,
        valueLogicalType: column.logicalType,
      });

      issues.push(...patchResult.issues);

      if (patchResult.valueLogicalType) {
        projectedTypes.push(patchResult.valueLogicalType);
      }
    }

    const mergeResult = mergeLogicalTypes(projectedTypes);

    if (!mergeResult.valid) {
      issues.push(
        makeIssue(
          'incompatibleType',
          `Scoped rule '${step.id}' must not mix incompatible value result types for targeted column '${column.columnId}'.`,
          `${basePath}.columnIds[${columnIndex}]`,
          step.id,
          { columnId: column.columnId, logicalTypes: mergeResult.logicalTypes },
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

function validateDeriveColumnStep(step: Extract<WorkflowStep, { type: 'deriveColumn' }>, table: Table, basePath: string, runTimestamp: string) {
  const issues: WorkflowValidationIssue[] = [];

  validateNewColumn(table, step.newColumn.columnId, step.newColumn.displayName, `${basePath}.newColumn`, step.id, issues);

  const expressionResult = validateExpression(step.expression, table, `${basePath}.expression`, step.id, {
    runTimestamp,
    allowValueReference: false,
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

function validateFilterRowsStep(step: Extract<WorkflowStep, { type: 'filterRows' }>, table: Table, basePath: string, runTimestamp: string) {
  return validateBooleanExpressionWithContext(step.condition, table, `${basePath}.condition`, step.id, {
    runTimestamp,
    allowValueReference: false,
  });
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
      if (!context.allowValueReference) {
        return {
          logicalType: 'unknown',
          valueKind: 'scalar',
          issues: [makeIssue('invalidExpression', `Value references are only valid inside scoped rules.`, path, stepId)],
        };
      }

      return {
        logicalType: context.valueLogicalType ?? 'unknown',
        valueKind: 'scalar',
        issues: [],
      };
    case 'caseValue':
      if (!context.allowCaseValueReference) {
        return {
          logicalType: 'unknown',
          valueKind: 'scalar',
          issues: [makeIssue('invalidExpression', `caseValue is only valid inside match cases.`, path, stepId)],
        };
      }

      return {
        logicalType: context.caseValueLogicalType ?? 'unknown',
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
    case 'match':
      return validateMatchExpression(expression, table, path, stepId, context);
    default:
      return {
        logicalType: 'unknown',
        valueKind: 'scalar',
        issues: [makeIssue('invalidExpression', `Unsupported expression kind in step '${stepId}'.`, path, stepId)],
      };
  }
}

function validateBooleanExpression(expression: WorkflowExpression, table: Table, path: string, stepId: string, runTimestamp: string) {
  return validateBooleanExpressionWithContext(expression, table, path, stepId, {
    runTimestamp,
    allowValueReference: false,
    allowCaseValueReference: false,
  });
}

function validateBooleanExpressionWithContext(
  expression: WorkflowExpression,
  table: Table,
  path: string,
  stepId: string,
  context: ExpressionContext,
) {
  const result = validateExpression(expression, table, path, stepId, {
    ...context,
  });
  const issues = [...result.issues];

  if (result.valueKind !== 'scalar') {
    issues.push(makeIssue('invalidExpression', 'Logical expression must resolve to a scalar boolean value.', path, stepId));
  }

  if (result.logicalType !== 'boolean' && result.logicalType !== 'unknown') {
    issues.push(makeIssue('incompatibleType', 'Logical expression must resolve to a boolean.', path, stepId));
  }

  return issues;
}

function validateCellPatch(
  patch: WorkflowCellPatch,
  table: Table,
  path: string,
  stepId: string,
  context: ExpressionContext,
) {
  const issues: WorkflowValidationIssue[] = [];
  let valueLogicalType: LogicalType | null = null;

  if (!patch.value && !patch.format) {
    issues.push(makeIssue('invalidExpression', `Patch in step '${stepId}' must define a value or format change.`, path, stepId));
  }

  if (patch.value) {
    const valueResult = validateExpression(patch.value, table, `${path}.value`, stepId, context);

    issues.push(...valueResult.issues);

    if (valueResult.valueKind !== 'scalar') {
      issues.push(makeIssue('invalidExpression', `Patch value in step '${stepId}' must resolve to a scalar cell value.`, `${path}.value`, stepId));
    } else {
      valueLogicalType = valueResult.logicalType;
    }
  }

  if (patch.format) {
    if (!patch.format.fillColor) {
      issues.push(makeIssue('invalidExpression', `Format patch in step '${stepId}' must define at least one formatting property.`, `${path}.format`, stepId));
    } else if (!isValidFillColor(patch.format.fillColor)) {
      issues.push(makeIssue('invalidColor', `Step '${stepId}' must use a hex color like '#ffeb9c'.`, `${path}.format.fillColor`, stepId));
    }
  }

  return {
    issues,
    valueLogicalType,
  };
}

function mergeLogicalTypes(logicalTypes: LogicalType[]) {
  const concreteTypes = [...new Set(logicalTypes.filter((logicalType) => logicalType !== 'unknown'))];

  if (concreteTypes.length === 1 && concreteTypes[0] === 'mixed') {
    return {
      valid: true,
      logicalType: 'mixed' as const,
      logicalTypes: concreteTypes,
    };
  }

  if (concreteTypes.includes('mixed') || concreteTypes.length > 1) {
    return {
      valid: false,
      logicalType: 'unknown' as const,
      logicalTypes: concreteTypes,
    };
  }

  return {
    valid: true,
    logicalType: (concreteTypes[0] ?? 'unknown') as LogicalType,
    logicalTypes: concreteTypes,
  };
}

function scopedRuleRetainsOriginalValueType(step: Extract<WorkflowStep, { type: 'scopedRule' }>) {
  return Boolean(
    step.rowCondition
    || !step.defaultPatch?.value
    || (step.cases ?? []).some((ruleCase) => !ruleCase.then.value),
  );
}

function validateMatchExpression(
  expression: WorkflowMatchExpression,
  table: Table,
  path: string,
  stepId: string,
  context: ExpressionContext,
): WorkflowExpressionValidationResult {
  const subjectResult = validateExpression(expression.subject, table, `${path}.subject`, stepId, {
    ...context,
    allowValueReference: false,
    allowCaseValueReference: false,
  });
  const issues = [...subjectResult.issues];

  if (subjectResult.valueKind !== 'scalar') {
    issues.push(makeIssue('invalidExpression', `Match subject must resolve to a scalar value.`, `${path}.subject`, stepId));
  }

  if (expression.cases.length === 0) {
    issues.push(makeIssue('invalidExpression', `Match expressions require at least one case.`, `${path}.cases`, stepId));
  }

  let otherwiseSeen = false;
  const thenResults: WorkflowExpressionValidationResult[] = [];

  expression.cases.forEach((matchCase, caseIndex) => {
    const casePath = `${path}.cases[${caseIndex}]`;

    if (otherwiseSeen) {
      issues.push(makeIssue('invalidExpression', `Match cases after an otherwise case are unreachable.`, casePath, stepId));
    }

    if (matchCase.kind === 'when') {
      issues.push(...validateBooleanExpressionWithContext(matchCase.when, table, `${casePath}.when`, stepId, {
        ...context,
        allowCaseValueReference: true,
        caseValueLogicalType: subjectResult.logicalType,
      }));
    } else {
      if (otherwiseSeen) {
        issues.push(makeIssue('invalidExpression', `Match expressions may include at most one otherwise case.`, `${casePath}.kind`, stepId));
      }

      otherwiseSeen = true;

      if (caseIndex !== expression.cases.length - 1) {
        issues.push(makeIssue('invalidExpression', `Otherwise match cases must be last.`, `${casePath}.kind`, stepId));
      }
    }

    const thenResult = validateExpression(matchCase.then, table, `${casePath}.then`, stepId, {
      ...context,
      allowCaseValueReference: true,
      caseValueLogicalType: subjectResult.logicalType,
    });
    issues.push(...thenResult.issues);

    if (thenResult.valueKind !== 'scalar') {
      issues.push(makeIssue('invalidExpression', `Match case results must resolve to a scalar value.`, `${casePath}.then`, stepId));
    }

    thenResults.push(thenResult);
  });

  const mergedResultType = mergeLogicalTypes(thenResults.map((result) => result.logicalType));

  if (!mergedResultType.valid) {
    issues.push(
      makeIssue(
        'incompatibleType',
        `Match case results must resolve to one compatible type.`,
        path,
        stepId,
        { logicalTypes: mergedResultType.logicalTypes },
      ),
    );
  }

  return {
    logicalType: mergedResultType.logicalType,
    valueKind: 'scalar',
    issues,
  };
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
    case 'now': {
      if (results.length !== 0) {
        issues.push(makeIssue('invalidExpression', `Function 'now' requires zero arguments.`, path, stepId));
      }

      return {
        logicalType: 'datetime',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'datePart': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function 'datePart' requires exactly two arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (results[0].valueKind !== 'scalar' || !isDateTimeLikeType(results[0].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'datePart' requires a date, datetime, or string input.`, `${path}.args[0]`, stepId));
      }

      if (results[1].valueKind !== 'scalar' || !isStringLikeType(results[1].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'datePart' requires a string unit.`, `${path}.args[1]`, stepId));
      }

      const unit = getLiteralStringValue(expression.args[1]);

      if (unit !== null && !DATE_PART_UNITS.has(unit)) {
        issues.push(makeIssue('invalidExpression', `Function 'datePart' does not support unit '${unit}'.`, `${path}.args[1]`, stepId));
      }

      return {
        logicalType: 'number',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'dateDiff': {
      if (results.length !== 3) {
        issues.push(makeIssue('invalidExpression', `Function 'dateDiff' requires exactly three arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (results[0].valueKind !== 'scalar' || !isDateTimeLikeType(results[0].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'dateDiff' requires a date, datetime, or string input.`, `${path}.args[0]`, stepId));
      }

      if (results[1].valueKind !== 'scalar' || !isDateTimeLikeType(results[1].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'dateDiff' requires a date, datetime, or string input.`, `${path}.args[1]`, stepId));
      }

      const unit = getLiteralStringValue(expression.args[2]);

      if (unit === null) {
        issues.push(makeIssue('invalidExpression', `Function 'dateDiff' requires a string literal unit.`, `${path}.args[2]`, stepId));
      } else if (!DATE_DURATION_UNITS.has(unit)) {
        issues.push(makeIssue('invalidExpression', `Function 'dateDiff' does not support unit '${unit}'.`, `${path}.args[2]`, stepId));
      }

      return {
        logicalType: 'number',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'dateAdd': {
      if (results.length !== 3) {
        issues.push(makeIssue('invalidExpression', `Function 'dateAdd' requires exactly three arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (results[0].valueKind !== 'scalar' || !isDateTimeLikeType(results[0].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'dateAdd' requires a date, datetime, or string input.`, `${path}.args[0]`, stepId));
      }

      if (results[1].valueKind !== 'scalar' || !isNumberLikeType(results[1].logicalType)) {
        issues.push(makeIssue('incompatibleType', `Function 'dateAdd' requires a numeric amount.`, `${path}.args[1]`, stepId));
      }

      const unit = getLiteralStringValue(expression.args[2]);

      if (unit === null) {
        issues.push(makeIssue('invalidExpression', `Function 'dateAdd' requires a string literal unit.`, `${path}.args[2]`, stepId));
      } else if (!DATE_DURATION_UNITS.has(unit)) {
        issues.push(makeIssue('invalidExpression', `Function 'dateAdd' does not support unit '${unit}'.`, `${path}.args[2]`, stepId));
      }

      return {
        logicalType: 'datetime',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'round':
    case 'floor':
    case 'ceil':
    case 'abs': {
      const [input] = results;

      if (results.length !== 1) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly one argument.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (input.valueKind !== 'scalar' || !isNumberLikeType(input.logicalType)) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Function '${expression.name}' requires a numeric input but received '${input.logicalType}'.`,
            `${path}.args[0]`,
            stepId,
            { logicalType: input.logicalType, functionName: expression.name },
          ),
        );
      }

      return {
        logicalType: 'number',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'trim':
    case 'lower':
    case 'upper':
    case 'toNumber':
    case 'toString':
    case 'toBoolean':
    case 'collapseWhitespace': {
      const [input] = results;

      if (results.length !== 1) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly one argument.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      if (input.valueKind !== 'scalar') {
        issues.push(
          makeIssue(
            'invalidExpression',
            `Function '${expression.name}' only accepts scalar inputs.`,
            `${path}.args[0]`,
            stepId,
            { logicalType: input.logicalType, functionName: expression.name },
          ),
        );
      }

      if (
        (expression.name === 'trim' || expression.name === 'lower' || expression.name === 'upper' || expression.name === 'collapseWhitespace')
        && !isStringLikeType(input.logicalType)
      ) {
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
        logicalType: expression.name === 'toNumber'
          ? 'number'
          : expression.name === 'toBoolean'
            ? 'boolean'
            : expression.name === 'toString'
              ? 'string'
              : input.logicalType === 'string'
                ? 'string'
                : 'unknown',
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
    case 'replaceRegex': {
      if (results.length !== 3) {
        issues.push(makeIssue('invalidExpression', `Function 'replaceRegex' requires exactly three arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      results.forEach((result, index) => {
        if (result.valueKind !== 'scalar' || !isStringLikeType(result.logicalType)) {
          issues.push(makeIssue('incompatibleType', `Function 'replaceRegex' requires string inputs.`, `${path}.args[${index}]`, stepId));
        }
      });

      if (
        expression.args[1]?.kind === 'literal'
        && typeof expression.args[1].value === 'string'
        && !isValidRegexPattern(expression.args[1].value)
      ) {
        issues.push(makeIssue('invalidRegex', `Regular expression '${expression.args[1].value}' is invalid.`, `${path}.args[1]`, stepId, { pattern: expression.args[1].value }));
      }

      return {
        logicalType: 'string',
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
    case 'extractRegex': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function 'extractRegex' requires exactly two arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      results.forEach((result, index) => {
        if (result.valueKind !== 'scalar' || !isStringLikeType(result.logicalType)) {
          issues.push(makeIssue('incompatibleType', `Function 'extractRegex' requires string inputs.`, `${path}.args[${index}]`, stepId));
        }
      });

      if (
        expression.args[1]?.kind === 'literal'
        && typeof expression.args[1].value === 'string'
        && !isValidRegexPattern(expression.args[1].value)
      ) {
        issues.push(makeIssue('invalidRegex', `Regular expression '${expression.args[1].value}' is invalid.`, `${path}.args[1]`, stepId, { pattern: expression.args[1].value }));
      }

      return {
        logicalType: 'string',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'atIndex': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function 'atIndex' requires exactly two arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      const [input, index] = results;

      if (input.valueKind !== 'list' && (input.valueKind !== 'scalar' || !isStringLikeType(input.logicalType))) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Function 'atIndex' requires a string or list input.`,
            `${path}.args[0]`,
            stepId,
            { logicalType: input.logicalType, valueKind: input.valueKind },
          ),
        );
      }

      if (index.valueKind !== 'scalar' || !isNumberLikeType(index.logicalType)) {
        issues.push(
          makeIssue(
            'incompatibleType',
            `Function 'atIndex' requires a numeric index.`,
            `${path}.args[1]`,
            stepId,
            { logicalType: index.logicalType, valueKind: index.valueKind },
          ),
        );
      }

      return {
        logicalType: input.logicalType === 'string' || input.valueKind === 'list' ? 'string' : 'unknown',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide':
    case 'modulo': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly two arguments.`, path, stepId));
        return { logicalType: 'unknown', valueKind: 'scalar', issues };
      }

      results.forEach((result, index) => {
        if (result.valueKind !== 'scalar' || !isNumberLikeType(result.logicalType)) {
          issues.push(
            makeIssue(
              'incompatibleType',
              `Function '${expression.name}' requires numeric inputs.`,
              `${path}.args[${index}]`,
              stepId,
            ),
          );
        }
      });

      return {
        logicalType: 'number',
        valueKind: 'scalar',
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
    case 'isEmpty': {
      if (results.length !== 1) {
        issues.push(makeIssue('invalidExpression', `Function 'isEmpty' requires exactly one argument.`, path, stepId));
      }

      if (results[0]?.valueKind !== 'scalar') {
        issues.push(makeIssue('invalidExpression', `Function 'isEmpty' only accepts scalar inputs.`, `${path}.args[0]`, stepId));
      }

      return {
        logicalType: 'boolean',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'not': {
      if (results.length !== 1) {
        issues.push(makeIssue('invalidExpression', `Function 'not' requires exactly one argument.`, path, stepId));
      }

      if (results[0]?.valueKind !== 'scalar' || !isBooleanLikeType(results[0]?.logicalType ?? 'unknown')) {
        issues.push(makeIssue('incompatibleType', `Function 'not' requires a boolean input.`, `${path}.args[0]`, stepId));
      }

      return {
        logicalType: 'boolean',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'and':
    case 'or': {
      if (results.length < 2) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires at least two arguments.`, path, stepId));
      }

      results.forEach((result, index) => {
        if (result.valueKind !== 'scalar' || !isBooleanLikeType(result.logicalType)) {
          issues.push(makeIssue('incompatibleType', `Function '${expression.name}' requires boolean inputs.`, `${path}.args[${index}]`, stepId));
        }
      });

      return {
        logicalType: 'boolean',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'equals': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function 'equals' requires exactly two arguments.`, path, stepId));
      }

      if (results.some((result) => result.valueKind !== 'scalar')) {
        issues.push(makeIssue('invalidExpression', `Function 'equals' only accepts scalar inputs.`, path, stepId));
      }

      if (!areComparableEqualityTypes(results[0]?.logicalType ?? 'unknown', results[1]?.logicalType ?? 'unknown')) {
        issues.push(makeIssue('incompatibleType', `Function 'equals' requires comparable scalar inputs.`, path, stepId));
      }

      return {
        logicalType: 'boolean',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'greaterThan':
    case 'lessThan': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly two arguments.`, path, stepId));
      }

      if (results.some((result) => result.valueKind !== 'scalar')) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' only accepts scalar inputs.`, path, stepId));
      }

      if (!areComparableOrderingTypes(results[0]?.logicalType ?? 'unknown', results[1]?.logicalType ?? 'unknown')) {
        issues.push(makeIssue('incompatibleType', `Function '${expression.name}' requires comparable ordered inputs.`, path, stepId));
      }

      return {
        logicalType: 'boolean',
        valueKind: 'scalar',
        issues,
      };
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'matchesRegex': {
      if (results.length !== 2) {
        issues.push(makeIssue('invalidExpression', `Function '${expression.name}' requires exactly two arguments.`, path, stepId));
      }

      results.forEach((result, index) => {
        if (result.valueKind !== 'scalar' || !isStringLikeType(result.logicalType)) {
          issues.push(makeIssue('incompatibleType', `Function '${expression.name}' requires string inputs.`, `${path}.args[${index}]`, stepId));
        }
      });

      if (
        expression.name === 'matchesRegex'
        && expression.args[1]?.kind === 'literal'
        && typeof expression.args[1].value === 'string'
        && !isValidRegexPattern(expression.args[1].value)
      ) {
        issues.push(makeIssue('invalidRegex', `Regular expression '${expression.args[1].value}' is invalid.`, `${path}.args[1]`, stepId, { pattern: expression.args[1].value }));
      }

      return {
        logicalType: 'boolean',
        valueKind: 'scalar',
        issues,
      };
    }
    default:
      return {
        logicalType: 'unknown',
        valueKind: 'scalar',
        issues: [...issues, makeIssue('invalidExpression', `Unsupported function '${expression.name}' in step '${stepId}'.`, path, stepId)],
      };
  }
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

function projectValidatedWorkflowStep(table: Table, step: WorkflowStep, runTimestamp: string): Table {
  switch (step.type) {
    case 'comment':
      return table;
    case 'scopedRule':
      return projectScopedRuleSchema(table, step, runTimestamp);
    case 'dropColumns':
      return projectDropColumnsSchema(table, step);
    case 'renameColumn':
      return projectRenameColumnSchema(table, step);
    case 'deriveColumn':
      return projectDeriveColumnSchema(table, step, runTimestamp);
    case 'filterRows':
    case 'deduplicateRows':
    case 'sortRows':
      return cloneTableWithSchema(table, cloneSchema(table.schema));
    case 'splitColumn':
      return projectSplitColumnSchema(table, step);
    case 'combineColumns':
      return projectCombineColumnsSchema(table, step);
    default:
      return cloneTableWithSchema(table, cloneSchema(table.schema));
  }
}

function projectScopedRuleSchema(
  table: Table,
  step: Extract<WorkflowStep, { type: 'scopedRule' }>,
  runTimestamp: string,
): Table {
  const projectedTypes = new Map<string, LogicalType>();

  step.columnIds.forEach((columnId) => {
    const column = findColumn(table, columnId);

    if (!column) {
      return;
    }

    projectedTypes.set(columnId, getProjectedScopedRuleLogicalType(step, table, column.logicalType, runTimestamp));
  });

  return cloneTableWithSchema(table, {
    columns: table.schema.columns.map((column) =>
      projectedTypes.has(column.columnId)
        ? {
            ...column,
            logicalType: projectedTypes.get(column.columnId) ?? column.logicalType,
            nullable: true,
          }
        : { ...column },
    ),
  });
}

function projectDropColumnsSchema(table: Table, step: Extract<WorkflowStep, { type: 'dropColumns' }>): Table {
  const removedColumnIds = new Set(step.columnIds);

  return cloneTableWithSchema(table, {
    columns: table.schema.columns
      .filter((column) => !removedColumnIds.has(column.columnId))
      .map((column, index) => ({
        ...column,
        sourceIndex: index,
      })),
  });
}

function projectRenameColumnSchema(table: Table, step: Extract<WorkflowStep, { type: 'renameColumn' }>): Table {
  return cloneTableWithSchema(table, {
    columns: table.schema.columns.map((column) =>
      column.columnId === step.columnId
        ? {
            ...column,
            displayName: normalizeWorkflowDisplayName(step.newDisplayName),
          }
        : { ...column },
    ),
  });
}

function projectDeriveColumnSchema(
  table: Table,
  step: Extract<WorkflowStep, { type: 'deriveColumn' }>,
  runTimestamp: string,
): Table {
  const result = validateExpression(step.expression, table, '$projection.expression', step.id, {
    runTimestamp,
    allowValueReference: false,
  });

  const newColumn = buildCreatedColumn(step.newColumn.columnId, step.newColumn.displayName, table.schema.columns.length);

  newColumn.logicalType = result.valueKind === 'scalar' ? result.logicalType : 'unknown';

  return cloneTableWithSchema(table, {
    columns: [...table.schema.columns.map((column) => ({ ...column })), newColumn],
  });
}

function projectSplitColumnSchema(table: Table, step: Extract<WorkflowStep, { type: 'splitColumn' }>): Table {
  const outputColumns = step.outputColumns.map((outputColumn, index) => ({
    ...buildCreatedColumn(outputColumn.columnId, outputColumn.displayName, table.schema.columns.length + index),
    logicalType: 'string' as const,
  }));

  return cloneTableWithSchema(table, {
    columns: [...table.schema.columns.map((column) => ({ ...column })), ...outputColumns],
  });
}

function projectCombineColumnsSchema(table: Table, step: WorkflowCombineColumnsStep): Table {
  const newColumn = buildCreatedColumn(step.newColumn.columnId, step.newColumn.displayName, table.schema.columns.length);

  newColumn.logicalType = 'string';

  return cloneTableWithSchema(table, {
    columns: [...table.schema.columns.map((column) => ({ ...column })), newColumn],
  });
}

function applyWorkflowStepUnchecked(table: Table, step: WorkflowStep, runTimestamp: string): WorkflowStepApplyResult {
  switch (step.type) {
    case 'comment':
      return {
        table,
        createdColumnIds: [],
        warnings: [],
        sortApplied: false,
        summary: createEmptyStepSummary(step.id, step.type),
      };
    case 'scopedRule':
      return applyScopedRuleStep(table, step, runTimestamp);
    case 'dropColumns':
      return applyDropColumnsStep(table, step);
    case 'renameColumn':
      return applyRenameColumnStep(table, step);
    case 'deriveColumn':
      return applyDeriveColumnStep(table, step, runTimestamp);
    case 'filterRows':
      return applyFilterRowsStep(table, step, runTimestamp);
    case 'splitColumn':
      return applySplitColumnStep(table, step);
    case 'combineColumns':
      return applyCombineColumnsStep(table, step);
    case 'deduplicateRows':
      return applyDeduplicateRowsStep(table, step);
    case 'sortRows':
      return applySortRowsStep(table, step);
  }
}

function applyScopedRuleStep(
  table: Table,
  step: Extract<WorkflowStep, { type: 'scopedRule' }>,
  runTimestamp: string,
): WorkflowStepApplyResult {
  const summary = createEmptyStepSummary(step.id, step.type);
  const rowsById = mapRows(table, (row) => {
    if (
      step.rowCondition
      && !Boolean(evaluateExpression(step.rowCondition, {
        runTimestamp,
        row,
        currentValue: null,
      }))
    ) {
      return {
        rowId: row.rowId,
        cellsByColumnId: { ...row.cellsByColumnId },
        stylesByColumnId: cloneStylesByColumnId(row.stylesByColumnId),
      };
    }

    const cellsByColumnId = { ...row.cellsByColumnId };
    const stylesByColumnId = cloneStylesByColumnId(row.stylesByColumnId);

    step.columnIds.forEach((columnId) => {
      const originalValue = row.cellsByColumnId[columnId] ?? null;
      const originalStyle = stylesByColumnId[columnId];
      const resolvedPatch = resolveScopedRulePatch(step, row, originalValue, originalStyle, runTimestamp);

      if (!resolvedPatch.matched) {
        return;
      }

      summary.matchedCellCount += 1;
      const valueChanged = resolvedPatch.valueApplied && !Object.is(originalValue, resolvedPatch.nextValue);
      const formatChanged =
        resolvedPatch.formatApplied
        && !Object.is(getComparableCellStyle(originalStyle), getComparableCellStyle(resolvedPatch.nextStyle));

      if (resolvedPatch.valueApplied) {
        cellsByColumnId[columnId] = resolvedPatch.nextValue;
      }

      if (resolvedPatch.formatApplied && resolvedPatch.nextStyle) {
        stylesByColumnId[columnId] = resolvedPatch.nextStyle;
      }

      if (valueChanged) {
        summary.valueChangedCellCount += 1;
      }

      if (formatChanged) {
        summary.formatChangedCellCount += 1;
      }

      if (valueChanged || formatChanged) {
        summary.changedCellCount += 1;
      }
    });

    return {
      rowId: row.rowId,
      cellsByColumnId,
      stylesByColumnId,
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
    summary,
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
    stylesByColumnId: Object.fromEntries(
      Object.entries(row.stylesByColumnId).filter(([columnId]) => !removedColumnIds.has(columnId)),
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
    summary: createEmptyStepSummary(step.id, step.type),
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
    summary: createEmptyStepSummary(step.id, step.type),
  };
}

function applyDeriveColumnStep(table: Table, step: Extract<WorkflowStep, { type: 'deriveColumn' }>, runTimestamp: string): WorkflowStepApplyResult {
  const newColumn = buildCreatedColumn(step.newColumn.columnId, step.newColumn.displayName, table.schema.columns.length);
  const rowsById = mapRows(table, (row) => ({
    rowId: row.rowId,
    cellsByColumnId: {
      ...row.cellsByColumnId,
      [newColumn.columnId]: toCellValue(evaluateExpression(step.expression, {
        runTimestamp,
        row,
        currentValue: null,
      })),
    },
    stylesByColumnId: cloneStylesByColumnId(row.stylesByColumnId),
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
    summary: createEmptyStepSummary(step.id, step.type),
  };
}

function applyFilterRowsStep(table: Table, step: Extract<WorkflowStep, { type: 'filterRows' }>, runTimestamp: string): WorkflowStepApplyResult {
  const keptRowIds = table.rowOrder.filter((rowId) => {
    const row = table.rowsById[rowId];
    const matches = Boolean(evaluateExpression(step.condition, {
      runTimestamp,
      row,
      currentValue: null,
    }));

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
    summary: createEmptyStepSummary(step.id, step.type),
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
      stylesByColumnId: cloneStylesByColumnId(row.stylesByColumnId),
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
    summary: createEmptyStepSummary(step.id, step.type),
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
      stylesByColumnId: cloneStylesByColumnId(row.stylesByColumnId),
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
    summary: createEmptyStepSummary(step.id, step.type),
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
    summary: createEmptyStepSummary(step.id, step.type),
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
    summary: createEmptyStepSummary(step.id, step.type),
  };
}

function evaluateExpression(expression: WorkflowExpression, context: ExpressionExecutionContext): ExpressionRuntimeValue {
  switch (expression.kind) {
    case 'value':
      return context.currentValue;
    case 'caseValue':
      return context.caseValue ?? null;
    case 'literal':
      return expression.value;
    case 'column':
      return context.row.cellsByColumnId[expression.columnId] ?? null;
    case 'call':
      return evaluateCallExpression(expression, context);
    case 'match':
      return evaluateMatchExpression(expression, context);
    default:
      return null;
  }
}

function evaluateMatchExpression(expression: WorkflowMatchExpression, context: ExpressionExecutionContext): ExpressionRuntimeValue {
  const subjectValue = evaluateExpression(expression.subject, context);
  const matchContext = { ...context, caseValue: Array.isArray(subjectValue) ? null : subjectValue };

  for (const matchCase of expression.cases) {
    if (matchCase.kind === 'when' && !Boolean(evaluateExpression(matchCase.when, matchContext))) {
      continue;
    }

    return evaluateExpression(matchCase.then, matchContext);
  }

  return null;
}

function evaluateCallExpression(expression: WorkflowCallExpression, context: ExpressionExecutionContext): ExpressionRuntimeValue {
  switch (expression.name) {
    case 'now':
      return context.runTimestamp;
    case 'datePart': {
      const input = evaluateExpression(expression.args[0], context);
      const unit = evaluateExpression(expression.args[1], context);
      const date = parseDateMathValue(input);

      if (!date || typeof unit !== 'string') {
        return null;
      }

      switch (unit) {
        case 'year':
          return date.getUTCFullYear();
        case 'month':
          return date.getUTCMonth() + 1;
        case 'day':
          return date.getUTCDate();
        case 'dayOfWeek':
          return date.getUTCDay();
        case 'hour':
          return date.getUTCHours();
        case 'minute':
          return date.getUTCMinutes();
        case 'second':
          return date.getUTCSeconds();
        default:
          return null;
      }
    }
    case 'dateDiff': {
      const left = parseDateMathValue(evaluateExpression(expression.args[0], context));
      const right = parseDateMathValue(evaluateExpression(expression.args[1], context));
      const unit = evaluateExpression(expression.args[2], context);
      const divisor = typeof unit === 'string' ? getDateDurationUnitMilliseconds(unit) : null;

      if (!left || !right || divisor === null) {
        return null;
      }

      return (left.getTime() - right.getTime()) / divisor;
    }
    case 'dateAdd': {
      const input = parseDateMathValue(evaluateExpression(expression.args[0], context));
      const amount = evaluateExpression(expression.args[1], context);
      const unit = evaluateExpression(expression.args[2], context);

      if (!input || typeof amount !== 'number' || typeof unit !== 'string') {
        return null;
      }

      const next = new Date(input.getTime());

      switch (unit) {
        case 'years':
          next.setUTCFullYear(next.getUTCFullYear() + amount);
          break;
        case 'months':
          next.setUTCMonth(next.getUTCMonth() + amount);
          break;
        case 'days':
          next.setUTCDate(next.getUTCDate() + amount);
          break;
        case 'hours':
          next.setUTCHours(next.getUTCHours() + amount);
          break;
        case 'minutes':
          next.setUTCMinutes(next.getUTCMinutes() + amount);
          break;
        case 'seconds':
          next.setUTCSeconds(next.getUTCSeconds() + amount);
          break;
        default:
          return null;
      }

      return next.toISOString();
    }
    case 'round': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'number' ? Math.round(value) : null;
    }
    case 'floor': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'number' ? Math.floor(value) : null;
    }
    case 'ceil': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'number' ? Math.ceil(value) : null;
    }
    case 'abs': {
      const value = evaluateExpression(expression.args[0], context);
      return typeof value === 'number' ? Math.abs(value) : null;
    }
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
    case 'toNumber': {
      return castToNumber(evaluateExpression(expression.args[0], context));
    }
    case 'toString': {
      return castToString(evaluateExpression(expression.args[0], context));
    }
    case 'toBoolean': {
      return castToBoolean(evaluateExpression(expression.args[0], context));
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
    case 'replaceRegex': {
      const value = evaluateExpression(expression.args[0], context);
      const pattern = evaluateExpression(expression.args[1], context);
      const replacement = evaluateExpression(expression.args[2], context);

      if (typeof value !== 'string' || typeof pattern !== 'string' || typeof replacement !== 'string') {
        return value;
      }

      try {
        return value.replace(new RegExp(pattern, 'g'), replacement);
      } catch {
        return value;
      }
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
    case 'extractRegex': {
      const value = evaluateExpression(expression.args[0], context);
      const pattern = evaluateExpression(expression.args[1], context);

      if (typeof value !== 'string' || typeof pattern !== 'string') {
        return null;
      }

      try {
        const match = value.match(new RegExp(pattern));
        return match ? match[0] : null;
      } catch {
        return null;
      }
    }
    case 'atIndex': {
      const value = evaluateExpression(expression.args[0], context);
      const indexVal = evaluateExpression(expression.args[1], context);

      if (typeof indexVal !== 'number') {
        return null;
      }

      const idx = Math.trunc(indexVal);

      if (Array.isArray(value)) {
        return value[idx] ?? null;
      }

      if (typeof value === 'string') {
        return value[idx] ?? null;
      }

      return null;
    }
    case 'add': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);
      return typeof left === 'number' && typeof right === 'number' ? left + right : null;
    }
    case 'subtract': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);
      return typeof left === 'number' && typeof right === 'number' ? left - right : null;
    }
    case 'multiply': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);
      return typeof left === 'number' && typeof right === 'number' ? left * right : null;
    }
    case 'divide': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);

      if (typeof left !== 'number' || typeof right !== 'number' || right === 0) {
        return null;
      }

      return left / right;
    }
    case 'modulo': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);

      if (typeof left !== 'number' || typeof right !== 'number' || right === 0) {
        return null;
      }

      return left % right;
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

      if (Array.isArray(first) || !isEmptyValue(first)) {
        return first;
      }

      return evaluateExpression(expression.args[1], context);
    }
    case 'concat':
      return expression.args
        .map((argument) => evaluateExpression(argument, context))
        .map((value) => (Array.isArray(value) || value === null ? '' : String(value)))
        .join('');
    case 'isEmpty': {
      const value = evaluateExpression(expression.args[0], context);
      return !Array.isArray(value) && isBlankLikeValue(value);
    }
    case 'not':
      return !Boolean(evaluateExpression(expression.args[0], context));
    case 'and':
      return expression.args.every((argument) => Boolean(evaluateExpression(argument, context)));
    case 'or':
      return expression.args.some((argument) => Boolean(evaluateExpression(argument, context)));
    case 'equals': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);
      return !Array.isArray(left) && !Array.isArray(right) && Object.is(left, right);
    }
    case 'greaterThan': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);
      return !Array.isArray(left) && !Array.isArray(right) && compareExpressionValues(left, right) > 0;
    }
    case 'lessThan': {
      const left = evaluateExpression(expression.args[0], context);
      const right = evaluateExpression(expression.args[1], context);
      return !Array.isArray(left) && !Array.isArray(right) && compareExpressionValues(left, right) < 0;
    }
    case 'contains': {
      const value = evaluateExpression(expression.args[0], context);
      const search = evaluateExpression(expression.args[1], context);
      return typeof value === 'string' && typeof search === 'string' ? value.includes(search) : false;
    }
    case 'startsWith': {
      const value = evaluateExpression(expression.args[0], context);
      const search = evaluateExpression(expression.args[1], context);
      return typeof value === 'string' && typeof search === 'string' ? value.startsWith(search) : false;
    }
    case 'endsWith': {
      const value = evaluateExpression(expression.args[0], context);
      const search = evaluateExpression(expression.args[1], context);
      return typeof value === 'string' && typeof search === 'string' ? value.endsWith(search) : false;
    }
    case 'matchesRegex': {
      const value = evaluateExpression(expression.args[0], context);
      const pattern = evaluateExpression(expression.args[1], context);

      if (typeof value !== 'string' || typeof pattern !== 'string') {
        return false;
      }

      try {
        return new RegExp(pattern).test(value);
      } catch {
        return false;
      }
    }
    default:
      return null;
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

function createEmptyStepSummary(
  stepId: string,
  stepType: WorkflowStep['type'],
): WorkflowStepExecutionSummary {
  return {
    stepId,
    stepType,
    matchedCellCount: 0,
    valueChangedCellCount: 0,
    formatChangedCellCount: 0,
    changedCellCount: 0,
  };
}

function getProjectedScopedRuleLogicalType(
  step: Extract<WorkflowStep, { type: 'scopedRule' }>,
  table: Table,
  currentLogicalType: LogicalType,
  runTimestamp: string,
) {
  const projectedTypes: LogicalType[] = [];

  if (scopedRuleRetainsOriginalValueType(step)) {
    projectedTypes.push(currentLogicalType);
  }

  (step.cases ?? []).forEach((ruleCase, caseIndex) => {
    const patchResult = validateCellPatch(ruleCase.then, table, `$projection.cases[${caseIndex}].then`, step.id, {
      runTimestamp,
      allowValueReference: true,
      valueLogicalType: currentLogicalType,
    });

    if (patchResult.valueLogicalType) {
      projectedTypes.push(patchResult.valueLogicalType);
    }
  });

  if (step.defaultPatch) {
    const patchResult = validateCellPatch(step.defaultPatch, table, '$projection.defaultPatch', step.id, {
      runTimestamp,
      allowValueReference: true,
      valueLogicalType: currentLogicalType,
    });

    if (patchResult.valueLogicalType) {
      projectedTypes.push(patchResult.valueLogicalType);
    }
  }

  return mergeLogicalTypes(projectedTypes).logicalType;
}

function resolveScopedRulePatch(
  step: Extract<WorkflowStep, { type: 'scopedRule' }>,
  row: TableRow,
  currentValue: CellValue,
  currentStyle: CellStyle | undefined,
  runTimestamp: string,
) {
  let workingValue = currentValue;
  let workingStyle = currentStyle ? { ...currentStyle } : undefined;
  let matched = false;
  let valueApplied = false;
  let formatApplied = false;

  for (const ruleCase of step.cases ?? []) {
    if (!Boolean(evaluateExpression(ruleCase.when, {
      runTimestamp,
      row,
      currentValue: workingValue,
    }))) {
      continue;
    }

    matched = true;

    if (ruleCase.then.value) {
      workingValue = toCellValue(evaluateExpression(ruleCase.then.value, {
        runTimestamp,
        row,
        currentValue: workingValue,
      }));
      valueApplied = true;
    }

    if (ruleCase.then.format?.fillColor) {
      workingStyle = {
        ...workingStyle,
        fillColor: normalizeFillColor(ruleCase.then.format.fillColor),
      };
      formatApplied = true;
    }
  }

  if (!matched && step.defaultPatch) {
    if (step.defaultPatch.value) {
      workingValue = toCellValue(evaluateExpression(step.defaultPatch.value, {
        runTimestamp,
        row,
        currentValue: workingValue,
      }));
      valueApplied = true;
    }

    if (step.defaultPatch.format?.fillColor) {
      workingStyle = {
        ...workingStyle,
        fillColor: normalizeFillColor(step.defaultPatch.format.fillColor),
      };
      formatApplied = true;
    }
  }

  return {
    matched: matched || Boolean(step.defaultPatch),
    valueApplied,
    nextValue: workingValue,
    formatApplied,
    nextStyle: workingStyle,
  };
}

function normalizeCellFormatPatch(format: WorkflowCellFormatPatch | undefined) {
  if (!format) {
    return undefined;
  }

  return {
    ...format,
    ...(format.fillColor ? { fillColor: normalizeFillColor(format.fillColor) } : {}),
  };
}

function applyCellPatchFormat(
  stylesByColumnId: Record<string, CellStyle>,
  columnId: string,
  format: WorkflowCellFormatPatch | undefined,
) {
  if (!format?.fillColor) {
    return {
      stylesByColumnId,
      formatChanged: false,
    };
  }

  const previousStyle = getComparableCellStyle(stylesByColumnId[columnId]);
  const nextStyle = {
    ...stylesByColumnId[columnId],
    ...normalizeCellFormatPatch(format),
  };
  const nextComparableStyle = getComparableCellStyle(nextStyle);

  stylesByColumnId[columnId] = nextStyle;

  return {
    stylesByColumnId,
    formatChanged: !Object.is(previousStyle, nextComparableStyle),
  };
}

function applyCellPatchValue(
  patch: WorkflowCellPatch,
  row: TableRow,
  currentValue: CellValue,
  runTimestamp: string,
) {
  if (!patch.value) {
    return {
      nextValue: currentValue,
      valueChanged: false,
    };
  }

  const nextValue = toCellValue(evaluateExpression(patch.value, {
    runTimestamp,
    row,
    currentValue,
  }));

  return {
    nextValue,
    valueChanged: !Object.is(currentValue, nextValue),
  };
}

function cloneCellPatch(patch: WorkflowCellPatch | undefined) {
  if (!patch) {
    return undefined;
  }

  return {
    ...(patch.value ? { value: patch.value } : {}),
    ...(patch.format ? { format: normalizeCellFormatPatch(patch.format) } : {}),
  };
}

function cloneRuleCase(ruleCase: WorkflowRuleCase) {
  return {
    when: ruleCase.when,
    then: cloneCellPatch(ruleCase.then) ?? {},
  };
}

function cloneScopedRuleStep(step: Extract<WorkflowStep, { type: 'scopedRule' }>) {
  return {
    ...step,
    columnIds: [...step.columnIds],
    ...(step.cases ? { cases: step.cases.map(cloneRuleCase) } : {}),
    ...(step.defaultPatch ? { defaultPatch: cloneCellPatch(step.defaultPatch) } : {}),
  };
}

function getComparableCellPatchFormat(format: WorkflowCellFormatPatch | undefined) {
  return format?.fillColor ?? null;
}

function getComparableCellPatch(patch: WorkflowCellPatch | undefined) {
  return patch
    ? JSON.stringify({
        hasValue: Boolean(patch.value),
        format: getComparableCellPatchFormat(patch.format),
      })
    : null;
}

function getRuleCasesWithDefault(step: Extract<WorkflowStep, { type: 'scopedRule' }>) {
  return {
    cases: (step.cases ?? []).map(cloneRuleCase),
    defaultPatch: cloneCellPatch(step.defaultPatch),
  };
}

function hasCellPatchValue(patch: WorkflowCellPatch | undefined) {
  return Boolean(patch?.value);
}

function hasCellPatchFormat(patch: WorkflowCellPatch | undefined) {
  return Boolean(patch?.format?.fillColor);
}

function isEmptyCellPatch(patch: WorkflowCellPatch | undefined) {
  return !hasCellPatchValue(patch) && !hasCellPatchFormat(patch);
}

function getScopedRulePatches(step: Extract<WorkflowStep, { type: 'scopedRule' }>) {
  return [...(step.cases ?? []).map((ruleCase) => ruleCase.then), ...(step.defaultPatch ? [step.defaultPatch] : [])];
}

function canApplyScopedRuleValueToAllPaths(step: Extract<WorkflowStep, { type: 'scopedRule' }>) {
  return !step.rowCondition && step.defaultPatch?.value && (step.cases ?? []).every((ruleCase) => ruleCase.then.value);
}

function scopedRuleChangesOnlyFormat(step: Extract<WorkflowStep, { type: 'scopedRule' }>) {
  return getScopedRulePatches(step).every((patch) => !patch.value && Boolean(patch.format?.fillColor));
}

function getScopedRuleProjectedTypeCandidates(
  step: Extract<WorkflowStep, { type: 'scopedRule' }>,
  currentLogicalType: LogicalType,
  table: Table,
  runTimestamp: string,
) {
  const projectedTypes: LogicalType[] = [];

  if (!canApplyScopedRuleValueToAllPaths(step)) {
    projectedTypes.push(currentLogicalType);
  }

  getScopedRulePatches(step).forEach((patch, index) => {
    if (!patch.value) {
      return;
    }

    const patchResult = validateCellPatch(patch, table, `$projection.patch[${index}]`, step.id, {
      runTimestamp,
      allowValueReference: true,
      valueLogicalType: currentLogicalType,
    });

    if (patchResult.valueLogicalType) {
      projectedTypes.push(patchResult.valueLogicalType);
    }
  });

  return projectedTypes;
}

export function projectWorkflowStepSchema(table: Table, step: WorkflowStep): Table {
  return projectValidatedWorkflowStep(table, step, SCHEMA_PROJECTION_RUN_TIMESTAMP);
}

function cloneTableWithSchema(table: Table, schema: Table['schema']): Table {
  return {
    ...table,
    schema,
  };
}

function cloneRowsById(table: Table, rowIds: string[]) {
  return Object.fromEntries(
    rowIds.map((rowId) => [
      rowId,
      {
        rowId,
        cellsByColumnId: { ...table.rowsById[rowId].cellsByColumnId },
        stylesByColumnId: cloneStylesByColumnId(table.rowsById[rowId].stylesByColumnId),
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

function cloneStylesByColumnId(stylesByColumnId: Record<string, CellStyle> | undefined) {
  return Object.fromEntries(
    Object.entries(stylesByColumnId ?? {}).map(([columnId, style]) => [columnId, { ...style }]),
  );
}

function normalizeWorkflowDisplayName(displayName: string) {
  return normalizeWhitespace(displayName);
}

function getDisplayNameKey(displayName: string) {
  return normalizeWorkflowDisplayName(displayName).toLocaleLowerCase();
}

function isEmptyValue(value: CellValue) {
  return value === null || value === '';
}

function isBlankLikeValue(value: CellValue) {
  return value === null || (typeof value === 'string' && value.trim() === '');
}

function getComparableCellStyle(style: CellStyle | undefined) {
  return style?.fillColor ?? null;
}

function isValidRegexPattern(pattern: string) {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function toCellValue(value: ExpressionRuntimeValue): CellValue {
  return Array.isArray(value) ? null : value;
}

function castToNumber(value: ExpressionRuntimeValue): CellValue {
  if (Array.isArray(value) || value === null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function castToString(value: ExpressionRuntimeValue): CellValue {
  if (Array.isArray(value) || value === null) {
    return null;
  }

  return typeof value === 'string' ? value : String(value);
}

function castToBoolean(value: ExpressionRuntimeValue): CellValue {
  if (Array.isArray(value) || value === null) {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    if (value === 1) {
      return true;
    }

    if (value === 0) {
      return false;
    }

    return null;
  }

  const normalized = value.trim().toLocaleLowerCase();

  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return null;
}

function isStringLikeType(logicalType: LogicalType) {
  return logicalType === 'string' || logicalType === 'unknown';
}

function isDateTimeLikeType(logicalType: LogicalType) {
  return logicalType === 'date' || logicalType === 'datetime' || isStringLikeType(logicalType);
}

function isNumberLikeType(logicalType: LogicalType) {
  return logicalType === 'number' || logicalType === 'unknown';
}

function getLiteralStringValue(expression: WorkflowExpression | undefined): string | null {
  return expression?.kind === 'literal' && typeof expression.value === 'string'
    ? expression.value
    : null;
}

function parseDateMathValue(value: ExpressionRuntimeValue): Date | null {
  if (value === null || Array.isArray(value) || typeof value === 'number' || typeof value === 'boolean') {
    return null;
  }

  const text = String(value).trim();

  if (text === '') {
    return null;
  }

  let candidate = text;

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    candidate = `${text}T00:00:00.000Z`;
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(text)) {
    candidate = `${text}Z`;
  }

  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function getDateDurationUnitMilliseconds(unit: string): number | null {
  switch (unit) {
    case 'years':
      return MILLISECONDS_PER_YEAR;
    case 'months':
      return MILLISECONDS_PER_MONTH;
    case 'days':
      return MILLISECONDS_PER_DAY;
    case 'hours':
      return MILLISECONDS_PER_HOUR;
    case 'minutes':
      return MILLISECONDS_PER_MINUTE;
    case 'seconds':
      return MILLISECONDS_PER_SECOND;
    default:
      return null;
  }
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

function compareExpressionValues(left: CellValue, right: CellValue) {
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

function isBooleanLikeType(logicalType: LogicalType) {
  return logicalType === 'boolean' || logicalType === 'unknown';
}

function areComparableEqualityTypes(left: LogicalType, right: LogicalType) {
  if (left === 'mixed' || right === 'mixed') {
    return false;
  }

  const concreteTypes = new Set([left, right].filter((logicalType) => logicalType !== 'unknown'));
  return concreteTypes.size <= 1;
}

function areComparableOrderingTypes(left: LogicalType, right: LogicalType) {
  if (!isOrderingType(left) || !isOrderingType(right)) {
    return false;
  }

  const concreteTypes = new Set([left, right].filter((logicalType) => logicalType !== 'unknown'));

  if (concreteTypes.size === 0) {
    return true;
  }

  if (concreteTypes.size > 1) {
    return false;
  }

  const [logicalType] = [...concreteTypes];
  return logicalType === 'number' || logicalType === 'date' || logicalType === 'datetime';
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
