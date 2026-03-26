import type { CellValue, LogicalType, Schema, Table } from '../domain/model';

export type WorkflowScalar = CellValue;
export type WorkflowNonNullScalar = Exclude<WorkflowScalar, null>;
export type WorkflowVersion = 2;

export type WorkflowStepType =
  | 'scopedTransform'
  | 'dropColumns'
  | 'renameColumn'
  | 'deriveColumn'
  | 'filterRows'
  | 'splitColumn'
  | 'combineColumns'
  | 'deduplicateRows'
  | 'sortRows';

export interface Workflow {
  version: WorkflowVersion;
  workflowId: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface WorkflowNewColumn {
  columnId: string;
  displayName: string;
}

export type WorkflowExpressionFunctionName =
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
  | 'isEmpty';

export type WorkflowExpression =
  | WorkflowValueExpression
  | WorkflowLiteralExpression
  | WorkflowColumnExpression
  | WorkflowCallExpression;

export interface WorkflowValueExpression {
  kind: 'value';
}

export interface WorkflowLiteralExpression {
  kind: 'literal';
  value: WorkflowScalar;
}

export interface WorkflowColumnExpression {
  kind: 'column';
  columnId: string;
}

export interface WorkflowCallExpression {
  kind: 'call';
  name: WorkflowExpressionFunctionName;
  args: WorkflowExpression[];
}

export interface WorkflowScopedTransformStep {
  id: string;
  type: 'scopedTransform';
  columnIds: string[];
  rowCondition?: WorkflowExpression;
  expression: WorkflowExpression;
}

export interface WorkflowRenameColumnStep {
  id: string;
  type: 'renameColumn';
  columnId: string;
  newDisplayName: string;
}

export interface WorkflowDropColumnsStep {
  id: string;
  type: 'dropColumns';
  columnIds: string[];
}

export interface WorkflowDeriveColumnStep {
  id: string;
  type: 'deriveColumn';
  newColumn: WorkflowNewColumn;
  expression: WorkflowExpression;
}

export interface WorkflowFilterRowsStep {
  id: string;
  type: 'filterRows';
  mode: 'keep' | 'drop';
  condition: WorkflowExpression;
}

export interface WorkflowSplitColumnStep {
  id: string;
  type: 'splitColumn';
  columnId: string;
  delimiter: string;
  outputColumns: WorkflowNewColumn[];
}

export interface WorkflowCombineColumnsStep {
  id: string;
  type: 'combineColumns';
  columnIds: string[];
  separator: string;
  newColumn: WorkflowNewColumn;
}

export interface WorkflowDeduplicateRowsStep {
  id: string;
  type: 'deduplicateRows';
  columnIds: string[];
}

export interface WorkflowSortKey {
  columnId: string;
  direction: 'asc' | 'desc';
}

export interface WorkflowSortRowsStep {
  id: string;
  type: 'sortRows';
  sorts: WorkflowSortKey[];
}

export type WorkflowStep =
  | WorkflowScopedTransformStep
  | WorkflowDropColumnsStep
  | WorkflowRenameColumnStep
  | WorkflowDeriveColumnStep
  | WorkflowFilterRowsStep
  | WorkflowSplitColumnStep
  | WorkflowCombineColumnsStep
  | WorkflowDeduplicateRowsStep
  | WorkflowSortRowsStep;

export type WorkflowValidationPhase = 'structural' | 'semantic';

export interface WorkflowValidationIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path: string;
  phase: WorkflowValidationPhase;
  stepId?: string;
  details?: Record<string, unknown>;
}

export interface WorkflowStructuralValidationResult {
  valid: boolean;
  workflow?: Workflow;
  issues: WorkflowValidationIssue[];
}

export interface WorkflowSemanticStepResult {
  stepId: string;
  stepType: WorkflowStepType;
  valid: boolean;
  issues: WorkflowValidationIssue[];
  schemaAfterStep: Schema;
}

export interface WorkflowSemanticValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
  stepResults: WorkflowSemanticStepResult[];
  finalSchema: Schema;
}

export interface WorkflowExecutionWarning {
  code: string;
  message: string;
  stepId?: string;
  details?: Record<string, unknown>;
}

export interface WorkflowExecutionResult {
  transformedTable: Table | null;
  validationErrors: WorkflowValidationIssue[];
  executionWarnings: WorkflowExecutionWarning[];
  changedRowCount: number;
  changedCellCount: number;
  createdColumnIds: string[];
  removedRowCount: number;
  rowOrderChanged: boolean;
  sortApplied: boolean;
}

export interface WorkflowExpressionValidationResult {
  logicalType: LogicalType;
  valueKind: 'scalar' | 'list';
  issues: WorkflowValidationIssue[];
}
