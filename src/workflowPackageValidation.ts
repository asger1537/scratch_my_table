import type { WorkflowValidationIssue } from './workflow';
import { validateWorkflowSemantics } from './workflow';
import { validateWorkflowWithWorker } from './workflow/validationWorkerClient';
import type { ValidationWorkerTableSnapshot } from './workflow/validationWorker';
import type { Table } from './domain/model';
import { flattenWorkflowSequence, type WorkflowPackageV1 } from './workflowPackage';

export async function validateWorkflowPackageWithWorker(
  workflowPackage: WorkflowPackageV1,
  tableSnapshot: ValidationWorkerTableSnapshot,
  signal?: AbortSignal,
): Promise<Map<string, WorkflowValidationIssue[]>> {
  const issuesByWorkflowId = new Map(workflowPackage.workflows.map((workflow) => [workflow.workflowId, [] as WorkflowValidationIssue[]] as const));
  const workflowIds = new Set(workflowPackage.workflows.map((workflow) => workflow.workflowId));
  const runOrderWorkflowIds = workflowPackage.runOrderWorkflowIds.filter((workflowId, index, array) =>
    workflowIds.has(workflowId) && array.indexOf(workflowId) === index);
  const runOrderWorkflowIdSet = new Set(runOrderWorkflowIds);

  if (runOrderWorkflowIds.length > 0) {
    const flattenedSequence = flattenWorkflowSequence(workflowPackage.workflows, runOrderWorkflowIds);
    const flattenedIssues = await validateWorkflowWithWorker(flattenedSequence.workflow, tableSnapshot, signal);
    const mappedIssues = mapFlattenedSequenceIssuesToWorkflows(workflowPackage, runOrderWorkflowIds, flattenedIssues);

    mappedIssues.forEach((issues, workflowId) => {
      issuesByWorkflowId.set(workflowId, issues);
    });
  }

  await Promise.all(
    workflowPackage.workflows
      .filter((workflow) => !runOrderWorkflowIdSet.has(workflow.workflowId))
      .map(async (workflow) => {
        issuesByWorkflowId.set(workflow.workflowId, await validateWorkflowWithWorker(workflow, tableSnapshot, signal));
      }),
  );

  return issuesByWorkflowId;
}

export function mapFlattenedSequenceIssuesToWorkflows(
  workflowPackage: WorkflowPackageV1,
  runOrderWorkflowIds: string[],
  issues: WorkflowValidationIssue[],
): Map<string, WorkflowValidationIssue[]> {
  const issuesByWorkflowId = new Map(workflowPackage.workflows.map((workflow) => [workflow.workflowId, [] as WorkflowValidationIssue[]] as const));
  const stepMap = buildFlattenedStepMap(workflowPackage, runOrderWorkflowIds);
  const orderedWorkflowIds = runOrderWorkflowIds.filter((workflowId) => issuesByWorkflowId.has(workflowId));
  const fallbackWorkflowId = orderedWorkflowIds[0];

  issues.forEach((issue) => {
    const stepReference = getIssueStepReference(issue, stepMap);
    const workflowId = stepReference?.workflowId ?? fallbackWorkflowId;

    if (!workflowId) {
      return;
    }

    const mappedIssue = stepReference
      ? mapFlattenedIssueToWorkflowIssue(issue, stepReference)
      : issue;

    issuesByWorkflowId.set(workflowId, [
      ...(issuesByWorkflowId.get(workflowId) ?? []),
      mappedIssue,
    ]);
  });

  return issuesByWorkflowId;
}

export function getWorkflowInputTableForRunOrder(
  workflowPackage: WorkflowPackageV1,
  workflowId: string,
  table: Table,
): Table {
  const runOrderIndex = workflowPackage.runOrderWorkflowIds.indexOf(workflowId);

  if (runOrderIndex <= 0) {
    return table;
  }

  const priorRunOrderWorkflowIds = workflowPackage.runOrderWorkflowIds.slice(0, runOrderIndex);
  const flattenedPrefix = flattenWorkflowSequence(workflowPackage.workflows, priorRunOrderWorkflowIds);
  const semantic = validateWorkflowSemantics(flattenedPrefix.workflow, table);

  if (!semantic.valid) {
    return table;
  }

  return {
    ...table,
    schema: {
      columns: semantic.finalSchema.columns.map((column) => ({ ...column })),
    },
  };
}

interface FlattenedStepReference {
  workflowId: string;
  flatStepId: string;
  localStepId: string;
  flatStepIndex: number;
  localStepIndex: number;
}

function buildFlattenedStepMap(
  workflowPackage: WorkflowPackageV1,
  runOrderWorkflowIds: string[],
) {
  const workflowById = new Map(workflowPackage.workflows.map((workflow) => [workflow.workflowId, workflow] as const));
  const byFlatStepId = new Map<string, FlattenedStepReference>();
  const byFlatStepIndex = new Map<number, FlattenedStepReference>();
  let flatStepIndex = 0;

  runOrderWorkflowIds.forEach((workflowId) => {
    const workflow = workflowById.get(workflowId);

    if (!workflow) {
      return;
    }

    workflow.steps.forEach((step, localStepIndex) => {
      const reference: FlattenedStepReference = {
        workflowId,
        flatStepId: `${workflowId}__${step.id}`,
        localStepId: step.id,
        flatStepIndex,
        localStepIndex,
      };

      byFlatStepId.set(reference.flatStepId, reference);
      byFlatStepIndex.set(flatStepIndex, reference);
      flatStepIndex += 1;
    });
  });

  return {
    byFlatStepId,
    byFlatStepIndex,
  };
}

function getIssueStepReference(
  issue: WorkflowValidationIssue,
  stepMap: ReturnType<typeof buildFlattenedStepMap>,
) {
  if (issue.stepId) {
    const byStepId = stepMap.byFlatStepId.get(issue.stepId);

    if (byStepId) {
      return byStepId;
    }
  }

  const stepIndex = getPathStepIndex(issue.path);

  return typeof stepIndex === 'number' ? stepMap.byFlatStepIndex.get(stepIndex) : undefined;
}

function mapFlattenedIssueToWorkflowIssue(
  issue: WorkflowValidationIssue,
  reference: FlattenedStepReference,
): WorkflowValidationIssue {
  return {
    ...issue,
    path: issue.path.replace(`steps[${reference.flatStepIndex}]`, `steps[${reference.localStepIndex}]`),
    ...(issue.stepId === reference.flatStepId ? { stepId: reference.localStepId } : {}),
  };
}

function getPathStepIndex(path: string) {
  const match = /^steps\[(\d+)\]/.exec(path);

  return match ? Number(match[1]) : undefined;
}
