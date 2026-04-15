import type { WorkflowStep } from '../workflow';

import type { AIDraftIssue } from './authoringIr';
import type { AIRepairIssueSummary } from './types';

const DEFAULT_REPAIR_ISSUE_LIMIT = 12;

export function selectRelevantValidationIssues(issues: AIDraftIssue[], limit = DEFAULT_REPAIR_ISSUE_LIMIT) {
  if (issues.length <= 1) {
    return issues;
  }

  const authoringIssues = issues.filter((issue) => issue.phase === 'authoring');
  const structuralIssues = issues.filter((issue) => issue.phase === 'structural');
  const sourceIssues = authoringIssues.length > 0 ? authoringIssues : structuralIssues.length > 0 ? structuralIssues : issues;
  const dedupedIssues = dedupeIssues(sourceIssues);
  const rankedIssues = [...dedupedIssues].sort((left, right) =>
    compareIssues(left, right, authoringIssues.length === 0 && structuralIssues.length > 0));
  const selectedIssues: AIDraftIssue[] = [];

  for (const issue of rankedIssues) {
    if (
      issue.phase === 'structural'
      && issue.code === 'schema.oneOf'
      && issue.path === '$'
      && rankedIssues.some((candidate) => candidate.path !== '$')
    ) {
      continue;
    }

    if (
      issue.phase === 'structural'
      && issue.code === 'schema.oneOf'
      && rankedIssues.some((candidate) => candidate !== issue && isSameOrDescendantPath(candidate.path, issue.path))
    ) {
      continue;
    }

    if (selectedIssues.some((selected) => isSameOrDescendantPath(issue.path, selected.path))) {
      continue;
    }

    selectedIssues.push(issue);

    if (selectedIssues.length >= limit) {
      break;
    }
  }

  return selectedIssues.length > 0 ? selectedIssues : dedupedIssues.slice(0, Math.min(limit, dedupedIssues.length));
}

export function selectRepairPromptIssues(
  issues: AIDraftIssue[],
  compiledSteps: WorkflowStep[],
  limit = DEFAULT_REPAIR_ISSUE_LIMIT,
): AIRepairIssueSummary[] {
  const selectedIssues = selectRelevantRepairIssues(issues, compiledSteps, limit);

  return selectedIssues.map((issue) => ({
    code: issue.code,
    path: issue.path,
    message: issue.message,
    ...(issue.stepId ? { stepId: issue.stepId } : {}),
  }));
}

function selectRelevantRepairIssues(issues: AIDraftIssue[], compiledSteps: WorkflowStep[], limit: number): AIDraftIssue[] {
  if (issues.some((issue) => issue.phase === 'authoring' || issue.phase === 'structural') || compiledSteps.length === 0) {
    return selectRelevantValidationIssues(issues, limit);
  }

  const generatedColumns = collectGeneratedColumns(compiledSteps);
  const issuesByStepIndex = collectIssuesByStepIndex(issues, compiledSteps);
  const cascadingColumns = new Set<string>();
  const rootIssues = issues.filter((issue) => {
    const missingColumnId = getMissingColumnId(issue);

    if (!missingColumnId) {
      return true;
    }

    const producer = generatedColumns.get(missingColumnId);

    if (!producer) {
      return true;
    }

    const issueStepIndex = getIssueStepIndex(issue, compiledSteps);

    if (typeof issueStepIndex === 'number' && producer.stepIndex >= issueStepIndex) {
      return true;
    }

    if (!issuesByStepIndex.has(producer.stepIndex)) {
      return true;
    }

    cascadingColumns.add(missingColumnId);
    return false;
  });

  const selectedRootIssues = selectRelevantValidationIssues(rootIssues.length > 0 ? rootIssues : issues, limit);

  if (cascadingColumns.size === 0) {
    return selectedRootIssues;
  }

  const cascadeNote: AIDraftIssue = {
    code: 'cascadingMissingColumns',
    severity: 'warning',
    phase: 'semantic',
    path: 'repair.cascadingMissingColumns',
    message: `Later missingColumn errors for ${formatColumnList([...cascadingColumns])} are cascading from failed derived columns; fix the root issue first.`,
  };

  if (selectedRootIssues.length >= limit) {
    return [...selectedRootIssues.slice(0, Math.max(0, limit - 1)), cascadeNote];
  }

  return [...selectedRootIssues, cascadeNote];
}

