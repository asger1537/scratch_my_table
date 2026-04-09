import type { ValidationDisplayItem } from './types';

export function buildValidationDisplayItems(
  issues: ValidationDisplayItem[],
  jsonError: string | null,
): ValidationDisplayItem[] {
  const jsonErrorItems = (jsonError ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((message) => ({
      code: 'workflowJson',
      message,
    }));

  return [...jsonErrorItems, ...issues];
}
