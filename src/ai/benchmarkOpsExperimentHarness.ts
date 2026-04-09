import { readFile, writeFile } from 'node:fs/promises';

import type { Table } from '../domain/model';
import { validateWorkflowSemantics, validateWorkflowStructure, type Workflow } from '../workflow';

import type { GeminiRequestExport } from './gemini';
import {
  assignWorkflowStepIds,
  buildGeminiRequestExport,
  compileAuthoringDraft,
  parseGeminiAuthoringResponse,
  type AIPromptContext,
  type AISettings,
  type AIMessage,
} from './index';
import {
  BENCHMARKS,
  compact,
  extractCandidateText,
  extractResponseErrorMessage,
  loadBenchmarkTable,
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
  schemaPath?: string;
  reportPath: string;
  includeAssistantPrefill?: boolean;
  includeCuratedExamples?: boolean;
  disableStructuredOutput?: boolean;
}

export async function executeBenchmarkOpsExperiment(config: BenchmarkOpsExperimentConfig) {
  const apiKey = await readGeminiApiKey();
  const tablesByBenchmark = Object.fromEntries(
    await Promise.all(
      BENCHMARKS.map(async (benchmark) => [benchmark.id, await loadBenchmarkTable(benchmark.id)] as const),
    ),
  ) as Record<(typeof BENCHMARKS)[number]['id'], Table>;
  const schema = config.schemaPath
    ? (JSON.parse(await readFile(config.schemaPath, 'utf8')) as Record<string, unknown>)
    : null;
  const requestExports = Object.fromEntries(
    BENCHMARKS.map((benchmark) => [
      benchmark.id,
      buildBenchmarkRequest({
        apiKey,
        benchmarkId: benchmark.id,
        prompt: benchmark.prompt,
        table: tablesByBenchmark[benchmark.id],
        schema,
        includeAssistantPrefill: config.includeAssistantPrefill ?? true,
        includeCuratedExamples: config.includeCuratedExamples ?? true,
        disableStructuredOutput: config.disableStructuredOutput ?? false,
      }),
    ]),
  ) as Record<(typeof BENCHMARKS)[number]['id'], GeminiRequestExport>;
  const results: BenchmarkOpsExperimentResult[] = [];

  for (const benchmark of BENCHMARKS) {
    for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
      results.push(
        await runBenchmarkIteration({
          apiKey,
          table: tablesByBenchmark[benchmark.id],
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
      schemaPath: config.schemaPath ?? '(none)',
      schema,
      requestExports,
      results,
      includeAssistantPrefill: config.includeAssistantPrefill ?? true,
      includeCuratedExamples: config.includeCuratedExamples ?? true,
      disableStructuredOutput: config.disableStructuredOutput ?? false,
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
  requestExport: GeminiRequestExport;
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
      const parsed = parseGeminiAuthoringResponse(rawText);

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

      const compiled = compileAuthoringDraft(parsed.steps);

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
        workflowId: `wf_${input.benchmarkId}_authoring_ir_experiment`,
        name: `Authoring IR ${input.benchmarkId}`,
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
        issueSummary: error instanceof Error ? error.message : 'Failed to parse authoring response.',
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

function buildBenchmarkRequest(input: {
  apiKey: string;
  benchmarkId: (typeof BENCHMARKS)[number]['id'];
  prompt: string;
  table: Table;
  schema: Record<string, unknown> | null;
  includeAssistantPrefill: boolean;
  includeCuratedExamples: boolean;
  disableStructuredOutput: boolean;
}): GeminiRequestExport {
  const baseContext: AIPromptContext = {
    table: input.table,
    workflow: {
      version: 2,
      workflowId: `wf_${input.benchmarkId}_benchmark`,
      name: `Benchmark ${input.benchmarkId}`,
      steps: [],
    },
    draft: null,
    messages: [],
    currentIssues: [],
    workflowContextSource: 'current',
    workspacePromptSnapshot: '',
  };

  const prefillMessages = input.includeAssistantPrefill
    ? buildAssistantPrefillMessages(input.benchmarkId, input.prompt)
    : [];

  const requestExport = buildGeminiRequestExport(
    {
      settings: {
        apiKey: input.apiKey,
        model: MODEL,
        thinkingEnabled: false,
      } satisfies AISettings,
      context: {
        ...baseContext,
        messages: prefillMessages,
      },
      userMessage: createMessage('user', input.prompt),
      phase: 'initial',
    },
    {
      ...(input.schema ? { responseJsonSchema: input.schema } : {}),
      promptOptions: {
        includeCuratedExamples: input.includeCuratedExamples,
      },
    },
  );

  if (input.disableStructuredOutput) {
    const generationConfig = requestExport.requestBody.generationConfig as unknown as Record<string, unknown>;
    delete generationConfig.responseJsonSchema;
    delete generationConfig.responseMimeType;
  }

  return requestExport;
}

function buildAssistantPrefillMessages(
  benchmarkId: (typeof BENCHMARKS)[number]['id'],
  prompt: string,
): AIMessage[] {
  return [
    createMessage('user', prompt),
    createMessage('assistant', getAssistantPrefill(benchmarkId)),
  ];
}

function getAssistantPrefill(benchmarkId: (typeof BENCHMARKS)[number]['id']) {
  switch (benchmarkId) {
    case 'email_fallback_red':
      return 'I will fill Email from Email (2) when needed, color any still-empty Email cells red, and then drop Email (2).';
    case 'priority_score':
      return 'I will create a priority score column from Balance using ordered match cases on the numeric balance.';
    case 'contact_tier_pipeline':
      return 'I will normalize the email and phone columns, derive contact and tier columns with match logic, drop helper columns when they are no longer needed, and filter to customers with a usable contact method.';
  }
}

function buildReport(input: {
  experimentTitle: string;
  schemaPath: string;
  schema: Record<string, unknown> | null;
  requestExports: Record<string, GeminiRequestExport>;
  results: BenchmarkOpsExperimentResult[];
  includeAssistantPrefill: boolean;
  includeCuratedExamples: boolean;
  disableStructuredOutput: boolean;
}) {
  const schemaText = input.schema ? `${JSON.stringify(input.schema, null, 2)}\n` : '';
  const lines = [
    `# ${input.experimentTitle} Report`,
    '',
    `Generated at: \`${new Date().toISOString()}\``,
    '',
    '## Configuration',
    '',
    '- Request style: `authoring IR via production request builder`',
    `- Model: \`${MODEL}\``,
    '- Thinking: `disabled`',
    '- Temperature: `0`',
    `- Iterations per benchmark: \`${ITERATIONS}\``,
    `- Assistant prefill: \`${String(input.includeAssistantPrefill)}\``,
    `- Curated examples: \`${String(input.includeCuratedExamples)}\``,
    `- Structured output: \`${input.disableStructuredOutput ? 'disabled' : 'enabled'}\``,
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

  if (input.schema) {
    lines.push('## Schema Snapshot', '', '```json', schemaText.trimEnd(), '```', '');
  } else {
    lines.push('## Schema Snapshot', '', '(none)', '');
  }

  return `${lines.join('\n')}\n`;
}

function createMessage(role: AIMessage['role'], text: string): AIMessage {
  return {
    role,
    text,
    timestamp: new Date().toISOString(),
  };
}

function countStatus(results: BenchmarkOpsExperimentResult[], status: BenchmarkOpsStatus) {
  return results.filter((result) => result.status === status).length;
}

function escapeTable(value: string) {
  return value.replace(/\|/g, '\\|');
}
