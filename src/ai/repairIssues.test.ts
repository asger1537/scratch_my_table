import { describe, expect, it } from 'vitest';

import type { WorkflowStep } from '../workflow';

import type { AIDraftIssue } from './authoringIr';
import { selectRepairPromptIssues } from './repairIssues';

describe('AI repair issue grouping', () => {
  it('keeps the mixed-type root issue and suppresses downstream generated-column cascades', () => {
    const repairIssues = selectRepairPromptIssues(
      [
        issue({
          code: 'incompatibleType',
          message: "Function 'replace' requires a string input.",
          path: 'steps[0].expression.args[0]',
          stepId: 'step_derive_column_1',
        }),
        issue({
          code: 'missingColumn',
          message: "Column 'col_balance_num' does not exist at step 'step_derive_column_2'.",
          path: 'steps[1].expression.args[0].columnId',
          stepId: 'step_derive_column_2',
          details: { columnId: 'col_balance_num' },
        }),
        issue({
          code: 'missingColumn',
          message: "Column 'col_action_segment' does not exist at step 'step_filter_rows_1'.",
          path: 'steps[2].condition.args[0].columnId',
          stepId: 'step_filter_rows_1',
          details: { columnId: 'col_action_segment' },
        }),
      ],
      createCascadeSteps(),
    );

    expect(repairIssues).toEqual([
      expect.objectContaining({
        code: 'incompatibleType',
        message: "Function 'replace' requires a string input.",
      }),
      expect.objectContaining({
        code: 'cascadingMissingColumns',
        message: expect.stringContaining("'col_balance_num', 'col_action_segment'"),
      }),
    ]);
  });

  it('keeps missing source columns as primary repair issues', () => {
    const repairIssues = selectRepairPromptIssues(
      [
        issue({
          code: 'missingColumn',
          message: "Column 'col_phone' does not exist at step 'step_scoped_rule_1'.",
          path: 'steps[0].columnIds[0]',
          stepId: 'step_scoped_rule_1',
          details: { columnId: 'col_phone' },
        }),
      ],
      createCascadeSteps(),
    );

    expect(repairIssues).toEqual([
      expect.objectContaining({
        code: 'missingColumn',
        message: expect.stringContaining('col_phone'),
      }),
    ]);
  });

  it('keeps task-quality issues as primary repair issues', () => {
    const repairIssues = selectRepairPromptIssues(
      [
        issue({
          code: 'taskQualityPhaseMissing',
          severity: 'warning',
          message: 'The draft is missing requested phases: drop columns.',
          path: 'taskQuality.phases',
        }),
        issue({
          code: 'missingColumn',
          message: "Column 'col_balance_num' does not exist at step 'step_derive_column_2'.",
          path: 'steps[1].expression.args[0].columnId',
          stepId: 'step_derive_column_2',
          details: { columnId: 'col_balance_num' },
        }),
      ],
      createCascadeSteps(),
    );

    expect(repairIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'taskQualityPhaseMissing',
        }),
      ]),
    );
  });
});

function issue(input: {
  code: string;
  message: string;
  path: string;
  stepId?: string;
  severity?: AIDraftIssue['severity'];
  details?: Record<string, unknown>;
}): AIDraftIssue {
  return {
    code: input.code,
    severity: input.severity ?? 'error',
    phase: 'semantic',
    message: input.message,
    path: input.path,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.details ? { details: input.details } : {}),
  };
}

function createCascadeSteps(): WorkflowStep[] {
  return [
    {
      id: 'step_derive_column_1',
      type: 'deriveColumn',
      newColumn: {
        columnId: 'col_balance_num',
        displayName: 'Balance Num',
      },
      expression: {
        kind: 'call',
        name: 'replace',
        args: [
          { kind: 'column', columnId: 'col_balance' },
          { kind: 'literal', value: ',' },
          { kind: 'literal', value: '.' },
        ],
      },
    },
    {
      id: 'step_derive_column_2',
      type: 'deriveColumn',
      newColumn: {
        columnId: 'col_action_segment',
        displayName: 'Action Segment',
      },
      expression: {
        kind: 'column',
        columnId: 'col_balance_num',
      },
    },
    {
      id: 'step_filter_rows_1',
      type: 'filterRows',
      mode: 'keep',
      condition: {
        kind: 'column',
        columnId: 'col_action_segment',
      },
    },
  ];
}
