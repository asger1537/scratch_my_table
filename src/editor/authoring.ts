import { slugify } from '../domain/normalize';
import type { Workflow, WorkflowCellPatch, WorkflowExpression, WorkflowRuleCase, WorkflowStep } from '../workflow';

import type { EditorIssue, WorkspaceWorkflowResult } from './types';

export interface AuthoringWorkflowMetadata {
  workflowId: string;
  name: string;
  description?: string;
}

export interface AuthoringWorkflow {
  metadata: AuthoringWorkflowMetadata;
  steps: AuthoringStep[];
}

interface AuthoringStepBase {
  stepId?: string;
  sourceBlockId?: string;
  sourceBlockType?: string;
}

export interface AuthoringCommentStep extends AuthoringStepBase {
  kind: 'comment';
  text: string;
}

export interface AuthoringCellPatch {
  valueEnabled: boolean;
  value?: WorkflowExpression;
  formatEnabled: boolean;
  fillColor?: string;
}

export interface AuthoringRuleCase {
  when: WorkflowExpression;
  then: AuthoringCellPatch;
}

export interface AuthoringScopedRuleStep extends AuthoringStepBase {
  kind: 'scopedRule';
  columnIds: string[];
  rowCondition?: WorkflowExpression;
  mode: 'single' | 'cases';
  singlePatch: AuthoringCellPatch;
  cases: AuthoringRuleCase[];
  defaultPatch: AuthoringCellPatch;
}

export interface AuthoringRenameColumnStep extends AuthoringStepBase {
  kind: 'renameColumn';
  columnId: string;
  newDisplayName: string;
}

export interface AuthoringDropColumnsStep extends AuthoringStepBase {
  kind: 'dropColumns';
  columnIds: string[];
}

export interface AuthoringDeriveColumnStep extends AuthoringStepBase {
  kind: 'deriveColumn';
  newColumn: {
    columnId: string;
    displayName: string;
  };
  expression: WorkflowExpression;
}

export interface AuthoringFilterRowsStep extends AuthoringStepBase {
  kind: 'filterRows';
  mode: 'keep' | 'drop';
  condition: WorkflowExpression;
}

export interface AuthoringSplitColumnStep extends AuthoringStepBase {
  kind: 'splitColumn';
  columnId: string;
  delimiter: string;
  outputColumns: Array<{
    columnId: string;
    displayName: string;
  }>;
}

export interface AuthoringCombineColumnsStep extends AuthoringStepBase {
  kind: 'combineColumns';
  columnIds: string[];
  separator: string;
  newColumn: {
    columnId: string;
    displayName: string;
  };
}

export interface AuthoringDeduplicateRowsStep extends AuthoringStepBase {
  kind: 'deduplicateRows';
  columnIds: string[];
}

export interface AuthoringSortRowsStep extends AuthoringStepBase {
  kind: 'sortRows';
  sorts: Array<{
    columnId: string;
    direction: 'asc' | 'desc';
  }>;
}

export type AuthoringStep =
  | AuthoringCommentStep
  | AuthoringScopedRuleStep
  | AuthoringDropColumnsStep
  | AuthoringRenameColumnStep
  | AuthoringDeriveColumnStep
  | AuthoringFilterRowsStep
  | AuthoringSplitColumnStep
  | AuthoringCombineColumnsStep
  | AuthoringDeduplicateRowsStep
  | AuthoringSortRowsStep;

export function authoringWorkflowToWorkflow(authoringWorkflow: AuthoringWorkflow): WorkspaceWorkflowResult {
  const usedStepIds = new Set<string>();
  const steps: WorkflowStep[] = authoringWorkflow.steps.map((step, index) => compileStep(step, index, usedStepIds));
  const name = normalizeWorkflowName(authoringWorkflow.metadata.name);
  const workflowId = normalizeWorkflowId(authoringWorkflow.metadata.workflowId, name);
  const description = emptyToUndefined(normalizeDescription(authoringWorkflow.metadata.description));

  return {
    workflow: {
      version: 2,
      workflowId,
      name,
      ...(description ? { description } : {}),
      steps,
    },
    issues: [],
  };
}

export function workflowToAuthoringWorkflow(workflow: Workflow): AuthoringWorkflow {
  return {
    metadata: {
      workflowId: workflow.workflowId,
      name: workflow.name,
      description: workflow.description,
    },
    steps: workflow.steps.map((step) => workflowStepToAuthoringStep(step)),
  };
}

