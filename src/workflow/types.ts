import type { CellValue, LogicalType, Schema, Table } from '../domain/model';

export type WorkflowScalar = CellValue;
export type WorkflowVersion = 2;

export type WorkflowStepType =
  | 'comment'
  | 'scopedRule'
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
  | 'now'
  | 'datePart'
  | 'dateDiff'
  | 'dateAdd'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'abs'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'trim'
  | 'lower'
  | 'upper'
  | 'toNumber'
  | 'toString'
  | 'toBoolean'
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
  | WorkflowCaseValueExpression
  | WorkflowLiteralExpression
  | WorkflowColumnExpression
  | WorkflowCallExpression
  | WorkflowMatchExpression;

export interface WorkflowValueExpression {
  kind: 'value';
}

export interface WorkflowCaseValueExpression {
  kind: 'caseValue';
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

export interface WorkflowMatchWhenCase {
  kind: 'when';
  when: WorkflowExpression;
  then: WorkflowExpression;
}

export interface WorkflowMatchOtherwiseCase {
  kind: 'otherwise';
  then: WorkflowExpression;
}

export type WorkflowMatchCase =
  | WorkflowMatchWhenCase
  | WorkflowMatchOtherwiseCase;

export interface WorkflowMatchExpression {
  kind: 'match';
  subject: WorkflowExpression;
  cases: WorkflowMatchCase[];
}

export interface WorkflowCellFormatPatch {
  fillColor?: string;
}

export interface WorkflowCellPatch {
  value?: WorkflowExpression;
  format?: WorkflowCellFormatPatch;
}

export interface WorkflowRuleCase {
  when: WorkflowExpression;
  then: WorkflowCellPatch;
}

export interface WorkflowScopedRuleStep {
  id: string;
  type: 'scopedRule';
  columnIds: string[];
  rowCondition?: WorkflowExpression;
  cases?: WorkflowRuleCase[];
  defaultPatch?: WorkflowCellPatch;
}

export interface WorkflowCommentStep {
  id: string;
  type: 'comment';
  text: string;
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
  | WorkflowCommentStep
  | WorkflowScopedRuleStep
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

export interface WorkflowStepExecutionSummary {
  stepId: string;
  stepType: WorkflowStepType;
  matchedCellCount: number;
  valueChangedCellCount: number;
  formatChangedCellCount: number;
  changedCellCount: number;
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
  stepSummaries: WorkflowStepExecutionSummary[];
}

export interface WorkflowExpressionValidationResult {
  logicalType: LogicalType;
  valueKind: 'scalar' | 'list';
  issues: WorkflowValidationIssue[];
}
