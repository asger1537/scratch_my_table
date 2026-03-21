import type { Column } from '../domain/model';
import type { Workflow, WorkflowCondition, WorkflowExpression, WorkflowStep } from '../workflow';

let currentColumns: Column[] = [];
let extraColumnIds = new Set<string>();

export function setEditorSchemaColumns(columns: Column[], extraIds: string[] = []) {
  currentColumns = columns.map((column) => ({ ...column }));
  extraColumnIds = new Set(extraIds.filter((columnId) => columnId !== ''));
}

export function getSchemaColumnOptions(): [string, string][] {
  const options = currentColumns.map((column) => [`${column.displayName} [${column.columnId}]`, column.columnId] as [string, string]);

  [...extraColumnIds]
    .filter((columnId) => !currentColumns.some((column) => column.columnId === columnId))
    .sort()
    .forEach((columnId) => {
      options.push([`Missing column [${columnId}]`, columnId]);
    });

  return options.length > 0 ? options : [['No columns loaded', '']];
}

export function collectWorkflowColumnIds(workflow: Workflow): string[] {
  const columnIds = new Set<string>();

  workflow.steps.forEach((step) => {
    collectStepColumnIds(step, columnIds);
  });

  return [...columnIds];
}

function collectStepColumnIds(step: WorkflowStep, columnIds: Set<string>) {
  switch (step.type) {
    case 'fillEmpty':
    case 'normalizeText':
    case 'combineColumns':
    case 'deduplicateRows':
      step.target.columnIds.forEach((columnId) => columnIds.add(columnId));
      return;
    case 'renameColumn':
    case 'splitColumn':
      columnIds.add(step.columnId);
      return;
    case 'sortRows':
      step.sorts.forEach((sort) => columnIds.add(sort.columnId));
      return;
    case 'deriveColumn':
      collectExpressionColumnIds(step.expression, columnIds);
      return;
    case 'filterRows':
      collectConditionColumnIds(step.condition, columnIds);
      return;
    default:
      return;
  }
}

function collectExpressionColumnIds(expression: WorkflowExpression, columnIds: Set<string>) {
  switch (expression.kind) {
    case 'column':
      columnIds.add(expression.columnId);
      return;
    case 'concat':
      expression.parts.forEach((part) => collectExpressionColumnIds(part, columnIds));
      return;
    case 'coalesce':
      expression.inputs.forEach((input) => collectExpressionColumnIds(input, columnIds));
      return;
    default:
      return;
  }
}

function collectConditionColumnIds(condition: WorkflowCondition, columnIds: Set<string>) {
  switch (condition.kind) {
    case 'isEmpty':
    case 'equals':
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'greaterThan':
    case 'lessThan':
      columnIds.add(condition.columnId);
      return;
    case 'and':
    case 'or':
      condition.conditions.forEach((child) => collectConditionColumnIds(child, columnIds));
      return;
    case 'not':
      collectConditionColumnIds(condition.condition, columnIds);
      return;
    default:
      return;
  }
}
