import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  BENCHMARKS,
  DEFAULT_EXPERIMENT_ITERATIONS,
  RUN_GEMINI_EXPERIMENTS,
  executeSchemaExperiment,
} from './experimentHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 2', () => {
  it(
    'runs the shallow structured authoring schema against the benchmark prompts and writes a report',
    async () => {
      const { results } = await executeSchemaExperiment({
        experimentName: 'Experiment 2',
        schemaPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_2_schema.json'),
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_2_report.md'),
      });

      expect(results).toHaveLength(BENCHMARKS.length * DEFAULT_EXPERIMENT_ITERATIONS);
    },
    180_000,
  );
});
