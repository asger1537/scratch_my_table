import * as Blockly from 'blockly';

import { getSchemaColumnOptions } from './schemaOptions';

const STEP_COLOR = '#b04a1f';
const SUPPORT_COLOR = '#6b6a5c';
const EXPRESSION_COLOR = '#2d6a4f';
const CONDITION_COLOR = '#355070';
const ROOT_COLOR = '#8c3a18';

let blocksRegistered = false;

export const BLOCK_TYPES = {
  workflowRoot: 'workflow_root',
  fillEmptyStep: 'fill_empty_step',
  normalizeTextStep: 'normalize_text_step',
  renameColumnStep: 'rename_column_step',
  deriveColumnStep: 'derive_column_step',
  filterRowsStep: 'filter_rows_step',
  splitColumnStep: 'split_column_step',
  combineColumnsStep: 'combine_columns_step',
  deduplicateRowsStep: 'deduplicate_rows_step',
  sortRowsStep: 'sort_rows_step',
  columnTarget: 'column_target',
  columnItem: 'column_item',
  outputColumns: 'output_columns',
  outputColumnItem: 'output_column_item',
  sortList: 'sort_list',
  sortItem: 'sort_item',
  expressionItem: 'expression_item',
  conditionItem: 'condition_item',
  literalString: 'literal_string',
  literalNumber: 'literal_number',
  literalBoolean: 'literal_boolean',
  literalNull: 'literal_null',
  columnExpression: 'column_expression',
  concatExpression: 'concat_expression',
  coalesceExpression: 'coalesce_expression',
  isEmptyCondition: 'is_empty_condition',
  equalsCondition: 'equals_condition',
  containsCondition: 'contains_condition',
  startsWithCondition: 'starts_with_condition',
  endsWithCondition: 'ends_with_condition',
  greaterThanCondition: 'greater_than_condition',
  lessThanCondition: 'less_than_condition',
  andCondition: 'and_condition',
  orCondition: 'or_condition',
  notCondition: 'not_condition',
} as const;

