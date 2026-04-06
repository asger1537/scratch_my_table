import { readFile, writeFile } from 'node:fs/promises';

import type { Table } from '../domain/model';
import {
  validateWorkflowSemantics,
  validateWorkflowStructure,
  type Workflow,
  type WorkflowExpression,
} from '../workflow';
import type { WorkflowExpressionFunctionName, WorkflowMatchCase } from '../workflow/types';

import { assignWorkflowStepIds } from './index';
import type { WorkflowStepInput } from './types';
import {
  BENCHMARKS,
  compact,
  extractCandidateText,
  extractResponseErrorMessage,
  loadCustomersMessyTable,
  readGeminiApiKey,
} from './experimentHarness';

const ITERATIONS = 5;
const MODEL = 'gemini-3.1-flash-lite-preview';

export type BenchmarkOpsStatus =
  | 'valid_draft'
  | 'clarify'
  | 'request_error'
  | 'parse_error'
  | 'compile_failed'
  | 'structural_failed'
  | 'semantic_failed';

export interface BenchmarkOpsExperimentResult {
  benchmarkId: string;
  iteration: number;
  status: BenchmarkOpsStatus;
  mode?: 'clarify' | 'draft';
  issueSummary?: string;
  rawTextPreview?: string;
}

export interface BenchmarkOpsExperimentConfig {
  experimentTitle: string;
  schemaPath: string;
  reportPath: string;
  includeAssistantPrefill?: boolean;
  includeCuratedExamples?: boolean;
}

interface CompilerOpsDraftResponse {
  mode: 'clarify' | 'draft';
  msg: string;
  ass: string[];
  ops: CompilerOp[];
}

type CompilerOp =
  | FillEmptyFromColOp
  | ColorIfEmptyOp
  | DropColsOp
  | DeriveScoreBandsOp;

interface FillEmptyFromColOp {
  op: 'fill_empty_from_col';
  dst: string;
  src: string;
}

interface ColorIfEmptyOp {
  op: 'color_if_empty';
  col: string;
  color: string;
}

interface DropColsOp {
  op: 'drop_cols';
  cols: string[];
}

interface DeriveScoreBandsOp {
  op: 'derive_score_bands';
  src: string;
  out: {
    id: string;
    name: string;
  };
  bands: ScoreBand[];
}

interface ScoreBand {
  lo: number | null;
  hi: number | null;
  loInc: boolean;
  hiInc: boolean;
  score: number;
}

interface CompilerIssue {
  path: string;
  message: string;
}

interface FrozenRequestExport {
  requestUrl: string;
  systemInstructionText: string;
  contents: Array<{
    role: 'user' | 'model';
    parts: Array<{ text: string }>;
  }>;
  requestBody: Record<string, unknown>;
}

export async function executeBenchmarkOpsExperiment(config: BenchmarkOpsExperimentConfig) {
  const apiKey = await readGeminiApiKey();
  const table = await loadCustomersMessyTable();
  const schema = JSON.parse(await readFile(config.schemaPath, 'utf8')) as Record<string, unknown>;
  const requestExports = Object.fromEntries(
    BENCHMARKS.map((benchmark) => [
      benchmark.id,
      buildBenchmarkOpsRequest({
        benchmarkId: benchmark.id,
        prompt: benchmark.prompt,
        table,
        schema,
        includeAssistantPrefill: config.includeAssistantPrefill ?? true,
        includeCuratedExamples: config.includeCuratedExamples ?? true,
      }),
    ]),
  ) as Record<(typeof BENCHMARKS)[number]['id'], FrozenRequestExport>;
  const results: BenchmarkOpsExperimentResult[] = [];

  for (const benchmark of BENCHMARKS) {
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      results.push(
        await runBenchmarkIteration({
          apiKey,
          table,
          requestExport: requestExports[benchmark.id],
          benchmarkId: benchmark.id,
          iteration,
        }),
      );
    }
  }

  await writeFile(
    config.reportPath,
    buildReport({
      experimentTitle: config.experimentTitle,
      schemaPath: config.schemaPath,
      schema,
      requestExports,
      results,
      includeAssistantPrefill: config.includeAssistantPrefill ?? true,
      includeCuratedExamples: config.includeCuratedExamples ?? true,
    }),
    'utf8',
  );

  return {
    results,
    requestExports,
    schema,
  };
}

