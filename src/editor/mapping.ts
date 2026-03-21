import * as Blockly from 'blockly';

import { type Table } from '../domain/model';
import { slugify } from '../domain/normalize';
import { validateWorkflowStructure, type Workflow, type WorkflowCondition, type WorkflowExpression, type WorkflowStep } from '../workflow';

import { BLOCK_TYPES, registerWorkflowBlocks } from './blocks';

export interface EditorIssue {
  code: string;
  message: string;
  blockId?: string;
  blockType?: string;
}

export interface WorkspaceWorkflowResult {
  workflow: Workflow | null;
  issues: EditorIssue[];
}

export function createDefaultWorkflow(table: Table): Workflow {
  const baseName = table.sourceName.replace(/\.[^.]+$/, '');
  const workflowSlug = slugify(baseName);

  return {
    version: 1,
    workflowId: `wf_${workflowSlug}`,
    name: toTitleCase(baseName),
    description: '',
    steps: [],
  };
}

export function createHeadlessWorkflowWorkspace(): Blockly.Workspace {
  registerWorkflowBlocks();
  return new Blockly.Workspace();
}

export function workspaceToWorkflow(workspace: Blockly.Workspace): WorkspaceWorkflowResult {
  registerWorkflowBlocks();

  const topBlocks = workspace.getTopBlocks(false);
  const rootBlocks = topBlocks.filter((block) => block.type === BLOCK_TYPES.workflowRoot);
  const orphanBlocks = topBlocks.filter((block) => block.type !== BLOCK_TYPES.workflowRoot);

  if (rootBlocks.length !== 1) {
    return {
      workflow: null,
      issues: [
        {
          code: 'invalidRoot',
          message: rootBlocks.length === 0 ? 'The workspace is missing the workflow root block.' : 'The workspace contains more than one workflow root block.',
        },
      ],
    };
  }

  if (orphanBlocks.length > 0) {
    return {
      workflow: null,
      issues: orphanBlocks.map((block) => ({
        code: 'orphanBlock',
        message: `Block '${block.type}' is not connected to the workflow.`,
        blockId: block.id,
        blockType: block.type,
      })),
    };
  }

  const root = rootBlocks[0];
  const stepsResult = readStepChain(root.getInputTargetBlock('STEPS'));

  if (stepsResult.issues.length > 0) {
    return {
      workflow: null,
      issues: stepsResult.issues,
    };
  }

  return {
    workflow: {
      version: 1,
      workflowId: getFieldString(root, 'WORKFLOW_ID'),
      name: getFieldString(root, 'WORKFLOW_NAME'),
      description: emptyToUndefined(getFieldString(root, 'WORKFLOW_DESCRIPTION')),
      steps: stepsResult.steps,
    },
    issues: [],
  };
}

