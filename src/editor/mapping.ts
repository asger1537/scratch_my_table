import * as Blockly from 'blockly';

import { isValidFillColor, type Table } from '../domain/model';
import { slugify } from '../domain/normalize';
import { projectWorkflowStepSchema, validateWorkflowSemantics, validateWorkflowStructure, type Workflow, type WorkflowExpression } from '../workflow';

import {
  authoringWorkflowToWorkflow,
  normalizeWorkflowMetadata,
  type AuthoringCellPatch,
  type AuthoringCommentStep,
  type AuthoringCombineColumnsStep,
  type AuthoringDeduplicateRowsStep,
  type AuthoringDeriveColumnStep,
  type AuthoringDropColumnsStep,
  type AuthoringFilterRowsStep,
  type AuthoringRenameColumnStep,
  type AuthoringRuleCase,
  type AuthoringScopedRuleStep,
  type AuthoringSortRowsStep,
  type AuthoringSplitColumnStep,
  type AuthoringStep,
  type AuthoringWorkflow,
  type AuthoringWorkflowMetadata,
  workflowToAuthoringWorkflow,
} from './authoring';
import { parseColumnSelectionValue, serializeColumnSelectionValue } from './FieldColumnMultiSelect';
import { BLOCK_TYPES, CREATE_COLUMN_MODES, type CreateColumnMode, registerWorkflowBlocks } from './blocks';
import { getEditorSchemaColumns, hasEditorSchemaForBlock } from './schemaOptions';
import type { EditorIssue, WorkspaceWorkflowResult } from './types';

const workspaceMetadata = new WeakMap<Blockly.Workspace, AuthoringWorkflowMetadata>();
const STEP_BLOCK_TYPES = new Set<string>([
  BLOCK_TYPES.commentStep,
  BLOCK_TYPES.scopedRuleSingleStep,
  BLOCK_TYPES.scopedRuleCasesStep,
  BLOCK_TYPES.dropColumnsStep,
  BLOCK_TYPES.renameColumnStep,
  BLOCK_TYPES.deriveColumnStep,
  BLOCK_TYPES.filterRowsStep,
  BLOCK_TYPES.splitColumnStep,
  BLOCK_TYPES.combineColumnsStep,
  BLOCK_TYPES.deduplicateRowsStep,
  BLOCK_TYPES.sortRowsStep,
]);

export function createDefaultWorkflow(table: Table): Workflow {
  const baseName = table.sourceName.replace(/\.[^.]+$/, '');
  const workflowSlug = slugify(baseName);

  return {
    version: 2,
    workflowId: `wf_${workflowSlug}`,
    name: toTitleCase(baseName),
    description: '',
    steps: [],
  };
}

export function createHeadlessWorkflowWorkspace(): Blockly.Workspace {
  registerWorkflowBlocks();

  const workspace = new Blockly.Workspace();

  setWorkspaceMetadata(workspace, {
    workflowId: 'wf_workflow',
    name: 'Workflow',
    description: '',
  });

  return workspace;
}

export function setWorkspaceMetadata(workspace: Blockly.Workspace, metadata: Partial<AuthoringWorkflowMetadata>) {
  const nextMetadata = normalizeWorkflowMetadata({
    ...getWorkspaceMetadata(workspace),
    ...metadata,
  });

  workspaceMetadata.set(workspace, nextMetadata);
}

export function getWorkspaceMetadata(workspace: Blockly.Workspace): AuthoringWorkflowMetadata {
  const metadata = workspaceMetadata.get(workspace);

  return metadata
    ? { ...metadata }
    : normalizeWorkflowMetadata({
        workflowId: '',
        name: '',
        description: '',
      });
}

export function workspaceToAuthoringWorkflow(workspace: Blockly.Workspace): { workflow: AuthoringWorkflow | null; issues: EditorIssue[] } {
  registerWorkflowBlocks();

  const topBlocks = sortBlocksByPosition(workspace.getTopBlocks(false));

  const steps: AuthoringStep[] = [];
  const issues: EditorIssue[] = [];

  topBlocks.forEach((topBlock) => {
    if (!isStepBlockType(topBlock.type)) {
      issues.push(orphanBlockIssue(topBlock));
      return;
    }

    const stepResult = readStepChain(topBlock);

    if (stepResult.issues.length > 0) {
      issues.push(...stepResult.issues);
      return;
    }

    steps.push(...stepResult.steps);
  });

  if (issues.length > 0) {
    return {
      workflow: null,
      issues,
    };
  }

  return {
    workflow: {
      metadata: getWorkspaceMetadata(workspace),
      steps,
    },
    issues: [],
  };
}

export function workspaceToWorkflow(workspace: Blockly.Workspace): WorkspaceWorkflowResult {
  const authored = workspaceToAuthoringWorkflow(workspace);

  if (!authored.workflow) {
    return {
      workflow: null,
      issues: authored.issues,
    };
  }

  return authoringWorkflowToWorkflow(authored.workflow);
}

export function workflowToWorkspace(workspace: Blockly.Workspace, workflow: Workflow): EditorIssue[] {
  registerWorkflowBlocks();
  workspace.clear();

  const authoringWorkflow = workflowToAuthoringWorkflow(workflow);

  setWorkspaceMetadata(workspace, authoringWorkflow.metadata);

  const stepBlocks = authoringWorkflow.steps.map((step, index) => createStepBlockFromAuthoringStep(workspace, step, index === 0));

  connectStepChain(stepBlocks);
  finalizeWorkspace(workspace);

  return [];
}

export function projectWorkspaceStepSchemas(workspace: Blockly.Workspace, table: Table) {
  registerWorkflowBlocks();

  const schemaByBlockId = new Map<string, Table['schema']['columns']>();
  let workingTable = createSchemaProjectionTable(table);

  getOrderedStepBlocks(workspace).forEach((block) => {
    const projectedColumns = workingTable.schema.columns.map((column) => ({ ...column }));

    collectStepScopedBlocks(block).forEach((scopedBlock) => {
      schemaByBlockId.set(scopedBlock.id, projectedColumns.map((column) => ({ ...column })));
    });

    const stepResult = readStepBlock(block);

    if (stepResult.issues.length > 0 || !stepResult.step) {
      return;
    }

    const compiled = authoringWorkflowToWorkflow({
      metadata: getWorkspaceMetadata(workspace),
      steps: [stepResult.step],
    });

    if (!compiled.workflow) {
      return;
    }

    const validation = validateWorkflowSemantics(compiled.workflow, workingTable);

    if (!validation.valid) {
      return;
    }

    workingTable = projectWorkflowStepSchema(workingTable, compiled.workflow.steps[0]);
  });

  return schemaByBlockId;
}

export function parseWorkflowJson(text: string): WorkspaceWorkflowResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      workflow: null,
      issues: [
        {
          code: 'invalidJson',
          message: error instanceof Error ? error.message : 'Workflow JSON could not be parsed.',
        },
      ],
    };
  }

  const validation = validateWorkflowStructure(parsed);

  if (!validation.valid || !validation.workflow) {
    return {
      workflow: null,
      issues: validation.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  return {
    workflow: validation.workflow,
    issues: [],
  };
}

export function workflowToJson(workflow: Workflow) {
  return `${JSON.stringify(workflow, null, 2)}\n`;
}

export function createWorkspacePromptSnapshot(workspace: Blockly.Workspace) {
  registerWorkflowBlocks();

  const metadata = getWorkspaceMetadata(workspace);
  const topBlocks = sortBlocksByPosition(workspace.getTopBlocks(false));
  const serializedBlocks = topBlocks
    .map((block) =>
      sanitizePromptBlockState(
        Blockly.serialization.blocks.save(block, {
          addCoordinates: false,
          addInputBlocks: true,
          addNextBlocks: true,
          doFullSerialization: false,
          saveIds: false,
        }) as Record<string, unknown> | null,
      ),
    )
    .filter((block): block is Record<string, unknown> => block !== null);

  return `${JSON.stringify(
    {
      metadata: {
        workflowId: metadata.workflowId,
        name: metadata.name,
        description: metadata.description,
      },
      topBlocks: serializedBlocks,
    },
    null,
    2,
  )}\n`;
}

function readStepChain(firstBlock: Blockly.Block | null): { steps: AuthoringStep[]; issues: EditorIssue[] } {
  const steps: AuthoringStep[] = [];
  const issues: EditorIssue[] = [];
  let block: Blockly.Block | null = firstBlock;

  while (block) {
    const stepResult = readStepBlock(block);

    if (stepResult.issues.length > 0 || !stepResult.step) {
      issues.push(...stepResult.issues);
      block = block.getNextBlock();
      continue;
    }

    steps.push(stepResult.step);
    block = block.getNextBlock();
  }

  return { steps, issues };
}

function sanitizePromptBlockState(state: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!state) {
    return null;
  }

  const sanitized: Record<string, unknown> = {
    type: state.type,
  };
  const fields = sanitizePromptValue(state.fields);
  const extraState = sanitizePromptValue(state.extraState);
  const inputs = sanitizePromptInputs(state.inputs);
  const next = sanitizePromptConnection(state.next);

  if (fields && typeof fields === 'object' && !Array.isArray(fields) && Object.keys(fields).length > 0) {
    sanitized.fields = fields;
  }

  if (extraState !== undefined) {
    sanitized.extraState = extraState;
  }

  if (inputs && Object.keys(inputs).length > 0) {
    sanitized.inputs = inputs;
  }

  if (next) {
    sanitized.next = next;
  }

  return sanitized;
}

