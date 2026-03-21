import type { CellValue, LogicalType, Schema, Table } from '../domain/model';

export type WorkflowScalar = CellValue;
export type WorkflowNonNullScalar = Exclude<WorkflowScalar, null>;
export type WorkflowStepType =
  | 'fillEmpty'
  | 'normalizeText'
  | 'renameColumn'
  | 'deriveColumn'
  | 'filterRows'
  | 'splitColumn'
  | 'combineColumns'
  | 'deduplicateRows'
  | 'sortRows';

export interface Workflow {
  version: 1;
  workflowId: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
}

export interface WorkflowColumnTarget {
  kind: 'columns';
  columnIds: string[];
}

export interface WorkflowNewColumn {
  columnId: string;
  displayName: string;
}

export type WorkflowExpression =
  | WorkflowLiteralExpression
  | WorkflowColumnExpression
  | WorkflowConcatExpression
  | WorkflowCoalesceExpression;

export interface WorkflowLiteralExpression {
  kind: 'literal';
  value: WorkflowScalar;
}

export interface WorkflowColumnExpression {
  kind: 'column';
  columnId: string;
}

export interface WorkflowConcatExpression {
  kind: 'concat';
  parts: WorkflowExpression[];
}

export interface WorkflowCoalesceExpression {
  kind: 'coalesce';
  inputs: WorkflowExpression[];
}

export type WorkflowCondition =
  | WorkflowIsEmptyCondition
  | WorkflowEqualsCondition
  | WorkflowContainsCondition
  | WorkflowStartsWithCondition
  | WorkflowEndsWithCondition
  | WorkflowGreaterThanCondition
  | WorkflowLessThanCondition
  | WorkflowAndCondition
  | WorkflowOrCondition
  | WorkflowNotCondition;

export interface WorkflowIsEmptyCondition {
  kind: 'isEmpty';
  columnId: string;
  treatWhitespaceAsEmpty: boolean;
}

export interface WorkflowEqualsCondition {
  kind: 'equals';
  columnId: string;
  value: WorkflowNonNullScalar;
}

export interface WorkflowContainsCondition {
  kind: 'contains';
  columnId: string;
  value: string;
}

export interface WorkflowStartsWithCondition {
  kind: 'startsWith';
  columnId: string;
  value: string;
}

export interface WorkflowEndsWithCondition {
  kind: 'endsWith';
  columnId: string;
  value: string;
}

export interface WorkflowGreaterThanCondition {
  kind: 'greaterThan';
  columnId: string;
  value: WorkflowNonNullScalar;
}

export interface WorkflowLessThanCondition {
  kind: 'lessThan';
  columnId: string;
  value: WorkflowNonNullScalar;
}

export interface WorkflowAndCondition {
  kind: 'and';
  conditions: WorkflowCondition[];
}

export interface WorkflowOrCondition {
  kind: 'or';
  conditions: WorkflowCondition[];
}

export interface WorkflowNotCondition {
  kind: 'not';
  condition: WorkflowCondition;
}

export interface WorkflowFillEmptyStep {
  id: string;
  type: 'fillEmpty';
  target: WorkflowColumnTarget;
  value: WorkflowNonNullScalar;
  treatWhitespaceAsEmpty: boolean;
}

export interface WorkflowNormalizeTextStep {
  id: string;
  type: 'normalizeText';
  target: WorkflowColumnTarget;
  trim: boolean;
  collapseWhitespace: boolean;
  case: 'preserve' | 'lower' | 'upper';
}

export interface WorkflowRenameColumnStep {
  id: string;
  type: 'renameColumn';
  columnId: string;
  newDisplayName: string;
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
  condition: WorkflowCondition;
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
  target: WorkflowColumnTarget;
  separator: string;
  newColumn: WorkflowNewColumn;
}

export interface WorkflowDeduplicateRowsStep {
  id: string;
  type: 'deduplicateRows';
  target: WorkflowColumnTarget;
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
  | WorkflowFillEmptyStep
  | WorkflowNormalizeTextStep
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
  issues: WorkflowValidationIssue[];
}
