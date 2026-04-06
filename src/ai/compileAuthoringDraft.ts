import type {
  WorkflowCellPatch,
  WorkflowExpression,
  WorkflowValidationIssue,
} from '../workflow';
import type { WorkflowCallExpression, WorkflowExpressionFunctionName, WorkflowMatchCase } from '../workflow/types';

import type {
  AIDraftIssue,
  AuthoringBooleanExpression,
  AuthoringCompareOp,
  AuthoringOperand,
  AuthoringStepInput,
  AuthoringValueExpression,
  AuthoringValueInput,
} from './authoringIr';
import type { WorkflowStepInput } from './types';

interface CompileExpressionScope {
  allowValue: boolean;
  allowCaseValue: boolean;
}

interface CompileResult<T> {
  value: T | null;
  issues: AIDraftIssue[];
}

const DIRECT_UNARY_FUNCTION_NAMES = new Set<WorkflowExpressionFunctionName>([
  'trim',
  'lower',
  'upper',
  'toNumber',
  'toString',
  'toBoolean',
  'collapseWhitespace',
  'first',
  'last',
  'round',
  'floor',
  'ceil',
  'abs',
]);
const DIRECT_BINARY_FUNCTION_NAMES = new Set<WorkflowExpressionFunctionName>([
  'split',
  'atIndex',
  'extractRegex',
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'datePart',
]);
const DIRECT_TERNARY_FUNCTION_NAMES = new Set<WorkflowExpressionFunctionName>([
  'substring',
  'replace',
  'replaceRegex',
  'dateDiff',
  'dateAdd',
]);
const DIRECT_COMPARE_FUNCTION_NAMES: Record<Exclude<AuthoringCompareOp, 'gte' | 'lte'>, WorkflowExpressionFunctionName> = {
  eq: 'equals',
  gt: 'greaterThan',
  lt: 'lessThan',
  contains: 'contains',
  startsWith: 'startsWith',
  endsWith: 'endsWith',
  matchesRegex: 'matchesRegex',
};

export function compileAuthoringDraft(
  authoringSteps: AuthoringStepInput[],
): CompileResult<WorkflowStepInput[]> {
  const issues: AIDraftIssue[] = [];
  const compiledSteps: WorkflowStepInput[] = [];

  if (!Array.isArray(authoringSteps)) {
    return {
      value: null,
      issues: [
        makeIssue(
          'authoringType',
          'Authoring draft steps must be an array.',
          'steps',
        ),
      ],
    };
  }

  authoringSteps.forEach((step, index) => {
    const compiledStep = compileStep(step, `steps[${index}]`, issues);

    if (compiledStep) {
      compiledSteps.push(compiledStep);
    }
  });

  return {
    value: issues.length > 0 ? null : compiledSteps,
    issues,
  };
}

export function compileAuthoringDraftToWorkflowSteps(authoringSteps: AuthoringStepInput[]) {
  const compiled = compileAuthoringDraft(authoringSteps);

  if (!compiled.value) {
    throw new Error(compiled.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n') || 'Failed to compile authoring draft.');
  }

  return compiled.value;
}

export function mapWorkflowValidationIssueToAIDraftIssue(issue: WorkflowValidationIssue): AIDraftIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    path: issue.path,
    phase: issue.phase,
    ...(issue.stepId ? { stepId: issue.stepId } : {}),
    ...(issue.details ? { details: issue.details } : {}),
  };
}

