import { describe, expect, it } from 'vitest';

import { BLOCK_TYPES, CHECKBOX_FALSE, CHECKBOX_TRUE, SCOPED_RULE_INPUT_NAMES } from './blocks';
import {
  filterWorkflowToolboxEntries,
  getWorkflowToolboxCategory,
  getWorkflowToolboxCategoryContents,
  getWorkflowToolboxDefinition,
  WORKFLOW_TOOLBOX_CATEGORIES,
} from './toolbox';

describe('workflow toolbox search', () => {
  it('returns all category entries for an empty query', () => {
    const contents = getWorkflowToolboxCategoryContents('category_functions', '');

    expect(contents).toHaveLength(getWorkflowToolboxCategory('category_functions')?.entries.length ?? 0);
    expect(contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'block', type: BLOCK_TYPES.trimFunction }),
        expect.objectContaining({ kind: 'block', type: BLOCK_TYPES.replaceRegexFunction }),
      ]),
    );
  });

  it('finds generic logic blocks through keyword search', () => {
    const comparisonMatches = getWorkflowToolboxCategoryContents('category_logic', 'greater');
    const predicateMatches = getWorkflowToolboxCategoryContents('category_logic', 'regex');

    expect(comparisonMatches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'block', type: BLOCK_TYPES.comparisonFunction })]),
    );
    expect(predicateMatches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'block', type: BLOCK_TYPES.predicateFunction })]),
    );
  });

  it('preserves preset fields on filtered scoped rule entries', () => {
    const contents = getWorkflowToolboxCategoryContents('category_scoped_rules', 'highlight');
    const scopedRuleEntry = contents.find(
      (item): item is Extract<(typeof contents)[number], { kind: 'block' }> =>
        item.kind === 'block' && 'type' in item && item.type === BLOCK_TYPES.scopedRuleCasesStep,
    );

    expect(scopedRuleEntry).toEqual(
      expect.objectContaining({
        kind: 'block',
        type: BLOCK_TYPES.scopedRuleCasesStep,
        fields: {
          [SCOPED_RULE_INPUT_NAMES.defaultValueEnabled]: CHECKBOX_TRUE,
          [SCOPED_RULE_INPUT_NAMES.defaultFormatEnabled]: CHECKBOX_FALSE,
        },
      }),
    );
  });

  it('returns a no-match label when a category search is empty', () => {
    expect(getWorkflowToolboxCategoryContents('category_math', 'definitely-not-a-math-block')).toEqual([
      {
        kind: 'label',
        text: 'No matching blocks',
      },
    ]);
  });

  it('builds dynamic toolbox categories with callback ids for every visible category', () => {
    const definition = getWorkflowToolboxDefinition();

    expect(definition.kind).toBe('categoryToolbox');
    expect(definition.contents).toHaveLength(WORKFLOW_TOOLBOX_CATEGORIES.length);
    expect(definition.contents).toEqual(
      expect.arrayContaining(
        WORKFLOW_TOOLBOX_CATEGORIES.map((category) => expect.objectContaining({
          kind: 'category',
          name: category.name,
          custom: category.id,
          toolboxitemid: category.id,
        })),
      ),
    );
  });

  it('filters entries case-insensitively while preserving original block definitions', () => {
    const category = getWorkflowToolboxCategory('category_scoped_rules');

    if (!category) {
      throw new Error('Expected scoped rule category metadata.');
    }

    const contents = filterWorkflowToolboxEntries(category.entries, 'RULE');

    expect(contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'block', type: BLOCK_TYPES.scopedRuleCasesStep }),
        expect.objectContaining({ kind: 'block', type: BLOCK_TYPES.ruleCaseItem }),
      ]),
    );
  });
});
