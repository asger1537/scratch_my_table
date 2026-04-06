import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { RUN_GEMINI_EXPERIMENTS } from './experimentHarness';
import { executeCanonicalReplayExperiment } from './canonicalReplayHarness';

const describeExperiment = RUN_GEMINI_EXPERIMENTS ? describe : describe.skip;

describeExperiment('Gemini experiment 7', () => {
  it(
    'replays the old canonical-AST email request without the prefilled workflow solution and without curated examples',
    async () => {
      const { results } = await executeCanonicalReplayExperiment({
        experimentTitle: 'Experiment 7',
        reportPath: path.resolve(process.cwd(), '.tools', 'ai-experiments', 'experiment_7_report.md'),
        includeCurrentWorkflowSolution: false,
        includeCuratedExamples: false,
      });

      expect(results).toHaveLength(5);
    },
    180_000,
  );
});
