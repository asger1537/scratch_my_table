import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';

import workflowPackageSchema from '../schemas/workflow-package-v1.schema.json';

import { slugify } from './domain/normalize';
import { validateWorkflowStructure, type Workflow, type WorkflowStep, type WorkflowValidationIssue } from './workflow';

export interface WorkflowPackageV1 {
  version: 1;
  type: 'workflowPackage';
  activeWorkflowId: string;
  workflows: Workflow[];
  runOrderWorkflowIds: string[];
}

export interface WorkflowPackageValidationResult {
  valid: boolean;
  workflowPackage?: WorkflowPackageV1;
  issues: WorkflowValidationIssue[];
}

export interface FlattenedWorkflowSequence {
  workflow: Workflow;
  workflowIds: string[];
  workflowNames: string[];
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
});

const validateWorkflowPackageSchema = ajv.compile(workflowPackageSchema);

export function createWorkflowPackage(workflows: Workflow[], activeWorkflowId?: string, runOrderWorkflowIds?: string[]): WorkflowPackageV1 {
  if (workflows.length === 0) {
    throw new Error('Workflow packages must contain at least one workflow.');
  }

  const workflowIds = new Set(workflows.map((workflow) => workflow.workflowId));
  const sanitizedRunOrder = (runOrderWorkflowIds ?? workflows.map((workflow) => workflow.workflowId))
    .filter((workflowId, index, array) => array.indexOf(workflowId) === index)
    .filter((workflowId) => workflowIds.has(workflowId));
  const nextActiveWorkflowId = workflowIds.has(activeWorkflowId ?? '') ? activeWorkflowId ?? workflows[0].workflowId : workflows[0].workflowId;

  return {
    version: 1,
    type: 'workflowPackage',
    activeWorkflowId: nextActiveWorkflowId,
    workflows,
    runOrderWorkflowIds: sanitizedRunOrder,
  };
}

export function createSingleWorkflowPackage(workflow: Workflow): WorkflowPackageV1 {
  return createWorkflowPackage([workflow], workflow.workflowId, [workflow.workflowId]);
}

export function createNewPackageWorkflow(existingWorkflows: Workflow[]): Workflow {
  const existingNames = new Set(existingWorkflows.map((workflow) => workflow.name));
  const existingIds = new Set(existingWorkflows.map((workflow) => workflow.workflowId));
  const name = getUniqueWorkflowName(existingNames, 'Workflow');
  const workflowId = getUniqueWorkflowId(existingIds, `wf_${slugify(name) || 'workflow'}`);

  return {
    version: 2,
    workflowId,
    name,
    description: '',
    steps: [],
  };
}

export function renameWorkflowInPackage(workflowPackage: WorkflowPackageV1, workflowId: string, nextName: string): WorkflowPackageV1 {
  return createWorkflowPackage(
    workflowPackage.workflows.map((workflow) =>
      workflow.workflowId === workflowId
        ? {
            ...workflow,
            name: normalizeWorkflowName(nextName),
          }
        : workflow),
    workflowPackage.activeWorkflowId,
    workflowPackage.runOrderWorkflowIds,
  );
}

export function updateWorkflowDescriptionInPackage(workflowPackage: WorkflowPackageV1, workflowId: string, description: string | undefined): WorkflowPackageV1 {
  return createWorkflowPackage(
    workflowPackage.workflows.map((workflow) =>
      workflow.workflowId === workflowId
        ? {
            ...workflow,
            ...(description && description.trim() !== '' ? { description: description.trim() } : {}),
            ...(description && description.trim() !== '' ? {} : { description: undefined }),
          }
        : workflow),
    workflowPackage.activeWorkflowId,
    workflowPackage.runOrderWorkflowIds,
  );
}

export function addWorkflowToPackage(
  workflowPackage: WorkflowPackageV1,
  workflow: Workflow,
  activate = false,
  includeInRunOrder = false,
): WorkflowPackageV1 {
  return createWorkflowPackage(
    [...workflowPackage.workflows, workflow],
    activate ? workflow.workflowId : workflowPackage.activeWorkflowId,
    includeInRunOrder
      ? [...workflowPackage.runOrderWorkflowIds, workflow.workflowId]
      : workflowPackage.runOrderWorkflowIds,
  );
}

export function deleteWorkflowFromPackage(workflowPackage: WorkflowPackageV1, workflowId: string): WorkflowPackageV1 {
  if (workflowPackage.workflows.length <= 1) {
    throw new Error('Cannot delete the final workflow.');
  }

  const workflowIndex = workflowPackage.workflows.findIndex((workflow) => workflow.workflowId === workflowId);

  if (workflowIndex < 0) {
    return workflowPackage;
  }

  const nextWorkflows = workflowPackage.workflows.filter((workflow) => workflow.workflowId !== workflowId);
  const nextActiveWorkflowId = workflowPackage.activeWorkflowId === workflowId
    ? nextWorkflows[Math.max(0, workflowIndex - 1)].workflowId
    : workflowPackage.activeWorkflowId;

  return createWorkflowPackage(
    nextWorkflows,
    nextActiveWorkflowId,
    workflowPackage.runOrderWorkflowIds.filter((currentWorkflowId) => currentWorkflowId !== workflowId),
  );
}

