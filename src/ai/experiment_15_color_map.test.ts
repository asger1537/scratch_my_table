import path from 'node:path';
import { writeFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { generateGeminiDraftTurn, type AIPromptContext, type WorkflowStepInput } from './index';
import { BENCHMARKS, RUN_GEMINI_EXPERIMENTS, loadBenchmarkTable, readGeminiApiKey } from './experimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;
const ITERATIONS = 10;
const MODEL = 'gemini-3.1-flash-lite-preview';
const TARGET_RED = '#FFC7CE';

describeExperiment('Gemini experiment 15', () => {
  it(
    'measures color-word to hex reliability for the red email fallback prompt',
    async () => {
      const benchmark = BENCHMARKS.find((candidate) => candidate.id === 'email_fallback_red');

      if (!benchmark) {
        throw new Error('Missing email_fallback_red benchmark.');
      }

      const apiKey = await readGeminiApiKey();
      const table = await loadBenchmarkTable('email_fallback_red');
      const context: AIPromptContext = {
        table,
        workflow: {
          version: 2,
          workflowId: 'wf_color_map_probe',
          name: 'Color map probe',
          steps: [],
        },
        draft: null,
        messages: [],
        currentIssues: [],
        workflowContextSource: 'current',
        workspacePromptSnapshot: '',
      };

      const runs: Array<{
        iteration: number;
        mode: 'clarify' | 'draft';
        fillColor: string | null;
        matchesRequestedRed: boolean;
        note: string;
      }> = [];

      for (let iteration = 1; iteration <= ITERATIONS; iteration += 1) {
        const turn = await generateGeminiDraftTurn({
          settings: {
            apiKey,
            model: MODEL,
            thinkingEnabled: false,
          },
          context,
          userMessage: {
            role: 'user',
            text: benchmark.prompt,
            timestamp: new Date().toISOString(),
          },
          phase: 'initial',
        });

        if (turn.response.mode !== 'draft') {
          runs.push({
            iteration,
            mode: 'clarify',
            fillColor: null,
            matchesRequestedRed: false,
            note: `clarify: ${turn.response.msg}`,
          });
          continue;
        }

        const fillColor = extractEmailFallbackFillColor(turn.compiledDraft?.kind === 'singleWorkflow' ? turn.compiledDraft.steps : []);
        runs.push({
          iteration,
          mode: 'draft',
          fillColor,
          matchesRequestedRed: fillColor?.toUpperCase() === TARGET_RED,
          note: fillColor ? `fillColor=${fillColor}` : 'no fillColor emitted',
        });
      }

      const redMatchCount = runs.filter((run) => run.matchesRequestedRed).length;
      const colorHistogram = runs.reduce<Record<string, number>>((accumulator, run) => {
        const key = run.fillColor ? run.fillColor.toUpperCase() : '(none)';
        accumulator[key] = (accumulator[key] ?? 0) + 1;
        return accumulator;
      }, {});

      const reportPath = path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_15_color_map_report.md');
      const reportLines = [
        '# Experiment 15 Color Map Report',
        '',
        `Generated at: \`${new Date().toISOString()}\``,
        '',
        '## Configuration',
        '',
        `- Model: \`${MODEL}\``,
        '- Thinking: `disabled`',
        '- Structured output: `disabled`',
        `- Iterations: \`${ITERATIONS}\``,
        `- Target color word mapping: \`red -> ${TARGET_RED}\``,
        '',
        '## Summary',
        '',
        `- Drafts that emitted target red: \`${redMatchCount}/${ITERATIONS}\``,
        '',
        '### Observed fillColor histogram',
        '',
        '```json',
        JSON.stringify(colorHistogram, null, 2),
        '```',
        '',
        '## Per-run results',
        '',
        '| Run | Mode | fillColor | Matches red | Note |',
        '| ---: | --- | --- | --- | --- |',
        ...runs.map((run) => `| ${run.iteration} | ${run.mode} | ${run.fillColor ?? '-'} | ${run.matchesRequestedRed ? 'yes' : 'no'} | ${escapeTable(run.note)} |`),
        '',
      ];
      await writeFile(reportPath, reportLines.join('\n'), 'utf8');

      expect(runs).toHaveLength(ITERATIONS);
    },
    240_000,
  );
});

function extractEmailFallbackFillColor(steps: WorkflowStepInput[]) {
  for (const step of steps) {
    if (step.type !== 'scopedRule') {
      continue;
    }

    if (!step.columnIds.includes('col_email')) {
      continue;
    }

    for (const ruleCase of step.cases ?? []) {
      const fillColor = ruleCase.then.format?.fillColor;

      if (typeof fillColor === 'string' && fillColor.trim() !== '') {
        return fillColor;
      }
    }

    const defaultFillColor = step.defaultPatch?.format?.fillColor;

    if (typeof defaultFillColor === 'string' && defaultFillColor.trim() !== '') {
      return defaultFillColor;
    }
  }

  return null;
}

function escapeTable(value: string) {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br/>');
}
