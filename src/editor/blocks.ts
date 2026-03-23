import * as Blockly from 'blockly';

import { FieldColumnMultiSelect } from './FieldColumnMultiSelect';
import { getSchemaColumnOptions } from './schemaOptions';

const TRANSFORM_COLOR = '#b04a1f';
const TABLE_OPERATION_COLOR = '#8c3a18';
const SUPPORT_COLOR = '#6b6a5c';
const VALUE_COLOR = '#2d6a4f';
const FUNCTION_COLOR = '#457b9d';
const CONDITION_COLOR = '#355070';
const CREATE_COLUMN_INPUT_NAMES = {
  mode: 'CREATE_MODE',
  copySource: 'COPY_COLUMN_ID',
  copySourceRow: 'COPY_COLUMN_ROW',
  expression: 'EXPRESSION',
} as const;

let blocksRegistered = false;
export const CREATE_COLUMN_MODES = {
  blank: 'blank',
  copy: 'copy',
  expression: 'expression',
} as const;
export type CreateColumnMode = typeof CREATE_COLUMN_MODES[keyof typeof CREATE_COLUMN_MODES];

function createSchemaColumnDropdown() {
  return new Blockly.FieldDropdown(function (this: Blockly.FieldDropdown) {
    return getSchemaColumnOptions(this.getSourceBlock()?.id);
  });
}