function sanitizePromptInputs(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const sanitizedEntries = Object.entries(value).flatMap(([key, connection]) => {
    const sanitizedConnection = sanitizePromptConnection(connection);
    return sanitizedConnection ? [[key, sanitizedConnection] as const] : [];
  });

  return sanitizedEntries.length > 0 ? Object.fromEntries(sanitizedEntries) : null;
}

function sanitizePromptConnection(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const connection = value as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  const block = sanitizePromptBlockState(connection.block as Record<string, unknown> | null);
  const shadow = sanitizePromptBlockState(connection.shadow as Record<string, unknown> | null);

  if (block) {
    sanitized.block = block;
  }

  if (shadow) {
    sanitized.shadow = shadow;
  }

  return Object.keys(sanitized).length > 0 ? sanitized : null;
}

function sanitizePromptValue(value: unknown): unknown {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean'
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    const sanitizedItems = value
      .map((item) => sanitizePromptValue(item))
      .filter((item) => item !== undefined);

    return sanitizedItems.length > 0 ? sanitizedItems : undefined;
  }

  if (typeof value !== 'object') {
    return undefined;
  }

  const sanitizedEntries = Object.entries(value).flatMap(([key, nestedValue]) => {
    const sanitizedNestedValue = sanitizePromptValue(nestedValue);
    return sanitizedNestedValue === undefined ? [] : [[key, sanitizedNestedValue] as const];
  });

  return sanitizedEntries.length > 0 ? Object.fromEntries(sanitizedEntries) : undefined;
}

function getOrderedStepBlocks(workspace: Blockly.Workspace) {
  const orderedBlocks: Blockly.Block[] = [];

  sortBlocksByPosition(workspace.getTopBlocks(false)).forEach((topBlock) => {
    if (!isStepBlockType(topBlock.type)) {
      return;
    }

    let block: Blockly.Block | null = topBlock;

    while (block) {
      orderedBlocks.push(block);
      block = block.getNextBlock();
    }
  });

  return orderedBlocks;
}

function collectStepScopedBlocks(stepBlock: Blockly.Block) {
  const scopedBlocks: Blockly.Block[] = [];
  const visited = new Set<string>();

  const visit = (block: Blockly.Block | null, includeNext: boolean) => {
    if (!block || visited.has(block.id)) {
      return;
    }

    visited.add(block.id);
    scopedBlocks.push(block);

    block.inputList.forEach((input) => {
      const child = input.connection?.targetBlock() ?? null;
      visit(child, true);
    });

    if (includeNext) {
      visit(block.getNextBlock(), true);
    }
  };

  visit(stepBlock, false);
  return scopedBlocks;
}

