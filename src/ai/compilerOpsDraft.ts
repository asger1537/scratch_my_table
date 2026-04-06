import type { AIDraftIssue } from './authoringIr';
import type { WorkflowStepInput } from './types';
import type {
  WorkflowExpression,
  WorkflowExpressionFunctionName,
  WorkflowMatchCase,
} from '../workflow/types';

export interface GeminiCompilerOpsDraftResponse {
  mode: 'clarify' | 'draft';
  msg: string;
  ass: string[];
  ops: CompilerOpInput[];
}

export type CompilerOpInput =
  | FillEmptyFromColOpInput
  | ColorIfEmptyOpInput
  | DropColsOpInput
  | DeriveScoreBandsOpInput;

export interface FillEmptyFromColOpInput {
  op: 'fill_empty_from_col';
  dst: string;
  src: string;
}

export interface ColorIfEmptyOpInput {
  op: 'color_if_empty';
  col: string;
  color: string;
}

export interface DropColsOpInput {
  op: 'drop_cols';
  cols: string[];
}

export interface DeriveScoreBandsOpInput {
  op: 'derive_score_bands';
  src: string;
  out: {
    id: string;
    name: string;
  };
  bands: ScoreBandInput[];
}

export interface ScoreBandInput {
  lo: number | null;
  hi: number | null;
  loInc: boolean;
  hiInc: boolean;
  score: number;
}

interface CompileResult<T> {
  value: T | null;
  issues: AIDraftIssue[];
}

export function compileGeminiCompilerOpsDraft(
  ops: CompilerOpInput[],
): CompileResult<WorkflowStepInput[]> {
  const issues: AIDraftIssue[] = [];
  const steps: WorkflowStepInput[] = [];

  if (!Array.isArray(ops)) {
    return {
      value: null,
      issues: [
        makeIssue(
          'authoringType',
          'Gemini compiler ops must be an array.',
          'ops',
        ),
      ],
    };
  }

  ops.forEach((op, index) => {
    if (!isRecord(op)) {
      issues.push(
        makeIssue(
          'authoringType',
          'Each compiler op must be an object.',
          `ops[${index}]`,
        ),
      );
      return;
    }

    switch (op.op) {
      case 'fill_empty_from_col': {
        if (!isNonEmptyString(op.dst)) {
          issues.push(
            makeIssue(
              'authoringMissingField',
              'fill_empty_from_col requires dst.',
              `ops[${index}].dst`,
            ),
          );
          return;
        }

        if (!isNonEmptyString(op.src)) {
          issues.push(
            makeIssue(
              'authoringMissingField',
              'fill_empty_from_col requires src.',
              `ops[${index}].src`,
            ),
          );
          return;
        }

        steps.push({
          type: 'scopedRule',
          columnIds: [op.dst],
          cases: [
            {
              when: call('isEmpty', [valueExpr()]),
              then: {
                value: columnExpr(op.src),
              },
            },
          ],
        });
        return;
      }

      case 'color_if_empty': {
        if (!isNonEmptyString(op.col)) {
          issues.push(
            makeIssue(
              'authoringMissingField',
              'color_if_empty requires col.',
              `ops[${index}].col`,
            ),
          );
          return;
        }

        if (!isNonEmptyString(op.color)) {
          issues.push(
            makeIssue(
              'authoringMissingField',
              'color_if_empty requires color.',
              `ops[${index}].color`,
            ),
          );
          return;
        }

        steps.push({
          type: 'scopedRule',
          columnIds: [op.col],
          cases: [
            {
              when: call('isEmpty', [valueExpr()]),
              then: {
                format: {
                  fillColor: op.color,
                },
              },
            },
          ],
        });
        return;
      }

      case 'drop_cols': {
        if (
          !Array.isArray(op.cols)
          || op.cols.length === 0
          || op.cols.some((columnId) => !isNonEmptyString(columnId))
        ) {
          issues.push(
            makeIssue(
              'authoringType',
              'drop_cols requires a non-empty cols array.',
              `ops[${index}].cols`,
            ),
          );
          return;
        }

        steps.push({
          type: 'dropColumns',
          columnIds: op.cols,
        });
        return;
      }

      case 'derive_score_bands': {
        const compiled = compileDeriveScoreBandsOp(op, index);
        issues.push(...compiled.issues);

        if (compiled.value) {
          steps.push(compiled.value);
        }
        return;
      }

      default:
        issues.push(
          makeIssue(
            'authoringUnsupportedOp',
            `Unsupported compiler op '${String((op as { op?: unknown }).op ?? '')}'.`,
            `ops[${index}].op`,
          ),
        );
    }
  });

  return {
    value: issues.length === 0 ? steps : null,
    issues,
  };
}

