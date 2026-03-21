import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';

import workflowSchema from '../../schemas/workflow-ir-v1.schema.json';

import type { Workflow, WorkflowStructuralValidationResult, WorkflowValidationIssue } from './types';

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
});

const validateWorkflowSchema = ajv.compile(workflowSchema);

export function validateWorkflowStructure(candidate: unknown): WorkflowStructuralValidationResult {
  const schemaValid = validateWorkflowSchema(candidate);
  const issues: WorkflowValidationIssue[] = [];

  if (!schemaValid) {
    issues.push(...mapSchemaErrors(candidate, validateWorkflowSchema.errors ?? []));
  }

  issues.push(...findDuplicateStepIdIssues(candidate));

  if (issues.length > 0) {
    return {
      valid: false,
      issues,
    };
  }

  return {
    valid: true,
    workflow: candidate as Workflow,
    issues: [],
  };
}

function mapSchemaErrors(candidate: unknown, errors: ErrorObject[]): WorkflowValidationIssue[] {
  return errors.map((error) => ({
    code: `schema.${error.keyword}`,
    severity: 'error',
    message: error.message ?? 'Workflow JSON does not match the V1 schema.',
    path: buildErrorPath(error),
    phase: 'structural',
    stepId: findStepIdAtPath(candidate, error.instancePath),
    details: {
      keyword: error.keyword,
      params: error.params as Record<string, unknown>,
    },
  }));
}

function findDuplicateStepIdIssues(candidate: unknown): WorkflowValidationIssue[] {
  if (!isRecord(candidate) || !Array.isArray(candidate.steps)) {
    return [];
  }

  const seen = new Map<string, number>();
  const issues: WorkflowValidationIssue[] = [];

  candidate.steps.forEach((step, index) => {
    if (!isRecord(step) || typeof step.id !== 'string') {
      return;
    }

    const firstIndex = seen.get(step.id);

    if (firstIndex === undefined) {
      seen.set(step.id, index);
      return;
    }

    issues.push({
      code: 'duplicateStepId',
      severity: 'error',
      message: `Step ID '${step.id}' is already used by step ${firstIndex + 1}.`,
      path: `steps[${index}].id`,
      phase: 'structural',
      stepId: step.id,
      details: {
        stepId: step.id,
        firstIndex,
        duplicateIndex: index,
      },
    });
  });

  return issues;
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

function findStepIdAtPath(candidate: unknown, instancePath: string): string | undefined {
  if (!isRecord(candidate) || !Array.isArray(candidate.steps)) {
    return undefined;
  }

  const segments = instancePath.split('/').slice(1);

  if (segments[0] !== 'steps' || !/^\d+$/.test(segments[1] ?? '')) {
    return undefined;
  }

  const step = candidate.steps[Number(segments[1])];
  return isRecord(step) && typeof step.id === 'string' ? step.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