function readStepBlock(block: Blockly.Block): { step?: AuthoringStep; issues: EditorIssue[] } {
  const stepMetadata = readBlockMetadata(block);

  switch (block.type) {
    case BLOCK_TYPES.commentStep:
      return {
        step: {
          kind: 'comment',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          text: getFieldString(block, 'TEXT'),
        },
        issues: [],
      };
    case BLOCK_TYPES.scopedRuleSingleStep: {
      const issues: EditorIssue[] = [];
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');
      const rowCondition = readOptionalExpression(block, 'ROW_CONDITION');
      const singlePatch = readAuthoringCellPatchActions(block, 'DEFAULT_ACTIONS');
      const resolvedColumnIds = 'issue' in columnIds ? [] : columnIds.columnIds;
      const resolvedRowCondition = 'issue' in rowCondition ? undefined : rowCondition.expression;

      if ('issue' in columnIds) {
        issues.push(columnIds.issue);
      }

      if ('issue' in rowCondition) {
        issues.push(rowCondition.issue);
      }

      issues.push(...singlePatch.issues);

      if (issues.length > 0) {
        return { issues };
      }

      if (!isAuthoringCellPatchEnabled(singlePatch.patch)) {
        return {
          issues: [
            {
              code: 'missingRuleCases',
              message: `Block '${block.type}' must define at least one action in 'do'.`,
              blockId: block.id,
              blockType: block.type,
            },
          ],
        };
      }

      return {
        step: {
          kind: 'scopedRule',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: resolvedColumnIds,
          rowCondition: resolvedRowCondition,
          mode: 'single',
          singlePatch: singlePatch.patch,
          cases: [],
          defaultPatch: createEmptyAuthoringCellPatch(),
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.scopedRuleCasesStep: {
      const issues: EditorIssue[] = [];
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');
      const rowCondition = readOptionalExpression(block, 'ROW_CONDITION');

      const defaultPatch = readAuthoringCellPatchActions(block, 'DEFAULT_ACTIONS');
      const cases = readOptionalRuleCases(block, 'CASES');
      const resolvedColumnIds = 'issue' in columnIds ? [] : columnIds.columnIds;
      const resolvedRowCondition = 'issue' in rowCondition ? undefined : rowCondition.expression;

      if ('issue' in columnIds) {
        issues.push(columnIds.issue);
      }

      if ('issue' in rowCondition) {
        issues.push(rowCondition.issue);
      }

      issues.push(...defaultPatch.issues);
      issues.push(...cases.issues);

      if (issues.length > 0) {
        return { issues };
      }

      const hasEffectiveCases = cases.cases.some((ruleCase) => isAuthoringCellPatchEnabled(ruleCase.then));
      const hasDefaultPatch = isAuthoringCellPatchEnabled(defaultPatch.patch);

      if (!hasEffectiveCases && !hasDefaultPatch) {
        return {
          issues: [
            {
              code: 'missingRuleCases',
              message: `Block '${block.type}' must define at least one case or a default patch.`,
              blockId: block.id,
              blockType: block.type,
            },
          ],
        };
      }

      return {
        step: {
          kind: 'scopedRule',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: resolvedColumnIds,
          rowCondition: resolvedRowCondition,
          mode: cases.caseCount === 0 && hasDefaultPatch ? 'single' : 'cases',
          singlePatch: cases.caseCount === 0 && hasDefaultPatch
            ? defaultPatch.patch
            : createEmptyAuthoringCellPatch(),
          cases: cases.cases,
          defaultPatch: cases.caseCount === 0 && hasDefaultPatch
            ? createEmptyAuthoringCellPatch()
            : defaultPatch.patch,
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.renameColumnStep:
      {
        const columnId = readRequiredColumnIdField(block, 'COLUMN_ID');

        if ('issue' in columnId) {
          return { issues: [columnId.issue] };
        }

        return {
          step: {
            kind: 'renameColumn',
            stepId: stepMetadata.stepId,
            sourceBlockId: block.id,
            sourceBlockType: block.type,
            columnId: columnId.columnId,
            newDisplayName: getFieldString(block, 'NEW_DISPLAY_NAME'),
          },
          issues: [],
        };
      }
    case BLOCK_TYPES.dropColumnsStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');

      if ('issue' in columnIds) {
        return { issues: [columnIds.issue] };
      }

      return {
        step: {
          kind: 'dropColumns',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: columnIds.columnIds,
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.deriveColumnStep: {
      const expression = readCreateColumnExpression(block);

      if ('issue' in expression) {
        return { issues: [expression.issue] };
      }

      return {
        step: {
          kind: 'deriveColumn',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          newColumn: readNewColumnFields(block),
          expression: expression.expression,
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.filterRowsStep: {
      const condition = readRequiredExpression(block, 'CONDITION');

      if ('issue' in condition) {
        return { issues: [condition.issue] };
      }

      return {
        step: {
          kind: 'filterRows',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          mode: getFieldString(block, 'MODE') as 'keep' | 'drop',
          condition: condition.expression,
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.splitColumnStep: {
      const columnId = readRequiredColumnIdField(block, 'COLUMN_ID');
      const outputColumns = readRequiredOutputColumns(block, 'OUTPUT_COLUMNS');

      if ('issue' in columnId) {
        return { issues: [columnId.issue] };
      }

      if ('issue' in outputColumns) {
        return { issues: [outputColumns.issue] };
      }

      return {
        step: {
          kind: 'splitColumn',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnId: columnId.columnId,
          delimiter: getFieldString(block, 'DELIMITER'),
          outputColumns: outputColumns.outputColumns,
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.combineColumnsStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');

      if ('issue' in columnIds) {
        return { issues: [columnIds.issue] };
      }

      return {
        step: {
          kind: 'combineColumns',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: columnIds.columnIds,
          separator: getFieldString(block, 'SEPARATOR'),
          newColumn: readNewColumnFields(block),
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.deduplicateRowsStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');

      if ('issue' in columnIds) {
        return { issues: [columnIds.issue] };
      }

      return {
        step: {
          kind: 'deduplicateRows',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: columnIds.columnIds,
        },
        issues: [],
      };
    }
    case BLOCK_TYPES.sortRowsStep: {
      const sorts = readRequiredSorts(block, 'SORTS');

      if ('issue' in sorts) {
        return { issues: [sorts.issue] };
      }

      return {
        step: {
          kind: 'sortRows',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          sorts: sorts.sorts,
        },
        issues: [],
      };
    }
    default:
      return {
        issues: [
          {
            code: 'unsupportedStepBlock',
            message: `Unsupported step block '${block.type}'.`,
            blockId: block.id,
            blockType: block.type,
          },
        ],
      };
  }
}

function readRequiredColumnIdsField(block: Blockly.Block, fieldName: string): { columnIds: string[] } | { issue: EditorIssue } {
  const columnIds = parseColumnSelectionValue(getFieldString(block, fieldName));

  if (columnIds.length === 0) {
    return {
      issue: {
        code: 'missingColumns',
        message: `Block '${block.type}' must target at least one column.`,
        blockId: block.id,
        blockType: block.type,
      },
    };
  }

  const missingColumnIds = findMissingColumnIds(block, columnIds);

  if (missingColumnIds.length > 0) {
    return { issue: missingColumnIssue(block, missingColumnIds) };
  }

  return { columnIds };
}

function readRequiredColumnIdField(block: Blockly.Block, fieldName: string): { columnId: string } | { issue: EditorIssue } {
  const columnId = getFieldString(block, fieldName);

  if (columnId === '') {
    return {
      issue: {
        code: 'missingColumn',
        message: `Block '${block.type}' must target a column.`,
        blockId: block.id,
        blockType: block.type,
      },
    };
  }

  const missingColumnIds = findMissingColumnIds(block, [columnId]);

  if (missingColumnIds.length > 0) {
    return { issue: missingColumnIssue(block, missingColumnIds) };
  }

  return { columnId };
}

function readRequiredOutputColumns(block: Blockly.Block, inputName: string) {
  const items = readStatementItems(block.getInputTargetBlock(inputName), BLOCK_TYPES.outputColumnItem, 'missingOutputColumns', (item) => ({
    columnId: getFieldString(item, 'COLUMN_ID'),
    displayName: getFieldString(item, 'DISPLAY_NAME'),
  }));

  return 'issue' in items ? items : { outputColumns: items.values };
}

function readRequiredSorts(block: Blockly.Block, inputName: string) {
  const items = readStatementItems(block.getInputTargetBlock(inputName), BLOCK_TYPES.sortItem, 'missingSorts', (item) => {
    const columnId = readRequiredColumnIdField(item, 'COLUMN_ID');

    if ('issue' in columnId) {
      throw columnId.issue;
    }

    return {
      columnId: columnId.columnId,
      direction: getFieldString(item, 'DIRECTION') as 'asc' | 'desc',
    };
  });

  return 'issue' in items ? items : { sorts: items.values };
}

function readOptionalExpression(block: Blockly.Block, inputName: string): { expression?: WorkflowExpression } | { issue: EditorIssue } {
  const expressionBlock = block.getInputTargetBlock(inputName);

  if (!expressionBlock) {
    return { expression: undefined };
  }

  return readExpression(expressionBlock);
}

function readAuthoringCellPatchActions(
  block: Blockly.Block,
  inputName: string,
): { patch: AuthoringCellPatch; actionCount: number; issues: EditorIssue[] } {
  let valueEnabled = false;
  let value: WorkflowExpression | undefined;
  let formatEnabled = false;
  let fillColor: string | undefined;
  let actionCount = 0;
  const issues: EditorIssue[] = [];
  let current = block.getInputTargetBlock(inputName);

  while (current) {
    actionCount += 1;

    if (current.type === BLOCK_TYPES.setValueActionItem) {
      if (valueEnabled) {
        issues.push(duplicateCellActionIssue(block, current, 'set cell'));
        current = current.getNextBlock();
        continue;
      }

      const expression = readRequiredExpression(current, 'VALUE');

      if ('issue' in expression) {
        issues.push(expression.issue);
        current = current.getNextBlock();
        continue;
      }

      valueEnabled = true;
      value = expression.expression;
      current = current.getNextBlock();
      continue;
    }

    if (current.type === BLOCK_TYPES.highlightActionItem) {
      if (formatEnabled) {
        issues.push(duplicateCellActionIssue(block, current, 'highlight'));
        current = current.getNextBlock();
        continue;
      }

      const colorLiteral = readRequiredColorLiteral(current, 'COLOR');

      if ('issue' in colorLiteral) {
        issues.push(colorLiteral.issue);
        current = current.getNextBlock();
        continue;
      }

      formatEnabled = true;
      fillColor = colorLiteral.fillColor;
      current = current.getNextBlock();
      continue;
    }

    issues.push({
        code: 'invalidCellActionBlock',
        message: `Block '${block.type}' contains unsupported action block '${current.type}'.`,
        blockId: current.id,
        blockType: current.type,
      });
    current = current.getNextBlock();
  }

  return {
    patch: {
      valueEnabled,
      ...(value ? { value } : {}),
      formatEnabled,
      ...(fillColor ? { fillColor } : {}),
    },
    actionCount,
    issues,
  };
}

function readOptionalColorLiteral(block: Blockly.Block, inputName: string): { fillColor?: string } | { issue: EditorIssue } {
  const colorBlock = block.getInputTargetBlock(inputName);

  if (!colorBlock) {
    return { fillColor: undefined };
  }

  if (colorBlock.type !== BLOCK_TYPES.literalColor) {
    return {
      issue: {
        code: 'invalidColorBlock',
        message: `Block '${block.type}' must use a color block for '${inputName}'.`,
        blockId: colorBlock.id,
        blockType: colorBlock.type,
      },
    };
  }

  return { fillColor: getFieldString(colorBlock, 'VALUE') };
}

function readRequiredColorLiteral(block: Blockly.Block, inputName: string): { fillColor: string } | { issue: EditorIssue } {
  const colorLiteral = readOptionalColorLiteral(block, inputName);

  if ('issue' in colorLiteral) {
    return colorLiteral;
  }

  if (!colorLiteral.fillColor) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  return {
    fillColor: colorLiteral.fillColor,
  };
}

function readOptionalRuleCases(block: Blockly.Block, inputName: string): { cases: AuthoringRuleCase[]; caseCount: number; issues: EditorIssue[] } {
  const cases: AuthoringRuleCase[] = [];
  let caseCount = 0;
  const issues: EditorIssue[] = [];
  let current = block.getInputTargetBlock(inputName);

  while (current) {
    caseCount += 1;

    if (current.type !== BLOCK_TYPES.ruleCaseItem) {
      issues.push({
          code: 'invalidCaseBlock',
          message: `Block '${block.type}' contains unsupported case block '${current.type}'.`,
          blockId: current.id,
          blockType: current.type,
        });
      current = current.getNextBlock();
      continue;
    }

    const when = readRequiredExpression(current, 'WHEN');
    const then = readAuthoringCellPatchActions(current, 'ACTIONS');

    if ('issue' in when) {
      issues.push(when.issue);
    }

    issues.push(...then.issues);

    if ('issue' in when || then.issues.length > 0) {
      current = current.getNextBlock();
      continue;
    }

    cases.push({
      when: when.expression,
      then: then.patch,
    });
    current = current.getNextBlock();
  }

  return { cases, caseCount, issues };
}

function isAuthoringCellPatchEnabled(patch: AuthoringCellPatch) {
  return patch.valueEnabled || patch.formatEnabled;
}

function createEmptyAuthoringCellPatch(): AuthoringCellPatch {
  return {
    valueEnabled: false,
    formatEnabled: false,
    fillColor: '#ffeb9c',
  };
}

function readRequiredExpression(block: Blockly.Block, inputName: string): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const expressionBlock = block.getInputTargetBlock(inputName);

  if (!expressionBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  return readExpression(expressionBlock);
}

function readExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  switch (block.type) {
    case BLOCK_TYPES.currentValueExpression:
      return { expression: { kind: 'value' } };
    case BLOCK_TYPES.caseValueExpression:
      return { expression: { kind: 'caseValue' } };
    case BLOCK_TYPES.literalString:
      return { expression: { kind: 'literal', value: getFieldString(block, 'VALUE') } };
    case BLOCK_TYPES.literalColor:
      return { expression: { kind: 'literal', value: getFieldString(block, 'VALUE') } };
    case BLOCK_TYPES.literalNumber:
      return { expression: { kind: 'literal', value: Number(block.getFieldValue('VALUE') ?? 0) } };
    case BLOCK_TYPES.literalBoolean:
      return { expression: { kind: 'literal', value: getFieldString(block, 'VALUE') === 'true' } };
    case BLOCK_TYPES.literalNull:
      return { expression: { kind: 'literal', value: null } };
    case BLOCK_TYPES.columnExpression:
      return { expression: { kind: 'column', columnId: getFieldString(block, 'COLUMN_ID') } };
    case BLOCK_TYPES.matchExpression:
      return readMatchExpression(block);
    case BLOCK_TYPES.trimFunction:
      return readUnaryCall(block, 'trim');
    case BLOCK_TYPES.lowerFunction:
      return readUnaryCall(block, 'lower');
    case BLOCK_TYPES.upperFunction:
      return readUnaryCall(block, 'upper');
    case BLOCK_TYPES.toNumberFunction:
      return readUnaryCall(block, 'toNumber');
    case BLOCK_TYPES.toStringFunction:
      return readUnaryCall(block, 'toString');
    case BLOCK_TYPES.toBooleanFunction:
      return readUnaryCall(block, 'toBoolean');
    case BLOCK_TYPES.collapseWhitespaceFunction:
      return readUnaryCall(block, 'collapseWhitespace');
    case BLOCK_TYPES.firstFunction:
      return readUnaryCall(block, 'first');
    case BLOCK_TYPES.lastFunction:
      return readUnaryCall(block, 'last');
    case BLOCK_TYPES.nowFunction:
      return {
        expression: {
          kind: 'call',
          name: 'now',
          args: [],
        },
      };
    case BLOCK_TYPES.datePartFunction: {
      const input = readRequiredExpression(block, 'INPUT');

      if ('issue' in input) {
        return input;
      }

      return {
        expression: {
          kind: 'call',
          name: 'datePart',
          args: [
            input.expression,
            { kind: 'literal', value: getFieldString(block, 'PART') },
          ],
        },
      };
    }
    case BLOCK_TYPES.dateDiffFunction: {
      const start = readRequiredExpression(block, 'START');

      if ('issue' in start) {
        return start;
      }

      const end = readRequiredExpression(block, 'END');

      if ('issue' in end) {
        return end;
      }

      return {
        expression: {
          kind: 'call',
          name: 'dateDiff',
          args: [
            start.expression,
            end.expression,
            { kind: 'literal', value: getFieldString(block, 'UNIT') },
          ],
        },
      };
    }
    case BLOCK_TYPES.dateAddFunction: {
      const input = readRequiredExpression(block, 'INPUT');

      if ('issue' in input) {
        return input;
      }

      const amount = readRequiredExpression(block, 'AMOUNT');

      if ('issue' in amount) {
        return amount;
      }

      return {
        expression: {
          kind: 'call',
          name: 'dateAdd',
          args: [
            input.expression,
            amount.expression,
            { kind: 'literal', value: getFieldString(block, 'UNIT') },
          ],
        },
      };
    }
    case BLOCK_TYPES.substringFunction:
      return readFixedArityCall(block, 'substring', ['INPUT', 'START', 'LENGTH']);
    case BLOCK_TYPES.replaceFunction:
      return readFixedArityCall(block, 'replace', ['INPUT', 'FROM', 'TO']);
    case BLOCK_TYPES.extractRegexFunction:
      return readFixedArityCall(block, 'extractRegex', ['INPUT', 'PATTERN']);
    case BLOCK_TYPES.replaceRegexFunction:
      return readFixedArityCall(block, 'replaceRegex', ['INPUT', 'PATTERN', 'REPLACEMENT']);
    case BLOCK_TYPES.splitFunction:
      return readFixedArityCall(block, 'split', ['INPUT', 'DELIMITER']);
    case BLOCK_TYPES.atIndexFunction:
      return readFixedArityCall(block, 'atIndex', ['INPUT', 'INDEX']);
    case BLOCK_TYPES.mathRoundingFunction:
      return readFixedArityCall(block, getFieldString(block, 'OPERATOR') as 'round' | 'floor' | 'ceil' | 'abs', ['INPUT']);
    case BLOCK_TYPES.coalesceFunction:
      return readFixedArityCall(block, 'coalesce', ['FIRST', 'SECOND']);
    case BLOCK_TYPES.concatFunction:
      return readConcatCall(block);
    case BLOCK_TYPES.arithmeticFunction:
      return readFixedArityCall(
        block,
        getFieldString(block, 'OPERATOR') as 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo',
        ['FIRST', 'SECOND'],
      );
    case BLOCK_TYPES.notFunction:
      return readUnaryCall(block, 'not');
    case BLOCK_TYPES.comparisonFunction:
      return readComparisonExpression(block);
    case BLOCK_TYPES.predicateFunction:
      return readPredicateExpression(block);
    case BLOCK_TYPES.unaryPredicateFunction:
      return readUnaryPredicateExpression(block);
    case BLOCK_TYPES.logicalBinaryFunction:
      return readLogicalBinaryExpression(block);
    default:
      return {
        issue: {
          code: 'invalidExpressionBlock',
          message: `Block '${block.type}' is not a supported expression block.`,
          blockId: block.id,
          blockType: block.type,
        },
      };
  }
}

function readUnaryCall(
  block: Blockly.Block,
  name: 'trim' | 'lower' | 'upper' | 'toNumber' | 'toString' | 'toBoolean' | 'collapseWhitespace' | 'first' | 'last' | 'not',
): { expression: WorkflowExpression } | { issue: EditorIssue } {
  return readFixedArityCall(block, name, ['INPUT']);
}

function readFixedArityCall(
  block: Blockly.Block,
  name:
    | 'now'
    | 'datePart'
    | 'dateDiff'
    | 'dateAdd'
    | 'substring'
    | 'replace'
    | 'extractRegex'
    | 'replaceRegex'
    | 'split'
    | 'atIndex'
    | 'round'
    | 'floor'
    | 'ceil'
    | 'abs'
    | 'add'
    | 'subtract'
    | 'multiply'
    | 'divide'
    | 'modulo'
    | 'coalesce'
    | 'concat'
    | 'trim'
    | 'lower'
    | 'upper'
    | 'toNumber'
    | 'toString'
    | 'toBoolean'
    | 'collapseWhitespace'
    | 'first'
    | 'last'
    | 'isEmpty'
    | 'not'
    | 'equals'
    | 'contains'
    | 'startsWith'
    | 'endsWith'
    | 'matchesRegex'
    | 'greaterThan'
    | 'lessThan'
    | 'and'
    | 'or',
  inputNames: string[],
): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const args: WorkflowExpression[] = [];

  for (const inputName of inputNames) {
    const expression = readRequiredExpression(block, inputName);

    if ('issue' in expression) {
      return expression;
    }

    args.push(expression.expression);
  }

  return {
    expression: {
      kind: 'call',
      name,
      args,
    },
  };
}

function readMatchExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const subject = readRequiredExpression(block, 'SUBJECT');

  if ('issue' in subject) {
    return subject;
  }

  const matchCases = readRequiredMatchCases(block, 'CASES');

  if ('issue' in matchCases) {
    return matchCases;
  }

  return {
    expression: {
      kind: 'match',
      subject: subject.expression,
      cases: matchCases.cases,
    },
  };
}

function readRequiredMatchCases(
  block: Blockly.Block,
  inputName: string,
): {
  cases: Extract<Extract<WorkflowExpression, { kind: 'match' }>['cases'], Array<unknown>>;
} | { issue: EditorIssue } {
  const firstBlock = block.getInputTargetBlock(inputName);

  if (!firstBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  const cases: Extract<Extract<WorkflowExpression, { kind: 'match' }>['cases'], Array<unknown>> = [];
  let current: Blockly.Block | null = firstBlock;

  while (current) {
    if (current.type !== BLOCK_TYPES.matchWhenCaseItem && current.type !== BLOCK_TYPES.matchOtherwiseCaseItem) {
      return {
        issue: {
          code: 'invalidMatchCaseBlock',
          message: `Block '${block.type}' contains unsupported case block '${current.type}'.`,
          blockId: current.id,
          blockType: current.type,
        },
      };
    }

    const then = readRequiredExpression(current, 'THEN');

    if ('issue' in then) {
      return then;
    }

    if (current.type === BLOCK_TYPES.matchWhenCaseItem) {
      const when = readRequiredExpression(current, 'WHEN');

      if ('issue' in when) {
        return when;
      }

      cases.push({
        kind: 'when',
        when: when.expression,
        then: then.expression,
      });
    } else {
      cases.push({
        kind: 'otherwise',
        then: then.expression,
      });
    }

    current = current.getNextBlock();
  }

  return { cases };
}

function readConcatCall(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  return readFlattenedBinaryCall(block, 'concat', ['FIRST', 'SECOND']);
}

function readFlattenedBinaryCall(
  block: Blockly.Block,
  name: 'concat' | 'and' | 'or',
  inputNames: [string, string],
): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const result = readFixedArityCall(block, name, inputNames);

  if ('issue' in result) {
    return result;
  }

  return {
    expression: flattenCallExpression(result.expression, name),
  };
}

function readComparisonExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const first = readRequiredExpression(block, 'FIRST');
  const second = readRequiredExpression(block, 'SECOND');

  if ('issue' in first) {
    return first;
  }

  if ('issue' in second) {
    return second;
  }

  return {
    expression: createComparatorExpression(
      getFieldString(block, 'OPERATOR') as 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
      first.expression,
      second.expression,
    ),
  };
}

function readPredicateExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const operator = getFieldString(block, 'OPERATOR') as 'contains' | 'startsWith' | 'endsWith' | 'matchesRegex';

  return readFixedArityCall(block, operator, ['FIRST', 'SECOND']);
}

function readUnaryPredicateExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  return readFixedArityCall(block, getFieldString(block, 'OPERATOR') as 'isEmpty', ['INPUT']);
}

function readLogicalBinaryExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const operator = getFieldString(block, 'OPERATOR') as 'and' | 'or';
  const inputNames = getLogicalGroupInputNames(block);

  if (inputNames.length < 2) {
    return {
      issue: missingInputIssue(block, `ITEM${inputNames.length}`),
    };
  }

  const args: WorkflowExpression[] = [];

  for (const inputName of inputNames) {
    const expression = readRequiredExpression(block, inputName);

    if ('issue' in expression) {
      return expression;
    }

    args.push(expression.expression);
  }

  return {
    expression: flattenCallExpression(
      {
        kind: 'call',
        name: operator,
        args,
      },
      operator,
    ),
  };
}

function flattenCallExpression(expression: WorkflowExpression, name: 'concat' | 'and' | 'or'): WorkflowExpression {
  if (expression.kind !== 'call' || expression.name !== name) {
    return expression;
  }

  return {
    kind: 'call',
    name,
    args: expression.args.flatMap((argument) => {
      const flattened = flattenCallExpression(argument, name);
      return flattened.kind === 'call' && flattened.name === name ? flattened.args : [flattened];
    }),
  };
}

function createComparatorExpression(
  operator: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  first: WorkflowExpression,
  second: WorkflowExpression,
): WorkflowExpression {
  switch (operator) {
    case 'eq':
      return {
        kind: 'call',
        name: 'equals',
        args: [first, second],
      };
    case 'ne':
      return {
        kind: 'call',
        name: 'not',
        args: [{
          kind: 'call',
          name: 'equals',
          args: [first, second],
        }],
      };
    case 'lt':
      return {
        kind: 'call',
        name: 'lessThan',
        args: [first, second],
      };
    case 'lte':
      return {
        kind: 'call',
        name: 'or',
        args: [
          {
            kind: 'call',
            name: 'lessThan',
            args: [first, second],
          },
          {
            kind: 'call',
            name: 'equals',
            args: [first, second],
          },
        ],
      };
    case 'gt':
      return {
        kind: 'call',
        name: 'greaterThan',
        args: [first, second],
      };
    case 'gte':
      return {
        kind: 'call',
        name: 'or',
        args: [
          {
            kind: 'call',
            name: 'greaterThan',
            args: [first, second],
          },
          {
            kind: 'call',
            name: 'equals',
            args: [first, second],
          },
        ],
      };
    default:
      return {
        kind: 'call',
        name: 'equals',
        args: [first, second],
      };
  }
}

function detectComparatorExpression(expression: Extract<WorkflowExpression, { kind: 'call' }>) {
  switch (expression.name) {
    case 'equals':
      return {
        operator: 'eq' as const,
        first: expression.args[0],
        second: expression.args[1],
      };
    case 'lessThan':
      return {
        operator: 'lt' as const,
        first: expression.args[0],
        second: expression.args[1],
      };
    case 'greaterThan':
      return {
        operator: 'gt' as const,
        first: expression.args[0],
        second: expression.args[1],
      };
    case 'not': {
      const candidate = expression.args[0];

      if (candidate?.kind === 'call' && candidate.name === 'equals') {
        return {
          operator: 'ne' as const,
          first: candidate.args[0],
          second: candidate.args[1],
        };
      }

      return null;
    }
    case 'or':
      return detectRangeComparatorExpression(expression);
    default:
      return null;
  }
}

function detectRangeComparatorExpression(expression: Extract<WorkflowExpression, { kind: 'call' }>) {
  if (expression.args.length !== 2) {
    return null;
  }

  const [left, right] = expression.args;

  const lessThanMatch = matchComparatorPair(left, right, 'lessThan');

  if (lessThanMatch) {
    return {
      operator: 'lte' as const,
      first: lessThanMatch.first,
      second: lessThanMatch.second,
    };
  }

  const greaterThanMatch = matchComparatorPair(left, right, 'greaterThan');

  if (greaterThanMatch) {
    return {
      operator: 'gte' as const,
      first: greaterThanMatch.first,
      second: greaterThanMatch.second,
    };
  }

  return null;
}

function matchComparatorPair(
  left: WorkflowExpression,
  right: WorkflowExpression,
  comparisonName: 'lessThan' | 'greaterThan',
) {
  const direct = matchComparatorPairOrder(left, right, comparisonName);

  if (direct) {
    return direct;
  }

  return matchComparatorPairOrder(right, left, comparisonName);
}

function matchComparatorPairOrder(
  comparisonExpression: WorkflowExpression,
  equalsExpression: WorkflowExpression,
  comparisonName: 'lessThan' | 'greaterThan',
) {
  if (comparisonExpression.kind !== 'call' || comparisonExpression.name !== comparisonName) {
    return null;
  }

  if (equalsExpression.kind !== 'call' || equalsExpression.name !== 'equals') {
    return null;
  }

  if (
    sameExpression(comparisonExpression.args[0], equalsExpression.args[0])
    && sameExpression(comparisonExpression.args[1], equalsExpression.args[1])
  ) {
    return {
      first: comparisonExpression.args[0],
      second: comparisonExpression.args[1],
    };
  }

  return null;
}

function sameExpression(left: WorkflowExpression, right: WorkflowExpression) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getLogicalGroupInputNames(block: Blockly.Block) {
  const inputNames: string[] = [];
  let index = 0;

  while (block.getInput(`ITEM${index}`)) {
    inputNames.push(`ITEM${index}`);
    index += 1;
  }

  return inputNames;
}

function readStatementItems<T>(
  firstBlock: Blockly.Block | null,
  expectedType: string,
  missingCode: string,
  mapper: (block: Blockly.Block) => T,
): { values: T[] } | { issue: EditorIssue } {
  if (!firstBlock) {
    return {
      issue: {
        code: missingCode,
        message: `A '${expectedType}' selection is required.`,
      },
    };
  }

  const values: T[] = [];
  let block: Blockly.Block | null = firstBlock;

  while (block) {
    if (block.type !== expectedType) {
      return {
        issue: {
          code: 'invalidListItem',
          message: `Expected block '${expectedType}' but found '${block.type}'.`,
          blockId: block.id,
          blockType: block.type,
        },
      };
    }

    try {
      values.push(mapper(block));
    } catch (error) {
      return {
        issue: error as EditorIssue,
      };
    }

    block = block.getNextBlock();
  }

  return { values };
}

function createStepBlockFromAuthoringStep(workspace: Blockly.Workspace, step: AuthoringStep, isTopBlock: boolean) {
  switch (step.kind) {
    case 'comment':
      return createCommentBlock(workspace, step, isTopBlock);
    case 'scopedRule':
      return createScopedRuleBlock(workspace, step, isTopBlock);
    case 'dropColumns':
      return createDropColumnsBlock(workspace, step, isTopBlock);
    case 'renameColumn':
      return createRenameColumnBlock(workspace, step, isTopBlock);
    case 'deriveColumn':
      return createDeriveColumnBlock(workspace, step, isTopBlock);
    case 'filterRows':
      return createFilterRowsBlock(workspace, step, isTopBlock);
    case 'splitColumn':
      return createSplitColumnBlock(workspace, step, isTopBlock);
    case 'combineColumns':
      return createCombineColumnsBlock(workspace, step, isTopBlock);
    case 'deduplicateRows':
      return createDeduplicateRowsBlock(workspace, step, isTopBlock);
    case 'sortRows':
      return createSortRowsBlock(workspace, step, isTopBlock);
    default:
      throw new Error(`Unsupported authoring step '${(step as AuthoringStep).kind}'.`);
  }
}

function createCommentBlock(workspace: Blockly.Workspace, step: AuthoringCommentStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.commentStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(step.text, 'TEXT');
  return block;
}

function createScopedRuleBlock(workspace: Blockly.Workspace, step: AuthoringScopedRuleStep, isTopBlock: boolean) {
  const block = createBlock(
    workspace,
    step.mode === 'single' ? BLOCK_TYPES.scopedRuleSingleStep : BLOCK_TYPES.scopedRuleCasesStep,
    isTopBlock ? 24 : undefined,
    isTopBlock ? 24 : undefined,
  );

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(serializeColumnSelectionValue(step.columnIds), 'COLUMN_IDS');

  if (step.rowCondition) {
    connectValueBlock(block, 'ROW_CONDITION', createExpressionBlock(workspace, step.rowCondition));
  }

  connectStatementChain(
    block,
    'DEFAULT_ACTIONS',
    createCellActionBlocks(workspace, step.mode === 'single' ? step.singlePatch : step.defaultPatch),
  );

  if (step.mode === 'cases' && step.cases.length > 0) {
    connectStatementChain(block, 'CASES', step.cases.map((ruleCase) => createRuleCaseBlock(workspace, ruleCase)));
  }

  return block;
}

function createRuleCaseBlock(workspace: Blockly.Workspace, ruleCase: AuthoringRuleCase) {
  const block = createBlock(workspace, BLOCK_TYPES.ruleCaseItem);

  connectValueBlock(block, 'WHEN', createExpressionBlock(workspace, ruleCase.when));
  connectStatementChain(block, 'ACTIONS', createCellActionBlocks(workspace, ruleCase.then));

  return block;
}

function createCellActionBlocks(workspace: Blockly.Workspace, patch: AuthoringCellPatch) {
  const blocks: Blockly.Block[] = [];

  if (patch.valueEnabled && patch.value) {
    const setValueBlock = createBlock(workspace, BLOCK_TYPES.setValueActionItem);

    connectValueBlock(setValueBlock, 'VALUE', createExpressionBlock(workspace, patch.value));
    blocks.push(setValueBlock);
  }

  if (patch.formatEnabled && patch.fillColor) {
    const highlightBlock = createBlock(workspace, BLOCK_TYPES.highlightActionItem);

    connectValueBlock(highlightBlock, 'COLOR', createColorLiteralBlock(workspace, patch.fillColor));
    blocks.push(highlightBlock);
  }

  return blocks;
}

function createRenameColumnBlock(workspace: Blockly.Workspace, step: AuthoringRenameColumnStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.renameColumnStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(step.columnId, 'COLUMN_ID');
  block.setFieldValue(step.newDisplayName, 'NEW_DISPLAY_NAME');
  return block;
}

function createDropColumnsBlock(workspace: Blockly.Workspace, step: AuthoringDropColumnsStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.dropColumnsStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(serializeColumnSelectionValue(step.columnIds), 'COLUMN_IDS');
  return block;
}

function createDeriveColumnBlock(workspace: Blockly.Workspace, step: AuthoringDeriveColumnStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.deriveColumnStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);
  const mode = inferCreateColumnMode(step.expression);

  setBlockMetadata(block, step.stepId);
  setNewColumnFields(block, step.newColumn.columnId, step.newColumn.displayName);
  block.setFieldValue(mode, 'CREATE_MODE');

  if (mode === CREATE_COLUMN_MODES.copy && step.expression.kind === 'column') {
    block.setFieldValue(step.expression.columnId, 'COPY_COLUMN_ID');
  }

  if (mode === CREATE_COLUMN_MODES.expression) {
    connectValueBlock(block, 'EXPRESSION', createExpressionBlock(workspace, step.expression));
  }

  return block;
}

function createFilterRowsBlock(workspace: Blockly.Workspace, step: AuthoringFilterRowsStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.filterRowsStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(step.mode, 'MODE');
  connectValueBlock(block, 'CONDITION', createExpressionBlock(workspace, step.condition));
  return block;
}

function createSplitColumnBlock(workspace: Blockly.Workspace, step: AuthoringSplitColumnStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.splitColumnStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(step.columnId, 'COLUMN_ID');
  block.setFieldValue(step.delimiter, 'DELIMITER');
  connectStatementChain(block, 'OUTPUT_COLUMNS', createOutputColumnBlocks(workspace, step.outputColumns));
  return block;
}

function createCombineColumnsBlock(workspace: Blockly.Workspace, step: AuthoringCombineColumnsStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.combineColumnsStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(serializeColumnSelectionValue(step.columnIds), 'COLUMN_IDS');
  block.setFieldValue(step.separator, 'SEPARATOR');
  setNewColumnFields(block, step.newColumn.columnId, step.newColumn.displayName);
  return block;
}

function createDeduplicateRowsBlock(workspace: Blockly.Workspace, step: AuthoringDeduplicateRowsStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.deduplicateRowsStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(serializeColumnSelectionValue(step.columnIds), 'COLUMN_IDS');
  return block;
}

function createSortRowsBlock(workspace: Blockly.Workspace, step: AuthoringSortRowsStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.sortRowsStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  connectStatementChain(block, 'SORTS', createSortBlocks(workspace, step.sorts));
  return block;
}

function createOutputColumnBlocks(workspace: Blockly.Workspace, outputColumns: Array<{ columnId: string; displayName: string }>) {
  return outputColumns.map((outputColumn) => {
    const block = createBlock(workspace, BLOCK_TYPES.outputColumnItem);

    block.setFieldValue(outputColumn.columnId, 'COLUMN_ID');
    block.setFieldValue(outputColumn.displayName, 'DISPLAY_NAME');
    return block;
  });
}

function createSortBlocks(workspace: Blockly.Workspace, sorts: Array<{ columnId: string; direction: 'asc' | 'desc' }>) {
  return sorts.map((sort) => {
    const block = createBlock(workspace, BLOCK_TYPES.sortItem);

    block.setFieldValue(sort.columnId, 'COLUMN_ID');
    block.setFieldValue(sort.direction, 'DIRECTION');
    return block;
  });
}

function createLiteralBlock(workspace: Blockly.Workspace, value: string | number | boolean | null) {
  if (value === null) {
    return createBlock(workspace, BLOCK_TYPES.literalNull);
  }

  if (typeof value === 'string') {
    const block = isValidFillColor(value)
      ? createBlock(workspace, BLOCK_TYPES.literalColor)
      : createBlock(workspace, BLOCK_TYPES.literalString);

    block.setFieldValue(value, 'VALUE');
    return block;
  }

  if (typeof value === 'number') {
    const block = createBlock(workspace, BLOCK_TYPES.literalNumber);

    block.setFieldValue(String(value), 'VALUE');
    return block;
  }

  const block = createBlock(workspace, BLOCK_TYPES.literalBoolean);

  block.setFieldValue(value ? 'true' : 'false', 'VALUE');
  return block;
}

function createColorLiteralBlock(workspace: Blockly.Workspace, value: string) {
  const block = createBlock(workspace, BLOCK_TYPES.literalColor);

  block.setFieldValue(value, 'VALUE');
  return block;
}

function createExpressionBlock(workspace: Blockly.Workspace, expression: WorkflowExpression): Blockly.Block {
  switch (expression.kind) {
    case 'value':
      return createBlock(workspace, BLOCK_TYPES.currentValueExpression);
    case 'caseValue':
      return createBlock(workspace, BLOCK_TYPES.caseValueExpression);
    case 'literal':
      return createLiteralBlock(workspace, expression.value);
    case 'column': {
      const block = createBlock(workspace, BLOCK_TYPES.columnExpression);

      block.setFieldValue(expression.columnId, 'COLUMN_ID');
      return block;
    }
    case 'match':
      return createMatchExpressionBlock(workspace, expression);
    case 'call': {
      const block = createCallBlock(workspace, expression);
      return block;
    }
    default:
      throw new Error(`Unsupported expression kind '${(expression as WorkflowExpression).kind}'.`);
  }
}

function createMatchExpressionBlock(
  workspace: Blockly.Workspace,
  expression: Extract<WorkflowExpression, { kind: 'match' }>,
) {
  const block = createBlock(workspace, BLOCK_TYPES.matchExpression);

  connectValueBlock(block, 'SUBJECT', createExpressionBlock(workspace, expression.subject));
  connectStatementChain(block, 'CASES', expression.cases.map((matchCase) => createMatchCaseBlock(workspace, matchCase)));
  return block;
}

function createMatchCaseBlock(
  workspace: Blockly.Workspace,
  matchCase: Extract<WorkflowExpression, { kind: 'match' }>['cases'][number],
) {
  if (matchCase.kind === 'when') {
    const block = createBlock(workspace, BLOCK_TYPES.matchWhenCaseItem);

    connectValueBlock(block, 'WHEN', createExpressionBlock(workspace, matchCase.when));
    connectValueBlock(block, 'THEN', createExpressionBlock(workspace, matchCase.then));
    return block;
  }

  const block = createBlock(workspace, BLOCK_TYPES.matchOtherwiseCaseItem);
  connectValueBlock(block, 'THEN', createExpressionBlock(workspace, matchCase.then));
  return block;
}

function createCallBlock(workspace: Blockly.Workspace, expression: Extract<WorkflowExpression, { kind: 'call' }>) {
  const comparatorExpression = detectComparatorExpression(expression);

  if (comparatorExpression) {
    const block = createBlock(workspace, BLOCK_TYPES.comparisonFunction);

    block.setFieldValue(comparatorExpression.operator, 'OPERATOR');
    connectValueBlock(block, 'FIRST', createExpressionBlock(workspace, comparatorExpression.first));
    connectValueBlock(block, 'SECOND', createExpressionBlock(workspace, comparatorExpression.second));
    return block;
  }

  switch (expression.name) {
    case 'now':
      return createBlock(workspace, BLOCK_TYPES.nowFunction);
    case 'datePart': {
      const block = createBlock(workspace, BLOCK_TYPES.datePartFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      block.setFieldValue(getRequiredLiteralStringArgument(expression, 1), 'PART');
      return block;
    }
    case 'dateDiff': {
      const block = createBlock(workspace, BLOCK_TYPES.dateDiffFunction);

      connectValueBlock(block, 'START', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'END', createExpressionBlock(workspace, expression.args[1]));
      block.setFieldValue(getRequiredLiteralStringArgument(expression, 2), 'UNIT');
      return block;
    }
    case 'dateAdd': {
      const block = createBlock(workspace, BLOCK_TYPES.dateAddFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'AMOUNT', createExpressionBlock(workspace, expression.args[1]));
      block.setFieldValue(getRequiredLiteralStringArgument(expression, 2), 'UNIT');
      return block;
    }
    case 'round':
    case 'floor':
    case 'ceil':
    case 'abs': {
      const block = createBlock(workspace, BLOCK_TYPES.mathRoundingFunction);

      block.setFieldValue(expression.name, 'OPERATOR');
      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      return block;
    }
    case 'trim':
    case 'lower':
    case 'upper':
    case 'toNumber':
    case 'toString':
    case 'toBoolean':
    case 'collapseWhitespace':
    case 'first':
    case 'last':
    case 'not': {
      const blockType = {
        trim: BLOCK_TYPES.trimFunction,
        lower: BLOCK_TYPES.lowerFunction,
        upper: BLOCK_TYPES.upperFunction,
        toNumber: BLOCK_TYPES.toNumberFunction,
        toString: BLOCK_TYPES.toStringFunction,
        toBoolean: BLOCK_TYPES.toBooleanFunction,
        collapseWhitespace: BLOCK_TYPES.collapseWhitespaceFunction,
        first: BLOCK_TYPES.firstFunction,
        last: BLOCK_TYPES.lastFunction,
        not: BLOCK_TYPES.notFunction,
      }[expression.name];
      const block = createBlock(workspace, blockType);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      return block;
    }
    case 'substring': {
      const block = createBlock(workspace, BLOCK_TYPES.substringFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'START', createExpressionBlock(workspace, expression.args[1]));
      connectValueBlock(block, 'LENGTH', createExpressionBlock(workspace, expression.args[2]));
      return block;
    }
    case 'replace': {
      const block = createBlock(workspace, BLOCK_TYPES.replaceFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'FROM', createExpressionBlock(workspace, expression.args[1]));
      connectValueBlock(block, 'TO', createExpressionBlock(workspace, expression.args[2]));
      return block;
    }
    case 'extractRegex': {
      const block = createBlock(workspace, BLOCK_TYPES.extractRegexFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'PATTERN', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    case 'replaceRegex': {
      const block = createBlock(workspace, BLOCK_TYPES.replaceRegexFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'PATTERN', createExpressionBlock(workspace, expression.args[1]));
      connectValueBlock(block, 'REPLACEMENT', createExpressionBlock(workspace, expression.args[2]));
      return block;
    }
    case 'split': {
      const block = createBlock(workspace, BLOCK_TYPES.splitFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'DELIMITER', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    case 'atIndex': {
      const block = createBlock(workspace, BLOCK_TYPES.atIndexFunction);

      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'INDEX', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    case 'coalesce': {
      const block = createBlock(workspace, BLOCK_TYPES.coalesceFunction);

      connectValueBlock(block, 'FIRST', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'SECOND', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide':
    case 'modulo': {
      const block = createBlock(workspace, BLOCK_TYPES.arithmeticFunction);

      block.setFieldValue(expression.name, 'OPERATOR');
      connectValueBlock(block, 'FIRST', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'SECOND', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'matchesRegex': {
      const block = createBlock(workspace, BLOCK_TYPES.predicateFunction);

      block.setFieldValue(expression.name, 'OPERATOR');

      connectValueBlock(block, 'FIRST', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'SECOND', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    case 'isEmpty': {
      const block = createBlock(workspace, BLOCK_TYPES.unaryPredicateFunction);

      block.setFieldValue(expression.name, 'OPERATOR');
      connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
      return block;
    }
    case 'and':
    case 'or': {
      const flattenedExpression = flattenCallExpression(expression, expression.name) as Extract<WorkflowExpression, { kind: 'call' }>;
      const block = createBlock(workspace, BLOCK_TYPES.logicalBinaryFunction);
      const logicalBlock = block as Blockly.Block & {
        loadExtraState?: (state: { itemCount?: number }) => void;
        itemCount_?: number;
        updateShape_?: () => void;
      };

      logicalBlock.loadExtraState?.({ itemCount: Math.max(2, flattenedExpression.args.length) });

      if (!logicalBlock.loadExtraState) {
        logicalBlock.itemCount_ = Math.max(2, flattenedExpression.args.length);
        logicalBlock.updateShape_?.();
      }

      block.setFieldValue(flattenedExpression.name, 'OPERATOR');

      flattenedExpression.args.forEach((argument: WorkflowExpression, index: number) => {
        connectValueBlock(block, `ITEM${index}`, createExpressionBlock(workspace, argument));
      });

      return block;
    }
    case 'concat': {
      if (expression.args.length > 2) {
        return createCallBlock(workspace, {
          kind: 'call',
          name: expression.name,
          args: [expression.args[0], { kind: 'call', name: expression.name, args: expression.args.slice(1) }],
        });
      }

      const block = createBlock(workspace, BLOCK_TYPES.concatFunction);

      connectValueBlock(block, 'FIRST', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'SECOND', createExpressionBlock(workspace, expression.args[1]));
      return block;
    }
    default:
      throw new Error(`Unsupported expression call '${expression.name}'.`);
  }
}

function createBlock(workspace: Blockly.Workspace, type: string, x?: number, y?: number) {
  const block = workspace.newBlock(type);

  finalizeBlock(block);

  if (typeof x === 'number' && typeof y === 'number' && 'moveBy' in block) {
    (block as Blockly.BlockSvg).moveBy(x, y);
  }

  return block;
}

function getRequiredLiteralStringArgument(
  expression: Extract<WorkflowExpression, { kind: 'call' }>,
  index: number,
) {
  const argument = expression.args[index];

  if (argument?.kind !== 'literal' || typeof argument.value !== 'string') {
    throw new Error(`Function '${expression.name}' requires a string literal at args[${index}] for Blockly reconstruction.`);
  }

  return argument.value;
}

function finalizeBlock(block: Blockly.Block) {
  if ('initSvg' in block) {
    (block as Blockly.BlockSvg).initSvg();
  }

  if ('render' in block) {
    (block as Blockly.BlockSvg).render();
  }
}

function finalizeWorkspace(workspace: Blockly.Workspace) {
  if ('render' in workspace) {
    (workspace as Blockly.WorkspaceSvg).render();
  }
}

function connectStepChain(blocks: Blockly.Block[]) {
  for (let index = 0; index < blocks.length - 1; index += 1) {
    blocks[index].nextConnection?.connect(blocks[index + 1].previousConnection!);
  }
}

function connectStatementChain(parent: Blockly.Block, inputName: string, blocks: Blockly.Block[]) {
  const inputConnection = parent.getInput(inputName)?.connection;

  if (!inputConnection || blocks.length === 0) {
    return;
  }

  inputConnection.connect(blocks[0].previousConnection!);

  for (let index = 0; index < blocks.length - 1; index += 1) {
    blocks[index].nextConnection?.connect(blocks[index + 1].previousConnection!);
  }
}

function connectValueBlock(parent: Blockly.Block, inputName: string, child: Blockly.Block) {
  const connection = parent.getInput(inputName)?.connection;

  if (!connection || !child.outputConnection) {
    return;
  }

  connection.connect(child.outputConnection);
}

function createSchemaProjectionTable(table: Table): Table {
  return {
    tableId: table.tableId,
    sourceName: table.sourceName,
    schema: {
      columns: table.schema.columns.map((column) => ({ ...column })),
    },
    rowsById: {},
    rowOrder: [],
    importWarnings: [],
  };
}

function getFieldString(block: Blockly.Block, fieldName: string) {
  return String(block.getFieldValue(fieldName) ?? '');
}

function readCreateColumnExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const mode = getCreateColumnMode(block);

  switch (mode) {
    case CREATE_COLUMN_MODES.blank:
      return {
        expression: {
          kind: 'literal',
          value: null,
        },
      };
    case CREATE_COLUMN_MODES.copy:
      {
        const copyColumnId = readRequiredColumnIdField(block, 'COPY_COLUMN_ID');

        if ('issue' in copyColumnId) {
          return { issue: copyColumnId.issue };
        }

        return {
          expression: {
            kind: 'column',
            columnId: copyColumnId.columnId,
          },
        };
      }
    case CREATE_COLUMN_MODES.expression:
      return readRequiredExpression(block, 'EXPRESSION');
    default:
      return {
        issue: {
          code: 'invalidCreateColumnMode',
          message: `Block '${block.type}' has an unsupported create-column mode '${String(mode)}'.`,
          blockId: block.id,
          blockType: block.type,
        },
      };
  }
}

function readNewColumnFields(block: Blockly.Block) {
  return {
    columnId: getFieldString(block, 'NEW_COLUMN_ID'),
    displayName: getFieldString(block, 'NEW_DISPLAY_NAME'),
  };
}

function setNewColumnFields(block: Blockly.Block, columnId: string, displayName: string) {
  block.setFieldValue(columnId, 'NEW_COLUMN_ID');
  block.setFieldValue(displayName, 'NEW_DISPLAY_NAME');
}

function getCreateColumnMode(block: Blockly.Block): CreateColumnMode {
  const value = getFieldString(block, 'CREATE_MODE');

  switch (value) {
    case CREATE_COLUMN_MODES.copy:
      return CREATE_COLUMN_MODES.copy;
    case CREATE_COLUMN_MODES.expression:
      return CREATE_COLUMN_MODES.expression;
    case CREATE_COLUMN_MODES.blank:
    default:
      return CREATE_COLUMN_MODES.blank;
  }
}

function inferCreateColumnMode(expression: WorkflowExpression): CreateColumnMode {
  if (expression.kind === 'literal' && expression.value === null) {
    return CREATE_COLUMN_MODES.blank;
  }

  if (expression.kind === 'column') {
    return CREATE_COLUMN_MODES.copy;
  }

  return CREATE_COLUMN_MODES.expression;
}

function findMissingColumnIds(block: Blockly.Block, columnIds: string[]) {
  if (!hasEditorSchemaForBlock(block.id)) {
    return [];
  }

  const availableColumnIds = new Set(getEditorSchemaColumns(block.id).map((column) => column.columnId));

  return columnIds
    .filter((columnId) => columnId !== '' && !availableColumnIds.has(columnId))
    .filter((columnId, index, values) => values.indexOf(columnId) === index);
}

function missingColumnIssue(block: Blockly.Block, columnIds: string[]): EditorIssue {
  const quotedColumnIds = columnIds.map((columnId) => `'${columnId}'`).join(', ');
  const label = columnIds.length === 1 ? 'column' : 'columns';
  const verb = columnIds.length === 1 ? 'does' : 'do';

  return {
    code: 'missingColumn',
    message: `Block '${block.type}' references missing ${label} ${quotedColumnIds} that ${verb} not exist in the current schema at this step.`,
    blockId: block.id,
    blockType: block.type,
  };
}

function missingInputIssue(block: Blockly.Block, inputName: string): EditorIssue {
  return {
    code: 'missingInput',
    message: `Block '${block.type}' is missing required input '${inputName}'.`,
    blockId: block.id,
    blockType: block.type,
  };
}

function orphanBlockIssue(block: Blockly.Block): EditorIssue {
  return {
    code: 'orphanBlock',
    message: `Block '${block.type}' is not connected to a workflow step.`,
    blockId: block.id,
    blockType: block.type,
  };
}

function duplicateCellActionIssue(containerBlock: Blockly.Block, actionBlock: Blockly.Block, actionLabel: string): EditorIssue {
  return {
    code: 'duplicateCellAction',
    message: `Block '${containerBlock.type}' cannot define more than one '${actionLabel}' action.`,
    blockId: actionBlock.id,
    blockType: actionBlock.type,
  };
}

function sortBlocksByPosition(blocks: Blockly.Block[]) {
  return [...blocks].sort((left, right) => {
    const leftPosition = getBlockPosition(left);
    const rightPosition = getBlockPosition(right);

    return leftPosition.y - rightPosition.y || leftPosition.x - rightPosition.x;
  });
}

function getBlockPosition(block: Blockly.Block) {
  if ('getRelativeToSurfaceXY' in block) {
    return (block as Blockly.BlockSvg).getRelativeToSurfaceXY();
  }

  return { x: 0, y: 0 };
}

function isStepBlockType(type: string) {
  return STEP_BLOCK_TYPES.has(type);
}

function readBlockMetadata(block: Blockly.Block): { stepId?: string } {
  if (!block.data) {
    return {};
  }

  try {
    const parsed = JSON.parse(block.data) as { stepId?: string };

    return parsed.stepId ? { stepId: parsed.stepId } : {};
  } catch {
    return {};
  }
}

function setBlockMetadata(block: Blockly.Block, stepId: string | undefined) {
  block.data = stepId ? JSON.stringify({ stepId }) : '';
}

function toTitleCase(value: string) {
  return (
    value
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (character) => character.toLocaleUpperCase()) || 'Workflow'
  );
}
