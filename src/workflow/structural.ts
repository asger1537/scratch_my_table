import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';

import workflowSchema from '../../schemas/workflow-ir-v2.schema.json';

import type {
  Workflow,
  WorkflowCallExpression,
  WorkflowCondition,
  WorkflowExpression,
  WorkflowStructuralValidationResult,
  WorkflowValidationIssue,
} from './types';

const ajv = new Ajv2020({
  allErrors: true,
  strict: false,
});

const validateWorkflowSchema = ajv.compile(workflowSchema);

export function validateWorkflowStructure(candidate: unknown): WorkflowStructuralValidationResult {
  const normalized = normalizeWorkflowCandidate(candidate);

  if ('issues' in normalized) {
    return {
      valid: false,
      issues: normalized.issues,
    };
  }

  const schemaValid = validateWorkflowSchema(normalized.candidate);
  const issues: WorkflowValidationIssue[] = [];

  if (!schemaValid) {
    issues.push(...mapSchemaErrors(normalized.candidate, validateWorkflowSchema.errors ?? []));
  }

  issues.push(...findDuplicateStepIdIssues(normalized.candidate));

  if (issues.length > 0) {
    return {
      valid: false,
      issues,
    };
  }

  return {
    valid: true,
    workflow: normalized.candidate as Workflow,
    issues: [],
  };
}

function normalizeWorkflowCandidate(candidate: unknown): { candidate: unknown } | { issues: WorkflowValidationIssue[] } {
  if (!isRecord(candidate) || typeof candidate.version !== 'number') {
    return { candidate };
  }

  if (candidate.version === 2) {
    return { candidate };
  }

  if (candidate.version !== 1) {
    return { candidate };
  }

  try {
    return {
      candidate: upgradeWorkflowV1Candidate(candidate),
    };
  } catch (error) {
    return {
      issues: [
        makeStructuralIssue(
          'legacyUpgradeFailed',
          error instanceof Error ? error.message : 'Legacy workflow v1 could not be upgraded to workflow v2.',
          '$',
        ),
      ],
    };
  }
}

function upgradeWorkflowV1Candidate(candidate: Record<string, unknown>): Workflow {
  const steps = Array.isArray(candidate.steps) ? candidate.steps : [];
  const description = typeof candidate.description === 'string' ? candidate.description : undefined;

  return {
    version: 2,
    workflowId: String(candidate.workflowId ?? ''),
    name: String(candidate.name ?? ''),
    ...(description ? { description } : {}),
    steps: steps.map((step, index) => upgradeWorkflowV1Step(step, index)),
  };
}

function upgradeWorkflowV1Step(step: unknown, index: number): Workflow['steps'][number] {
  if (!isRecord(step)) {
    throw new Error(`Legacy workflow step ${index + 1} is not an object.`);
  }

  const id = String(step.id ?? '');
  const type = String(step.type ?? '');

  switch (type) {
    case 'fillEmpty':
      return {
        id,
        type: 'scopedTransform',
        columnIds: readLegacyTargetColumnIds(step.target),
        expression: {
          kind: 'call',
          name: 'coalesce',
          args: [
            { kind: 'value' },
            { kind: 'literal', value: readLegacyScalar(step.value) },
          ],
        },
        treatWhitespaceAsEmpty: readLegacyTreatWhitespaceAsEmpty(step.treatWhitespaceAsEmpty),
      };
    case 'normalizeText':
      return {
        id,
        type: 'scopedTransform',
        columnIds: readLegacyTargetColumnIds(step.target),
        rowCondition: undefined,
        expression: buildLegacyNormalizeExpression(step),
        treatWhitespaceAsEmpty: true,
      };
    case 'renameColumn':
      return {
        id,
        type: 'renameColumn',
        columnId: String(step.columnId ?? ''),
        newDisplayName: String(step.newDisplayName ?? ''),
      };
    case 'deriveColumn':
      return {
        id,
        type: 'deriveColumn',
        newColumn: readLegacyColumnSpec(step.newColumn),
        expression: upgradeLegacyExpression(step.expression),
      };
    case 'filterRows':
      return {
        id,
        type: 'filterRows',
        mode: step.mode === 'drop' ? 'drop' : 'keep',
        condition: upgradeLegacyCondition(step.condition),
      };
    case 'splitColumn':
      return {
        id,
        type: 'splitColumn',
        columnId: String(step.columnId ?? ''),
        delimiter: String(step.delimiter ?? ''),
        outputColumns: Array.isArray(step.outputColumns) ? step.outputColumns.map(readLegacyColumnSpec) : [],
      };
    case 'combineColumns':
      return {
        id,
        type: 'combineColumns',
        columnIds: readLegacyTargetColumnIds(step.target),
        separator: String(step.separator ?? ''),
        newColumn: readLegacyColumnSpec(step.newColumn),
      };
    case 'deduplicateRows':
      return {
        id,
        type: 'deduplicateRows',
        columnIds: readLegacyTargetColumnIds(step.target),
      };
    case 'sortRows':
      return {
        id,
        type: 'sortRows',
        sorts: Array.isArray(step.sorts)
          ? step.sorts.map((sort) => ({
              columnId: isRecord(sort) ? String(sort.columnId ?? '') : '',
              direction: isRecord(sort) && sort.direction === 'desc' ? 'desc' : 'asc',
            }))
          : [],
      };
    default:
      throw new Error(`Legacy workflow step '${type}' is not supported for automatic upgrade.`);
  }
}

