import { describe, expect, it } from 'vitest';

import { buildValidationDisplayItems } from './validationDisplay';

describe('editor validation display items', () => {
  it('splits multiline workflow JSON errors into separately counted entries', () => {
    expect(
      buildValidationDisplayItems(
        [
          {
            code: 'missingColumns',
            message: 'Pick at least one column.',
          },
        ],
        'First parser problem.\nSecond parser problem.\n\nThird parser problem.',
      ),
    ).toEqual([
      {
        code: 'workflowJson',
        message: 'First parser problem.',
      },
      {
        code: 'workflowJson',
        message: 'Second parser problem.',
      },
      {
        code: 'workflowJson',
        message: 'Third parser problem.',
      },
      {
        code: 'missingColumns',
        message: 'Pick at least one column.',
      },
    ]);
  });

  it('returns only live workflow issues when there is no workflow JSON error', () => {
    expect(
      buildValidationDisplayItems(
        [
          {
            code: 'invalidExpression',
            message: 'Expression must return a string.',
          },
        ],
        null,
      ),
    ).toEqual([
      {
        code: 'invalidExpression',
        message: 'Expression must return a string.',
      },
    ]);
  });
});
