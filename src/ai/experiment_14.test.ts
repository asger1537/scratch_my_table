import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BENCHMARKS, RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeBenchmarkOpsExperiment } from './benchmarkOpsExperimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 14', () => {
  it(
    'runs without structured output while keeping curated examples and no assistant prefill',
    async () => {
      const { results } = await executeBenchmarkOpsExperiment({
        experimentTitle: 'Experiment 14',
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_14_report.md'),
        includeAssistantPrefill: false,
        includeCuratedExamples: true,
        disableStructuredOutput: true,
      });

      expect(results).toHaveLength(BENCHMARKS.length * 5);
    },
    180_000,
  );
});
