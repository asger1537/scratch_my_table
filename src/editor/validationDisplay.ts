export interface ValidationDisplayItem {
  code: string;
  message: string;
}

export function buildValidationDisplayItems(
  issues: Array<{ code: string; message: string }>,
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