export const BLOCK_TYPES = {
  scopedTransformStep: 'scoped_transform_step',
  dropColumnsStep: 'drop_columns_step',
  renameColumnStep: 'rename_column_step',
  deriveColumnStep: 'derive_column_step',
  filterRowsStep: 'filter_rows_step',
  splitColumnStep: 'split_column_step',
  combineColumnsStep: 'combine_columns_step',
  deduplicateRowsStep: 'deduplicate_rows_step',
  sortRowsStep: 'sort_rows_step',
  outputColumnItem: 'output_column_item',
  sortItem: 'sort_item',
  conditionItem: 'condition_item',
  currentValueExpression: 'current_value_expression',
  literalString: 'literal_string',
  literalNumber: 'literal_number',
  literalBoolean: 'literal_boolean',
  literalNull: 'literal_null',
  columnExpression: 'column_expression',
  trimFunction: 'trim_function',
  lowerFunction: 'lower_function',
  upperFunction: 'upper_function',
  collapseWhitespaceFunction: 'collapse_whitespace_function',
  substringFunction: 'substring_function',
  replaceFunction: 'replace_function',
  splitFunction: 'split_function',
  firstFunction: 'first_function',
  lastFunction: 'last_function',
  coalesceFunction: 'coalesce_function',
  concatFunction: 'concat_function',
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

  createStepBlock(BLOCK_TYPES.scopedTransformStep, TRANSFORM_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('on columns')
      .appendField(new FieldColumnMultiSelect(), 'COLUMN_IDS');
    block.appendValueInput('ROW_CONDITION').setCheck('CONDITION').appendField('for rows where');
    block.appendValueInput('EXPRESSION').setCheck('EXPRESSION').appendField('apply');
    block.appendDummyInput()
      .appendField('treat whitespace as empty')
      .appendField(new Blockly.FieldCheckbox('TRUE'), 'TREAT_WHITESPACE_AS_EMPTY');
  });

  createStepBlock(BLOCK_TYPES.renameColumnStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('rename column')
      .appendField(createSchemaColumnDropdown(), 'COLUMN_ID');
    block.appendDummyInput()
      .appendField('to display name')
      .appendField(new Blockly.FieldTextInput('new_name'), 'NEW_DISPLAY_NAME');
  });

  createStepBlock(BLOCK_TYPES.dropColumnsStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('drop columns')
      .appendField(new FieldColumnMultiSelect(), 'COLUMN_IDS');
  });

  createStepBlock(BLOCK_TYPES.deriveColumnStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput().appendField('create new column');
    appendNewColumnFields(block);
    block.appendDummyInput()
      .appendField('initialize with')
      .appendField(new Blockly.FieldDropdown([
        ['blank', CREATE_COLUMN_MODES.blank],
        ['copy column', CREATE_COLUMN_MODES.copy],
        ['expression', CREATE_COLUMN_MODES.expression],
      ], (newValue) => {
        updateCreateColumnBlockMode(block, normalizeCreateColumnMode(newValue));
        return newValue;
      }), CREATE_COLUMN_INPUT_NAMES.mode);
    block.appendDummyInput(CREATE_COLUMN_INPUT_NAMES.copySourceRow)
      .appendField('copy from column')
      .appendField(createSchemaColumnDropdown(), CREATE_COLUMN_INPUT_NAMES.copySource);
    block.appendValueInput(CREATE_COLUMN_INPUT_NAMES.expression).setCheck('EXPRESSION').appendField('expression');
    updateCreateColumnBlockMode(block, CREATE_COLUMN_MODES.blank);
  });

  createStepBlock(BLOCK_TYPES.filterRowsStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('filter rows')
      .appendField(new Blockly.FieldDropdown([
        ['keep', 'keep'],
        ['drop', 'drop'],
      ]), 'MODE');
    block.appendValueInput('CONDITION').setCheck('CONDITION').appendField('where');
  });

  createStepBlock(BLOCK_TYPES.splitColumnStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('split column')
      .appendField(createSchemaColumnDropdown(), 'COLUMN_ID');
    block.appendDummyInput()
      .appendField('delimiter')
      .appendField(new Blockly.FieldTextInput(','), 'DELIMITER');
    block.appendStatementInput('OUTPUT_COLUMNS').setCheck('OUTPUT_COLUMN_ITEM').appendField('into output columns');
  });

  createStepBlock(BLOCK_TYPES.combineColumnsStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('combine columns')
      .appendField(new FieldColumnMultiSelect(), 'COLUMN_IDS');
    block.appendDummyInput()
      .appendField('separator')
      .appendField(new Blockly.FieldTextInput(', '), 'SEPARATOR');
    appendNewColumnFields(block);
  });

  createStepBlock(BLOCK_TYPES.deduplicateRowsStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput()
      .appendField('deduplicate rows by')
      .appendField(new FieldColumnMultiSelect(), 'COLUMN_IDS');
  });

  createStepBlock(BLOCK_TYPES.sortRowsStep, TABLE_OPERATION_COLOR, (block) => {
    block.appendDummyInput().appendField('sort rows by');
    block.appendStatementInput('SORTS').setCheck('SORT_ITEM').appendField('sort keys');
  });

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

  Blockly.Blocks[BLOCK_TYPES.sortItem] = {
    init() {
      this.appendDummyInput()
        .appendField('column')
        .appendField(createSchemaColumnDropdown(), 'COLUMN_ID')
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

  Blockly.Blocks[BLOCK_TYPES.conditionItem] = {
    init() {
      this.appendValueInput('CONDITION').setCheck('CONDITION').appendField('condition');
      this.setPreviousStatement(true, 'CONDITION_ITEM');
      this.setNextStatement(true, 'CONDITION_ITEM');
      this.setColour(CONDITION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.currentValueExpression] = {
    init() {
      this.appendDummyInput().appendField('current value');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(VALUE_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalString] = {
    init() {
      this.appendDummyInput()
        .appendField('text')
        .appendField(new Blockly.FieldTextInput('value'), 'VALUE');
      this.setOutput(true, ['EXPRESSION', 'LITERAL', 'NON_NULL_LITERAL', 'STRING_LITERAL']);
      this.setColour(VALUE_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalNumber] = {
    init() {
      this.appendDummyInput()
        .appendField('number')
        .appendField(new Blockly.FieldNumber(0), 'VALUE');
      this.setOutput(true, ['EXPRESSION', 'LITERAL', 'NON_NULL_LITERAL', 'NUMBER_LITERAL']);
      this.setColour(VALUE_COLOR);
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
      this.setColour(VALUE_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.literalNull] = {
    init() {
      this.appendDummyInput().appendField('null');
      this.setOutput(true, ['EXPRESSION', 'LITERAL']);
      this.setColour(VALUE_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.columnExpression] = {
    init() {
      this.appendDummyInput()
        .appendField('column value')
        .appendField(createSchemaColumnDropdown(), 'COLUMN_ID');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(VALUE_COLOR);
    },
  };

  createUnaryFunctionBlock(BLOCK_TYPES.trimFunction, 'trim');
  createUnaryFunctionBlock(BLOCK_TYPES.lowerFunction, 'lower');
  createUnaryFunctionBlock(BLOCK_TYPES.upperFunction, 'upper');
  createUnaryFunctionBlock(BLOCK_TYPES.collapseWhitespaceFunction, 'collapse whitespace');
  createUnaryFunctionBlock(BLOCK_TYPES.firstFunction, 'first');
  createUnaryFunctionBlock(BLOCK_TYPES.lastFunction, 'last');

  Blockly.Blocks[BLOCK_TYPES.substringFunction] = {
    init() {
      this.appendValueInput('INPUT').setCheck('EXPRESSION').appendField('substring');
      this.appendValueInput('START').setCheck('EXPRESSION').appendField('start');
      this.appendValueInput('LENGTH').setCheck('EXPRESSION').appendField('length');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(FUNCTION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.replaceFunction] = {
    init() {
      this.appendValueInput('INPUT').setCheck('EXPRESSION').appendField('replace');
      this.appendValueInput('FROM').setCheck('EXPRESSION').appendField('from');
      this.appendValueInput('TO').setCheck('EXPRESSION').appendField('to');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(FUNCTION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.splitFunction] = {
    init() {
      this.appendValueInput('INPUT').setCheck('EXPRESSION').appendField('split');
      this.appendValueInput('DELIMITER').setCheck('EXPRESSION').appendField('delimiter');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(FUNCTION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.coalesceFunction] = {
    init() {
      this.appendValueInput('FIRST').setCheck('EXPRESSION').appendField('coalesce');
      this.appendValueInput('SECOND').setCheck('EXPRESSION').appendField('fallback');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(FUNCTION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.concatFunction] = {
    init() {
      this.appendValueInput('FIRST').setCheck('EXPRESSION').appendField('concat');
      this.appendValueInput('SECOND').setCheck('EXPRESSION').appendField('with');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(FUNCTION_COLOR);
    },
  };

  Blockly.Blocks[BLOCK_TYPES.isEmptyCondition] = {
    init() {
      this.appendDummyInput()
        .appendField('is empty')
        .appendField(createSchemaColumnDropdown(), 'COLUMN_ID')
        .appendField('treat whitespace as empty')
        .appendField(new Blockly.FieldCheckbox('TRUE'), 'TREAT_WHITESPACE_AS_EMPTY');
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
        name: 'Scoped transforms',
        colour: TRANSFORM_COLOR,
        contents: [{ kind: 'block', type: BLOCK_TYPES.scopedTransformStep }],
      },
      {
        kind: 'category',
        name: 'Table operations',
        colour: TABLE_OPERATION_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.dropColumnsStep },
          { kind: 'block', type: BLOCK_TYPES.renameColumnStep },
          { kind: 'block', type: BLOCK_TYPES.deriveColumnStep },
          { kind: 'block', type: BLOCK_TYPES.filterRowsStep },
          { kind: 'block', type: BLOCK_TYPES.splitColumnStep },
          { kind: 'block', type: BLOCK_TYPES.combineColumnsStep },
          { kind: 'block', type: BLOCK_TYPES.deduplicateRowsStep },
          { kind: 'block', type: BLOCK_TYPES.sortRowsStep },
        ],
      },
      {
        kind: 'category',
        name: 'Values',
        colour: VALUE_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.currentValueExpression },
          { kind: 'block', type: BLOCK_TYPES.literalString },
          { kind: 'block', type: BLOCK_TYPES.literalNumber },
          { kind: 'block', type: BLOCK_TYPES.literalBoolean },
          { kind: 'block', type: BLOCK_TYPES.columnExpression },
        ],
      },
      {
        kind: 'category',
        name: 'Functions',
        colour: FUNCTION_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.trimFunction },
          { kind: 'block', type: BLOCK_TYPES.lowerFunction },
          { kind: 'block', type: BLOCK_TYPES.upperFunction },
          { kind: 'block', type: BLOCK_TYPES.collapseWhitespaceFunction },
          { kind: 'block', type: BLOCK_TYPES.substringFunction },
          { kind: 'block', type: BLOCK_TYPES.replaceFunction },
          { kind: 'block', type: BLOCK_TYPES.splitFunction },
          { kind: 'block', type: BLOCK_TYPES.firstFunction },
          { kind: 'block', type: BLOCK_TYPES.lastFunction },
          { kind: 'block', type: BLOCK_TYPES.coalesceFunction },
          { kind: 'block', type: BLOCK_TYPES.concatFunction },
        ],
      },
      {
        kind: 'category',
        name: 'Lists',
        colour: SUPPORT_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.outputColumnItem },
          { kind: 'block', type: BLOCK_TYPES.sortItem },
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

function createStepBlock(type: string, colour: string, buildFields: (block: Blockly.Block) => void) {
  Blockly.Blocks[type] = {
    init() {
      buildFields(this);
      this.setPreviousStatement(true, 'AUTHORING_STEP');
      this.setNextStatement(true, 'AUTHORING_STEP');
      this.setColour(colour);
    },
  };
}

function createUnaryFunctionBlock(type: string, label: string) {
  Blockly.Blocks[type] = {
    init() {
      this.appendValueInput('INPUT').setCheck('EXPRESSION').appendField(label);
      this.setOutput(true, 'EXPRESSION');
      this.setColour(FUNCTION_COLOR);
    },
  };
}

function createLiteralConditionBlock(type: string, label: string) {
  Blockly.Blocks[type] = {
    init() {
      this.appendDummyInput()
        .appendField(label)
        .appendField(createSchemaColumnDropdown(), 'COLUMN_ID');
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
        .appendField(createSchemaColumnDropdown(), 'COLUMN_ID')
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
    .appendField('display name')
    .appendField(new Blockly.FieldTextInput('new_column'), 'NEW_DISPLAY_NAME');
}

function updateCreateColumnBlockMode(block: Blockly.Block, mode: CreateColumnMode) {
  block.getInput(CREATE_COLUMN_INPUT_NAMES.copySourceRow)?.setVisible(mode === CREATE_COLUMN_MODES.copy);
  block.getInput(CREATE_COLUMN_INPUT_NAMES.expression)?.setVisible(mode === CREATE_COLUMN_MODES.expression);

  if ('rendered' in block && (block as Blockly.BlockSvg).rendered) {
    (block as Blockly.BlockSvg).render();
  }
}

function normalizeCreateColumnMode(value: unknown): CreateColumnMode {
  switch (value) {
    case CREATE_COLUMN_MODES.copy:
    case CREATE_COLUMN_MODES.expression:
      return value;
    case CREATE_COLUMN_MODES.blank:
    default:
      return CREATE_COLUMN_MODES.blank;
  }
}
