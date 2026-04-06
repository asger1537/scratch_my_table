import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeCanonicalReplayExperiment } from './canonicalReplayHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 5', () => {
  it(
    'replays the old canonical-AST email request with the prefilled solution and curated examples',
    async () => {
      const { results } = await executeCanonicalReplayExperiment({
        experimentTitle: 'Experiment 5',
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_5_report.md'),
        includeCurrentWorkflowSolution: true,
        includeCuratedExamples: true,
      });

      expect(results).toHaveLength(5);
    },
    180_000,
  );
});