function buildLegacyNormalizeExpression(step: Record<string, unknown>): WorkflowExpression {
  let expression: WorkflowExpression = { kind: 'value' };

  if (Boolean(step.trim)) {
    expression = makeCall('trim', [expression]);
  }

  if (Boolean(step.collapseWhitespace)) {
    expression = makeCall('collapseWhitespace', [expression]);
  }

  if (step.case === 'lower' || step.case === 'upper') {
    expression = makeCall(step.case, [expression]);
  }

  return expression;
}

function readLegacyTargetColumnIds(target: unknown) {
  if (!isRecord(target) || !Array.isArray(target.columnIds)) {
    return [];
  }

  return target.columnIds.map((columnId) => String(columnId ?? ''));
}

function readLegacyColumnSpec(candidate: unknown) {
  if (!isRecord(candidate)) {
    return {
      columnId: '',
      displayName: '',
    };
  }

  return {
    columnId: String(candidate.columnId ?? ''),
    displayName: String(candidate.displayName ?? ''),
  };
}

function readLegacyScalar(value: unknown) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}

function upgradeLegacyExpression(expression: unknown): WorkflowExpression {
  if (!isRecord(expression)) {
    throw new Error('Legacy expression is not an object.');
  }

  switch (expression.kind) {
    case 'literal':
      return {
        kind: 'literal',
        value: readLegacyScalar(expression.value),
      };
    case 'column':
      return {
        kind: 'column',
        columnId: String(expression.columnId ?? ''),
      };
    case 'concat':
      return makeCall(
        'concat',
        Array.isArray(expression.parts) ? expression.parts.map((part) => upgradeLegacyExpression(part)) : [],
      );
    case 'coalesce': {
      const inputs = Array.isArray(expression.inputs) ? expression.inputs.map((input) => upgradeLegacyExpression(input)) : [];
      return nestCoalesceCalls(inputs);
    }
    default:
      throw new Error(`Legacy expression kind '${String(expression.kind ?? '')}' is not supported for automatic upgrade.`);
  }
}

function nestCoalesceCalls(inputs: WorkflowExpression[]): WorkflowExpression {
  if (inputs.length < 2) {
    throw new Error('Legacy coalesce requires at least two inputs.');
  }

  return inputs.reduce<WorkflowExpression | null>((current, input) => {
    if (!current) {
      return input;
    }

    return makeCall('coalesce', [current, input]);
  }, null) ?? { kind: 'literal', value: null };
}

function upgradeLegacyCondition(condition: unknown): WorkflowCondition {
  if (!isRecord(condition)) {
    throw new Error('Legacy condition is not an object.');
  }

  switch (condition.kind) {
    case 'isEmpty':
      return {
        kind: 'isEmpty',
        columnId: String(condition.columnId ?? ''),
        treatWhitespaceAsEmpty: readLegacyTreatWhitespaceAsEmpty(condition.treatWhitespaceAsEmpty),
      };
    case 'equals':
      return {
        kind: 'equals',
        columnId: String(condition.columnId ?? ''),
        value: readLegacyNonNullScalar(condition.value),
      };
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      return {
        kind: condition.kind,
        columnId: String(condition.columnId ?? ''),
        value: String(condition.value ?? ''),
      };
    case 'greaterThan':
    case 'lessThan':
      return {
        kind: condition.kind,
        columnId: String(condition.columnId ?? ''),
        value: readLegacyNonNullScalar(condition.value),
      };
    case 'and':
    case 'or':
      return {
        kind: condition.kind,
        conditions: Array.isArray(condition.conditions)
          ? condition.conditions.map((child) => upgradeLegacyCondition(child))
          : [],
      };
    case 'not':
      return {
        kind: 'not',
        condition: upgradeLegacyCondition(condition.condition),
      };
    default:
      throw new Error(`Legacy condition kind '${String(condition.kind ?? '')}' is not supported for automatic upgrade.`);
  }
}

function readLegacyNonNullScalar(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  throw new Error('Legacy condition value must be a non-null scalar.');
}

function readLegacyTreatWhitespaceAsEmpty(value: unknown) {
  return value !== false;
}

function makeCall(name: WorkflowCallExpression['name'], args: WorkflowExpression[]): WorkflowCallExpression {
  return {
    kind: 'call',
    name,
    args,
  };
}

function mapSchemaErrors(candidate: unknown, errors: ErrorObject[]): WorkflowValidationIssue[] {
  return errors.map((error) => ({
    code: `schema.${error.keyword}`,
    severity: 'error',
    message: error.message ?? 'Workflow JSON does not match the workflow v2 schema.',
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

function makeStructuralIssue(code: string, message: string, path: string): WorkflowValidationIssue {
  return {
    code,
    severity: 'error',
    message,
    path,
    phase: 'structural',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
