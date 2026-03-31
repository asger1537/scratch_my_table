import type { Workflow, WorkflowStep } from '../workflow';

import type { WorkflowStepInput } from './types';

export function assignWorkflowStepIds(stepInputs: WorkflowStepInput[]): WorkflowStep[] {
  const usedIds = new Set<string>();
  const nextCounterByType = new Map<string, number>();

  return stepInputs.map((stepInput) => {
    const stepType = normalizeStepType(stepInput.type);
    let counter = nextCounterByType.get(stepType) ?? 1;
    let stepId = `step_${stepType}_${counter}`;

    while (usedIds.has(stepId)) {
      counter += 1;
      stepId = `step_${stepType}_${counter}`;
    }

    nextCounterByType.set(stepType, counter + 1);
    usedIds.add(stepId);

    return {
      ...stepInput,
      id: stepId,
    } as WorkflowStep;
  });
}

export function replaceWorkflowSteps(workflow: Workflow, draftSteps: WorkflowStep[]): Workflow {
  return {
    ...workflow,
    steps: draftSteps,
  };
}

export function stripWorkflowStepIds(steps: WorkflowStep[]): WorkflowStepInput[] {
  return steps.map(({ id: _id, ...step }) => step as WorkflowStepInput);
}

export function summarizeWorkflowSteps(workflow: Workflow): string[] {
  if (workflow.steps.length === 0) {
    return ['(no steps yet)'];
  }

  return workflow.steps.map((step, index) => `${index + 1}. ${summarizeWorkflowStep(step)}`);
}

function summarizeWorkflowStep(step: WorkflowStep) {
  switch (step.type) {
    case 'comment':
      return `comment "${truncate(step.text, 60)}"`;
    case 'scopedRule':
      return `scopedRule on ${formatColumnIds(step.columnIds)}${step.cases?.length ? ` with ${step.cases.length} case${step.cases.length === 1 ? '' : 's'}` : ''}${step.defaultPatch ? ' with default patch' : ''}`;
    case 'dropColumns':
      return `dropColumns ${formatColumnIds(step.columnIds)}`;
    case 'renameColumn':
      return `renameColumn ${step.columnId} -> "${step.newDisplayName}"`;
    case 'deriveColumn':
      return `deriveColumn ${step.newColumn.columnId}`;
    case 'filterRows':
      return `filterRows ${step.mode}`;
    case 'splitColumn':
      return `splitColumn ${step.columnId} into ${step.outputColumns.map((column) => column.columnId).join(', ')}`;
    case 'combineColumns':
      return `combineColumns ${formatColumnIds(step.columnIds)} -> ${step.newColumn.columnId}`;
    case 'deduplicateRows':
      return `deduplicateRows on ${formatColumnIds(step.columnIds)}`;
    case 'sortRows':
      return `sortRows by ${step.sorts.map((sort) => `${sort.columnId} ${sort.direction}`).join(', ')}`;
  }
}

function normalizeStepType(stepType: string) {
  return stepType.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function formatColumnIds(columnIds: string[]) {
  return columnIds.join(', ');
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}...`;
}