function compileStep(step: unknown, path: string, issues: AIDraftIssue[]): WorkflowStepInput | null {
  if (!isRecord(step)) {
    issues.push(makeIssue('authoringType', 'Each authoring step must be an object.', path));
    return null;
  }

  switch (step.type) {
    case 'comment':
      if (typeof step.text !== 'string' || step.text.trim() === '') {
        issues.push(makeIssue('authoringMissingField', 'Comment steps require a non-empty text string.', `${path}.text`));
        return null;
      }
      return {
        type: 'comment',
        text: step.text,
      };

    case 'scopedRule': {
      const columnIds = compileStringArray(step.columnIds, `${path}.columnIds`, issues);
      const rowCondition = step.rowWhere === undefined
        ? undefined
        : compileBooleanExpression(step.rowWhere, `${path}.rowWhere`, { allowValue: false, allowCaseValue: false }, issues);
      const cases = compileScopedRuleCases(step.cases, `${path}.cases`, issues);
      const defaultPatch = step.defaultPatch === undefined
        ? undefined
        : compileCellPatch(step.defaultPatch, `${path}.defaultPatch`, { allowValue: true, allowCaseValue: false }, issues);

      if (!columnIds) {
        return null;
      }

      return {
        type: 'scopedRule',
        columnIds,
        ...(rowCondition ? { rowCondition } : {}),
        ...(cases ? { cases } : {}),
        ...(defaultPatch ? { defaultPatch } : {}),
      };
    }

    case 'dropColumns': {
      const columnIds = compileStringArray(step.columnIds, `${path}.columnIds`, issues);

      return columnIds
        ? {
            type: 'dropColumns',
            columnIds,
          }
        : null;
    }

    case 'renameColumn':
      if (typeof step.columnId !== 'string' || step.columnId.trim() === '') {
        issues.push(makeIssue('authoringMissingField', 'Rename steps require a non-empty columnId.', `${path}.columnId`));
      }
      if (typeof step.newDisplayName !== 'string' || step.newDisplayName.trim() === '') {
        issues.push(makeIssue('authoringMissingField', 'Rename steps require a non-empty newDisplayName.', `${path}.newDisplayName`));
      }

      if (issues.some((issue) => issue.path === `${path}.columnId` || issue.path === `${path}.newDisplayName`)) {
        return null;
      }

      return {
        type: 'renameColumn',
        columnId: step.columnId,
        newDisplayName: step.newDisplayName,
      };

    case 'deriveColumn': {
      const newColumn = compileNewColumn(step.newColumn, `${path}.newColumn`, issues);
      const expression = compileValueInput(step.derive, `${path}.derive`, { allowValue: false, allowCaseValue: false }, issues);

      return newColumn && expression
        ? {
            type: 'deriveColumn',
            newColumn,
            expression,
          }
        : null;
    }

    case 'filterRows': {
      if (step.mode !== 'keep' && step.mode !== 'drop') {
        issues.push(makeIssue('authoringType', 'Filter rows mode must be "keep" or "drop".', `${path}.mode`));
        return null;
      }

      const condition = compileBooleanExpression(step.where, `${path}.where`, { allowValue: false, allowCaseValue: false }, issues);

      return condition
        ? {
            type: 'filterRows',
            mode: step.mode,
            condition,
          }
        : null;
    }

    case 'splitColumn': {
      const outputColumns = compileNewColumnArray(step.outputColumns, `${path}.outputColumns`, issues);

      if (typeof step.columnId !== 'string' || step.columnId.trim() === '') {
        issues.push(makeIssue('authoringMissingField', 'Split column steps require a non-empty columnId.', `${path}.columnId`));
      }
      if (typeof step.delimiter !== 'string' || step.delimiter === '') {
        issues.push(makeIssue('authoringMissingField', 'Split column steps require a delimiter string.', `${path}.delimiter`));
      }

      if (
        !outputColumns
        || issues.some((issue) =>
          issue.path === `${path}.columnId`
          || issue.path === `${path}.delimiter`)
      ) {
        return null;
      }

      return {
        type: 'splitColumn',
        columnId: step.columnId,
        delimiter: step.delimiter,
        outputColumns,
      };
    }

    case 'combineColumns': {
      const columnIds = compileStringArray(step.columnIds, `${path}.columnIds`, issues);
      const newColumn = compileNewColumn(step.newColumn, `${path}.newColumn`, issues);

      if (typeof step.separator !== 'string') {
        issues.push(makeIssue('authoringMissingField', 'Combine columns steps require a separator string.', `${path}.separator`));
      }

      return columnIds && newColumn && typeof step.separator === 'string'
        ? {
            type: 'combineColumns',
            columnIds,
            separator: step.separator,
            newColumn,
          }
        : null;
    }

    case 'deduplicateRows': {
      const columnIds = compileStringArray(step.columnIds, `${path}.columnIds`, issues);

      return columnIds
        ? {
            type: 'deduplicateRows',
            columnIds,
          }
        : null;
    }

    case 'sortRows': {
      const sorts = compileSorts(step.sorts, `${path}.sorts`, issues);

      return sorts
        ? {
            type: 'sortRows',
            sorts,
          }
        : null;
    }

    default:
      issues.push(makeIssue('authoringUnsupportedStepType', `Unsupported authoring step type '${String(step.type)}'.`, `${path}.type`));
      return null;
  }
}

