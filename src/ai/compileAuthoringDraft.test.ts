import { describe, expect, it } from 'vitest';

import { compileAuthoringDraft, compileAuthoringDraftToWorkflowSteps } from './index';
import type { AuthoringStepInput } from './authoringIr';

describe('compileAuthoringDraft', () => {
  it('lowers unary, binary, ternary, nary, and nullary value expressions into canonical calls', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_full_name',
          displayName: 'Full Name',
        },
        derive: {
          kind: 'nary',
          op: 'concat',
          items: [
            {
              kind: 'unary',
              op: 'trim',
              input: { source: 'column', columnId: 'col_first_name' },
            },
            { source: 'literal', value: ' ' },
            {
              kind: 'ternary',
              op: 'replace',
              first: { source: 'column', columnId: 'col_last_name' },
              second: { source: 'literal', value: '-' },
              third: { source: 'literal', value: ' ' },
            },
          ],
        },
      },
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_created_at',
          displayName: 'Created At',
        },
        derive: {
          kind: 'nullary',
          op: 'now',
        },
      },
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_year',
          displayName: 'Year',
        },
        derive: {
          kind: 'binary',
          op: 'datePart',
          left: { source: 'column', columnId: 'col_sign_up_date' },
          right: { source: 'literal', value: 'year' },
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_full_name',
          displayName: 'Full Name',
        },
        expression: call(
          'concat',
          call('trim', column('col_first_name')),
          literal(' '),
          call('replace', column('col_last_name'), literal('-'), literal(' ')),
        ),
      },
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_created_at',
          displayName: 'Created At',
        },
        expression: call('now'),
      },
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_year',
          displayName: 'Year',
        },
        expression: call('datePart', column('col_sign_up_date'), literal('year')),
      },
    ]);
  });

  it('lowers gte and lte comparisons into explicit canonical boolean expressions', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'filterRows',
        mode: 'keep',
        where: {
          kind: 'boolean',
          op: 'and',
          items: [
            {
              kind: 'compare',
              op: 'gte',
              left: { source: 'column', columnId: 'col_balance' },
              right: { source: 'literal', value: 0 },
            },
            {
              kind: 'compare',
              op: 'lte',
              left: { source: 'column', columnId: 'col_balance' },
              right: { source: 'literal', value: 200 },
            },
          ],
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'filterRows',
        mode: 'keep',
        condition: call(
          'and',
          call(
            'or',
            call('greaterThan', column('col_balance'), literal(0)),
            call('equals', column('col_balance'), literal(0)),
          ),
          call(
            'or',
            call('lessThan', column('col_balance'), literal(200)),
            call('equals', column('col_balance'), literal(200)),
          ),
        ),
      },
    ]);
  });

  it('lowers between into the exact canonical bounded-range expansion', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'filterRows',
        mode: 'keep',
        where: {
          kind: 'between',
          input: { source: 'column', columnId: 'col_balance' },
          min: { source: 'literal', value: 0 },
          max: { source: 'literal', value: 200 },
          inclusiveMin: true,
          inclusiveMax: false,
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'filterRows',
        mode: 'keep',
        condition: call(
          'and',
          call(
            'or',
            call('greaterThan', column('col_balance'), literal(0)),
            call('equals', column('col_balance'), literal(0)),
          ),
          call('lessThan', column('col_balance'), literal(200)),
        ),
      },
    ]);
  });

  it('lowers match with ordered when and otherwise cases', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_priority_score',
          displayName: 'Priority Score',
        },
        derive: {
          kind: 'match',
          subject: {
            kind: 'unary',
            op: 'toNumber',
            input: { source: 'column', columnId: 'col_balance' },
          },
          cases: [
            {
              kind: 'when',
              when: {
                kind: 'compare',
                op: 'lt',
                left: { source: 'caseValue' },
                right: { source: 'literal', value: 0 },
              },
              then: { source: 'literal', value: 3 },
            },
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 1 },
            },
          ],
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_priority_score',
          displayName: 'Priority Score',
        },
        expression: {
          kind: 'match',
          subject: call('toNumber', column('col_balance')),
          cases: [
            {
              kind: 'when',
              when: call('lessThan', caseValue(), literal(0)),
              then: literal(3),
            },
            {
              kind: 'otherwise',
              then: literal(1),
            },
          ],
        },
      },
    ]);
  });

  it('rejects value operands outside scopedRule contexts', () => {
    const compiled = compileAuthoringDraft([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_bad',
          displayName: 'Bad',
        },
        derive: { source: 'value' },
      },
    ]);

    expect(compiled.value).toBeNull();
    expect(compiled.issues).toEqual([
      expect.objectContaining({
        code: 'authoringInvalidContext',
        path: 'steps[0].derive',
      }),
    ]);
  });

  it('rejects caseValue operands outside match when conditions', () => {
    const compiled = compileAuthoringDraft([
      {
        type: 'filterRows',
        mode: 'keep',
        where: {
          kind: 'compare',
          op: 'eq',
          left: { source: 'caseValue' },
          right: { source: 'literal', value: 'x' },
        },
      },
    ]);

    expect(compiled.value).toBeNull();
    expect(compiled.issues).toEqual([
      expect.objectContaining({
        code: 'authoringInvalidContext',
        path: 'steps[0].where.left',
      }),
    ]);
  });

  it('rejects duplicate and misplaced otherwise cases', () => {
    const compiled = compileAuthoringDraft([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_status_label',
          displayName: 'Status Label',
        },
        derive: {
          kind: 'match',
          subject: { source: 'column', columnId: 'col_status' },
          cases: [
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 'Other' },
            },
            {
              kind: 'when',
              when: {
                kind: 'compare',
                op: 'eq',
                left: { source: 'caseValue' },
                right: { source: 'literal', value: 'active' },
              },
              then: { source: 'literal', value: 'Active customer' },
            },
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 'Fallback' },
            },
          ],
        },
      },
    ]);

    expect(compiled.value).toBeNull();
    expect(compiled.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoringInvalidMatch',
          message: 'Otherwise cases must be last.',
          path: 'steps[0].derive.cases[0]',
        }),
        expect.objectContaining({
          code: 'authoringInvalidMatch',
          message: 'Otherwise cases must be last.',
          path: 'steps[0].derive.cases[1]',
        }),
        expect.objectContaining({
          code: 'authoringInvalidMatch',
          message: 'Match expressions may include at most one otherwise case.',
          path: 'steps[0].derive.cases[2]',
        }),
      ]),
    );
  });

  it('rejects empty boolean and n-ary groups', () => {
    const compiled = compileAuthoringDraft([
      {
        type: 'filterRows',
        mode: 'keep',
        where: {
          kind: 'boolean',
          op: 'and',
          items: [],
        },
      },
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_full_name',
          displayName: 'Full Name',
        },
        derive: {
          kind: 'nary',
          op: 'concat',
          items: [],
        },
      },
    ]);

    expect(compiled.value).toBeNull();
    expect(compiled.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'authoringEmptyGroup',
          path: 'steps[0].where.items',
        }),
        expect.objectContaining({
          code: 'authoringEmptyGroup',
          path: 'steps[1].derive.items',
        }),
      ]),
    );
  });

  it('rejects unsupported ops before canonical workflow validation', () => {
    const compiled = compileAuthoringDraft([
      {
        type: 'filterRows',
        mode: 'drop',
        where: {
          kind: 'compare',
          op: 'gteish' as 'gte',
          left: { source: 'column', columnId: 'col_balance' },
          right: { source: 'literal', value: 0 },
        },
      },
    ]);

    expect(compiled.value).toBeNull();
    expect(compiled.issues).toEqual([
      expect.objectContaining({
        code: 'authoringUnsupportedOp',
        path: 'steps[0].where.op',
      }),
    ]);
  });

  it('compiles the priority-score authoring example into the exact canonical workflow shape', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_priority_score',
          displayName: 'Priority Score',
        },
        derive: {
          kind: 'match',
          subject: {
            kind: 'unary',
            op: 'toNumber',
            input: { source: 'column', columnId: 'col_balance' },
          },
          cases: [
            {
              kind: 'when',
              when: {
                kind: 'compare',
                op: 'lt',
                left: { source: 'caseValue' },
                right: { source: 'literal', value: 0 },
              },
              then: { source: 'literal', value: 3 },
            },
            {
              kind: 'when',
              when: {
                kind: 'between',
                input: { source: 'caseValue' },
                min: { source: 'literal', value: 0 },
                max: { source: 'literal', value: 200 },
                inclusiveMin: true,
                inclusiveMax: true,
              },
              then: { source: 'literal', value: 2 },
            },
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 1 },
            },
          ],
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_priority_score',
          displayName: 'Priority Score',
        },
        expression: {
          kind: 'match',
          subject: call('toNumber', column('col_balance')),
          cases: [
            {
              kind: 'when',
              when: call('lessThan', caseValue(), literal(0)),
              then: literal(3),
            },
            {
              kind: 'when',
              when: call(
                'and',
                call(
                  'or',
                  call('greaterThan', caseValue(), literal(0)),
                  call('equals', caseValue(), literal(0)),
                ),
                call(
                  'or',
                  call('lessThan', caseValue(), literal(200)),
                  call('equals', caseValue(), literal(200)),
                ),
              ),
              then: literal(2),
            },
            {
              kind: 'otherwise',
              then: literal(1),
            },
          ],
        },
      },
    ]);
  });

  it('compiles the status-label authoring example into the exact canonical workflow shape', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_status_label',
          displayName: 'Status Label',
        },
        derive: {
          kind: 'match',
          subject: {
            kind: 'unary',
            op: 'lower',
            input: {
              kind: 'unary',
              op: 'trim',
              input: { source: 'column', columnId: 'col_status' },
            },
          },
          cases: [
            {
              kind: 'when',
              when: {
                kind: 'compare',
                op: 'eq',
                left: { source: 'caseValue' },
                right: { source: 'literal', value: 'active' },
              },
              then: { source: 'literal', value: 'Active customer' },
            },
            {
              kind: 'when',
              when: {
                kind: 'boolean',
                op: 'or',
                items: [
                  {
                    kind: 'compare',
                    op: 'eq',
                    left: { source: 'caseValue' },
                    right: { source: 'literal', value: 'pending' },
                  },
                  {
                    kind: 'compare',
                    op: 'eq',
                    left: { source: 'caseValue' },
                    right: { source: 'literal', value: 'queued' },
                  },
                ],
              },
              then: { source: 'literal', value: 'Pending customer' },
            },
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 'Other' },
            },
          ],
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_status_label',
          displayName: 'Status Label',
        },
        expression: {
          kind: 'match',
          subject: call('lower', call('trim', column('col_status'))),
          cases: [
            {
              kind: 'when',
              when: call('equals', caseValue(), literal('active')),
              then: literal('Active customer'),
            },
            {
              kind: 'when',
              when: call(
                'or',
                call('equals', caseValue(), literal('pending')),
                call('equals', caseValue(), literal('queued')),
              ),
              then: literal('Pending customer'),
            },
            {
              kind: 'otherwise',
              then: literal('Other'),
            },
          ],
        },
      },
    ]);
  });

  it('compiles email fallback through scopedRule authoring inputs into canonical value-based logic', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'scopedRule',
        columnIds: ['col_email'],
        cases: [
          {
            when: {
              kind: 'predicate',
              op: 'isEmpty',
              input: { source: 'value' },
            },
            then: {
              value: { source: 'column', columnId: 'col_email_2' },
            },
          },
        ],
      },
      {
        type: 'dropColumns',
        columnIds: ['col_email_2'],
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'scopedRule',
        columnIds: ['col_email'],
        cases: [
          {
            when: call('isEmpty', value()),
            then: {
              value: column('col_email_2'),
            },
          },
        ],
      },
      {
        type: 'dropColumns',
        columnIds: ['col_email_2'],
      },
    ]);
  });

  it('compiles phone normalization via replaceRegex(toString(value), ...) inside scopedRule', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'scopedRule',
        columnIds: ['col_phone'],
        defaultPatch: {
          value: {
            kind: 'ternary',
            op: 'replaceRegex',
            first: {
              kind: 'unary',
              op: 'toString',
              input: { source: 'value' },
            },
            second: { source: 'literal', value: '[^0-9]+' },
            third: { source: 'literal', value: '' },
          },
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'scopedRule',
        columnIds: ['col_phone'],
        defaultPatch: {
          value: call(
            'replaceRegex',
            call('toString', value()),
            literal('[^0-9]+'),
            literal(''),
          ),
        },
      },
    ]);
  });

  it('compiles preferred contact derivation with match over caseValue and row columns', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_preferred_contact_method',
          displayName: 'Preferred Contact Method',
        },
        derive: {
          kind: 'match',
          subject: { source: 'column', columnId: 'col_email' },
          cases: [
            {
              kind: 'when',
              when: {
                kind: 'compare',
                op: 'contains',
                left: { source: 'caseValue' },
                right: { source: 'literal', value: '@' },
              },
              then: { source: 'literal', value: 'email' },
            },
            {
              kind: 'when',
              when: {
                kind: 'boolean',
                op: 'and',
                items: [
                  {
                    kind: 'predicate',
                    op: 'isEmpty',
                    input: { source: 'caseValue' },
                  },
                  {
                    kind: 'compare',
                    op: 'matchesRegex',
                    left: { source: 'column', columnId: 'col_phone' },
                    right: { source: 'literal', value: '^\\d{10}$' },
                  },
                ],
              },
              then: { source: 'literal', value: 'sms' },
            },
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 'none' },
            },
          ],
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_preferred_contact_method',
          displayName: 'Preferred Contact Method',
        },
        expression: {
          kind: 'match',
          subject: column('col_email'),
          cases: [
            {
              kind: 'when',
              when: call('contains', caseValue(), literal('@')),
              then: literal('email'),
            },
            {
              kind: 'when',
              when: call(
                'and',
                call('isEmpty', caseValue()),
                call('matchesRegex', column('col_phone'), literal('^\\d{10}$')),
              ),
              then: literal('sms'),
            },
            {
              kind: 'otherwise',
              then: literal('none'),
            },
          ],
        },
      },
    ]);
  });

  it('compiles customer tier derivation and at-risk row-conditional scoped rules', () => {
    const steps: AuthoringStepInput[] = [
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_customer_tier',
          displayName: 'Customer Tier',
        },
        derive: {
          kind: 'match',
          subject: { source: 'literal', value: true },
          cases: [
            {
              kind: 'when',
              when: {
                kind: 'boolean',
                op: 'and',
                items: [
                  {
                    kind: 'compare',
                    op: 'eq',
                    left: { source: 'column', columnId: 'col_vip' },
                    right: { source: 'literal', value: true },
                  },
                  {
                    kind: 'compare',
                    op: 'eq',
                    left: {
                      kind: 'unary',
                      op: 'lower',
                      input: {
                        kind: 'unary',
                        op: 'trim',
                        input: { source: 'column', columnId: 'col_status' },
                      },
                    },
                    right: { source: 'literal', value: 'active' },
                  },
                ],
              },
              then: { source: 'literal', value: 'vip-active' },
            },
            {
              kind: 'when',
              when: {
                kind: 'compare',
                op: 'lt',
                left: {
                  kind: 'unary',
                  op: 'toNumber',
                  input: { source: 'column', columnId: 'col_balance' },
                },
                right: { source: 'literal', value: 0 },
              },
              then: { source: 'literal', value: 'at-risk' },
            },
            {
              kind: 'otherwise',
              then: { source: 'literal', value: 'standard' },
            },
          ],
        },
      },
      {
        type: 'scopedRule',
        columnIds: ['col_status'],
        rowWhere: {
          kind: 'compare',
          op: 'eq',
          left: { source: 'column', columnId: 'col_customer_tier' },
          right: { source: 'literal', value: 'at-risk' },
        },
        defaultPatch: {
          value: {
            kind: 'unary',
            op: 'lower',
            input: {
              kind: 'unary',
              op: 'trim',
              input: { source: 'value' },
            },
          },
          format: {
            fillColor: '#FFC7CE',
          },
        },
      },
      {
        type: 'scopedRule',
        columnIds: ['col_balance'],
        rowWhere: {
          kind: 'compare',
          op: 'eq',
          left: { source: 'column', columnId: 'col_customer_tier' },
          right: { source: 'literal', value: 'at-risk' },
        },
        defaultPatch: {
          format: {
            fillColor: '#FFC7CE',
          },
        },
      },
    ];

    expect(compileAuthoringDraftToWorkflowSteps(steps)).toEqual([
      {
        type: 'deriveColumn',
        newColumn: {
          columnId: 'col_customer_tier',
          displayName: 'Customer Tier',
        },
        expression: {
          kind: 'match',
          subject: literal(true),
          cases: [
            {
              kind: 'when',
              when: call(
                'and',
                call('equals', column('col_vip'), literal(true)),
                call(
                  'equals',
                  call('lower', call('trim', column('col_status'))),
                  literal('active'),
                ),
              ),
              then: literal('vip-active'),
            },
            {
              kind: 'when',
              when: call(
                'lessThan',
                call('toNumber', column('col_balance')),
                literal(0),
              ),
              then: literal('at-risk'),
            },
            {
              kind: 'otherwise',
              then: literal('standard'),
            },
          ],
        },
      },
      {
        type: 'scopedRule',
        columnIds: ['col_status'],
        rowCondition: call('equals', column('col_customer_tier'), literal('at-risk')),
        defaultPatch: {
          value: call('lower', call('trim', value())),
          format: {
            fillColor: '#FFC7CE',
          },
        },
      },
      {
        type: 'scopedRule',
        columnIds: ['col_balance'],
        rowCondition: call('equals', column('col_customer_tier'), literal('at-risk')),
        defaultPatch: {
          format: {
            fillColor: '#FFC7CE',
          },
        },
      },
    ]);
  });
});

function column(columnId: string) {
  return {
    kind: 'column' as const,
    columnId,
  };
}

function literal(value: string | number | boolean | null) {
  return {
    kind: 'literal' as const,
    value,
  };
}

function caseValue() {
  return {
    kind: 'caseValue' as const,
  };
}

function value() {
  return {
    kind: 'value' as const,
  };
}

function call(name: string, ...args: Array<Record<string, unknown>>) {
  return {
    kind: 'call' as const,
    name,
    args,
  };
}
