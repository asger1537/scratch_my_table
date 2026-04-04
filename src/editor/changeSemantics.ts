export function shouldIgnoreSemanticMove(params: {
  blockType: string | null;
  isOrderSensitive: boolean;
  isStepBlockType: boolean;
  hasParent: boolean;
  oldParentId?: string | null;
  newParentId?: string | null;
  oldInputName?: string | null;
  newInputName?: string | null;
  oldCoordinate?: unknown;
  newCoordinate?: unknown;
}) {
  const {
    blockType,
    isOrderSensitive,
    isStepBlockType,
    hasParent,
    oldParentId,
    newParentId,
    oldInputName,
    newInputName,
    oldCoordinate,
    newCoordinate,
  } = params;

  if (!blockType) {
    return false;
  }

  if (isOrderSensitive) {
    return false;
  }

  // Top-level non-step blocks are orphan candidates, so coordinate-only drops
  // still change editor validation even if no connection target changed.
  if (!isStepBlockType && !hasParent) {
    return false;
  }

  return oldParentId === newParentId
    && oldInputName === newInputName
    && Boolean(oldCoordinate || newCoordinate);
}