export function normalizeWorkflowMetadata(metadata: Partial<AuthoringWorkflowMetadata>): AuthoringWorkflowMetadata {
  const name = normalizeWorkflowName(metadata.name ?? '');

  return {
    workflowId: normalizeWorkflowId(metadata.workflowId ?? '', name),
    name,
    description: emptyToUndefined(normalizeDescription(metadata.description)),
  };
}

function compileStep(step: AuthoringStep, index: number, usedStepIds: Set<string>): WorkflowStep {
  const stepId = getUniqueStepId(step.stepId, getDefaultStepIdBase(step), index, usedStepIds);

  switch (step.kind) {
    case 'comment':
      return {
        id: stepId,
        type: 'comment',
        text: step.text,
      };
    case 'scopedRule': {
      const defaultPatch = step.mode === 'single'
        ? compileAuthoringCellPatch(step.singlePatch)
        : compileAuthoringCellPatch(step.defaultPatch);
      const cases = step.mode === 'cases'
        ? step.cases
          .map(compileAuthoringRuleCase)
          .filter((ruleCase): ruleCase is WorkflowRuleCase => Boolean(ruleCase))
        : undefined;

      return {
        id: stepId,
        type: 'scopedRule',
        columnIds: step.columnIds,
        ...(step.rowCondition ? { rowCondition: step.rowCondition } : {}),
        ...(cases && cases.length > 0 ? { cases } : {}),
        ...(defaultPatch ? { defaultPatch } : {}),
      };
    }
    case 'renameColumn':
      return {
        id: stepId,
        type: 'renameColumn',
        columnId: step.columnId,
        newDisplayName: step.newDisplayName,
      };
    case 'dropColumns':
      return {
        id: stepId,
        type: 'dropColumns',
        columnIds: step.columnIds,
      };
    case 'deriveColumn':
      return {
        id: stepId,
        type: 'deriveColumn',
        newColumn: step.newColumn,
        expression: step.expression,
      };
    case 'filterRows':
      return {
        id: stepId,
        type: 'filterRows',
        mode: step.mode,
        condition: step.condition,
      };
    case 'splitColumn':
      return {
        id: stepId,
        type: 'splitColumn',
        columnId: step.columnId,
        delimiter: step.delimiter,
        outputColumns: step.outputColumns,
      };
    case 'combineColumns':
      return {
        id: stepId,
        type: 'combineColumns',
        columnIds: step.columnIds,
        separator: step.separator,
        newColumn: step.newColumn,
      };
    case 'deduplicateRows':
      return {
        id: stepId,
        type: 'deduplicateRows',
        columnIds: step.columnIds,
      };
    case 'sortRows':
      return {
        id: stepId,
        type: 'sortRows',
        sorts: step.sorts,
      };
  }
}

function workflowStepToAuthoringStep(step: WorkflowStep): AuthoringStep {
  switch (step.type) {
    case 'comment':
      return {
        kind: 'comment',
        stepId: step.id,
        text: step.text,
      };
    case 'scopedRule':
      return {
        kind: 'scopedRule',
        stepId: step.id,
        columnIds: [...step.columnIds],
        rowCondition: step.rowCondition,
        mode: step.cases && step.cases.length > 0 ? 'cases' : 'single',
        singlePatch: step.cases && step.cases.length > 0
          ? createEmptyAuthoringCellPatch()
          : workflowCellPatchToAuthoringPatch(step.defaultPatch),
        cases: (step.cases ?? []).map(workflowRuleCaseToAuthoringRuleCase),
        defaultPatch: step.cases && step.cases.length > 0
          ? workflowCellPatchToAuthoringPatch(step.defaultPatch)
          : createEmptyAuthoringCellPatch(),
      };
    case 'renameColumn':
      return {
        kind: 'renameColumn',
        stepId: step.id,
        columnId: step.columnId,
        newDisplayName: step.newDisplayName,
      };
    case 'dropColumns':
      return {
        kind: 'dropColumns',
        stepId: step.id,
        columnIds: [...step.columnIds],
      };
    case 'deriveColumn':
      return {
        kind: 'deriveColumn',
        stepId: step.id,
        newColumn: step.newColumn,
        expression: step.expression,
      };
    case 'filterRows':
      return {
        kind: 'filterRows',
        stepId: step.id,
        mode: step.mode,
        condition: step.condition,
      };
    case 'splitColumn':
      return {
        kind: 'splitColumn',
        stepId: step.id,
        columnId: step.columnId,
        delimiter: step.delimiter,
        outputColumns: [...step.outputColumns],
      };
    case 'combineColumns':
      return {
        kind: 'combineColumns',
        stepId: step.id,
        columnIds: [...step.columnIds],
        separator: step.separator,
        newColumn: step.newColumn,
      };
    case 'deduplicateRows':
      return {
        kind: 'deduplicateRows',
        stepId: step.id,
        columnIds: [...step.columnIds],
      };
    case 'sortRows':
      return {
        kind: 'sortRows',
        stepId: step.id,
        sorts: [...step.sorts],
      };
    default:
      return assertNever(step);
  }
}