export function setActiveWorkflowInPackage(workflowPackage: WorkflowPackageV1, workflowId: string): WorkflowPackageV1 {
  return createWorkflowPackage(workflowPackage.workflows, workflowId, workflowPackage.runOrderWorkflowIds);
}

export function setRunOrderInPackage(workflowPackage: WorkflowPackageV1, runOrderWorkflowIds: string[]): WorkflowPackageV1 {
  return createWorkflowPackage(workflowPackage.workflows, workflowPackage.activeWorkflowId, runOrderWorkflowIds);
}

export function buildExportWorkflowPackage(workflowPackage: WorkflowPackageV1, selectedWorkflowIds: string[]): WorkflowPackageV1 {
  const selectedIdSet = new Set(selectedWorkflowIds);
  const workflows = workflowPackage.workflows.filter((workflow) => selectedIdSet.has(workflow.workflowId));

  if (workflows.length === 0) {
    throw new Error('Select at least one workflow to export.');
  }

  const activeWorkflowId = selectedIdSet.has(workflowPackage.activeWorkflowId)
    ? workflowPackage.activeWorkflowId
    : workflows[0].workflowId;

  return createWorkflowPackage(
    workflows,
    activeWorkflowId,
    workflowPackage.runOrderWorkflowIds.filter((workflowId) => selectedIdSet.has(workflowId)),
  );
}

export function mergeWorkflowPackages(currentPackage: WorkflowPackageV1, importedPackage: WorkflowPackageV1): WorkflowPackageV1 {
  const existingIds = new Set(currentPackage.workflows.map((workflow) => workflow.workflowId));
  const existingNames = new Set(currentPackage.workflows.map((workflow) => workflow.name));
  const workflowIdMap = new Map<string, string>();
  const mergedWorkflows = [...currentPackage.workflows];

  importedPackage.workflows.forEach((workflow) => {
    const nextWorkflowId = getUniqueWorkflowId(existingIds, workflow.workflowId || `wf_${slugify(workflow.name) || 'workflow'}`);
    const nextWorkflowName = getUniqueWorkflowName(existingNames, workflow.name);

    existingIds.add(nextWorkflowId);
    existingNames.add(nextWorkflowName);
    workflowIdMap.set(workflow.workflowId, nextWorkflowId);
    mergedWorkflows.push({
      ...workflow,
      workflowId: nextWorkflowId,
      name: nextWorkflowName,
    });
  });

  const importedRunOrder = importedPackage.runOrderWorkflowIds
    .map((workflowId) => workflowIdMap.get(workflowId))
    .filter((workflowId): workflowId is string => Boolean(workflowId));

  return createWorkflowPackage(
    mergedWorkflows,
    currentPackage.activeWorkflowId,
    [...currentPackage.runOrderWorkflowIds, ...importedRunOrder],
  );
}

export function flattenWorkflowSequence(workflows: Workflow[], runOrderWorkflowIds: string[]): FlattenedWorkflowSequence {
  const workflowById = new Map(workflows.map((workflow) => [workflow.workflowId, workflow] as const));
  const orderedWorkflows = runOrderWorkflowIds
    .map((workflowId) => workflowById.get(workflowId))
    .filter((workflow): workflow is Workflow => Boolean(workflow));

  const flattenedSteps = orderedWorkflows.flatMap((workflow) =>
    workflow.steps.map((step) => ({
      ...step,
      id: `${workflow.workflowId}__${step.id}`,
    })) as WorkflowStep[],
  );

  return {
    workflow: {
      version: 2,
      workflowId: 'wf_sequence',
      name: orderedWorkflows.length === 1 ? orderedWorkflows[0].name : 'Workflow sequence',
      description: orderedWorkflows.length > 0 ? orderedWorkflows.map((workflow) => workflow.name).join(' -> ') : 'Workflow sequence',
      steps: flattenedSteps,
    },
    workflowIds: orderedWorkflows.map((workflow) => workflow.workflowId),
    workflowNames: orderedWorkflows.map((workflow) => workflow.name),
  };
}

export function workflowPackageToJson(workflowPackage: WorkflowPackageV1) {
  return `${JSON.stringify(workflowPackage, null, 2)}\n`;
}

