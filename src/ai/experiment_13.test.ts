import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BENCHMARKS, RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeBenchmarkOpsExperiment } from './benchmarkOpsExperimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 13', () => {
  it(
    'runs an anyOf + propertyOrdering schema variant without assistant prefill while keeping curated examples',
    async () => {
      const { results } = await executeBenchmarkOpsExperiment({
        experimentTitle: 'Experiment 13',
        schemaPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_13_schema.json'),
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_13_report.md'),
        includeAssistantPrefill: false,
        includeCuratedExamples: true,
      });

      expect(results).toHaveLength(BENCHMARKS.length * 5);
    },
    180_000,
  );
});
