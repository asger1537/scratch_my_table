import type { Column } from '../domain/model';
import { validateWorkflowSemantics, type WorkflowExpression, type WorkflowStep } from '../workflow';

import type { AIDraftIssue } from './authoringIr';
import { replaceWorkflowSteps } from './draft';
import type { AIPromptContext } from './types';

export interface EvaluateDraftQualityInput {
  context: AIPromptContext;
  userText: string;
  steps: WorkflowStep[];
}

interface PromptColumnMention {
  raw: string;
  normalized: string;
}

export function evaluateDraftQuality(input: EvaluateDraftQualityInput): AIDraftIssue[] {
  const issues: AIDraftIssue[] = [];
  const availableColumns = getAvailableSchemaColumns(input.context);

  issues.push(...evaluatePromptColumnCoverage(input.userText, input.steps, availableColumns));
  issues.push(...evaluateNamedBranchCoverage(input.userText, input.steps));
  issues.push(...evaluateRequestedPhases(input.userText, input.steps));
  issues.push(...evaluateFallbackThenNormalizeCompression(input.steps));

  return dedupeIssues(issues);
}

function evaluatePromptColumnCoverage(
  userText: string,
  steps: WorkflowStep[],
  availableColumns: Column[],
) {
  const mentions = extractExplicitPromptColumnMentions(userText);
  const resolvedMentions = resolvePromptColumnMentions(mentions, availableColumns);
  const referencedColumnIds = collectReferencedColumnIds(steps);
  const issues: AIDraftIssue[] = [];

  for (const { column } of resolvedMentions.matchedMentions) {
    if (!referencedColumnIds.has(column.columnId)) {
      issues.push({
        code: 'taskQualityPromptColumnMentionedButUnused',
        severity: 'warning',
        phase: 'semantic',
        path: `taskQuality.columns.${column.columnId}`,
        message: `The request explicitly mentions column "${column.displayName}" (${column.columnId}), but the draft never uses that column.`,
        details: {
          columnId: column.columnId,
          displayName: column.displayName,
        },
      });
    }
  }

  return issues;
}

function evaluateNamedBranchCoverage(userText: string, steps: WorkflowStep[]) {
  const expectedBranches = extractQuotedReturnValues(userText);

  if (expectedBranches.length === 0) {
    return [];
  }

  const actualBranches = collectMatchThenStringLiterals(steps);
  const missingBranches = expectedBranches.filter((branch) => !actualBranches.has(branch.toLowerCase()));

  if (missingBranches.length === 0) {
    return [];
  }

  return [
    {
      code: 'taskQualityNamedBranchMissing',
      severity: 'warning',
      phase: 'semantic',
      path: 'taskQuality.namedBranches',
      message: `The request names match outcomes ${missingBranches.map((branch) => `"${branch}"`).join(', ')}, but the draft does not return all of them.`,
      details: {
        missingBranches,
      },
    },
  ] satisfies AIDraftIssue[];
}

function evaluateRequestedPhases(userText: string, steps: WorkflowStep[]) {
  const normalizedPrompt = normalizeForMatch(userText);
  const stepTypes = new Set(steps.map((step) => step.type));
  const hasFormattingPatch = steps.some(
    (step) => step.type === 'scopedRule'
      && ((step.cases ?? []).some((ruleCase) => ruleCase.then.format && Object.keys(ruleCase.then.format).length > 0)
        || (step.defaultPatch?.format && Object.keys(step.defaultPatch.format).length > 0)),
  );
  const missingPhases: string[] = [];

  if ((normalizedPrompt.includes('drop ') || normalizedPrompt.includes('drop helper')) && !stepTypes.has('dropColumns')) {
    missingPhases.push('drop columns');
  }

  if (
    (normalizedPrompt.includes('filter ')
      || normalizedPrompt.includes('keep only')
      || normalizedPrompt.includes('drop any rows')
      || normalizedPrompt.includes('remove rows'))
    && !stepTypes.has('filterRows')
  ) {
    missingPhases.push('filter rows');
  }

  if (
    (normalizedPrompt.includes('derive ')
      || normalizedPrompt.includes('calculate ')
      || normalizedPrompt.includes('using a match')
      || normalizedPrompt.includes('new column'))
    && !stepTypes.has('deriveColumn')
  ) {
    missingPhases.push('derive column');
  }

  if ((normalizedPrompt.includes('highlight') || normalizedPrompt.includes('color ')) && !hasFormattingPatch) {
    missingPhases.push('format or highlight cells');
  }

  if (missingPhases.length === 0) {
    return [];
  }

  return [
    {
      code: 'taskQualityPhaseMissing',
      severity: 'warning',
      phase: 'semantic',
      path: 'taskQuality.phases',
      message: `The draft is missing requested phases: ${missingPhases.join(', ')}.`,
      details: {
        missingPhases,
      },
    },
  ] satisfies AIDraftIssue[];
}