function compileDeriveScoreBandsOp(
  op: DeriveScoreBandsOpInput,
  opIndex: number,
): CompileResult<WorkflowStepInput> {
  const issues: AIDraftIssue[] = [];

  if (!isNonEmptyString(op.src)) {
    issues.push(
      makeIssue(
        'authoringMissingField',
        'derive_score_bands requires src.',
        `ops[${opIndex}].src`,
      ),
    );
  }

  if (!isRecord(op.out)) {
    issues.push(
      makeIssue(
        'authoringMissingField',
        'derive_score_bands requires out.',
        `ops[${opIndex}].out`,
      ),
    );
  } else {
    if (!isNonEmptyString(op.out.id)) {
      issues.push(
        makeIssue(
          'authoringMissingField',
          'derive_score_bands requires out.id.',
          `ops[${opIndex}].out.id`,
        ),
      );
    }

    if (!isNonEmptyString(op.out.name)) {
      issues.push(
        makeIssue(
          'authoringMissingField',
          'derive_score_bands requires out.name.',
          `ops[${opIndex}].out.name`,
        ),
      );
    }
  }

  if (!Array.isArray(op.bands) || op.bands.length === 0) {
    issues.push(
      makeIssue(
        'authoringInvalidMatch',
        'derive_score_bands requires a non-empty bands array.',
        `ops[${opIndex}].bands`,
      ),
    );
    return { value: null, issues };
  }

  const cases: WorkflowMatchCase[] = [];
  let sawOtherwise = false;

  op.bands.forEach((band, bandIndex) => {
    if (!isRecord(band)) {
      issues.push(
        makeIssue(
          'authoringType',
          'Each score band must be an object.',
          `ops[${opIndex}].bands[${bandIndex}]`,
        ),
      );
      return;
    }

    issues.push(...validateBand(band as ScoreBandInput, opIndex, bandIndex));
    const compiledCase = compileBandToMatchCase(
      band as ScoreBandInput,
      opIndex,
      bandIndex,
      sawOtherwise,
      bandIndex === op.bands.length - 1,
    );
    issues.push(...compiledCase.issues);

    if (!compiledCase.value) {
      return;
    }

    if (compiledCase.value.kind === 'otherwise') {
      sawOtherwise = true;
    }

    cases.push(compiledCase.value);
  });

  if (
    issues.length > 0
    || !isNonEmptyString(op.src)
    || !isRecord(op.out)
    || !isNonEmptyString(op.out.id)
    || !isNonEmptyString(op.out.name)
  ) {
    return { value: null, issues };
  }

  return {
    value: {
      type: 'deriveColumn',
      newColumn: {
        columnId: op.out.id,
        displayName: op.out.name,
      },
      expression: {
        kind: 'match',
        subject: call('toNumber', [columnExpr(op.src)]),
        cases,
      },
    },
    issues,
  };
}

function validateBand(
  band: ScoreBandInput,
  opIndex: number,
  bandIndex: number,
) {
  const issues: AIDraftIssue[] = [];
  const basePath = `ops[${opIndex}].bands[${bandIndex}]`;

  if (band.lo !== null && typeof band.lo !== 'number') {
    issues.push(makeIssue('authoringType', 'Band lo must be number or null.', `${basePath}.lo`));
  }

  if (band.hi !== null && typeof band.hi !== 'number') {
    issues.push(makeIssue('authoringType', 'Band hi must be number or null.', `${basePath}.hi`));
  }

  if (typeof band.loInc !== 'boolean') {
    issues.push(makeIssue('authoringType', 'Band loInc must be boolean.', `${basePath}.loInc`));
  }

  if (typeof band.hiInc !== 'boolean') {
    issues.push(makeIssue('authoringType', 'Band hiInc must be boolean.', `${basePath}.hiInc`));
  }

  if (typeof band.score !== 'number' || !Number.isFinite(band.score)) {
    issues.push(makeIssue('authoringType', 'Band score must be a finite number.', `${basePath}.score`));
  }

  if (typeof band.lo === 'number' && typeof band.hi === 'number') {
    if (band.lo > band.hi) {
      issues.push(makeIssue('authoringInvalidBetween', 'Band lo cannot be greater than hi.', basePath));
    }

    if (band.lo === band.hi && (!band.loInc || !band.hiInc)) {
      issues.push(
        makeIssue(
          'authoringInvalidBetween',
          'Equal band bounds require loInc and hiInc to both be true.',
          basePath,
        ),
      );
    }
  }

  return issues;
}

