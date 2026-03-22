import { slugify } from '../domain/normalize';
import type { Workflow, WorkflowCondition, WorkflowExpression, WorkflowStep } from '../workflow';

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

export interface AuthoringScopedTransformStep extends AuthoringStepBase {
  kind: 'scopedTransform';
  columnIds: string[];
  rowCondition?: WorkflowCondition;
  expression: WorkflowExpression;
  treatWhitespaceAsEmpty: boolean;
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
  condition: WorkflowCondition;
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
  | AuthoringScopedTransformStep
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
    case 'scopedTransform':
      return {
        id: stepId,
        type: 'scopedTransform',
        columnIds: step.columnIds,
        rowCondition: step.rowCondition,
        expression: step.expression,
        treatWhitespaceAsEmpty: step.treatWhitespaceAsEmpty,
      };
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
    case 'scopedTransform':
      return {
        kind: 'scopedTransform',
        stepId: step.id,
        columnIds: [...step.columnIds],
        rowCondition: step.rowCondition,
        expression: step.expression,
        treatWhitespaceAsEmpty: step.treatWhitespaceAsEmpty,
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
    case 'scopedTransform':
      return 'scoped_transform';
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

function emptyToUndefined(value: string) {
  return value === '' ? undefined : value;
}

function assertNever(step: never): never {
  throw new Error(`Authoring step '${JSON.stringify(step)}' cannot be converted.`);
}