function collectGeneratedColumns(steps: WorkflowStep[]) {
  const generatedColumns = new Map<string, { stepIndex: number; stepId: string }>();

  for (const [stepIndex, step] of steps.entries()) {
    switch (step.type) {
      case 'deriveColumn':
      case 'combineColumns':
        generatedColumns.set(step.newColumn.columnId, { stepIndex, stepId: step.id });
        break;
      case 'splitColumn':
        for (const outputColumn of step.outputColumns) {
          generatedColumns.set(outputColumn.columnId, { stepIndex, stepId: step.id });
        }
        break;
      default:
        break;
    }
  }

  return generatedColumns;
}

function collectIssuesByStepIndex(issues: AIDraftIssue[], steps: WorkflowStep[]) {
  const issuesByStepIndex = new Map<number, AIDraftIssue[]>();

  for (const issue of issues) {
    const stepIndex = getIssueStepIndex(issue, steps);

    if (typeof stepIndex !== 'number') {
      continue;
    }

    const stepIssues = issuesByStepIndex.get(stepIndex) ?? [];
    stepIssues.push(issue);
    issuesByStepIndex.set(stepIndex, stepIssues);
  }

  return issuesByStepIndex;
}

function getIssueStepIndex(issue: AIDraftIssue, steps: WorkflowStep[]) {
  const pathMatch = /^steps\[(\d+)\]/.exec(issue.path);

  if (pathMatch) {
    return Number(pathMatch[1]);
  }

  if (!issue.stepId) {
    return undefined;
  }

  const stepIndex = steps.findIndex((step) => step.id === issue.stepId);
  return stepIndex >= 0 ? stepIndex : undefined;
}

function getMissingColumnId(issue: AIDraftIssue) {
  if (issue.code !== 'missingColumn') {
    return undefined;
  }

  const detailColumnId = issue.details?.columnId;

  if (typeof detailColumnId === 'string' && detailColumnId.trim() !== '') {
    return detailColumnId;
  }

  const messageMatch = /Column '([^']+)'/.exec(issue.message);
  return messageMatch?.[1];
}

function formatColumnList(columnIds: string[]) {
  return columnIds.map((columnId) => `'${columnId}'`).join(', ');
}

function dedupeIssues(issues: AIDraftIssue[]) {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.phase}|${issue.code}|${issue.path}|${issue.message}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function compareIssues(left: AIDraftIssue, right: AIDraftIssue, structuralOnly: boolean) {
  const leftPriority = getIssuePriority(left, structuralOnly);
  const rightPriority = getIssuePriority(right, structuralOnly);

  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  if (left.path.length !== right.path.length) {
    return left.path.length - right.path.length;
  }

  return left.path.localeCompare(right.path) || left.message.localeCompare(right.message);
}

function getIssuePriority(issue: AIDraftIssue, structuralOnly: boolean) {
  if (issue.phase === 'authoring') {
    switch (issue.code) {
      case 'authoringMissingField':
        return 0;
      case 'authoringInvalidContext':
        return 1;
      case 'authoringUnsupportedOp':
        return 2;
      case 'authoringInvalidOperandSource':
        return 3;
      case 'authoringInvalidMatch':
      case 'authoringInvalidBetween':
        return 4;
      case 'authoringEmptyGroup':
        return 5;
      case 'authoringType':
        return 6;
      default:
        return 7;
    }
  }

  if (structuralOnly) {
    switch (issue.code) {
      case 'schema.type':
        return 0;
      case 'schema.required':
        return 1;
      case 'schema.enum':
        return 2;
      case 'schema.additionalProperties':
        return 3;
      case 'schema.const':
        return 4;
      case 'schema.pattern':
        return 5;
      case 'schema.maxItems':
      case 'schema.minItems':
        return 6;
      case 'schema.oneOf':
        return 9;
      default:
        return 8;
    }
  }

  switch (issue.code) {
    case 'taskQualityChecklistNotSatisfied':
      return 0;
    case 'taskQualityFallbackThenNormalizeCompressed':
      return 1;
    case 'taskQualityPromptColumnMentionedButUnused':
      return 2;
    case 'taskQualityNamedBranchMissing':
      return 3;
    case 'taskQualityPhaseMissing':
      return 4;
    case 'emptyDraft':
      return 5;
    case 'incompatibleType':
      return 6;
    case 'invalidExpression':
      return 7;
    case 'invalidRegex':
      return 8;
    case 'missingColumn':
      return 9;
    case 'duplicateColumnReference':
      return 10;
    default:
      return 11;
  }
}

function isSameOrDescendantPath(path: string, ancestorPath: string) {
  if (path === ancestorPath) {
    return true;
  }

  if (ancestorPath === '$') {
    return false;
  }

  return path.startsWith(`${ancestorPath}.`) || path.startsWith(`${ancestorPath}[`);
}
