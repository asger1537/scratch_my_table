import * as Blockly from 'blockly';

import { type Table } from '../domain/model';
import { slugify } from '../domain/normalize';
import { cloneTable, executeValidatedWorkflow, validateWorkflowSemantics, validateWorkflowStructure, type Workflow, type WorkflowExpression } from '../workflow';

import {
  authoringWorkflowToWorkflow,
  normalizeWorkflowMetadata,
  type AuthoringCombineColumnsStep,
  type AuthoringDeduplicateRowsStep,
  type AuthoringDeriveColumnStep,
  type AuthoringDropColumnsStep,
  type AuthoringFilterRowsStep,
  type AuthoringRenameColumnStep,
  type AuthoringScopedTransformStep,
  type AuthoringSortRowsStep,
  type AuthoringSplitColumnStep,
  type AuthoringStep,
  type AuthoringWorkflow,
  type AuthoringWorkflowMetadata,
  workflowToAuthoringWorkflow,
} from './authoring';
import { parseColumnSelectionValue, serializeColumnSelectionValue } from './FieldColumnMultiSelect';
import { BLOCK_TYPES, CREATE_COLUMN_MODES, type CreateColumnMode, registerWorkflowBlocks } from './blocks';
import type { EditorIssue, WorkspaceWorkflowResult } from './types';