async function runBenchmarkIteration(input: {
  apiKey: string;
  table: Table;
  requestExport: FrozenRequestExport;
  benchmarkId: string;
  iteration: number;
}): Promise<BenchmarkOpsExperimentResult> {
  try {
    const response = await fetch(input.requestExport.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.apiKey,
      },
      body: JSON.stringify(input.requestExport.requestBody),
    });
    const rawResponseBody = await response.text();

    if (!response.ok) {
      return {
        benchmarkId: input.benchmarkId,
        iteration: input.iteration,
        status: 'request_error',
        issueSummary: `HTTP ${response.status}: ${extractResponseErrorMessage(rawResponseBody)}`,
      };
    }

    const rawText = extractCandidateText(rawResponseBody);

    try {
      const parsed = parseCompilerOpsResponse(rawText);

      if (parsed.mode !== 'draft') {
        return {
          benchmarkId: input.benchmarkId,
          iteration: input.iteration,
          status: 'clarify',
          mode: parsed.mode,
          rawTextPreview: compact(rawText),
          issueSummary: parsed.msg,
        };
      }

      const compiled = compileCompilerOpsDraft(parsed.ops);

      if (!compiled.value || compiled.issues.length > 0) {
        return {
          benchmarkId: input.benchmarkId,
          iteration: input.iteration,
          status: 'compile_failed',
          mode: parsed.mode,
          rawTextPreview: compact(rawText),
          issueSummary: compiled.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | '),
        };
      }

      const workflow: Workflow = {
        version: 2,
        workflowId: `wf_${input.benchmarkId}_compiler_ops_experiment`,
        name: `Compiler ops ${input.benchmarkId}`,
        steps: assignWorkflowStepIds(compiled.value),
      };
      const structural = validateWorkflowStructure(workflow);

      if (!structural.valid) {
        return {
          benchmarkId: input.benchmarkId,
          iteration: input.iteration,
          status: 'structural_failed',
          mode: parsed.mode,
          rawTextPreview: compact(rawText),
          issueSummary: structural.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | '),
        };
      }

      const semantic = validateWorkflowSemantics(workflow, input.table);

      if (!semantic.valid) {
        return {
          benchmarkId: input.benchmarkId,
          iteration: input.iteration,
          status: 'semantic_failed',
          mode: parsed.mode,
          rawTextPreview: compact(rawText),
          issueSummary: semantic.issues.map((issue) => `${issue.path}: ${issue.message}`).join(' | '),
        };
      }

      return {
        benchmarkId: input.benchmarkId,
        iteration: input.iteration,
        status: 'valid_draft',
        mode: parsed.mode,
        rawTextPreview: compact(rawText),
      };
    } catch (error) {
      return {
        benchmarkId: input.benchmarkId,
        iteration: input.iteration,
        status: 'parse_error',
        rawTextPreview: compact(rawText),
        issueSummary: error instanceof Error ? error.message : 'Failed to parse compiler-ops response.',
      };
    }
  } catch (error) {
    return {
      benchmarkId: input.benchmarkId,
      iteration: input.iteration,
      status: 'request_error',
      issueSummary: error instanceof Error ? error.message : 'Request failed.',
    };
  }
}

function parseCompilerOpsResponse(rawText: string): CompilerOpsDraftResponse {
  const parsed = JSON.parse(stripJsonCodeFence(rawText)) as Record<string, unknown>;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Response must be a JSON object.');
  }

  if (parsed.mode !== 'clarify' && parsed.mode !== 'draft') {
    throw new Error('Response must include mode "clarify" or "draft".');
  }

  if (typeof parsed.msg !== 'string' || parsed.msg.trim() === '') {
    throw new Error('Response must include a non-empty msg string.');
  }

  if (!Array.isArray(parsed.ass) || parsed.ass.some((value) => typeof value !== 'string')) {
    throw new Error('Response must include ass as a string array.');
  }

  if (!Array.isArray(parsed.ops) || parsed.ops.some((op) => !op || typeof op !== 'object' || Array.isArray(op))) {
    throw new Error('Response must include ops as an object array.');
  }

  if (parsed.mode === 'draft' && parsed.ops.length === 0) {
    throw new Error('Draft responses must include at least one op.');
  }

  return {
    mode: parsed.mode,
    msg: parsed.msg,
    ass: parsed.ass as string[],
    ops: parsed.ops as CompilerOp[],
  };
}

