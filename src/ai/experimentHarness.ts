import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { getActiveTable, type Table } from '../domain/model';
import { importXlsxWorkbook } from '../domain/xlsx';
import { validateWorkflowSemantics, validateWorkflowStructure, type Workflow } from '../workflow';

import {
  assignWorkflowStepIds,
  buildGeminiRequestExport,
  compileGeminiCompilerOpsDraft,
  parseGeminiCompilerOpsResponse,
} from './index';

export const RUN_GEMINI_EXPERIMENTS = process.env.RUN_GEMINI_EXPERIMENTS === '1';
export const DEFAULT_EXPERIMENT_MODEL = 'gemini-3.1-flash-lite-preview';
export const DEFAULT_EXPERIMENT_THINKING_ENABLED = true;
export const DEFAULT_EXPERIMENT_ITERATIONS = 5;
export const GEMINI_ENV_PATH = path.resolve(process.cwd(), '.tools', 'gemini.env');

export const BENCHMARKS = [
  {
    id: 'email_fallback_red',
    prompt:
      "We just need one email column. We should use the main email column but if its empty we should use the email (2) column. If both are empty we should color red",
  },
  {
    id: 'priority_score',
    prompt:
      "Let's calculate a priority score based on the balance. If it's negative let's set a priority score of 3, if its between 0 and 200 let's set a score of 2 and if it's above lets set a score of 1",
  },
] as const;

export type ExperimentStatus =
  | 'valid_draft'
  | 'clarify'
  | 'request_error'
  | 'parse_error'
  | 'compile_failed'
  | 'structural_failed'
  | 'semantic_failed';

export interface ExperimentResult {
  benchmarkId: string;
  iteration: number;
  status: ExperimentStatus;
  mode?: 'clarify' | 'draft';
  issueSummary?: string;
  rawTextPreview?: string;
  structuralIssueCount?: number;
  semanticIssueCount?: number;
}

export interface SchemaExperimentConfig {
  experimentName: string;
  schemaPath: string;
  reportPath: string;
  model?: string;
  thinkingEnabled?: boolean;
  iterations?: number;
}

export async function executeSchemaExperiment(config: SchemaExperimentConfig) {
  const apiKey = await readGeminiApiKey();
  const schema = JSON.parse(await readFile(config.schemaPath, 'utf8')) as Record<string, unknown>;
  const table = await loadCustomersMessyTable();
  const results: ExperimentResult[] = [];
  const model = config.model ?? DEFAULT_EXPERIMENT_MODEL;
  const thinkingEnabled = config.thinkingEnabled ?? DEFAULT_EXPERIMENT_THINKING_ENABLED;
  const iterations = config.iterations ?? DEFAULT_EXPERIMENT_ITERATIONS;

  for (const benchmark of BENCHMARKS) {
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      results.push(
        await runBenchmarkIteration({
          apiKey,
          schema,
          table,
          benchmarkId: benchmark.id,
          prompt: benchmark.prompt,
          iteration,
          model,
          thinkingEnabled,
        }),
      );
    }
  }

  await writeFile(
    config.reportPath,
    buildReport({
      experimentName: config.experimentName,
      schema,
      schemaPath: config.schemaPath,
      results,
      model,
      thinkingEnabled,
      iterations,
    }),
    'utf8',
  );

  return {
    results,
    schema,
  };
}

