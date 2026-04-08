import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { BENCHMARKS, RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeBenchmarkOpsExperiment } from './benchmarkOpsExperimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 8', () => {
  it(
    'runs the authoring-IR schema against the benchmark prompts and writes a report',
    async () => {
      const { results } = await executeBenchmarkOpsExperiment({
        experimentTitle: 'Experiment 8',
        schemaPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_8_schema.json'),
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_8_report.md'),
      });

      expect(results).toHaveLength(BENCHMARKS.length * 5);
    },
    180_000,
  );
});