function getDefaultStepIdBase(step: AuthoringStep) {
  switch (step.kind) {
    case 'scopedRule':
      return 'scoped_rule';
    default:
      return step.kind;
  }
}

function getUniqueStepId(existingStepId: string | undefined, base: string, index: number, usedStepIds: Set<string>) {
  let candidate = normalizeStepId(existingStepId) || `step_${slugify(base || 'step')}_${index + 1}`;

  if (!usedStepIds.has(candidate)) {
    usedStepIds.add(candidate);
    return candidate;
  }

  let suffix = 2;

  while (usedStepIds.has(`${candidate}_${suffix}`)) {
    suffix += 1;
  }

  candidate = `${candidate}_${suffix}`;
  usedStepIds.add(candidate);
  return candidate;
}

function normalizeStepId(stepId: string | undefined) {
  const trimmed = (stepId ?? '').trim();
  return trimmed === '' ? '' : trimmed;
}

function normalizeWorkflowName(name: string) {
  const trimmed = name.trim();
  return trimmed === '' ? 'Workflow' : trimmed;
}

function normalizeWorkflowId(workflowId: string, name: string) {
  const trimmed = workflowId.trim();

  if (trimmed !== '') {
    return trimmed;
  }

  const slug = slugify(name);
  return slug === '' ? 'wf_workflow' : `wf_${slug}`;
}

function normalizeDescription(description: string | undefined) {
  return (description ?? '').trim();
}

function normalizeWorkflowColor(value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : '#ffeb9c';
}

function createEmptyAuthoringCellPatch(): AuthoringCellPatch {
  return {
    valueEnabled: false,
    formatEnabled: false,
    fillColor: '#ffeb9c',
  };
}

function compileAuthoringCellPatch(patch: AuthoringCellPatch): WorkflowCellPatch | undefined {
  const nextPatch: WorkflowCellPatch = {
    ...(patch.valueEnabled && patch.value ? { value: patch.value } : {}),
    ...(patch.formatEnabled
      ? {
          format: {
            fillColor: normalizeWorkflowColor(patch.fillColor ?? '#ffeb9c'),
          },
        }
      : {}),
  };

  return Object.keys(nextPatch).length > 0 ? nextPatch : undefined;
}

function compileAuthoringRuleCase(ruleCase: AuthoringRuleCase): WorkflowRuleCase | undefined {
  const then = compileAuthoringCellPatch(ruleCase.then);

  return then
    ? {
        when: ruleCase.when,
        then,
      }
    : undefined;
}

function workflowCellPatchToAuthoringPatch(patch: WorkflowCellPatch | undefined): AuthoringCellPatch {
  return {
    valueEnabled: Boolean(patch?.value),
    ...(patch?.value ? { value: patch.value } : {}),
    formatEnabled: Boolean(patch?.format?.fillColor),
    fillColor: normalizeWorkflowColor(patch?.format?.fillColor ?? '#ffeb9c'),
  };
}

function workflowRuleCaseToAuthoringRuleCase(ruleCase: WorkflowRuleCase): AuthoringRuleCase {
  return {
    when: ruleCase.when,
    then: workflowCellPatchToAuthoringPatch(ruleCase.then),
  };
}

function emptyToUndefined(value: string) {
  return value === '' ? undefined : value;
}

function assertNever(step: never): never {
  throw new Error(`Authoring step '${JSON.stringify(step)}' cannot be converted.`);
}