function evaluateFallbackThenNormalizeCompression(steps: WorkflowStep[]) {
  const issues: AIDraftIssue[] = [];

  for (const [index, step] of steps.entries()) {
    if (step.type !== 'scopedRule' || !step.defaultPatch?.value || (step.cases?.length ?? 0) === 0) {
      continue;
    }

    const hasFallbackCase = (step.cases ?? []).some((ruleCase) => containsColumnReference(ruleCase.then.value));

    if (!hasFallbackCase || !containsNormalization(step.defaultPatch.value)) {
      continue;
    }

    issues.push({
      code: 'taskQualityFallbackThenNormalizeCompressed',
      severity: 'warning',
      phase: 'semantic',
      path: `steps[${index}]`,
      stepId: step.id,
      message:
        'This scopedRule mixes a fallback case with defaultPatch normalization. If the fallback value must also be normalized, split it into sequential steps instead of relying on defaultPatch after a matched case.',
    });
  }

  return issues;
}

function getAvailableSchemaColumns(context: AIPromptContext) {
  const workflowForSchema = context.draft ? replaceWorkflowSteps(context.workflow, context.draft.steps) : context.workflow;
  const validation = validateWorkflowSemantics(workflowForSchema, context.table);

  return validation.valid ? validation.finalSchema.columns : context.table.schema.columns;
}