function compileScopedRuleCases(casesInput: unknown, path: string, issues: AIDraftIssue[]) {
  if (casesInput === undefined) {
    return undefined;
  }

  if (!Array.isArray(casesInput)) {
    issues.push(makeIssue('authoringType', 'Scoped rule cases must be an array.', path));
    return null;
  }

  const compiledCases: Array<{
    when: WorkflowExpression;
    then: WorkflowCellPatch;
  }> = [];

  casesInput.forEach((ruleCase, index) => {
    const casePath = `${path}[${index}]`;

    if (!isRecord(ruleCase)) {
      issues.push(makeIssue('authoringType', 'Each scoped rule case must be an object.', casePath));
      return;
    }

    const when = compileBooleanExpression(ruleCase.when, `${casePath}.when`, { allowValue: true, allowCaseValue: false }, issues);
    const then = compileCellPatch(ruleCase.then, `${casePath}.then`, { allowValue: true, allowCaseValue: false }, issues);

    if (when && then) {
      compiledCases.push({
        when,
        then,
      });
    }
  });

  return compiledCases;
}

function compileCellPatch(
  patch: unknown,
  path: string,
  scope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowCellPatch | null {
  if (!isRecord(patch)) {
    issues.push(makeIssue('authoringType', 'Cell patches must be objects.', path));
    return null;
  }

  const compiledPatch: WorkflowCellPatch = {};

  if ('value' in patch && patch.value !== undefined) {
    const value = compileValueInput(patch.value, `${path}.value`, scope, issues);

    if (value) {
      compiledPatch.value = value;
    }
  }

  if ('format' in patch && patch.format !== undefined) {
    if (!isRecord(patch.format)) {
      issues.push(makeIssue('authoringType', 'Cell patch format must be an object.', `${path}.format`));
    } else if ('fillColor' in patch.format && patch.format.fillColor !== undefined) {
      if (typeof patch.format.fillColor !== 'string') {
        issues.push(makeIssue('authoringType', 'Cell patch format.fillColor must be a string.', `${path}.format.fillColor`));
      } else {
        compiledPatch.format = {
          fillColor: patch.format.fillColor,
        };
      }
    }
  }

  if (!compiledPatch.value && !compiledPatch.format) {
    issues.push(makeIssue('authoringMissingField', 'Cell patches must include value and/or format.fillColor.', path));
    return null;
  }

  return compiledPatch;
}

function compileValueInput(
  input: unknown,
  path: string,
  scope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowExpression | null {
  if (!isRecord(input)) {
    issues.push(makeIssue('authoringType', 'Value expressions must be objects.', path));
    return null;
  }

  if ('source' in input) {
    return compileOperand(input as AuthoringOperand, path, scope, issues);
  }

  if ('kind' in input) {
    return compileValueExpression(input as AuthoringValueExpression, path, scope, issues);
  }

  issues.push(makeIssue('authoringType', 'Value expressions must use a supported authoring operand or expression shape.', path));
  return null;
}

function compileOperand(
  operand: AuthoringOperand,
  path: string,
  scope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowExpression | null {
  switch (operand.source) {
    case 'column':
      if (typeof operand.columnId !== 'string' || operand.columnId.trim() === '') {
        issues.push(makeIssue('authoringMissingField', 'Column operands require a non-empty columnId.', `${path}.columnId`));
        return null;
      }
      return {
        kind: 'column',
        columnId: operand.columnId,
      };

    case 'value':
      if (!scope.allowValue) {
        issues.push(makeIssue('authoringInvalidContext', 'Use { "source": "value" } only inside scopedRule conditions and cell patches.', path));
        return null;
      }
      return { kind: 'value' };

    case 'caseValue':
      if (!scope.allowCaseValue) {
        issues.push(makeIssue('authoringInvalidContext', 'Use { "source": "caseValue" } only inside match case conditions.', path));
        return null;
      }
      return { kind: 'caseValue' };

    case 'literal':
      return {
        kind: 'literal',
        value: normalizeLiteralValue(operand.value),
      };

    default:
      issues.push(makeIssue('authoringInvalidOperandSource', `Unsupported authoring operand source '${String((operand as { source?: unknown }).source)}'.`, `${path}.source`));
      return null;
  }
}

function compileValueExpression(
  expression: AuthoringValueExpression,
  path: string,
  scope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowExpression | null {
  switch (expression.kind) {
    case 'nullary':
      return call('now');

    case 'unary': {
      if (!DIRECT_UNARY_FUNCTION_NAMES.has(expression.op as WorkflowExpressionFunctionName)) {
        issues.push(makeIssue('authoringUnsupportedOp', `Unsupported unary value op '${String(expression.op)}'.`, `${path}.op`));
        return null;
      }
      const input = compileValueInput(expression.input, `${path}.input`, scope, issues);

      return input ? call(expression.op, input) : null;
    }

    case 'binary': {
      if (!DIRECT_BINARY_FUNCTION_NAMES.has(expression.op as WorkflowExpressionFunctionName)) {
        issues.push(makeIssue('authoringUnsupportedOp', `Unsupported binary value op '${String(expression.op)}'.`, `${path}.op`));
        return null;
      }
      const left = compileValueInput(expression.left, `${path}.left`, scope, issues);
      const right = compileValueInput(expression.right, `${path}.right`, scope, issues);

      return left && right ? call(expression.op, left, right) : null;
    }

    case 'ternary': {
      if (!DIRECT_TERNARY_FUNCTION_NAMES.has(expression.op as WorkflowExpressionFunctionName)) {
        issues.push(makeIssue('authoringUnsupportedOp', `Unsupported ternary value op '${String(expression.op)}'.`, `${path}.op`));
        return null;
      }
      const first = compileValueInput(expression.first, `${path}.first`, scope, issues);
      const second = compileValueInput(expression.second, `${path}.second`, scope, issues);
      const third = compileValueInput(expression.third, `${path}.third`, scope, issues);

      return first && second && third ? call(expression.op, first, second, third) : null;
    }

    case 'nary': {
      if (expression.op !== 'concat' && expression.op !== 'coalesce') {
        issues.push(makeIssue('authoringUnsupportedOp', `Unsupported n-ary value op '${String(expression.op)}'.`, `${path}.op`));
        return null;
      }
      if (!Array.isArray(expression.items) || expression.items.length === 0) {
        issues.push(makeIssue('authoringEmptyGroup', `Authoring ${expression.op} expressions require at least one item.`, `${path}.items`));
        return null;
      }

      const compiledItems = expression.items
        .map((item, index) => compileValueInput(item, `${path}.items[${index}]`, scope, issues))
        .filter((item): item is WorkflowExpression => item !== null);

      if (compiledItems.length !== expression.items.length) {
        return null;
      }

      if (expression.op === 'concat') {
        return call('concat', ...compiledItems);
      }

      return lowerCoalesce(compiledItems, `${path}.items`, issues);
    }

    case 'match': {
      const subject = compileValueInput(
        expression.subject,
        `${path}.subject`,
        { allowValue: false, allowCaseValue: false },
        issues,
      );
      const cases = compileMatchCases(expression.cases, `${path}.cases`, scope, issues);

      return subject && cases
        ? {
            kind: 'match',
            subject,
            cases,
          }
        : null;
    }

    default:
      issues.push(makeIssue('authoringType', `Unsupported authoring value expression kind '${String((expression as { kind?: unknown }).kind)}'.`, `${path}.kind`));
      return null;
  }
}

function compileMatchCases(
  casesInput: unknown,
  path: string,
  outerScope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowMatchCase[] | null {
  if (!Array.isArray(casesInput) || casesInput.length === 0) {
    issues.push(makeIssue('authoringInvalidMatch', 'Match expressions require a non-empty cases array.', path));
    return null;
  }

  let otherwiseCount = 0;
  const compiledCases: WorkflowMatchCase[] = [];

  casesInput.forEach((caseInput, index) => {
    const casePath = `${path}[${index}]`;

    if (!isRecord(caseInput)) {
      issues.push(makeIssue('authoringType', 'Each match case must be an object.', casePath));
      return;
    }

    switch (caseInput.kind) {
      case 'when': {
        if (otherwiseCount > 0) {
          issues.push(makeIssue('authoringInvalidMatch', 'Otherwise cases must be last.', casePath));
        }
        const when = compileBooleanExpression(
          caseInput.when,
          `${casePath}.when`,
          {
            allowValue: outerScope.allowValue,
            allowCaseValue: true,
          },
          issues,
        );
        const then = compileValueInput(
          caseInput.then,
          `${casePath}.then`,
          {
            allowValue: outerScope.allowValue,
            allowCaseValue: false,
          },
          issues,
        );

        if (when && then) {
          compiledCases.push({
            kind: 'when',
            when,
            then,
          });
        }
        break;
      }

      case 'otherwise': {
        otherwiseCount += 1;

        if (otherwiseCount > 1) {
          issues.push(makeIssue('authoringInvalidMatch', 'Match expressions may include at most one otherwise case.', casePath));
        }
        if (index !== casesInput.length - 1) {
          issues.push(makeIssue('authoringInvalidMatch', 'Otherwise cases must be last.', casePath));
        }

        const then = compileValueInput(
          caseInput.then,
          `${casePath}.then`,
          {
            allowValue: outerScope.allowValue,
            allowCaseValue: false,
          },
          issues,
        );

        if (then) {
          compiledCases.push({
            kind: 'otherwise',
            then,
          });
        }
        break;
      }

      default:
        issues.push(makeIssue('authoringInvalidMatch', `Unsupported match case kind '${String(caseInput.kind)}'.`, `${casePath}.kind`));
        break;
    }
  });

  return compiledCases;
}

function compileBooleanExpression(
  expression: unknown,
  path: string,
  scope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowExpression | null {
  if (!isRecord(expression)) {
    issues.push(makeIssue('authoringType', 'Boolean expressions must be objects.', path));
    return null;
  }

  switch (expression.kind) {
    case 'predicate': {
      if (expression.op !== 'isEmpty') {
        issues.push(makeIssue('authoringUnsupportedOp', `Unsupported predicate op '${String(expression.op)}'.`, `${path}.op`));
        return null;
      }
      const input = compileValueInput(expression.input, `${path}.input`, scope, issues);

      return input ? call('isEmpty', input) : null;
    }

    case 'compare': {
      return compileCompareExpression(expression as AuthoringBooleanExpression & { kind: 'compare' }, path, scope, issues);
    }

    case 'between': {
      const input = compileValueInput(expression.input, `${path}.input`, scope, issues);
      const min = compileValueInput(expression.min, `${path}.min`, scope, issues);
      const max = compileValueInput(expression.max, `${path}.max`, scope, issues);

      if (typeof expression.inclusiveMin !== 'boolean') {
        issues.push(makeIssue('authoringInvalidBetween', 'Between expressions require inclusiveMin to be a boolean.', `${path}.inclusiveMin`));
      }
      if (typeof expression.inclusiveMax !== 'boolean') {
        issues.push(makeIssue('authoringInvalidBetween', 'Between expressions require inclusiveMax to be a boolean.', `${path}.inclusiveMax`));
      }

      if (!input || !min || !max || typeof expression.inclusiveMin !== 'boolean' || typeof expression.inclusiveMax !== 'boolean') {
        return null;
      }

      const lowerBound = expression.inclusiveMin
        ? call('or', call('greaterThan', input, min), call('equals', input, min))
        : call('greaterThan', input, min);
      const upperBound = expression.inclusiveMax
        ? call('or', call('lessThan', input, max), call('equals', input, max))
        : call('lessThan', input, max);

      return call('and', lowerBound, upperBound);
    }

    case 'boolean': {
      if (expression.op === 'not') {
        const item = compileBooleanExpression(expression.item, `${path}.item`, scope, issues);
        return item ? call('not', item) : null;
      }

      if (expression.op !== 'and' && expression.op !== 'or') {
        issues.push(makeIssue('authoringUnsupportedOp', `Unsupported boolean group op '${String(expression.op)}'.`, `${path}.op`));
        return null;
      }
      if (!Array.isArray(expression.items) || expression.items.length === 0) {
        issues.push(makeIssue('authoringEmptyGroup', `Boolean ${expression.op} groups require at least one item.`, `${path}.items`));
        return null;
      }

      const compiledItems = expression.items
        .map((item, index) => compileBooleanExpression(item, `${path}.items[${index}]`, scope, issues))
        .filter((item): item is WorkflowExpression => item !== null);

      if (compiledItems.length !== expression.items.length) {
        return null;
      }

      return call(expression.op, ...compiledItems);
    }

    default:
      issues.push(makeIssue('authoringType', `Unsupported authoring boolean expression kind '${String(expression.kind)}'.`, `${path}.kind`));
      return null;
  }
}

function compileCompareExpression(
  expression: Extract<AuthoringBooleanExpression, { kind: 'compare' }>,
  path: string,
  scope: CompileExpressionScope,
  issues: AIDraftIssue[],
): WorkflowExpression | null {
  const left = compileValueInput(expression.left, `${path}.left`, scope, issues);
  const right = compileValueInput(expression.right, `${path}.right`, scope, issues);

  if (!left || !right) {
    return null;
  }

  if (expression.op === 'gte') {
    return call(
      'or',
      call('greaterThan', left, right),
      call('equals', left, right),
    );
  }

  if (expression.op === 'lte') {
    return call(
      'or',
      call('lessThan', left, right),
      call('equals', left, right),
    );
  }

  const functionName = DIRECT_COMPARE_FUNCTION_NAMES[expression.op as keyof typeof DIRECT_COMPARE_FUNCTION_NAMES];

  if (!functionName) {
    issues.push(makeIssue('authoringUnsupportedOp', `Unsupported compare op '${String(expression.op)}'.`, `${path}.op`));
    return null;
  }

  return call(functionName, left, right);
}

function lowerCoalesce(
  items: WorkflowExpression[],
  path: string,
  issues: AIDraftIssue[],
): WorkflowExpression | null {
  if (items.length === 0) {
    issues.push(makeIssue('authoringEmptyGroup', 'Authoring coalesce expressions require at least one item.', path));
    return null;
  }

  if (items.length === 1) {
    return items[0];
  }

  return items.slice(1).reduce<WorkflowExpression>(
    (current, item) => call('coalesce', current, item),
    items[0],
  );
}

function compileNewColumn(value: unknown, path: string, issues: AIDraftIssue[]) {
  if (!isRecord(value)) {
    issues.push(makeIssue('authoringType', 'New column definitions must be objects.', path));
    return null;
  }

  if (typeof value.columnId !== 'string' || value.columnId.trim() === '') {
    issues.push(makeIssue('authoringMissingField', 'New columns require a non-empty columnId.', `${path}.columnId`));
  }
  if (typeof value.displayName !== 'string' || value.displayName.trim() === '') {
    issues.push(makeIssue('authoringMissingField', 'New columns require a non-empty displayName.', `${path}.displayName`));
  }

  return typeof value.columnId === 'string' && value.columnId.trim() !== '' && typeof value.displayName === 'string' && value.displayName.trim() !== ''
    ? {
        columnId: value.columnId,
        displayName: value.displayName,
      }
    : null;
}

function compileNewColumnArray(value: unknown, path: string, issues: AIDraftIssue[]) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(makeIssue('authoringType', 'Output columns must be a non-empty array.', path));
    return null;
  }

  const compiled = value
    .map((column, index) => compileNewColumn(column, `${path}[${index}]`, issues))
    .filter((column): column is NonNullable<ReturnType<typeof compileNewColumn>> => column !== null);

  return compiled.length === value.length ? compiled : null;
}

function compileSorts(value: unknown, path: string, issues: AIDraftIssue[]) {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(makeIssue('authoringType', 'Sort rows steps require a non-empty sorts array.', path));
    return null;
  }

  const compiled = value
    .map((sort, index) => {
      const sortPath = `${path}[${index}]`;

      if (!isRecord(sort)) {
        issues.push(makeIssue('authoringType', 'Each sort must be an object.', sortPath));
        return null;
      }

      if (typeof sort.columnId !== 'string' || sort.columnId.trim() === '') {
        issues.push(makeIssue('authoringMissingField', 'Each sort requires a non-empty columnId.', `${sortPath}.columnId`));
        return null;
      }
      if (sort.direction !== 'asc' && sort.direction !== 'desc') {
        issues.push(makeIssue('authoringType', 'Each sort direction must be "asc" or "desc".', `${sortPath}.direction`));
        return null;
      }

      return {
        columnId: sort.columnId,
        direction: sort.direction,
      };
    })
    .filter((sort): sort is { columnId: string; direction: 'asc' | 'desc' } => sort !== null);

  return compiled.length === value.length ? compiled : null;
}

function compileStringArray(value: unknown, path: string, issues: AIDraftIssue[]) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    issues.push(makeIssue('authoringType', 'Expected a non-empty string array.', path));
    return null;
  }

  return value;
}

function call(name: WorkflowExpressionFunctionName, ...args: WorkflowExpression[]): WorkflowCallExpression {
  return {
    kind: 'call',
    name,
    args,
  };
}

function normalizeLiteralValue(value: unknown) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function makeIssue(code: string, message: string, path: string): AIDraftIssue {
  return {
    code,
    severity: 'error',
    message,
    path,
    phase: 'authoring',
  };
}