export function registerWorkflowBlocks() {
  if (blocksRegistered) {
    return;
  }

  blocksRegistered = true;

  Blockly.Blocks[BLOCK_TYPES.workflowRoot] = {
    init() {
      this.appendDummyInput()
        .appendField('workflow')
        .appendField('id')
        .appendField(new Blockly.FieldTextInput('workflow_id'), 'WORKFLOW_ID');
      this.appendDummyInput()
        .appendField('name')
        .appendField(new Blockly.FieldTextInput('Workflow'), 'WORKFLOW_NAME');
      this.appendDummyInput()
        .appendField('description')
        .appendField(new Blockly.FieldTextInput(''), 'WORKFLOW_DESCRIPTION');
      this.appendStatementInput('STEPS').setCheck('WORKFLOW_STEP').appendField('steps');
      this.setColour(ROOT_COLOR);
      this.setTooltip('Top-level workflow metadata and ordered step list.');
      this.setDeletable(false);
      this.setMovable(false);
    },
  };

  createStepBlock(BLOCK_TYPES.fillEmptyStep, 'fill empty', (block) => {
    block.appendValueInput('TARGET').setCheck('COLUMN_TARGET').appendField('target');
    block.appendValueInput('VALUE').setCheck('NON_NULL_LITERAL').appendField('value');
    block.appendDummyInput()
      .appendField('treat whitespace as empty')
      .appendField(new Blockly.FieldCheckbox('FALSE'), 'TREAT_WHITESPACE_AS_EMPTY');
  });

  createStepBlock(BLOCK_TYPES.normalizeTextStep, 'normalize text', (block) => {
    block.appendValueInput('TARGET').setCheck('COLUMN_TARGET').appendField('target');
    block.appendDummyInput()
      .appendField('trim')
      .appendField(new Blockly.FieldCheckbox('TRUE'), 'TRIM')
      .appendField('collapse whitespace')
      .appendField(new Blockly.FieldCheckbox('FALSE'), 'COLLAPSE_WHITESPACE')
      .appendField('case')
      .appendField(new Blockly.FieldDropdown([
        ['preserve', 'preserve'],
        ['lower', 'lower'],
        ['upper', 'upper'],
      ]), 'CASE');
  });

  createStepBlock(BLOCK_TYPES.renameColumnStep, 'rename column', (block) => {
    block.appendDummyInput()
      .appendField('column')
      .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID');
    block.appendDummyInput()
      .appendField('new display name')
      .appendField(new Blockly.FieldTextInput('new_name'), 'NEW_DISPLAY_NAME');
  });

  createStepBlock(BLOCK_TYPES.deriveColumnStep, 'derive column', (block) => {
    appendNewColumnFields(block);
    block.appendValueInput('EXPRESSION').setCheck('EXPRESSION').appendField('expression');
  });

  createStepBlock(BLOCK_TYPES.filterRowsStep, 'filter rows', (block) => {
    block.appendDummyInput()
      .appendField('mode')
      .appendField(new Blockly.FieldDropdown([
        ['keep', 'keep'],
        ['drop', 'drop'],
      ]), 'MODE');
    block.appendValueInput('CONDITION').setCheck('CONDITION').appendField('condition');
  });

  createStepBlock(BLOCK_TYPES.splitColumnStep, 'split column', (block) => {
    block.appendDummyInput()
      .appendField('column')
      .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID');
    block.appendDummyInput()
      .appendField('delimiter')
      .appendField(new Blockly.FieldTextInput(','), 'DELIMITER');
    block.appendValueInput('OUTPUT_COLUMNS').setCheck('OUTPUT_COLUMNS').appendField('output columns');
  });

  createStepBlock(BLOCK_TYPES.combineColumnsStep, 'combine columns', (block) => {
    block.appendValueInput('TARGET').setCheck('COLUMN_TARGET').appendField('target');
    block.appendDummyInput()
      .appendField('separator')
      .appendField(new Blockly.FieldTextInput(', '), 'SEPARATOR');
    appendNewColumnFields(block);
  });

  createStepBlock(BLOCK_TYPES.deduplicateRowsStep, 'deduplicate rows', (block) => {
    block.appendValueInput('TARGET').setCheck('COLUMN_TARGET').appendField('key columns');
  });

  createStepBlock(BLOCK_TYPES.sortRowsStep, 'sort rows', (block) => {
    block.appendValueInput('SORTS').setCheck('SORT_LIST').appendField('sorts');
  });

  Blockly.Blocks[BLOCK_TYPES.columnTarget] = {
    init() {
      this.appendDummyInput().appendField('column target');
      this.appendStatementInput('ITEMS').setCheck('COLUMN_REFERENCE').appendField('columns');
      this.setOutput(true, 'COLUMN_TARGET');
      this.setColour(SUPPORT_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.columnItem] = {
    init() {
      this.appendDummyInput()
        .appendField('column')
        .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID');
      this.setPreviousStatement(true, 'COLUMN_REFERENCE');
      this.setNextStatement(true, 'COLUMN_REFERENCE');
      this.setColour(SUPPORT_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.outputColumns] = {
    init() {
      this.appendDummyInput().appendField('output columns');
      this.appendStatementInput('ITEMS').setCheck('OUTPUT_COLUMN_ITEM').appendField('items');
      this.setOutput(true, 'OUTPUT_COLUMNS');
      this.setColour(SUPPORT_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.outputColumnItem] = {
    init() {
      this.appendDummyInput()
        .appendField('column id')
        .appendField(new Blockly.FieldTextInput('col_new'), 'COLUMN_ID');
      this.appendDummyInput()
        .appendField('display name')
        .appendField(new Blockly.FieldTextInput('new_column'), 'DISPLAY_NAME');
      this.setPreviousStatement(true, 'OUTPUT_COLUMN_ITEM');
      this.setNextStatement(true, 'OUTPUT_COLUMN_ITEM');
      this.setColour(SUPPORT_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.sortList] = {
    init() {
      this.appendDummyInput().appendField('sort list');
      this.appendStatementInput('ITEMS').setCheck('SORT_ITEM').appendField('sort keys');
      this.setOutput(true, 'SORT_LIST');
      this.setColour(SUPPORT_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.sortItem] = {
    init() {
      this.appendDummyInput()
        .appendField('column')
        .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID')
        .appendField('direction')
        .appendField(new Blockly.FieldDropdown([
          ['asc', 'asc'],
          ['desc', 'desc'],
        ]), 'DIRECTION');
      this.setPreviousStatement(true, 'SORT_ITEM');
      this.setNextStatement(true, 'SORT_ITEM');
      this.setColour(SUPPORT_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.expressionItem] = {
    init() {
      this.appendValueInput('EXPRESSION').setCheck('EXPRESSION').appendField('expression');
      this.setPreviousStatement(true, 'EXPRESSION_ITEM');
      this.setNextStatement(true, 'EXPRESSION_ITEM');
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.conditionItem] = {
    init() {
      this.appendValueInput('CONDITION').setCheck('CONDITION').appendField('condition');
      this.setPreviousStatement(true, 'CONDITION_ITEM');
      this.setNextStatement(true, 'CONDITION_ITEM');
      this.setColour(CONDITION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalString] = {
    init() {
      this.appendDummyInput()
        .appendField('text')
        .appendField(new Blockly.FieldTextInput('value'), 'VALUE');
      this.setOutput(true, ['EXPRESSION', 'LITERAL', 'NON_NULL_LITERAL', 'STRING_LITERAL']);
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalNumber] = {
    init() {
      this.appendDummyInput()
        .appendField('number')
        .appendField(new Blockly.FieldNumber(0), 'VALUE');
      this.setOutput(true, ['EXPRESSION', 'LITERAL', 'NON_NULL_LITERAL', 'NUMBER_LITERAL']);
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalBoolean] = {
    init() {
      this.appendDummyInput()
        .appendField('boolean')
        .appendField(new Blockly.FieldDropdown([
          ['true', 'true'],
          ['false', 'false'],
        ]), 'VALUE');
      this.setOutput(true, ['EXPRESSION', 'LITERAL', 'NON_NULL_LITERAL', 'BOOLEAN_LITERAL']);
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalNull] = {
    init() {
      this.appendDummyInput().appendField('null');
      this.setOutput(true, ['EXPRESSION', 'LITERAL']);
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.columnExpression] = {
    init() {
      this.appendDummyInput()
        .appendField('column')
        .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.concatExpression] = {
    init() {
      this.appendDummyInput().appendField('concat');
      this.appendStatementInput('PARTS').setCheck('EXPRESSION_ITEM').appendField('parts');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.coalesceExpression] = {
    init() {
      this.appendDummyInput().appendField('coalesce');
      this.appendStatementInput('INPUTS').setCheck('EXPRESSION_ITEM').appendField('inputs');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(EXPRESSION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.isEmptyCondition] = {
    init() {
      this.appendDummyInput()
        .appendField('is empty')
        .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID')
        .appendField('treat whitespace as empty')
        .appendField(new Blockly.FieldCheckbox('FALSE'), 'TREAT_WHITESPACE_AS_EMPTY');
      this.setOutput(true, 'CONDITION');
      this.setColour(CONDITION_COLOR);
    },
  };

  createLiteralConditionBlock(BLOCK_TYPES.equalsCondition, 'equals');
  createStringConditionBlock(BLOCK_TYPES.containsCondition, 'contains');
  createStringConditionBlock(BLOCK_TYPES.startsWithCondition, 'starts with');
  createStringConditionBlock(BLOCK_TYPES.endsWithCondition, 'ends with');
  createLiteralConditionBlock(BLOCK_TYPES.greaterThanCondition, 'greater than');
  createLiteralConditionBlock(BLOCK_TYPES.lessThanCondition, 'less than');

  createConditionGroupBlock(BLOCK_TYPES.andCondition, 'and', 'CONDITIONS');
  createConditionGroupBlock(BLOCK_TYPES.orCondition, 'or', 'CONDITIONS');

  Blockly.Blocks[BLOCK_TYPES.notCondition] = {
    init() {
      this.appendValueInput('CONDITION').setCheck('CONDITION').appendField('not');
      this.setOutput(true, 'CONDITION');
      this.setColour(CONDITION_COLOR);
    },
  };
}

export function getWorkflowToolboxDefinition(): Blockly.utils.toolbox.ToolboxInfo {
  return {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category',
        name: 'Steps',
        colour: STEP_COLOR,
        contents: stepTypesToToolboxContents(),
      },
      {
        kind: 'category',
        name: 'Targets',
        colour: SUPPORT_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.columnTarget },
          { kind: 'block', type: BLOCK_TYPES.columnItem },
          { kind: 'block', type: BLOCK_TYPES.outputColumns },
          { kind: 'block', type: BLOCK_TYPES.outputColumnItem },
          { kind: 'block', type: BLOCK_TYPES.sortList },
          { kind: 'block', type: BLOCK_TYPES.sortItem },
        ],
      },
      {
        kind: 'category',
        name: 'Expressions',
        colour: EXPRESSION_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.literalString },
          { kind: 'block', type: BLOCK_TYPES.literalNumber },
          { kind: 'block', type: BLOCK_TYPES.literalBoolean },
          { kind: 'block', type: BLOCK_TYPES.literalNull },
          { kind: 'block', type: BLOCK_TYPES.columnExpression },
          { kind: 'block', type: BLOCK_TYPES.concatExpression },
          { kind: 'block', type: BLOCK_TYPES.coalesceExpression },
          { kind: 'block', type: BLOCK_TYPES.expressionItem },
        ],
      },
      {
        kind: 'category',
        name: 'Conditions',
        colour: CONDITION_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.isEmptyCondition },
          { kind: 'block', type: BLOCK_TYPES.equalsCondition },
          { kind: 'block', type: BLOCK_TYPES.containsCondition },
          { kind: 'block', type: BLOCK_TYPES.startsWithCondition },
          { kind: 'block', type: BLOCK_TYPES.endsWithCondition },
          { kind: 'block', type: BLOCK_TYPES.greaterThanCondition },
          { kind: 'block', type: BLOCK_TYPES.lessThanCondition },
          { kind: 'block', type: BLOCK_TYPES.andCondition },
          { kind: 'block', type: BLOCK_TYPES.orCondition },
          { kind: 'block', type: BLOCK_TYPES.notCondition },
          { kind: 'block', type: BLOCK_TYPES.conditionItem },
        ],
      },
    ],
  };
}

function createStepBlock(type: string, label: string, buildFields: (block: Blockly.Block) => void) {
  Blockly.Blocks[type] = {
    init() {
      this.appendDummyInput()
        .appendField(label)
        .appendField('step id')
        .appendField(new Blockly.FieldTextInput(defaultStepId(type)), 'STEP_ID');
      buildFields(this);
      this.setPreviousStatement(true, 'WORKFLOW_STEP');
      this.setNextStatement(true, 'WORKFLOW_STEP');
      this.setColour(STEP_COLOR);
    },
  };
}

function createLiteralConditionBlock(type: string, label: string) {
  Blockly.Blocks[type] = {
    init() {
      this.appendDummyInput()
        .appendField(label)
        .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID');
      this.appendValueInput('VALUE').setCheck('NON_NULL_LITERAL').appendField('value');
      this.setOutput(true, 'CONDITION');
      this.setColour(CONDITION_COLOR);
    },
  };
}

function createStringConditionBlock(type: string, label: string) {
  Blockly.Blocks[type] = {
    init() {
      this.appendDummyInput()
        .appendField(label)
        .appendField(new Blockly.FieldDropdown(getSchemaColumnOptions), 'COLUMN_ID')
        .appendField('text')
        .appendField(new Blockly.FieldTextInput('value'), 'VALUE');
      this.setOutput(true, 'CONDITION');
      this.setColour(CONDITION_COLOR);
    },
  };
}

function createConditionGroupBlock(type: string, label: string, inputName: string) {
  Blockly.Blocks[type] = {
    init() {
      this.appendDummyInput().appendField(label);
      this.appendStatementInput(inputName).setCheck('CONDITION_ITEM').appendField('conditions');
      this.setOutput(true, 'CONDITION');
      this.setColour(CONDITION_COLOR);
    },
  };
}

function appendNewColumnFields(block: Blockly.Block) {
  block.appendDummyInput()
    .appendField('new column id')
    .appendField(new Blockly.FieldTextInput('col_new'), 'NEW_COLUMN_ID');
  block.appendDummyInput()
    .appendField('new display name')
    .appendField(new Blockly.FieldTextInput('new_column'), 'NEW_DISPLAY_NAME');
}

function defaultStepId(type: string) {
  return type.replace(/_step$/, '').replace(/[^a-z0-9]+/gi, '_');
}

function stepTypesToToolboxContents() {
  return [
    { kind: 'block', type: BLOCK_TYPES.fillEmptyStep },
    { kind: 'block', type: BLOCK_TYPES.normalizeTextStep },
    { kind: 'block', type: BLOCK_TYPES.renameColumnStep },
    { kind: 'block', type: BLOCK_TYPES.deriveColumnStep },
    { kind: 'block', type: BLOCK_TYPES.filterRowsStep },
    { kind: 'block', type: BLOCK_TYPES.splitColumnStep },
    { kind: 'block', type: BLOCK_TYPES.combineColumnsStep },
    { kind: 'block', type: BLOCK_TYPES.deduplicateRowsStep },
    { kind: 'block', type: BLOCK_TYPES.sortRowsStep },
  ];
}