export function workflowToWorkspace(workspace: Blockly.Workspace, workflow: Workflow): EditorIssue[] {
  registerWorkflowBlocks();
  workspace.clear();

  const root = createBlock(workspace, BLOCK_TYPES.workflowRoot, 24, 24);

  root.setFieldValue(workflow.workflowId, 'WORKFLOW_ID');
  root.setFieldValue(workflow.name, 'WORKFLOW_NAME');
  root.setFieldValue(workflow.description ?? '', 'WORKFLOW_DESCRIPTION');

  const stepBlocks = workflow.steps.map((step) => createStepBlockFromWorkflow(workspace, step));
  connectStatementChain(root, 'STEPS', stepBlocks);
  finalizeWorkspace(workspace);

  return [];
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

function readStepChain(firstBlock: Blockly.Block | null): { steps: WorkflowStep[]; issues: EditorIssue[] } {
  const steps: WorkflowStep[] = [];
  const issues: EditorIssue[] = [];
  let block = firstBlock;

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

function readStepBlock(block: Blockly.Block): { step: WorkflowStep; issue?: EditorIssue } {
  const stepId = getFieldString(block, 'STEP_ID');

  switch (block.type) {
    case BLOCK_TYPES.fillEmptyStep: {
      const target = readRequiredTarget(block, 'TARGET');
      const value = readRequiredLiteral(block, 'VALUE');

      if ('issue' in target) {
        return { step: undefined as never, issue: target.issue };
      }

      if ('issue' in value) {
        return { step: undefined as never, issue: value.issue };
      }

      return {
        step: {
          id: stepId,
          type: 'fillEmpty',
          target: target.target,
          value: value.value,
          treatWhitespaceAsEmpty: getFieldBoolean(block, 'TREAT_WHITESPACE_AS_EMPTY'),
        },
      };
    }
    case BLOCK_TYPES.normalizeTextStep: {
      const target = readRequiredTarget(block, 'TARGET');

      if ('issue' in target) {
        return { step: undefined as never, issue: target.issue };
      }

      return {
        step: {
          id: stepId,
          type: 'normalizeText',
          target: target.target,
          trim: getFieldBoolean(block, 'TRIM'),
          collapseWhitespace: getFieldBoolean(block, 'COLLAPSE_WHITESPACE'),
          case: getFieldString(block, 'CASE') as 'preserve' | 'lower' | 'upper',
        },
      };
    }
    case BLOCK_TYPES.renameColumnStep:
      return {
        step: {
          id: stepId,
          type: 'renameColumn',
          columnId: getFieldString(block, 'COLUMN_ID'),
          newDisplayName: getFieldString(block, 'NEW_DISPLAY_NAME'),
        },
      };
    case BLOCK_TYPES.deriveColumnStep: {
      const expression = readRequiredExpression(block, 'EXPRESSION');

      if ('issue' in expression) {
        return { step: undefined as never, issue: expression.issue };
      }

      return {
        step: {
          id: stepId,
          type: 'deriveColumn',
          newColumn: readNewColumnFields(block),
          expression: expression.expression,
        },
      };
    }
    case BLOCK_TYPES.filterRowsStep: {
      const condition = readRequiredCondition(block, 'CONDITION');

      if ('issue' in condition) {
        return { step: undefined as never, issue: condition.issue };
      }

      return {
        step: {
          id: stepId,
          type: 'filterRows',
          mode: getFieldString(block, 'MODE') as 'keep' | 'drop',
          condition: condition.condition,
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
          id: stepId,
          type: 'splitColumn',
          columnId: getFieldString(block, 'COLUMN_ID'),
          delimiter: getFieldString(block, 'DELIMITER'),
          outputColumns: outputColumns.outputColumns,
        },
      };
    }
    case BLOCK_TYPES.combineColumnsStep: {
      const target = readRequiredTarget(block, 'TARGET');

      if ('issue' in target) {
        return { step: undefined as never, issue: target.issue };
      }

      return {
        step: {
          id: stepId,
          type: 'combineColumns',
          target: target.target,
          separator: getFieldString(block, 'SEPARATOR'),
          newColumn: readNewColumnFields(block),
        },
      };
    }
    case BLOCK_TYPES.deduplicateRowsStep: {
      const target = readRequiredTarget(block, 'TARGET');

      if ('issue' in target) {
        return { step: undefined as never, issue: target.issue };
      }

      return {
        step: {
          id: stepId,
          type: 'deduplicateRows',
          target: target.target,
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
          id: stepId,
          type: 'sortRows',
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

function readRequiredTarget(block: Blockly.Block, inputName: string) {
  const targetBlock = block.getInputTargetBlock(inputName);

  if (!targetBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  return readColumnTarget(targetBlock);
}

function readColumnTarget(block: Blockly.Block): { target: { kind: 'columns'; columnIds: string[] } } | { issue: EditorIssue } {
  if (block.type !== BLOCK_TYPES.columnTarget) {
    return {
      issue: {
        code: 'invalidTargetBlock',
        message: `Expected a column target block but found '${block.type}'.`,
        blockId: block.id,
        blockType: block.type,
      },
    };
  }

  const columnIds = readStatementItems(block.getInputTargetBlock('ITEMS'), BLOCK_TYPES.columnItem, (item) => getFieldString(item, 'COLUMN_ID'));
  return 'issue' in columnIds ? columnIds : { target: { kind: 'columns', columnIds: columnIds.values } };
}

function readRequiredOutputColumns(block: Blockly.Block, inputName: string) {
  const outputBlock = block.getInputTargetBlock(inputName);

  if (!outputBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  if (outputBlock.type !== BLOCK_TYPES.outputColumns) {
    return {
      issue: {
        code: 'invalidOutputColumnsBlock',
        message: `Expected an output columns block but found '${outputBlock.type}'.`,
        blockId: outputBlock.id,
        blockType: outputBlock.type,
      },
    };
  }

  const items = readStatementItems(outputBlock.getInputTargetBlock('ITEMS'), BLOCK_TYPES.outputColumnItem, (item) => ({
    columnId: getFieldString(item, 'COLUMN_ID'),
    displayName: getFieldString(item, 'DISPLAY_NAME'),
  }));

  return 'issue' in items ? items : { outputColumns: items.values };
}

function readRequiredSorts(block: Blockly.Block, inputName: string) {
  const sortBlock = block.getInputTargetBlock(inputName);

  if (!sortBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  if (sortBlock.type !== BLOCK_TYPES.sortList) {
    return {
      issue: {
        code: 'invalidSortListBlock',
        message: `Expected a sort list block but found '${sortBlock.type}'.`,
        blockId: sortBlock.id,
        blockType: sortBlock.type,
      },
    };
  }

  const items = readStatementItems(sortBlock.getInputTargetBlock('ITEMS'), BLOCK_TYPES.sortItem, (item) => ({
    columnId: getFieldString(item, 'COLUMN_ID'),
    direction: getFieldString(item, 'DIRECTION') as 'asc' | 'desc',
  }));

  return 'issue' in items ? items : { sorts: items.values };
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
    case BLOCK_TYPES.concatExpression: {
      const items = readExpressionItems(block, 'PARTS');
      return 'issue' in items ? items : { expression: { kind: 'concat', parts: items.values } };
    }
    case BLOCK_TYPES.coalesceExpression: {
      const items = readExpressionItems(block, 'INPUTS');
      return 'issue' in items ? items : { expression: { kind: 'coalesce', inputs: items.values } };
    }
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

function readExpressionItems(block: Blockly.Block, inputName: string) {
  return readStatementItems(block.getInputTargetBlock(inputName), BLOCK_TYPES.expressionItem, (item) => {
    const expression = readRequiredExpression(item, 'EXPRESSION');
    if ('issue' in expression) {
      throw expression.issue;
    }

    return expression.expression;
  });
}

function readRequiredCondition(block: Blockly.Block, inputName: string): { condition: WorkflowCondition } | { issue: EditorIssue } {
  const conditionBlock = block.getInputTargetBlock(inputName);

  if (!conditionBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  return readCondition(conditionBlock);
}

function readCondition(block: Blockly.Block): { condition: WorkflowCondition } | { issue: EditorIssue } {
  switch (block.type) {
    case BLOCK_TYPES.isEmptyCondition:
      return {
        condition: {
          kind: 'isEmpty',
          columnId: getFieldString(block, 'COLUMN_ID'),
          treatWhitespaceAsEmpty: getFieldBoolean(block, 'TREAT_WHITESPACE_AS_EMPTY'),
        },
      };
    case BLOCK_TYPES.equalsCondition: {
      const value = readRequiredLiteral(block, 'VALUE');
      return 'issue' in value
        ? value
        : {
            condition: {
              kind: 'equals',
              columnId: getFieldString(block, 'COLUMN_ID'),
              value: value.value,
            },
          };
    }
    case BLOCK_TYPES.containsCondition:
      return { condition: { kind: 'contains', columnId: getFieldString(block, 'COLUMN_ID'), value: getFieldString(block, 'VALUE') } };
    case BLOCK_TYPES.startsWithCondition:
      return { condition: { kind: 'startsWith', columnId: getFieldString(block, 'COLUMN_ID'), value: getFieldString(block, 'VALUE') } };
    case BLOCK_TYPES.endsWithCondition:
      return { condition: { kind: 'endsWith', columnId: getFieldString(block, 'COLUMN_ID'), value: getFieldString(block, 'VALUE') } };
    case BLOCK_TYPES.greaterThanCondition: {
      const value = readRequiredLiteral(block, 'VALUE');
      return 'issue' in value
        ? value
        : {
            condition: {
              kind: 'greaterThan',
              columnId: getFieldString(block, 'COLUMN_ID'),
              value: value.value,
            },
          };
    }
    case BLOCK_TYPES.lessThanCondition: {
      const value = readRequiredLiteral(block, 'VALUE');
      return 'issue' in value
        ? value
        : {
            condition: {
              kind: 'lessThan',
              columnId: getFieldString(block, 'COLUMN_ID'),
              value: value.value,
            },
          };
    }
    case BLOCK_TYPES.andCondition: {
      const items = readConditionItems(block, 'CONDITIONS');
      return 'issue' in items ? items : { condition: { kind: 'and', conditions: items.values } };
    }
    case BLOCK_TYPES.orCondition: {
      const items = readConditionItems(block, 'CONDITIONS');
      return 'issue' in items ? items : { condition: { kind: 'or', conditions: items.values } };
    }
    case BLOCK_TYPES.notCondition: {
      const condition = readRequiredCondition(block, 'CONDITION');
      return 'issue' in condition ? condition : { condition: { kind: 'not', condition: condition.condition } };
    }
    default:
      return {
        issue: {
          code: 'invalidConditionBlock',
          message: `Block '${block.type}' is not a supported condition block.`,
          blockId: block.id,
          blockType: block.type,
        },
      };
  }
}

function readConditionItems(block: Blockly.Block, inputName: string) {
  return readStatementItems(block.getInputTargetBlock(inputName), BLOCK_TYPES.conditionItem, (item) => {
    const condition = readRequiredCondition(item, 'CONDITION');
    if ('issue' in condition) {
      throw condition.issue;
    }

    return condition.condition;
  });
}

function readRequiredLiteral(block: Blockly.Block, inputName: string): { value: string | number | boolean } | { issue: EditorIssue } {
  const literalBlock = block.getInputTargetBlock(inputName);

  if (!literalBlock) {
    return {
      issue: missingInputIssue(block, inputName),
    };
  }

  switch (literalBlock.type) {
    case BLOCK_TYPES.literalString:
      return { value: getFieldString(literalBlock, 'VALUE') };
    case BLOCK_TYPES.literalNumber:
      return { value: Number(literalBlock.getFieldValue('VALUE') ?? 0) };
    case BLOCK_TYPES.literalBoolean:
      return { value: getFieldString(literalBlock, 'VALUE') === 'true' };
    default:
      return {
        issue: {
          code: 'invalidLiteralBlock',
          message: `Block '${literalBlock.type}' is not a supported non-null literal block.`,
          blockId: literalBlock.id,
          blockType: literalBlock.type,
        },
      };
  }
}

function readStatementItems<T>(
  firstBlock: Blockly.Block | null,
  expectedType: string,
  mapper: (block: Blockly.Block) => T,
): { values: T[] } | { issue: EditorIssue } {
  const values: T[] = [];
  let block = firstBlock;

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

function createStepBlockFromWorkflow(workspace: Blockly.Workspace, step: WorkflowStep) {
  switch (step.type) {
    case 'fillEmpty': {
      const block = createStepBlock(workspace, BLOCK_TYPES.fillEmptyStep, step.id);
      connectValueBlock(block, 'TARGET', createTargetBlock(workspace, step.target.columnIds));
      connectValueBlock(block, 'VALUE', createLiteralBlock(workspace, step.value));
      block.setFieldValue(step.treatWhitespaceAsEmpty ? 'TRUE' : 'FALSE', 'TREAT_WHITESPACE_AS_EMPTY');
      return block;
    }
    case 'normalizeText': {
      const block = createStepBlock(workspace, BLOCK_TYPES.normalizeTextStep, step.id);
      connectValueBlock(block, 'TARGET', createTargetBlock(workspace, step.target.columnIds));
      block.setFieldValue(step.trim ? 'TRUE' : 'FALSE', 'TRIM');
      block.setFieldValue(step.collapseWhitespace ? 'TRUE' : 'FALSE', 'COLLAPSE_WHITESPACE');
      block.setFieldValue(step.case, 'CASE');
      return block;
    }
    case 'renameColumn': {
      const block = createStepBlock(workspace, BLOCK_TYPES.renameColumnStep, step.id);
      block.setFieldValue(step.columnId, 'COLUMN_ID');
      block.setFieldValue(step.newDisplayName, 'NEW_DISPLAY_NAME');
      return block;
    }
    case 'deriveColumn': {
      const block = createStepBlock(workspace, BLOCK_TYPES.deriveColumnStep, step.id);
      setNewColumnFields(block, step.newColumn.columnId, step.newColumn.displayName);
      connectValueBlock(block, 'EXPRESSION', createExpressionBlock(workspace, step.expression));
      return block;
    }
    case 'filterRows': {
      const block = createStepBlock(workspace, BLOCK_TYPES.filterRowsStep, step.id);
      block.setFieldValue(step.mode, 'MODE');
      connectValueBlock(block, 'CONDITION', createConditionBlock(workspace, step.condition));
      return block;
    }
    case 'splitColumn': {
      const block = createStepBlock(workspace, BLOCK_TYPES.splitColumnStep, step.id);
      block.setFieldValue(step.columnId, 'COLUMN_ID');
      block.setFieldValue(step.delimiter, 'DELIMITER');
      connectValueBlock(block, 'OUTPUT_COLUMNS', createOutputColumnsBlock(workspace, step.outputColumns));
      return block;
    }
    case 'combineColumns': {
      const block = createStepBlock(workspace, BLOCK_TYPES.combineColumnsStep, step.id);
      connectValueBlock(block, 'TARGET', createTargetBlock(workspace, step.target.columnIds));
      block.setFieldValue(step.separator, 'SEPARATOR');
      setNewColumnFields(block, step.newColumn.columnId, step.newColumn.displayName);
      return block;
    }
    case 'deduplicateRows': {
      const block = createStepBlock(workspace, BLOCK_TYPES.deduplicateRowsStep, step.id);
      connectValueBlock(block, 'TARGET', createTargetBlock(workspace, step.target.columnIds));
      return block;
    }
    case 'sortRows': {
      const block = createStepBlock(workspace, BLOCK_TYPES.sortRowsStep, step.id);
      connectValueBlock(block, 'SORTS', createSortListBlock(workspace, step.sorts));
      return block;
    }
    default:
      throw new Error(`Unsupported workflow step '${(step as WorkflowStep).type}'.`);
  }
}

function createTargetBlock(workspace: Blockly.Workspace, columnIds: string[]) {
  const block = createBlock(workspace, BLOCK_TYPES.columnTarget);
  const items = columnIds.map((columnId) => {
    const itemBlock = createBlock(workspace, BLOCK_TYPES.columnItem);
    itemBlock.setFieldValue(columnId, 'COLUMN_ID');
    return itemBlock;
  });

  connectStatementChain(block, 'ITEMS', items);
  return block;
}

function createOutputColumnsBlock(workspace: Blockly.Workspace, outputColumns: Array<{ columnId: string; displayName: string }>) {
  const block = createBlock(workspace, BLOCK_TYPES.outputColumns);
  const items = outputColumns.map((outputColumn) => {
    const itemBlock = createBlock(workspace, BLOCK_TYPES.outputColumnItem);
    itemBlock.setFieldValue(outputColumn.columnId, 'COLUMN_ID');
    itemBlock.setFieldValue(outputColumn.displayName, 'DISPLAY_NAME');
    return itemBlock;
  });

  connectStatementChain(block, 'ITEMS', items);
  return block;
}

function createSortListBlock(workspace: Blockly.Workspace, sorts: Array<{ columnId: string; direction: 'asc' | 'desc' }>) {
  const block = createBlock(workspace, BLOCK_TYPES.sortList);
  const items = sorts.map((sort) => {
    const itemBlock = createBlock(workspace, BLOCK_TYPES.sortItem);
    itemBlock.setFieldValue(sort.columnId, 'COLUMN_ID');
    itemBlock.setFieldValue(sort.direction, 'DIRECTION');
    return itemBlock;
  });

  connectStatementChain(block, 'ITEMS', items);
  return block;
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
    case 'literal':
      return createLiteralBlock(workspace, expression.value);
    case 'column': {
      const block = createBlock(workspace, BLOCK_TYPES.columnExpression);
      block.setFieldValue(expression.columnId, 'COLUMN_ID');
      return block;
    }
    case 'concat': {
      const block = createBlock(workspace, BLOCK_TYPES.concatExpression);
      const items = expression.parts.map((part) => {
        const itemBlock = createBlock(workspace, BLOCK_TYPES.expressionItem);
        connectValueBlock(itemBlock, 'EXPRESSION', createExpressionBlock(workspace, part));
        return itemBlock;
      });

      connectStatementChain(block, 'PARTS', items);
      return block;
    }
    case 'coalesce': {
      const block = createBlock(workspace, BLOCK_TYPES.coalesceExpression);
      const items = expression.inputs.map((input) => {
        const itemBlock = createBlock(workspace, BLOCK_TYPES.expressionItem);
        connectValueBlock(itemBlock, 'EXPRESSION', createExpressionBlock(workspace, input));
        return itemBlock;
      });

      connectStatementChain(block, 'INPUTS', items);
      return block;
    }
    default:
      throw new Error(`Unsupported expression kind '${(expression as WorkflowExpression).kind}'.`);
  }
}

function createConditionBlock(workspace: Blockly.Workspace, condition: WorkflowCondition): Blockly.Block {
  switch (condition.kind) {
    case 'isEmpty': {
      const block = createBlock(workspace, BLOCK_TYPES.isEmptyCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      block.setFieldValue(condition.treatWhitespaceAsEmpty ? 'TRUE' : 'FALSE', 'TREAT_WHITESPACE_AS_EMPTY');
      return block;
    }
    case 'equals': {
      const block = createBlock(workspace, BLOCK_TYPES.equalsCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      connectValueBlock(block, 'VALUE', createLiteralBlock(workspace, condition.value));
      return block;
    }
    case 'contains': {
      const block = createBlock(workspace, BLOCK_TYPES.containsCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      block.setFieldValue(condition.value, 'VALUE');
      return block;
    }
    case 'startsWith': {
      const block = createBlock(workspace, BLOCK_TYPES.startsWithCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      block.setFieldValue(condition.value, 'VALUE');
      return block;
    }
    case 'endsWith': {
      const block = createBlock(workspace, BLOCK_TYPES.endsWithCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      block.setFieldValue(condition.value, 'VALUE');
      return block;
    }
    case 'greaterThan': {
      const block = createBlock(workspace, BLOCK_TYPES.greaterThanCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      connectValueBlock(block, 'VALUE', createLiteralBlock(workspace, condition.value));
      return block;
    }
    case 'lessThan': {
      const block = createBlock(workspace, BLOCK_TYPES.lessThanCondition);
      block.setFieldValue(condition.columnId, 'COLUMN_ID');
      connectValueBlock(block, 'VALUE', createLiteralBlock(workspace, condition.value));
      return block;
    }
    case 'and': {
      const block = createBlock(workspace, BLOCK_TYPES.andCondition);
      const items = condition.conditions.map((child) => {
        const itemBlock = createBlock(workspace, BLOCK_TYPES.conditionItem);
        connectValueBlock(itemBlock, 'CONDITION', createConditionBlock(workspace, child));
        return itemBlock;
      });

      connectStatementChain(block, 'CONDITIONS', items);
      return block;
    }
    case 'or': {
      const block = createBlock(workspace, BLOCK_TYPES.orCondition);
      const items = condition.conditions.map((child) => {
        const itemBlock = createBlock(workspace, BLOCK_TYPES.conditionItem);
        connectValueBlock(itemBlock, 'CONDITION', createConditionBlock(workspace, child));
        return itemBlock;
      });

      connectStatementChain(block, 'CONDITIONS', items);
      return block;
    }
    case 'not': {
      const block = createBlock(workspace, BLOCK_TYPES.notCondition);
      connectValueBlock(block, 'CONDITION', createConditionBlock(workspace, condition.condition));
      return block;
    }
    default:
      throw new Error(`Unsupported condition kind '${(condition as WorkflowCondition).kind}'.`);
  }
}

function createStepBlock(workspace: Blockly.Workspace, type: string, stepId: string) {
  const block = createBlock(workspace, type);
  block.setFieldValue(stepId, 'STEP_ID');
  return block;
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

function getFieldBoolean(block: Blockly.Block, fieldName: string) {
  return getFieldString(block, fieldName) === 'TRUE';
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

function missingInputIssue(block: Blockly.Block, inputName: string): EditorIssue {
  return {
    code: 'missingInput',
    message: `Block '${block.type}' is missing required input '${inputName}'.`,
    blockId: block.id,
    blockType: block.type,
  };
}

function emptyToUndefined(value: string) {
  return value === '' ? undefined : value;
}

function toTitleCase(value: string) {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (character) => character.toLocaleUpperCase()) || 'Workflow';
}