async function runBenchmarkIteration(input: {
  apiKey: string;
  schema: Record<string, unknown>;
  table: Table;
  benchmarkId: string;
  prompt: string;
  iteration: number;
  model: string;
  thinkingEnabled: boolean;
}): Promise<ExperimentResult> {
  const baseWorkflow = createExperimentWorkflow(input.benchmarkId);
  const requestExport = buildGeminiRequestExport(
    {
      settings: {
        apiKey: input.apiKey,
        model: input.model,
        thinkingEnabled: input.thinkingEnabled,
      },
      context: {
        table: input.table,
        workflow: baseWorkflow,
        draft: null,
        messages: [],
        currentIssues: [],
        workflowContextSource: 'current',
        workspacePromptSnapshot: '',
      },
      userMessage: {
        role: 'user',
        text: input.prompt,
        timestamp: new Date().toISOString(),
      },
      phase: 'initial',
    },
    {
      responseJsonSchema: input.schema,
    },
  );

  try {
    const response = await fetch(requestExport.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.apiKey,
      },
      body: JSON.stringify(requestExport.requestBody),
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
      const parsed = parseGeminiCompilerOpsResponse(rawText);

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

      const compiled = compileGeminiCompilerOpsDraft(parsed.ops);

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

      const workflow = {
        ...baseWorkflow,
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
          structuralIssueCount: structural.issues.length,
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
          semanticIssueCount: semantic.issues.length,
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
        issueSummary: error instanceof Error ? error.message : 'Failed to parse Gemini response.',
        rawTextPreview: compact(rawText),
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

function buildReport(input: {
  experimentName: string;
  schema: Record<string, unknown>;
  schemaPath: string;
  results: ExperimentResult[];
  model: string;
  thinkingEnabled: boolean;
  iterations: number;
}) {
  const generatedAt = new Date().toISOString();
  const schemaText = `${JSON.stringify(input.schema, null, 2)}\n`;
  const schemaSizeBytes = Buffer.byteLength(schemaText, 'utf8');
  const summaryRows = BENCHMARKS.map((benchmark) => {
    const benchmarkResults = input.results.filter((result) => result.benchmarkId === benchmark.id);

    return {
      benchmarkId: benchmark.id,
      prompt: benchmark.prompt,
      total: benchmarkResults.length,
      validDraft: countStatus(benchmarkResults, 'valid_draft'),
      clarify: countStatus(benchmarkResults, 'clarify'),
      requestError: countStatus(benchmarkResults, 'request_error'),
      parseError: countStatus(benchmarkResults, 'parse_error'),
      compileFailed: countStatus(benchmarkResults, 'compile_failed'),
      structuralFailed: countStatus(benchmarkResults, 'structural_failed'),
      semanticFailed: countStatus(benchmarkResults, 'semantic_failed'),
    };
  });

  const lines = [
    `# ${input.experimentName} Report`,
    '',
    `Generated at: \`${generatedAt}\``,
    '',
    '## Configuration',
    '',
    `- Model: \`${input.model}\``,
    `- Thinking enabled: \`${String(input.thinkingEnabled)}\``,
    `- Iterations per benchmark: \`${input.iterations}\``,
    `- Schema file: \`${input.schemaPath}\``,
    `- Schema size: \`${schemaSizeBytes}\` bytes`,
    '',
    '## Benchmarks',
    '',
  ];

  BENCHMARKS.forEach((benchmark, index) => {
    lines.push(`${index + 1}. ${benchmark.prompt}`);
  });

  lines.push(
    '',
    '## Summary',
    '',
    '| Benchmark | Total | Valid | Clarify | Request error | Parse error | Compile failed | Structural failed | Semantic failed |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  );

  summaryRows.forEach((row) => {
    lines.push(
      `| \`${row.benchmarkId}\` | ${row.total} | ${row.validDraft} | ${row.clarify} | ${row.requestError} | ${row.parseError} | ${row.compileFailed} | ${row.structuralFailed} | ${row.semanticFailed} |`,
    );
  });

  lines.push('', '## Detailed Results', '');

  for (const benchmark of BENCHMARKS) {
    lines.push(`### ${benchmark.id}`, '', `Prompt: ${benchmark.prompt}`, '');
    lines.push('| Run | Status | Mode | Notes |', '| ---: | --- | --- | --- |');

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

    lines.push('');
  }

  lines.push('## Schema Snapshot', '', '```json', schemaText.trimEnd(), '```', '');

  return `${lines.join('\n')}\n`;
}

export async function readGeminiApiKey() {
  const envText = await readFile(GEMINI_ENV_PATH, 'utf8');
  const match = envText.match(/^\s*GEMINI_API_KEY\s*=\s*(.+)\s*$/m);

  if (!match) {
    throw new Error('GEMINI_API_KEY was not found in .tools/gemini.env.');
  }

  const apiKey = match[1].trim();

  if (apiKey === '') {
    throw new Error('GEMINI_API_KEY in .tools/gemini.env is empty.');
  }

  return apiKey;
}

export async function loadCustomersMessyTable() {
  const workbookPath = path.resolve(process.cwd(), 'Customers_Messy.xlsx');
  const workbookBytes = await readFile(workbookPath);
  const arrayBuffer = workbookBytes.buffer.slice(
    workbookBytes.byteOffset,
    workbookBytes.byteOffset + workbookBytes.byteLength,
  ) as ArrayBuffer;
  const workbook = importXlsxWorkbook('Customers_Messy.xlsx', arrayBuffer);
  const table = getActiveTable(workbook);

  if (!table) {
    throw new Error('Expected active table for Customers_Messy.xlsx.');
  }

  return table;
}

function createExperimentWorkflow(benchmarkId: string): Workflow {
  return {
    version: 2,
    workflowId: `wf_${benchmarkId}_experiment`,
    name: `Experiment ${benchmarkId}`,
    steps: [],
  };
}

export function extractResponseErrorMessage(rawBody: string) {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    return parsed.error?.message ?? compact(rawBody);
  } catch {
    return compact(rawBody);
  }
}

export function extractCandidateText(rawBody: string) {
  const parsed = JSON.parse(rawBody) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
        }>;
      };
    }>;
  };
  const text = parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim();

  if (!text) {
    throw new Error('Gemini returned no candidate text.');
  }

  return text;
}

export function compact(value: string, maxLength = 220) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function countStatus(results: ExperimentResult[], status: ExperimentStatus) {
  return results.filter((result) => result.status === status).length;
}

function escapeTable(value: string) {
  return value.replace(/\|/g, '\\|');
}