function normalizeForMatch(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function extractExplicitPromptColumnMentions(userText: string): PromptColumnMention[] {
  const mentions = new Map<string, PromptColumnMention>();
  const derivedColumnNames = extractDerivedColumnNames(userText);

  function addMention(rawValue: string) {
    const cleaned = cleanPromptColumnMention(rawValue);

    if (!cleaned) {
      return;
    }

    const normalized = normalizeForMatch(cleaned);

    if (normalized === '' || derivedColumnNames.has(normalized) || !isPlausibleColumnMention(normalized)) {
      return;
    }

    mentions.set(normalized, {
      raw: cleaned,
      normalized,
    });
  }

  collectRegexMentions(
    userText,
    /\b(?:normalize|clean(?:\s+up)?|use|drop|rename|split|combine|deduplicate|sort|highlight|fill|create|derive|calculate|map|make sure|ensure)\s+(?:the\s+)?(?:(?:primary|main|secondary|final|resulting)\s+)?([^,:;\n.]+?)\s+column\b/gi,
    addMention,
  );
  collectRegexMentions(
    userText,
    /\bon columns?\s+([^,\n.]+)/gi,
    (value) => splitColumnMentionList(value).forEach(addMention),
  );
  collectRegexMentions(
    userText,
    /\bfall back to\s+([^,\n.]+?)(?=$|[,.\n])/gi,
    addMention,
  );
  collectRegexMentions(
    userText,
    /\buse\s+([^,\n.]+?)(?=\s+(?:as|first|second|third|fourth|when|if|only)\b|$|[,.\n])/gi,
    addMention,
  );
  collectRegexMentions(
    userText,
    /\b(?:if\s+|where\s+|and\s+|or\s+)?([A-Z][A-Za-z0-9?() -]*?)\s+is\b/g,
    addMention,
  );
  collectRegexMentions(
    userText,
    /\b(?:if\s+|where\s+|and\s+|or\s+)?([A-Z][A-Za-z0-9?() -]*?)\s+has\b/g,
    addMention,
  );
  collectRegexMentions(
    userText,
    /\b(?:if\s+|where\s+|and\s+|or\s+)?([A-Z][A-Za-z0-9?() -]*?)\s+contains\b/g,
    addMention,
  );

  return [...mentions.values()];
}

function extractDerivedColumnNames(userText: string) {
  const derivedColumns = new Set<string>();

  collectRegexMentions(
    userText,
    /\bderive\s+(?:a\s+)?new\s+column\s+called\s+([^:\n.]+?)(?=\s+(?:using|with|from|for)\b|$|[:.\n])/gi,
    (value) => {
      const cleaned = cleanPromptColumnMention(value);

      if (cleaned) {
        derivedColumns.add(normalizeForMatch(cleaned));
      }
    },
  );

  return derivedColumns;
}

function collectRegexMentions(userText: string, pattern: RegExp, onMatch: (value: string) => void) {
  let match: RegExpExecArray | null = pattern.exec(userText);

  while (match) {
    const value = typeof match[1] === 'string' ? match[1] : '';

    if (value.trim() !== '') {
      onMatch(value);
    }

    match = pattern.exec(userText);
  }
}

function splitColumnMentionList(value: string) {
  return value
    .split(/\s*,\s*|\s+and\s+/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function cleanPromptColumnMention(value: string) {
  const cleaned = value
    .trim()
    .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
    .replace(/^goal\s+\d+:\s*/i, '')
    .replace(/^(?:if|where)\s+/i, '')
    .replace(/^(?:for|on)\s+rows\s+where\s+/i, '')
    .replace(/^filter\s+rows\s+to\s+keep\s+only\s+customers\s+where\s+/i, '')
    .replace(/^filter\s+rows\s+where\s+/i, '')
    .replace(/^keep\s+only\s+customers\s+where\s+/i, '')
    .replace(/^customers\s+where\s+/i, '')
    .replace(/^(?:(?:normalize|clean(?:\s+up)?|use|drop|rename|split|combine|deduplicate|sort|highlight|fill|make sure|ensure|derive|create|calculate|map)\s+)+/i, '')
    .replace(/^(?:the|primary|main|secondary|final|resulting)\s+/i, '')
    .replace(/\s+(?:first|second|third|fourth)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  const normalized = normalizeForMatch(cleaned);

  if (
    normalized === ''
    || normalized === 'new'
    || normalized === 'a new'
    || normalized.startsWith('new ')
    || normalized.startsWith('a new ')
  ) {
    return '';
  }

  return cleaned;
}

function isPlausibleColumnMention(normalized: string) {
  if (normalized === '' || normalized.includes(':')) {
    return false;
  }

  const tokens = normalized.split(/\s+/).filter((token) => token !== '');

  if (tokens.length === 0 || tokens.length > 6) {
    return false;
  }

  const bannedWholePhrases = new Set([
    'goal',
    'column',
    'new',
    'a new',
  ]);

  if (bannedWholePhrases.has(normalized)) {
    return false;
  }

  const bannedTokens = new Set([
    'goal',
    'normalize',
    'clean',
    'cleanup',
    'derive',
    'calculate',
    'filter',
    'rows',
    'keep',
    'customers',
    'return',
    'using',
    'helper',
  ]);

  return tokens.every((token) => !bannedTokens.has(token));
}

function resolvePromptColumnMentions(mentions: PromptColumnMention[], availableColumns: Column[]) {
  const matchedMentions: Array<{ mention: PromptColumnMention; column: Column }> = [];
  const missingMentions: PromptColumnMention[] = [];
  const availableColumnsByNormalizedName = new Map<string, Column[]>();

  for (const column of availableColumns) {
    const keys = new Set([
      normalizeForMatch(column.displayName),
      normalizeForMatch(column.columnId.replace(/^col_/, '')),
    ]);

    for (const key of keys) {
      availableColumnsByNormalizedName.set(key, [
        ...(availableColumnsByNormalizedName.get(key) ?? []),
        column,
      ]);
    }
  }

  for (const mention of mentions) {
    const matches = availableColumnsByNormalizedName.get(mention.normalized) ?? [];

    if (matches.length === 1) {
      matchedMentions.push({
        mention,
        column: matches[0],
      });
      continue;
    }

    if (matches.length === 0) {
      missingMentions.push(mention);
    }
  }

  return {
    matchedMentions,
    missingMentions,
  };
}

function collectReferencedColumnIds(steps: WorkflowStep[]) {
  const columnIds = new Set<string>();

  for (const step of steps) {
    switch (step.type) {
      case 'comment':
        break;
      case 'scopedRule':
        step.columnIds.forEach((columnId) => columnIds.add(columnId));
        collectExpressionColumnIds(step.rowCondition, columnIds);
        for (const ruleCase of step.cases ?? []) {
          collectExpressionColumnIds(ruleCase.when, columnIds);
          collectPatchColumnIds(ruleCase.then, columnIds);
        }
        collectPatchColumnIds(step.defaultPatch, columnIds);
        break;
      case 'dropColumns':
      case 'combineColumns':
      case 'deduplicateRows':
        step.columnIds.forEach((columnId) => columnIds.add(columnId));
        if (step.type === 'combineColumns') {
          columnIds.add(step.newColumn.columnId);
        }
        break;
      case 'renameColumn':
      case 'splitColumn':
        columnIds.add(step.columnId);
        if (step.type === 'splitColumn') {
          step.outputColumns.forEach((column) => columnIds.add(column.columnId));
        }
        break;
      case 'deriveColumn':
        columnIds.add(step.newColumn.columnId);
        collectExpressionColumnIds(step.expression, columnIds);
        break;
      case 'filterRows':
        collectExpressionColumnIds(step.condition, columnIds);
        break;
      case 'sortRows':
        step.sorts.forEach((sort) => columnIds.add(sort.columnId));
        break;
    }
  }

  return columnIds;
}

function collectPatchColumnIds(
  patch: { value?: WorkflowExpression } | undefined,
  columnIds: Set<string>,
) {
  if (!patch?.value) {
    return;
  }

  collectExpressionColumnIds(patch.value, columnIds);
}

function collectExpressionColumnIds(expression: WorkflowExpression | undefined, columnIds: Set<string>) {
  if (!expression) {
    return;
  }

  switch (expression.kind) {
    case 'column':
      columnIds.add(expression.columnId);
      return;
    case 'call':
      expression.args.forEach((arg) => collectExpressionColumnIds(arg, columnIds));
      return;
    case 'match':
      collectExpressionColumnIds(expression.subject, columnIds);
      for (const matchCase of expression.cases) {
        if (matchCase.kind === 'when') {
          collectExpressionColumnIds(matchCase.when, columnIds);
        }
        collectExpressionColumnIds(matchCase.then, columnIds);
      }
      return;
    default:
      return;
  }
}

function extractQuotedReturnValues(userText: string) {
  const values = new Set<string>();
  const pattern = /return\s+["']([^"']+)["']/gi;
  let match: RegExpExecArray | null = pattern.exec(userText);

  while (match) {
    values.add(match[1].trim().toLowerCase());
    match = pattern.exec(userText);
  }

  return [...values];
}

function collectMatchThenStringLiterals(steps: WorkflowStep[]) {
  const literals = new Set<string>();

  for (const step of steps) {
    switch (step.type) {
      case 'deriveColumn':
        collectMatchThenStringLiteralsFromExpression(step.expression, literals);
        break;
      case 'scopedRule':
        collectMatchThenStringLiteralsFromExpression(step.rowCondition, literals);
        for (const ruleCase of step.cases ?? []) {
          collectMatchThenStringLiteralsFromExpression(ruleCase.when, literals);
          collectMatchThenStringLiteralsFromExpression(ruleCase.then.value, literals);
        }
        collectMatchThenStringLiteralsFromExpression(step.defaultPatch?.value, literals);
        break;
      case 'filterRows':
        collectMatchThenStringLiteralsFromExpression(step.condition, literals);
        break;
      default:
        break;
    }
  }

  return literals;
}

function collectMatchThenStringLiteralsFromExpression(expression: WorkflowExpression | undefined, literals: Set<string>) {
  if (!expression) {
    return;
  }

  switch (expression.kind) {
    case 'call':
      expression.args.forEach((arg) => collectMatchThenStringLiteralsFromExpression(arg, literals));
      return;
    case 'match':
      collectMatchThenStringLiteralsFromExpression(expression.subject, literals);
      for (const matchCase of expression.cases) {
        if (matchCase.kind === 'when') {
          collectMatchThenStringLiteralsFromExpression(matchCase.when, literals);
        }

        if (matchCase.then.kind === 'literal' && typeof matchCase.then.value === 'string') {
          literals.add(matchCase.then.value.toLowerCase());
        }

        collectMatchThenStringLiteralsFromExpression(matchCase.then, literals);
      }
      return;
    default:
      return;
  }
}

function containsColumnReference(expression: WorkflowExpression | undefined): boolean {
  if (!expression) {
    return false;
  }

  switch (expression.kind) {
    case 'column':
      return true;
    case 'call':
      return expression.args.some((arg) => containsColumnReference(arg));
    case 'match':
      return containsColumnReference(expression.subject)
        || expression.cases.some((matchCase) =>
          (matchCase.kind === 'when' && containsColumnReference(matchCase.when))
          || containsColumnReference(matchCase.then));
    default:
      return false;
  }
}

function containsNormalization(expression: WorkflowExpression | undefined): boolean {
  if (!expression) {
    return false;
  }

  switch (expression.kind) {
    case 'call':
      return ['trim', 'lower', 'upper', 'collapseWhitespace'].includes(expression.name)
        || expression.args.some((arg) => containsNormalization(arg));
    case 'match':
      return containsNormalization(expression.subject)
        || expression.cases.some((matchCase) =>
          (matchCase.kind === 'when' && containsNormalization(matchCase.when))
          || containsNormalization(matchCase.then));
    default:
      return false;
  }
}

function dedupeIssues(issues: AIDraftIssue[]) {
  const seen = new Set<string>();

  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.path}|${issue.message}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}
