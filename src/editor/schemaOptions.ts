import type { Column } from '../domain/model';
import type { Workflow, WorkflowExpression, WorkflowStep } from '../workflow';

let currentColumns: Column[] = [];
let extraColumnIds = new Set<string>();
let blockColumnsById = new Map<string, Column[]>();

export interface EditorSchemaSnapshot {
  columns: Column[];
  extraColumnIds: string[];
  schemaByBlockId: Map<string, Column[]>;
}

export function setEditorSchemaColumns(columns: Column[], extraIds: string[] = [], schemaByBlockId?: Map<string, Column[]>) {
  currentColumns = columns.map((column) => ({ ...column }));
  extraColumnIds = new Set(extraIds.filter((columnId) => columnId !== ''));
  blockColumnsById = new Map(
    [...(schemaByBlockId ?? new Map<string, Column[]>()).entries()].map(([blockId, blockColumns]) => [
      blockId,
      blockColumns.map((column) => ({ ...column })),
    ]),
  );
}

export function captureEditorSchemaSnapshot(): EditorSchemaSnapshot {
  return {
    columns: currentColumns.map((column) => ({ ...column })),
    extraColumnIds: [...extraColumnIds],
    schemaByBlockId: new Map(
      [...blockColumnsById.entries()].map(([blockId, blockColumns]) => [
        blockId,
        blockColumns.map((column) => ({ ...column })),
      ]),
    ),
  };
}

export function restoreEditorSchemaSnapshot(snapshot: EditorSchemaSnapshot) {
  setEditorSchemaColumns(snapshot.columns, snapshot.extraColumnIds, snapshot.schemaByBlockId);
}

export function getSchemaColumnOptions(blockId?: string): [string, string][] {
  const columns = getEditorSchemaColumns(blockId);
  const options = columns.map((column) => [`${column.displayName} [${column.columnId}]`, column.columnId] as [string, string]);

  [...extraColumnIds]
    .filter((columnId) => !columns.some((column) => column.columnId === columnId))
    .sort()
    .forEach((columnId) => {
      options.push([`Missing column [${columnId}]`, columnId]);
    });

  return options.length > 0 ? options : [['No columns loaded', '']];
}

export function getEditorSchemaColumns(blockId?: string): Column[] {
  const columns = blockId ? (blockColumnsById.get(blockId) ?? currentColumns) : currentColumns;
  return columns.map((column) => ({ ...column }));
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
    case 'scopedRule':
      step.columnIds.forEach((columnId) => columnIds.add(columnId));
      if (step.rowCondition) {
        collectExpressionColumnIds(step.rowCondition, columnIds);
      }
      step.cases?.forEach((ruleCase) => {
        collectExpressionColumnIds(ruleCase.when, columnIds);
        if (ruleCase.then.value) {
          collectExpressionColumnIds(ruleCase.then.value, columnIds);
        }
      });
      if (step.defaultPatch?.value) {
        collectExpressionColumnIds(step.defaultPatch.value, columnIds);
      }
      return;
    case 'dropColumns':
    case 'combineColumns':
    case 'deduplicateRows':
      step.columnIds.forEach((columnId) => columnIds.add(columnId));
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
      collectExpressionColumnIds(step.condition, columnIds);
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
    case 'caseValue':
      return;
    case 'match':
      collectExpressionColumnIds(expression.subject, columnIds);
      expression.cases.forEach((matchCase) => {
        if (matchCase.kind === 'when') {
          collectExpressionColumnIds(matchCase.when, columnIds);
        }

        collectExpressionColumnIds(matchCase.then, columnIds);
      });
      return;
    case 'call':
      expression.args.forEach((argument) => collectExpressionColumnIds(argument, columnIds));
      return;
    default:
      return;
  }
}