const workspaceMetadata = new WeakMap<Blockly.Workspace, AuthoringWorkflowMetadata>();
const STEP_BLOCK_TYPES = new Set<string>([
  BLOCK_TYPES.scopedTransformStep,
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

  const topBlocks = workspace.getTopBlocks(false);
  const orphanBlocks = topBlocks.filter((block) => !isStepBlockType(block.type));

  if (orphanBlocks.length > 0) {
    return {
      workflow: null,
      issues: orphanBlocks.map((block) => ({
        code: 'orphanBlock',
        message: `Block '${block.type}' is not connected to a workflow step.`,
        blockId: block.id,
        blockType: block.type,
      })),
    };
  }

  const steps: AuthoringStep[] = [];
  const issues: EditorIssue[] = [];

  sortBlocksByPosition(topBlocks).forEach((topBlock) => {
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
  let workingTable = cloneTable(table);

  getOrderedStepBlocks(workspace).forEach((block) => {
    const projectedColumns = workingTable.schema.columns.map((column) => ({ ...column }));

    collectStepScopedBlocks(block).forEach((scopedBlock) => {
      schemaByBlockId.set(scopedBlock.id, projectedColumns.map((column) => ({ ...column })));
    });

    const stepResult = readStepBlock(block);

    if (stepResult.issue) {
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

    workingTable = executeValidatedWorkflow(compiled.workflow, workingTable).transformedTable;
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

function readStepChain(firstBlock: Blockly.Block | null): { steps: AuthoringStep[]; issues: EditorIssue[] } {
  const steps: AuthoringStep[] = [];
  const issues: EditorIssue[] = [];
  let block: Blockly.Block | null = firstBlock;

  while (block) {
    const stepResult = readStepBlock(block);

    if (stepResult.issue) {
      issues.push(stepResult.issue);
      return { steps: [], issues };
    }

    steps.push(stepResult.step);
    block = block.getNextBlock();
  }

  return { steps, issues };
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

function readStepBlock(block: Blockly.Block): { step: AuthoringStep; issue?: EditorIssue } {
  const stepMetadata = readBlockMetadata(block);

  switch (block.type) {
    case BLOCK_TYPES.scopedTransformStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');
      const expression = readRequiredExpression(block, 'EXPRESSION');
      const rowCondition = readOptionalExpression(block, 'ROW_CONDITION');

      if ('issue' in columnIds) {
        return { step: undefined as never, issue: columnIds.issue };
      }

      if ('issue' in expression) {
        return { step: undefined as never, issue: expression.issue };
      }

      if ('issue' in rowCondition) {
        return { step: undefined as never, issue: rowCondition.issue };
      }

      return {
        step: {
          kind: 'scopedTransform',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: columnIds.columnIds,
          rowCondition: rowCondition.expression,
          expression: expression.expression,
        },
      };
    }
    case BLOCK_TYPES.renameColumnStep:
      return {
        step: {
          kind: 'renameColumn',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnId: getFieldString(block, 'COLUMN_ID'),
          newDisplayName: getFieldString(block, 'NEW_DISPLAY_NAME'),
        },
      };
    case BLOCK_TYPES.dropColumnsStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');

      if ('issue' in columnIds) {
        return { step: undefined as never, issue: columnIds.issue };
      }

      return {
        step: {
          kind: 'dropColumns',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: columnIds.columnIds,
        },
      };
    }
    case BLOCK_TYPES.deriveColumnStep: {
      const expression = readCreateColumnExpression(block);

      if ('issue' in expression) {
        return { step: undefined as never, issue: expression.issue };
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
      };
    }
    case BLOCK_TYPES.filterRowsStep: {
      const condition = readRequiredExpression(block, 'CONDITION');

      if ('issue' in condition) {
        return { step: undefined as never, issue: condition.issue };
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
      };
    }
    case BLOCK_TYPES.splitColumnStep: {
      const outputColumns = readRequiredOutputColumns(block, 'OUTPUT_COLUMNS');

      if ('issue' in outputColumns) {
        return { step: undefined as never, issue: outputColumns.issue };
      }

      return {
        step: {
          kind: 'splitColumn',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnId: getFieldString(block, 'COLUMN_ID'),
          delimiter: getFieldString(block, 'DELIMITER'),
          outputColumns: outputColumns.outputColumns,
        },
      };
    }
    case BLOCK_TYPES.combineColumnsStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');

      if ('issue' in columnIds) {
        return { step: undefined as never, issue: columnIds.issue };
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
      };
    }
    case BLOCK_TYPES.deduplicateRowsStep: {
      const columnIds = readRequiredColumnIdsField(block, 'COLUMN_IDS');

      if ('issue' in columnIds) {
        return { step: undefined as never, issue: columnIds.issue };
      }

      return {
        step: {
          kind: 'deduplicateRows',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          columnIds: columnIds.columnIds,
        },
      };
    }
    case BLOCK_TYPES.sortRowsStep: {
      const sorts = readRequiredSorts(block, 'SORTS');

      if ('issue' in sorts) {
        return { step: undefined as never, issue: sorts.issue };
      }

      return {
        step: {
          kind: 'sortRows',
          stepId: stepMetadata.stepId,
          sourceBlockId: block.id,
          sourceBlockType: block.type,
          sorts: sorts.sorts,
        },
      };
    }
    default:
      return {
        step: undefined as never,
        issue: {
          code: 'unsupportedStepBlock',
          message: `Unsupported step block '${block.type}'.`,
          blockId: block.id,
          blockType: block.type,
        },
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

  return { columnIds };
}

function readRequiredOutputColumns(block: Blockly.Block, inputName: string) {
  const items = readStatementItems(block.getInputTargetBlock(inputName), BLOCK_TYPES.outputColumnItem, 'missingOutputColumns', (item) => ({
    columnId: getFieldString(item, 'COLUMN_ID'),
    displayName: getFieldString(item, 'DISPLAY_NAME'),
  }));

  return 'issue' in items ? items : { outputColumns: items.values };
}

function readRequiredSorts(block: Blockly.Block, inputName: string) {
  const items = readStatementItems(block.getInputTargetBlock(inputName), BLOCK_TYPES.sortItem, 'missingSorts', (item) => ({
    columnId: getFieldString(item, 'COLUMN_ID'),
    direction: getFieldString(item, 'DIRECTION') as 'asc' | 'desc',
  }));

  return 'issue' in items ? items : { sorts: items.values };
}

function readOptionalExpression(block: Blockly.Block, inputName: string): { expression?: WorkflowExpression } | { issue: EditorIssue } {
  const expressionBlock = block.getInputTargetBlock(inputName);

  if (!expressionBlock) {
    return { expression: undefined };
  }

  return readExpression(expressionBlock);
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
    case BLOCK_TYPES.literalString:
      return { expression: { kind: 'literal', value: getFieldString(block, 'VALUE') } };
    case BLOCK_TYPES.literalNumber:
      return { expression: { kind: 'literal', value: Number(block.getFieldValue('VALUE') ?? 0) } };
    case BLOCK_TYPES.literalBoolean:
      return { expression: { kind: 'literal', value: getFieldString(block, 'VALUE') === 'true' } };
    case BLOCK_TYPES.literalNull:
      return { expression: { kind: 'literal', value: null } };
    case BLOCK_TYPES.columnExpression:
      return { expression: { kind: 'column', columnId: getFieldString(block, 'COLUMN_ID') } };
    case BLOCK_TYPES.trimFunction:
      return readUnaryCall(block, 'trim');
    case BLOCK_TYPES.lowerFunction:
      return readUnaryCall(block, 'lower');
    case BLOCK_TYPES.upperFunction:
      return readUnaryCall(block, 'upper');
    case BLOCK_TYPES.collapseWhitespaceFunction:
      return readUnaryCall(block, 'collapseWhitespace');
    case BLOCK_TYPES.firstFunction:
      return readUnaryCall(block, 'first');
    case BLOCK_TYPES.lastFunction:
      return readUnaryCall(block, 'last');
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
    case BLOCK_TYPES.coalesceFunction:
      return readFixedArityCall(block, 'coalesce', ['FIRST', 'SECOND']);
    case BLOCK_TYPES.switchFunction:
      return readSwitchExpression(block);
    case BLOCK_TYPES.concatFunction:
      return readConcatCall(block);
    case BLOCK_TYPES.notFunction:
      return readUnaryCall(block, 'not');
    case BLOCK_TYPES.comparisonFunction:
      return readComparisonExpression(block);
    case BLOCK_TYPES.predicateFunction:
      return readPredicateExpression(block);
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
  name: 'trim' | 'lower' | 'upper' | 'collapseWhitespace' | 'first' | 'last' | 'isEmpty' | 'not',
): { expression: WorkflowExpression } | { issue: EditorIssue } {
  return readFixedArityCall(block, name, ['INPUT']);
}

function readFixedArityCall(
  block: Blockly.Block,
  name:
    | 'substring'
    | 'replace'
    | 'extractRegex'
    | 'replaceRegex'
    | 'split'
    | 'atIndex'
    | 'coalesce'
    | 'concat'
    | 'switch'
    | 'trim'
    | 'lower'
    | 'upper'
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

function readSwitchExpression(block: Blockly.Block): { expression: WorkflowExpression } | { issue: EditorIssue } {
  const target = readRequiredExpression(block, 'TARGET');

  if ('issue' in target) {
    return target;
  }

  const args: WorkflowExpression[] = [target.expression];
  let index = 0;

  while (block.getInput(`MATCH${index}`)) {
    const match = readRequiredExpression(block, `MATCH${index}`);

    if ('issue' in match) {
      return match;
    }

    const returnValue = readRequiredExpression(block, `RETURN${index}`);

    if ('issue' in returnValue) {
      return returnValue;
    }

    args.push(match.expression, returnValue.expression);
    index += 1;
  }

  const defaultResult = readRequiredExpression(block, 'DEFAULT');

  if ('issue' in defaultResult) {
    return defaultResult;
  }

  args.push(defaultResult.expression);

  return {
    expression: {
      kind: 'call',
      name: 'switch',
      args,
    },
  };
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
  const operator = getFieldString(block, 'OPERATOR') as 'contains' | 'startsWith' | 'endsWith' | 'matchesRegex' | 'isEmpty';

  if (operator === 'isEmpty') {
    return readFixedArityCall(block, operator, ['INPUT']);
  }

  return readFixedArityCall(block, operator, ['FIRST', 'SECOND']);
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
    case 'scopedTransform':
      return createScopedTransformBlock(workspace, step, isTopBlock);
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

function createScopedTransformBlock(workspace: Blockly.Workspace, step: AuthoringScopedTransformStep, isTopBlock: boolean) {
  const block = createBlock(workspace, BLOCK_TYPES.scopedTransformStep, isTopBlock ? 24 : undefined, isTopBlock ? 24 : undefined);

  setBlockMetadata(block, step.stepId);
  block.setFieldValue(serializeColumnSelectionValue(step.columnIds), 'COLUMN_IDS');

  if (step.rowCondition) {
    connectValueBlock(block, 'ROW_CONDITION', createExpressionBlock(workspace, step.rowCondition));
  }

  connectValueBlock(block, 'EXPRESSION', createExpressionBlock(workspace, step.expression));

  return block;
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
    const block = createBlock(workspace, BLOCK_TYPES.literalString);

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

function createExpressionBlock(workspace: Blockly.Workspace, expression: WorkflowExpression): Blockly.Block {
  switch (expression.kind) {
    case 'value':
      return createBlock(workspace, BLOCK_TYPES.currentValueExpression);
    case 'literal':
      return createLiteralBlock(workspace, expression.value);
    case 'column': {
      const block = createBlock(workspace, BLOCK_TYPES.columnExpression);

      block.setFieldValue(expression.columnId, 'COLUMN_ID');
      return block;
    }
    case 'call': {
      const block = createCallBlock(workspace, expression);
      return block;
    }
    default:
      throw new Error(`Unsupported expression kind '${(expression as WorkflowExpression).kind}'.`);
  }
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
    case 'trim':
    case 'lower':
    case 'upper':
    case 'collapseWhitespace':
    case 'first':
    case 'last':
    case 'not': {
      const blockType = {
        trim: BLOCK_TYPES.trimFunction,
        lower: BLOCK_TYPES.lowerFunction,
        upper: BLOCK_TYPES.upperFunction,
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
    case 'switch': {
      const block = createBlock(workspace, BLOCK_TYPES.switchFunction);
      const switchBlock = block as Blockly.Block & {
        loadExtraState?: (state: { itemCount?: number }) => void;
        itemCount_?: number;
        updateShape_?: () => void;
      };
      const caseCount = Math.max(1, Math.floor((expression.args.length - 2) / 2));

      if (switchBlock.loadExtraState) {
        switchBlock.loadExtraState({ itemCount: caseCount });
      } else {
        switchBlock.itemCount_ = caseCount;
        switchBlock.updateShape_?.();
      }

      connectValueBlock(block, 'TARGET', createExpressionBlock(workspace, expression.args[0]));

      for (let index = 0; index < caseCount; index += 1) {
        connectValueBlock(block, `MATCH${index}`, createExpressionBlock(workspace, expression.args[1 + (index * 2)]));
        connectValueBlock(block, `RETURN${index}`, createExpressionBlock(workspace, expression.args[2 + (index * 2)]));
      }

      connectValueBlock(block, 'DEFAULT', createExpressionBlock(workspace, expression.args[expression.args.length - 1]));
      return block;
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith':
    case 'matchesRegex':
    case 'isEmpty': {
      const block = createBlock(workspace, BLOCK_TYPES.predicateFunction);

      block.setFieldValue(expression.name, 'OPERATOR');

      if (expression.name === 'isEmpty') {
        connectValueBlock(block, 'INPUT', createExpressionBlock(workspace, expression.args[0]));
        return block;
      }

      connectValueBlock(block, 'FIRST', createExpressionBlock(workspace, expression.args[0]));
      connectValueBlock(block, 'SECOND', createExpressionBlock(workspace, expression.args[1]));
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
      return {
        expression: {
          kind: 'column',
          columnId: getFieldString(block, 'COPY_COLUMN_ID'),
        },
      };
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

function missingInputIssue(block: Blockly.Block, inputName: string): EditorIssue {
  return {
    code: 'missingInput',
    message: `Block '${block.type}' is missing required input '${inputName}'.`,
    blockId: block.id,
    blockType: block.type,
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
