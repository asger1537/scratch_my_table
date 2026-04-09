import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BENCHMARKS, RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeBenchmarkOpsExperiment } from './benchmarkOpsExperimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 12', () => {
  it(
    'runs object-only leaf guards on nested expressions without assistant prefill while keeping curated examples',
    async () => {
      const { results } = await executeBenchmarkOpsExperiment({
        experimentTitle: 'Experiment 12',
        schemaPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_12_schema.json'),
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_12_report.md'),
        includeAssistantPrefill: false,
        includeCuratedExamples: true,
      });

      expect(results).toHaveLength(BENCHMARKS.length * 5);
    },
    180_000,
  );
});
