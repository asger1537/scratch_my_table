import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeBenchmarkOpsExperiment } from './benchmarkOpsExperimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 10', () => {
  it(
    'runs the tiny compiler-op schema without assistant prefill and without curated examples',
    async () => {
      const { results } = await executeBenchmarkOpsExperiment({
        experimentTitle: 'Experiment 10',
        schemaPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_8_schema.json'),
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_10_report.md'),
        includeAssistantPrefill: false,
        includeCuratedExamples: false,
      });

      expect(results).toHaveLength(10);
    },
    180_000,
  );
});