function compileCompilerOpsDraft(ops: CompilerOp[]): {
  value?: WorkflowStepInput[];
  issues: CompilerIssue[];
} {
  const issues: CompilerIssue[] = [];
  const steps: WorkflowStepInput[] = [];

  ops.forEach((op, index) => {
    if (!op || typeof op !== 'object' || Array.isArray(op)) {
      issues.push({
        path: `ops[${index}]`,
        message: 'Each op must be an object.',
      });
      return;
    }

    switch (op.op) {
      case 'fill_empty_from_col': {
        if (!isNonEmptyString(op.dst)) {
          issues.push({
            path: `ops[${index}].dst`,
            message: 'fill_empty_from_col requires a non-empty dst column id.',
          });
          return;
        }

        if (!isNonEmptyString(op.src)) {
          issues.push({
            path: `ops[${index}].src`,
            message: 'fill_empty_from_col requires a non-empty src column id.',
          });
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
          issues.push({
            path: `ops[${index}].col`,
            message: 'color_if_empty requires a non-empty col column id.',
          });
          return;
        }

        if (!isNonEmptyString(op.color)) {
          issues.push({
            path: `ops[${index}].color`,
            message: 'color_if_empty requires a non-empty color string.',
          });
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
        if (!Array.isArray(op.cols) || op.cols.length === 0 || op.cols.some((columnId) => !isNonEmptyString(columnId))) {
          issues.push({
            path: `ops[${index}].cols`,
            message: 'drop_cols requires a non-empty cols array of column ids.',
          });
          return;
        }

        steps.push({
          type: 'dropColumns',
          columnIds: op.cols,
        });
        return;
      }
      case 'derive_score_bands': {
        const compiledStep = compileDeriveScoreBandsOp(op, index);
        issues.push(...compiledStep.issues);

        if (compiledStep.value) {
          steps.push(compiledStep.value);
        }
        return;
      }
      default:
        issues.push({
          path: `ops[${index}].op`,
          message: `Unsupported op '${String((op as { op?: unknown }).op ?? '')}'.`,
        });
    }
  });

  if (issues.length > 0) {
    return { issues };
  }

  return {
    value: steps,
    issues: [],
  };
}

function compileDeriveScoreBandsOp(op: DeriveScoreBandsOp, opIndex: number): {
  value?: WorkflowStepInput;
  issues: CompilerIssue[];
} {
  const issues: CompilerIssue[] = [];

  if (!isNonEmptyString(op.src)) {
    issues.push({
      path: `ops[${opIndex}].src`,
      message: 'derive_score_bands requires a non-empty src column id.',
    });
  }

  if (!op.out || typeof op.out !== 'object' || Array.isArray(op.out)) {
    issues.push({
      path: `ops[${opIndex}].out`,
      message: 'derive_score_bands requires an out object.',
    });
  } else {
    if (!isNonEmptyString(op.out.id)) {
      issues.push({
        path: `ops[${opIndex}].out.id`,
        message: 'derive_score_bands requires out.id.',
      });
    }

    if (!isNonEmptyString(op.out.name)) {
      issues.push({
        path: `ops[${opIndex}].out.name`,
        message: 'derive_score_bands requires out.name.',
      });
    }
  }

  if (!Array.isArray(op.bands) || op.bands.length === 0) {
    issues.push({
      path: `ops[${opIndex}].bands`,
      message: 'derive_score_bands requires a non-empty bands array.',
    });
  }

  const cases: WorkflowMatchCase[] = [];

  if (Array.isArray(op.bands)) {
    let sawOtherwise = false;

    op.bands.forEach((band, bandIndex) => {
      if (!band || typeof band !== 'object' || Array.isArray(band)) {
        issues.push({
          path: `ops[${opIndex}].bands[${bandIndex}]`,
          message: 'Each band must be an object.',
        });
        return;
      }

      const bandIssues = validateBand(band, opIndex, bandIndex);
      issues.push(...bandIssues);

      if (bandIssues.length > 0) {
        return;
      }

      const caseResult = compileBandToMatchCase(band, opIndex, bandIndex);
      issues.push(...caseResult.issues);

      if (!caseResult.value) {
        return;
      }

      if (caseResult.value.kind === 'otherwise') {
        if (sawOtherwise) {
          issues.push({
            path: `ops[${opIndex}].bands[${bandIndex}]`,
            message: 'Only one fully open band is allowed.',
          });
          return;
        }

        if (bandIndex !== op.bands.length - 1) {
          issues.push({
            path: `ops[${opIndex}].bands[${bandIndex}]`,
            message: 'A fully open band must be last.',
          });
          return;
        }

        sawOtherwise = true;
      } else if (sawOtherwise) {
        issues.push({
          path: `ops[${opIndex}].bands[${bandIndex}]`,
          message: 'Bands cannot appear after a fully open fallback band.',
        });
        return;
      }

      cases.push(caseResult.value);
    });
  }

  if (issues.length > 0 || !isNonEmptyString(op.src) || !op.out || !isNonEmptyString(op.out.id) || !isNonEmptyString(op.out.name)) {
    return { issues };
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

function validateBand(band: ScoreBand, opIndex: number, bandIndex: number): CompilerIssue[] {
  const issues: CompilerIssue[] = [];
  const basePath = `ops[${opIndex}].bands[${bandIndex}]`;

  if (band.lo !== null && typeof band.lo !== 'number') {
    issues.push({
      path: `${basePath}.lo`,
      message: 'Band lo must be a number or null.',
    });
  }

  if (band.hi !== null && typeof band.hi !== 'number') {
    issues.push({
      path: `${basePath}.hi`,
      message: 'Band hi must be a number or null.',
    });
  }

  if (typeof band.loInc !== 'boolean') {
    issues.push({
      path: `${basePath}.loInc`,
      message: 'Band loInc must be boolean.',
    });
  }

  if (typeof band.hiInc !== 'boolean') {
    issues.push({
      path: `${basePath}.hiInc`,
      message: 'Band hiInc must be boolean.',
    });
  }

  if (typeof band.score !== 'number' || !Number.isFinite(band.score)) {
    issues.push({
      path: `${basePath}.score`,
      message: 'Band score must be a finite number.',
    });
  }

  if (typeof band.lo === 'number' && typeof band.hi === 'number') {
    if (band.lo > band.hi) {
      issues.push({
        path: basePath,
        message: 'Band lo cannot be greater than hi.',
      });
    }

    if (band.lo === band.hi && (!band.loInc || !band.hiInc)) {
      issues.push({
        path: basePath,
        message: 'Equal band bounds require both loInc and hiInc to be true.',
      });
    }
  }

  return issues;
}

function compileBandToMatchCase(
  band: ScoreBand,
  opIndex: number,
  bandIndex: number,
): {
  value?: WorkflowMatchCase;
  issues: CompilerIssue[];
} {
  const lowerCondition = buildLowerBoundCondition(band.lo, band.loInc);
  const upperCondition = buildUpperBoundCondition(band.hi, band.hiInc);
  const thenExpression = literalExpr(band.score);

  if (!lowerCondition && !upperCondition) {
    return {
      value: {
        kind: 'otherwise',
        then: thenExpression,
      },
      issues: [],
    };
  }

  const whenConditions = [lowerCondition, upperCondition].filter(
    (condition): condition is WorkflowExpression => Boolean(condition),
  );

  if (whenConditions.length === 0) {
    return {
      issues: [
        {
          path: `ops[${opIndex}].bands[${bandIndex}]`,
          message: 'Band must produce a valid lower or upper bound condition.',
        },
      ],
    };
  }

  return {
    value: {
      kind: 'when',
      when: whenConditions.length === 1 ? whenConditions[0] : call('and', whenConditions),
      then: thenExpression,
    },
    issues: [],
  };
}

function buildLowerBoundCondition(lowerBound: number | null, inclusive: boolean) {
  if (lowerBound === null) {
    return null;
  }

  const greaterThan = call('greaterThan', [caseValueExpr(), literalExpr(lowerBound)]);

  if (!inclusive) {
    return greaterThan;
  }

  return call('or', [
    greaterThan,
    call('equals', [caseValueExpr(), literalExpr(lowerBound)]),
  ]);
}

function buildUpperBoundCondition(upperBound: number | null, inclusive: boolean) {
  if (upperBound === null) {
    return null;
  }

  const lessThan = call('lessThan', [caseValueExpr(), literalExpr(upperBound)]);

  if (!inclusive) {
    return lessThan;
  }

  return call('or', [
    lessThan,
    call('equals', [caseValueExpr(), literalExpr(upperBound)]),
  ]);
}

function buildBenchmarkOpsRequest(input: {
  benchmarkId: (typeof BENCHMARKS)[number]['id'];
  prompt: string;
  table: Table;
  schema: Record<string, unknown>;
  includeAssistantPrefill: boolean;
  includeCuratedExamples: boolean;
}): FrozenRequestExport {
  const systemInstructionText = buildCompilerOpsSystemInstruction({
    table: input.table,
    includeCuratedExamples: input.includeCuratedExamples,
  });
  const assistantPrefill = input.includeAssistantPrefill
    ? input.benchmarkId === 'email_fallback_red'
      ? 'I will fill Email from Email (2) when needed, color any still-empty Email cells red, and then drop Email (2).'
      : 'I will create a priority score column from Balance using three ordered numeric bands.'
    : null;
  const contents: FrozenRequestExport['contents'] = [
    {
      role: 'user',
      parts: [{ text: input.prompt }],
    },
  ];

  if (assistantPrefill) {
    contents.push({
      role: 'model',
      parts: [{ text: assistantPrefill }],
    });
    contents.push({
      role: 'user',
      parts: [{ text: input.prompt }],
    });
  }

  return {
    requestUrl: `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    systemInstructionText,
    contents,
    requestBody: {
      systemInstruction: {
        parts: [{ text: systemInstructionText }],
      },
      contents,
      generationConfig: {
        responseMimeType: 'application/json',
        responseJsonSchema: input.schema,
        temperature: 0,
        maxOutputTokens: 2048,
        thinkingConfig: {
          thinkingLevel: 'minimal',
        },
      },
    },
  };
}

function buildCompilerOpsSystemInstruction(input: {
  table: Table;
  includeCuratedExamples: boolean;
}) {
  const columnLines = input.table.schema.columns
    .map((column) => `- ${column.columnId} | ${column.displayName} | ${column.logicalType}`)
    .join('\n');
  const curatedExamples = input.includeCuratedExamples
    ? `Curated examples:
Example 1 user: If Email is empty, use Email (2), then drop Email (2).
Example 1 response: {"mode":"draft","msg":"Use Email (2) only when Email is empty, then drop Email (2).","ass":[],"ops":[{"op":"fill_empty_from_col","dst":"col_email","src":"col_email_2"},{"op":"drop_cols","cols":["col_email_2"]}]}
Example 2 user: We just need one email column. Use Email first, fall back to Email (2), and if both are empty color the final email cell red.
Example 2 response: {"mode":"draft","msg":"Use Email (2) when Email is empty, color any still-empty Email cells red, then drop Email (2).","ass":[],"ops":[{"op":"fill_empty_from_col","dst":"col_email","src":"col_email_2"},{"op":"color_if_empty","col":"col_email","color":"#ffc7ce"},{"op":"drop_cols","cols":["col_email_2"]}]}
Example 3 user: If balance is negative set priority score to 3, if balance is 0 to 200 set it to 2, otherwise set it to 1.
Example 3 response: {"mode":"draft","msg":"Create a priority score from Balance using three numeric bands.","ass":[],"ops":[{"op":"derive_score_bands","src":"col_balance","out":{"id":"col_priority_score","name":"Priority Score"},"bands":[{"lo":null,"hi":0,"loInc":false,"hiInc":false,"score":3},{"lo":0,"hi":200,"loInc":true,"hiInc":true,"score":2},{"lo":200,"hi":null,"loInc":false,"hiInc":false,"score":1}]}]}
Example 4 user: Clean the name column.
Example 4 response: {"mode":"clarify","msg":"Which column should be cleaned, and what kind of cleanup do you want?","ass":[],"ops":[]}`
    : 'Curated examples:\n(none)';

  return `You are an expert Scratch My Table copilot.
Translate the user request into a tiny compiler-friendly operation list.
Return JSON only. Do not use markdown fences.
Do not return canonical workflow AST, authoring IR, or step IDs.
Return exactly one object with keys in this order: mode, msg, ass, ops.
Use mode "draft" when you can act. Use mode "clarify" only when a required choice is missing.
Return ops: [] only when mode is "clarify".

Compiler-op response contract:
- mode: "clarify" or "draft"
- msg: short natural-language summary
- ass: array of short strings
- ops: ordered compiler ops

Allowed compiler ops:
- fill_empty_from_col
  - Use when a destination column should keep its current value unless it is empty, then copy from a source column.
  - Shape order: { "op", "dst", "src" }
- color_if_empty
  - Use when a column should be colored if its final value is still empty.
  - Shape order: { "op", "col", "color" }
- drop_cols
  - Use to remove columns after earlier ops no longer need them.
  - Shape order: { "op", "cols" }
- derive_score_bands
  - Use to derive a numeric score column from one source column using ordered numeric bands.
  - This op always normalizes src with toNumber before applying bands.
  - Each band has { "lo", "hi", "loInc", "hiInc", "score" }.
  - null for lo means no lower bound. null for hi means no upper bound.
  - Shape order: { "op", "src", "out", "bands" }

Rules:
- Use column ids exactly as provided.
- Keep ops in the execution order they should run.
- Use only the allowed op names above.
- Keep property order aligned with the schema and examples.
- When the user wants one email column with fallback then red formatting, use fill_empty_from_col, then color_if_empty, then drop_cols.
- When the user wants a priority score from Balance, use derive_score_bands.

Schema currently available to the returned ops:
${columnLines}

Current workflow/editor issues:
- (none)

Current workflow steps without IDs:
[]

Current workflow summary:
- (empty workflow)

Current AI draft workflow steps without IDs:
(no draft yet)

${curatedExamples}`;
}

function buildReport(input: {
  experimentTitle: string;
  schemaPath: string;
  schema: Record<string, unknown>;
  requestExports: Record<string, FrozenRequestExport>;
  results: BenchmarkOpsExperimentResult[];
  includeAssistantPrefill: boolean;
  includeCuratedExamples: boolean;
}) {
  const schemaText = `${JSON.stringify(input.schema, null, 2)}\n`;
  const lines = [
    `# ${input.experimentTitle} Report`,
    '',
    `Generated at: \`${new Date().toISOString()}\``,
    '',
    '## Configuration',
    '',
    `- Request style: \`tiny compiler-op IR\``,
    `- Model: \`${MODEL}\``,
    `- Thinking level: \`minimal\``,
    `- Temperature: \`0\``,
    `- Iterations per benchmark: \`${ITERATIONS}\``,
    `- Assistant prefill: \`${String(input.includeAssistantPrefill)}\``,
    `- Curated examples: \`${String(input.includeCuratedExamples)}\``,
    `- Schema file: \`${input.schemaPath}\``,
    `- Schema size: \`${Buffer.byteLength(schemaText, 'utf8')}\` bytes`,
    '',
    '## Summary',
    '',
    '| Benchmark | Total | Valid | Clarify | Request error | Parse error | Compile failed | Structural failed | Semantic failed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  BENCHMARKS.forEach((benchmark) => {
    const results = input.results.filter((result) => result.benchmarkId === benchmark.id);
    lines.push(
      `| \`${benchmark.id}\` | ${results.length} | ${countStatus(results, 'valid_draft')} | ${countStatus(results, 'clarify')} | ${countStatus(results, 'request_error')} | ${countStatus(results, 'parse_error')} | ${countStatus(results, 'compile_failed')} | ${countStatus(results, 'structural_failed')} | ${countStatus(results, 'semantic_failed')} |`,
    );
  });

  lines.push('', '## Detailed Results', '');

  BENCHMARKS.forEach((benchmark) => {
    lines.push(`### ${benchmark.id}`, '', `Prompt: ${benchmark.prompt}`, '', '| Run | Status | Mode | Notes |', '| ---: | --- | --- | --- |');

    input.results
      .filter((result) => result.benchmarkId === benchmark.id)
      .forEach((result) => {
        lines.push(
          `| ${result.iteration} | \`${result.status}\` | ${result.mode ?? '-'} | ${escapeTable(result.issueSummary ?? result.rawTextPreview ?? '')} |`,
        );
      });

    const failedResults = input.results.filter(
      (result) => result.benchmarkId === benchmark.id && result.status !== 'valid_draft',
    );

    if (failedResults.length > 0) {
      lines.push('', 'Representative raw output previews:', '');

      failedResults.slice(0, 3).forEach((result) => {
        lines.push(`- Run ${result.iteration} (\`${result.status}\`): ${result.rawTextPreview ?? '(no raw text preview)'}`);
      });
    }

    lines.push('', 'Frozen request snapshot:', '', '```json', JSON.stringify(input.requestExports[benchmark.id], null, 2), '```', '');
  });

  lines.push('## Schema Snapshot', '', '```json', schemaText.trimEnd(), '```', '');

  return `${lines.join('\n')}\n`;
}

function stripJsonCodeFence(value: string) {
  const trimmed = value.trim();

  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }

  return trimmed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
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

function call(name: WorkflowExpressionFunctionName, args: WorkflowExpression[]): WorkflowExpression {
  return {
    kind: 'call',
    name,
    args,
  };
}

function countStatus(results: BenchmarkOpsExperimentResult[], status: BenchmarkOpsStatus) {
  return results.filter((result) => result.status === status).length;
}

function escapeTable(value: string) {
  return value.replace(/\|/g, '\\|');
}