export function parseWorkflowPackageJson(text: string): WorkflowPackageValidationResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      valid: false,
      issues: [
        {
          code: 'invalidJson',
          severity: 'error',
          message: error instanceof Error ? error.message : 'Workflow package JSON could not be parsed.',
          path: '$',
          phase: 'structural',
        },
      ],
    };
  }

  return validateWorkflowPackageStructure(parsed);
}

export function validateWorkflowPackageStructure(candidate: unknown): WorkflowPackageValidationResult {
  const schemaValid = validateWorkflowPackageSchema(candidate);
  const issues: WorkflowValidationIssue[] = [];

  if (!schemaValid) {
    issues.push(...mapSchemaErrors(validateWorkflowPackageSchema.errors ?? []));
  }

  if (!isRecord(candidate) || !Array.isArray(candidate.workflows)) {
    return {
      valid: false,
      issues,
    };
  }

  const workflowIds = new Set<string>();

  candidate.workflows.forEach((workflowCandidate, index) => {
    const workflowValidation = validateWorkflowStructure(workflowCandidate);

    if (!workflowValidation.valid) {
      issues.push(
        ...workflowValidation.issues.map((issue) => ({
          ...issue,
          path: prefixPath(`workflows[${index}]`, issue.path),
        })),
      );
      return;
    }

    const validatedWorkflow = workflowValidation.workflow;

    if (!validatedWorkflow) {
      return;
    }

    const workflowId = validatedWorkflow.workflowId;

    if (workflowIds.has(workflowId)) {
      issues.push({
        code: 'duplicateWorkflowId',
        severity: 'error',
        message: `Workflow ID '${workflowId}' is already used by another workflow in the package.`,
        path: `workflows[${index}].workflowId`,
        phase: 'structural',
        details: {
          workflowId,
        },
      });
      return;
    }

    workflowIds.add(workflowId);
  });

  if (typeof candidate.activeWorkflowId === 'string' && !workflowIds.has(candidate.activeWorkflowId)) {
    issues.push({
      code: 'missingActiveWorkflow',
      severity: 'error',
      message: `Active workflow '${candidate.activeWorkflowId}' does not exist in the package.`,
      path: 'activeWorkflowId',
      phase: 'structural',
    });
  }

  if (Array.isArray(candidate.runOrderWorkflowIds)) {
    candidate.runOrderWorkflowIds.forEach((workflowId, index) => {
      if (typeof workflowId === 'string' && !workflowIds.has(workflowId)) {
        issues.push({
          code: 'missingRunOrderWorkflow',
          severity: 'error',
          message: `Run-order workflow '${workflowId}' does not exist in the package.`,
          path: `runOrderWorkflowIds[${index}]`,
          phase: 'structural',
        });
      }
    });
  }

  if (issues.length > 0) {
    return {
      valid: false,
      issues,
    };
  }

  return {
    valid: true,
    workflowPackage: candidate as unknown as WorkflowPackageV1,
    issues: [],
  };
}

function mapSchemaErrors(errors: ErrorObject[]): WorkflowValidationIssue[] {
  return errors.map((error) => ({
    code: `schema.${error.keyword}`,
    severity: 'error',
    message: error.message ?? 'Workflow package JSON does not match the workflow package schema.',
    path: buildErrorPath(error),
    phase: 'structural',
    details: {
      keyword: error.keyword,
      params: error.params as Record<string, unknown>,
    },
  }));
}

function buildErrorPath(error: ErrorObject): string {
  const pointerPath = jsonPointerToPath(error.instancePath);

  if (error.keyword === 'required') {
    const missingProperty = String((error.params as { missingProperty: string }).missingProperty);
    return appendPropertyPath(pointerPath, missingProperty);
  }

  if (error.keyword === 'additionalProperties') {
    const propertyName = String((error.params as { additionalProperty: string }).additionalProperty);
    return appendPropertyPath(pointerPath, propertyName);
  }

  return pointerPath;
}

function jsonPointerToPath(pointer: string): string {
  if (pointer === '') {
    return '$';
  }

  const parts = pointer
    .split('/')
    .slice(1)
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));

  return parts
    .map((part, index) => {
      if (/^\d+$/.test(part)) {
        return `[${part}]`;
      }

      return index === 0 ? part : `.${part}`;
    })
    .join('');
}

function appendPropertyPath(basePath: string, property: string): string {
  if (basePath === '$') {
    return property;
  }

  if (/^\d+$/.test(property)) {
    return `${basePath}[${property}]`;
  }

  return `${basePath}.${property}`;
}

function prefixPath(basePath: string, nestedPath: string) {
  if (nestedPath === '$') {
    return basePath;
  }

  if (nestedPath.startsWith('[')) {
    return `${basePath}${nestedPath}`;
  }

  return `${basePath}.${nestedPath}`;
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

  if (trimmed !== '') {
    return trimmed;
  }

  return 'wf_workflow';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
