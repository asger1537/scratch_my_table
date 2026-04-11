export interface AIDraftIssue {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  path: string;
  phase: 'authoring' | 'structural' | 'semantic';
  stepId?: string;
  details?: Record<string, unknown>;
}

export interface AuthoringColumnOperand {
  source: 'column';
  columnId: string;
}

export interface AuthoringValueOperand {
  source: 'value';
}

export interface AuthoringCaseValueOperand {
  source: 'caseValue';
}

export interface AuthoringLiteralOperand {
  source: 'literal';
  value: string | number | boolean | null;
}

export type AuthoringOperand =
  | AuthoringColumnOperand
  | AuthoringValueOperand
  | AuthoringCaseValueOperand
  | AuthoringLiteralOperand;

export type AuthoringNullaryValueOp = 'now';
export type AuthoringUnaryValueOp =
  | 'trim'
  | 'lower'
  | 'upper'
  | 'toNumber'
  | 'toString'
  | 'toBoolean'
  | 'collapseWhitespace'
  | 'first'
  | 'last'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'abs';
export type AuthoringBinaryValueOp =
  | 'split'
  | 'atIndex'
  | 'extractRegex'
  | 'add'
  | 'subtract'
  | 'multiply'
  | 'divide'
  | 'modulo'
  | 'datePart';
export type AuthoringTernaryValueOp =
  | 'substring'
  | 'replace'
  | 'replaceRegex'
  | 'dateDiff'
  | 'dateAdd';
export type AuthoringNaryValueOp =
  | 'concat'
  | 'coalesce';

export interface AuthoringNullaryValueExpression {
  kind: 'nullary';
  op: AuthoringNullaryValueOp;
}

export interface AuthoringUnaryValueExpression {
  kind: 'unary';
  op: AuthoringUnaryValueOp;
  input: AuthoringValueInput;
}

export interface AuthoringBinaryValueExpression {
  kind: 'binary';
  op: AuthoringBinaryValueOp;
  left: AuthoringValueInput;
  right: AuthoringValueInput;
}

export interface AuthoringTernaryValueExpression {
  kind: 'ternary';
  op: AuthoringTernaryValueOp;
  first: AuthoringValueInput;
  second: AuthoringValueInput;
  third: AuthoringValueInput;
}

export interface AuthoringNaryValueExpression {
  kind: 'nary';
  op: AuthoringNaryValueOp;
  items: AuthoringValueInput[];
}

export interface AuthoringMatchWhenCase {
  kind: 'when';
  when: AuthoringBooleanExpression;
  then: AuthoringValueInput;
}

export interface AuthoringMatchOtherwiseCase {
  kind: 'otherwise';
  then: AuthoringValueInput;
}

export type AuthoringMatchCase =
  | AuthoringMatchWhenCase
  | AuthoringMatchOtherwiseCase;

export interface AuthoringMatchValueExpression {
  kind: 'match';
  subject: AuthoringValueInput;
  cases: AuthoringMatchCase[];
}

export type AuthoringValueExpression =
  | AuthoringNullaryValueExpression
  | AuthoringUnaryValueExpression
  | AuthoringBinaryValueExpression
  | AuthoringTernaryValueExpression
  | AuthoringNaryValueExpression
  | AuthoringMatchValueExpression;

export type AuthoringValueInput =
  | AuthoringOperand
  | AuthoringValueExpression;

export type AuthoringPredicateOp = 'isEmpty';
export type AuthoringCompareOp =
  | 'eq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'matchesRegex';

export interface AuthoringPredicateBooleanExpression {
  kind: 'predicate';
  op: AuthoringPredicateOp;
  input: AuthoringValueInput;
}

export interface AuthoringCompareBooleanExpression {
  kind: 'compare';
  op: AuthoringCompareOp;
  left: AuthoringValueInput;
  right: AuthoringValueInput;
}

export interface AuthoringBetweenBooleanExpression {
  kind: 'between';
  input: AuthoringValueInput;
  min: AuthoringValueInput;
  max: AuthoringValueInput;
  inclusiveMin: boolean;
  inclusiveMax: boolean;
}

