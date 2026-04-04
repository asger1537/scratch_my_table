import { describe, expect, it } from 'vitest';

import { shouldIgnoreSemanticMove } from './changeSemantics';

describe('editor change semantics', () => {
  it('does not ignore coordinate-only drops for top-level orphan blocks', () => {
    expect(
      shouldIgnoreSemanticMove({
        blockType: 'comparison_function',
        isOrderSensitive: false,
        isStepBlockType: false,
        hasParent: false,
        oldParentId: null,
        newParentId: null,
        oldInputName: null,
        newInputName: null,
        oldCoordinate: { x: 10, y: 20 },
        newCoordinate: { x: 40, y: 60 },
      }),
    ).toBe(false);
  });

  it('still ignores pure coordinate moves for connected non-order-sensitive blocks', () => {
    expect(
      shouldIgnoreSemanticMove({
        blockType: 'column_expression',
        isOrderSensitive: false,
        isStepBlockType: false,
        hasParent: true,
        oldParentId: 'rule_case_1',
        newParentId: 'rule_case_1',
        oldInputName: 'WHEN',
        newInputName: 'WHEN',
        oldCoordinate: { x: 10, y: 20 },
        newCoordinate: { x: 40, y: 60 },
      }),
    ).toBe(true);
  });
});
