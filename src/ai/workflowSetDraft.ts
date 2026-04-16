import { slugify } from '../domain/normalize';
import type { Workflow } from '../workflow';
import { createWorkflowPackage, type WorkflowPackageV1 } from '../workflowPackage';

import type { AIWorkflowSetDraft } from './types';

export interface AppliedWorkflowSetDraft {
  workflowPackage: WorkflowPackageV1;
  workflowIdMap: Map<string, string>;
}

export function applyWorkflowSetDraftToPackage(
  currentPackage: WorkflowPackageV1,
  activeWorkflowId: string,
  draft: AIWorkflowSetDraft,
): AppliedWorkflowSetDraft {
  const replacedActiveWorkflowId = draft.applyMode === 'replaceActive' ? activeWorkflowId : null;
  const preservedWorkflows = getPreservedWorkflows(currentPackage, draft.applyMode, activeWorkflowId);
  const existingIds = new Set(preservedWorkflows.map((workflow) => workflow.workflowId));
  const existingNames = new Set(preservedWorkflows.map((workflow) => workflow.name));
  const workflowIdMap = new Map<string, string>();
  const materializedWorkflows = draft.workflows.map((workflow, index) => {
    const preferredWorkflowId = index === 0 && replacedActiveWorkflowId
      ? replacedActiveWorkflowId
      : workflow.workflowId || `wf_${slugify(workflow.name) || 'workflow'}`;
    const workflowId = getUniqueWorkflowId(existingIds, preferredWorkflowId);
    const name = getUniqueWorkflowName(existingNames, workflow.name);

    existingIds.add(workflowId);
    existingNames.add(name);
    workflowIdMap.set(workflow.workflowId, workflowId);

    return {
      ...workflow,
      workflowId,
      name,
    };
  });
  const runOrderWorkflowIds = draft.runOrderWorkflowIds
    .map((workflowId) => workflowIdMap.get(workflowId))
    .filter((workflowId): workflowId is string => Boolean(workflowId));
  const nextActiveWorkflowId = materializedWorkflows[0]?.workflowId ?? currentPackage.activeWorkflowId;

  if (draft.applyMode === 'replacePackage') {
    return {
      workflowPackage: createWorkflowPackage(materializedWorkflows, nextActiveWorkflowId, runOrderWorkflowIds),
      workflowIdMap,
    };
  }

  if (draft.applyMode === 'replaceActive') {
    const [replacementWorkflow, ...additionalWorkflows] = materializedWorkflows;
    const nextWorkflows = currentPackage.workflows.flatMap((workflow) =>
      workflow.workflowId === activeWorkflowId
        ? replacementWorkflow
          ? [replacementWorkflow]
          : []
        : [workflow]);

    return {
      workflowPackage: createWorkflowPackage(
        [...nextWorkflows, ...additionalWorkflows],
        nextActiveWorkflowId,
        runOrderWorkflowIds,
      ),
      workflowIdMap,
    };
  }

  throw new Error(`Unsupported workflow-set apply mode '${String(draft.applyMode)}'.`);
}

function getPreservedWorkflows(
  currentPackage: WorkflowPackageV1,
  applyMode: AIWorkflowSetDraft['applyMode'],
  activeWorkflowId: string,
): Workflow[] {
  if (applyMode === 'replacePackage') {
    return [];
  }

  return currentPackage.workflows.filter((workflow) => workflow.workflowId !== activeWorkflowId);
}

function getUniqueWorkflowId(existingIds: Set<string>, preferredId: string) {
  const normalizedBaseId = normalizeWorkflowId(preferredId);

  if (!existingIds.has(normalizedBaseId)) {
    return normalizedBaseId;
  }

  let suffix = 2;

  while (existingIds.has(`${normalizedBaseId}_${suffix}`)) {
    suffix += 1;
  }

  return `${normalizedBaseId}_${suffix}`;
}

function getUniqueWorkflowName(existingNames: Set<string>, preferredName: string) {
  const normalizedBaseName = normalizeWorkflowName(preferredName);

  if (!existingNames.has(normalizedBaseName)) {
    return normalizedBaseName;
  }

  let suffix = 2;

  while (existingNames.has(`${normalizedBaseName} (${suffix})`)) {
    suffix += 1;
  }

  return `${normalizedBaseName} (${suffix})`;
}

function normalizeWorkflowName(name: string) {
  const trimmed = name.trim();
  return trimmed === '' ? 'Workflow' : trimmed;
}

function normalizeWorkflowId(workflowId: string) {
  const trimmed = workflowId.trim();
  const slug = slugify(trimmed);

  return slug === '' ? 'wf_workflow' : `wf_${slug}`.replace(/^wf_wf_/, 'wf_');
}