export interface AuthoringBooleanGroupExpression {
  kind: 'boolean';
  op: 'and' | 'or';
  items: AuthoringBooleanExpression[];
}

export interface AuthoringBooleanNotExpression {
  kind: 'boolean';
  op: 'not';
  item: AuthoringBooleanExpression;
}

export type AuthoringBooleanExpression =
  | AuthoringPredicateBooleanExpression
  | AuthoringCompareBooleanExpression
  | AuthoringBetweenBooleanExpression
  | AuthoringBooleanGroupExpression
  | AuthoringBooleanNotExpression;

export interface AuthoringCellPatch {
  value?: AuthoringValueInput;
  format?: {
    fillColor?: string;
  };
}

export interface AuthoringCommentStepInput {
  type: 'comment';
  text: string;
}

export interface AuthoringScopedRuleCaseInput {
  when: AuthoringBooleanExpression;
  then: AuthoringCellPatch;
}

export interface AuthoringScopedRuleStepInput {
  type: 'scopedRule';
  columnIds: string[];
  rowWhere?: AuthoringBooleanExpression;
  cases?: AuthoringScopedRuleCaseInput[];
  defaultPatch?: AuthoringCellPatch;
}

export interface AuthoringDropColumnsStepInput {
  type: 'dropColumns';
  columnIds: string[];
}

export interface AuthoringRenameColumnStepInput {
  type: 'renameColumn';
  columnId: string;
  newDisplayName: string;
}

export interface AuthoringNewColumn {
  columnId: string;
  displayName: string;
}

export interface AuthoringDeriveColumnStepInput {
  type: 'deriveColumn';
  newColumn: AuthoringNewColumn;
  derive: AuthoringValueInput;
}

export interface AuthoringFilterRowsStepInput {
  type: 'filterRows';
  mode: 'keep' | 'drop';
  where: AuthoringBooleanExpression;
}

export interface AuthoringSplitColumnStepInput {
  type: 'splitColumn';
  columnId: string;
  delimiter: string;
  outputColumns: AuthoringNewColumn[];
}

export interface AuthoringCombineColumnsStepInput {
  type: 'combineColumns';
  columnIds: string[];
  separator: string;
  newColumn: AuthoringNewColumn;
}

export interface AuthoringDeduplicateRowsStepInput {
  type: 'deduplicateRows';
  columnIds: string[];
}

export interface AuthoringSortRowsStepInput {
  type: 'sortRows';
  sorts: Array<{
    columnId: string;
    direction: 'asc' | 'desc';
  }>;
}

export type AuthoringStepInput =
  | AuthoringCommentStepInput
  | AuthoringScopedRuleStepInput
  | AuthoringDropColumnsStepInput
  | AuthoringRenameColumnStepInput
  | AuthoringDeriveColumnStepInput
  | AuthoringFilterRowsStepInput
  | AuthoringSplitColumnStepInput
  | AuthoringCombineColumnsStepInput
  | AuthoringDeduplicateRowsStepInput
  | AuthoringSortRowsStepInput;

export type AuthoringWorkflowSetApplyMode =
  | 'append'
  | 'replaceActive'
  | 'replacePackage';

export interface AuthoringClarifyResponse {
  mode: 'clarify';
  msg: string;
  ass: string[];
  steps: AuthoringStepInput[];
}

export interface AuthoringSingleWorkflowDraftResponse {
  mode: 'draft';
  msg: string;
  ass: string[];
  steps: AuthoringStepInput[];
}

export interface AuthoringWorkflowDraftInput {
  workflowId: string;
  name: string;
  description?: string;
  steps: AuthoringStepInput[];
}

export interface AuthoringWorkflowSetDraftResponse {
  mode: 'workflowSetDraft';
  msg: string;
  ass: string[];
  applyMode: AuthoringWorkflowSetApplyMode;
  workflows: AuthoringWorkflowDraftInput[];
  runOrderWorkflowIds: string[];
}

export type AuthoringDraftResponse =
  | AuthoringClarifyResponse
  | AuthoringSingleWorkflowDraftResponse
  | AuthoringWorkflowSetDraftResponse;