function compileBandToMatchCase(
  band: ScoreBandInput,
  opIndex: number,
  bandIndex: number,
  sawOtherwise: boolean,
  isLastBand: boolean,
): CompileResult<WorkflowMatchCase> {
  const issues: AIDraftIssue[] = [];
  const lowerCondition = buildLowerBoundCondition(band.lo, band.loInc);
  const upperCondition = buildUpperBoundCondition(band.hi, band.hiInc);
  const thenExpression = literalExpr(band.score);
  const bandPath = `ops[${opIndex}].bands[${bandIndex}]`;

  if (!lowerCondition && !upperCondition) {
    if (sawOtherwise) {
      issues.push(
        makeIssue(
          'authoringInvalidMatch',
          'Only one fully-open fallback band is allowed.',
          bandPath,
        ),
      );
      return { value: null, issues };
    }

    if (!isLastBand) {
      issues.push(
        makeIssue(
          'authoringInvalidMatch',
          'A fully-open fallback band must be last.',
          bandPath,
        ),
      );
      return { value: null, issues };
    }

    return {
      value: {
        kind: 'otherwise',
        then: thenExpression,
      },
      issues,
    };
  }

  if (sawOtherwise) {
    issues.push(
      makeIssue(
        'authoringInvalidMatch',
        'Bands cannot appear after a fallback band.',
        bandPath,
      ),
    );
    return { value: null, issues };
  }

  const conditions = [lowerCondition, upperCondition].filter(
    (condition): condition is WorkflowExpression => Boolean(condition),
  );

  if (conditions.length === 0) {
    issues.push(
      makeIssue(
        'authoringInvalidBetween',
        'Band must include at least one valid bound.',
        bandPath,
      ),
    );
    return { value: null, issues };
  }

  return {
    value: {
      kind: 'when',
      when: conditions.length === 1 ? conditions[0] : call('and', conditions),
      then: thenExpression,
    },
    issues,
  };
}

function buildLowerBoundCondition(lowerBound: number | null, inclusive: boolean) {
  if (lowerBound === null) {
    return null;
  }

  const strict = call('greaterThan', [caseValueExpr(), literalExpr(lowerBound)]);

  if (!inclusive) {
    return strict;
  }

  return call('or', [
    strict,
    call('equals', [caseValueExpr(), literalExpr(lowerBound)]),
  ]);
}

function buildUpperBoundCondition(upperBound: number | null, inclusive: boolean) {
  if (upperBound === null) {
    return null;
  }

  const strict = call('lessThan', [caseValueExpr(), literalExpr(upperBound)]);

  if (!inclusive) {
    return strict;
  }

  return call('or', [
    strict,
    call('equals', [caseValueExpr(), literalExpr(upperBound)]),
  ]);
}

function columnExpr(columnId: string): WorkflowExpression {
  return {
    kind: 'column',
    columnId,
  };
}

function valueExpr(): WorkflowExpression {
  return {
    kind: 'value',
  };
}

function caseValueExpr(): WorkflowExpression {
  return {
    kind: 'caseValue',
  };
}

function literalExpr(value: string | number | boolean | null): WorkflowExpression {
  return {
    kind: 'literal',
    value,
  };
}

function call(
  name: WorkflowExpressionFunctionName,
  args: WorkflowExpression[],
): WorkflowExpression {
  return {
    kind: 'call',
    name,
    args,
  };
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

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
