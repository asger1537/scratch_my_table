import * as Blockly from 'blockly';

import { FieldColumnMultiSelect } from './FieldColumnMultiSelect';
import { getSchemaColumnOptions } from './schemaOptions';

const TRANSFORM_COLOR = '#b04a1f';
const TABLE_OPERATION_COLOR = '#8c3a18';
const SUPPORT_COLOR = '#6b6a5c';
const VALUE_COLOR = '#2d6a4f';
const FUNCTION_COLOR = '#457b9d';
const LOGIC_COLOR = '#355070';
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
  isEmptyFunction: 'is_empty_function',
  equalsFunction: 'equals_function',
  containsFunction: 'contains_function',
  startsWithFunction: 'starts_with_function',
  endsWithFunction: 'ends_with_function',
  matchesRegexFunction: 'matches_regex_function',
  greaterThanFunction: 'greater_than_function',
  lessThanFunction: 'less_than_function',
  andFunction: 'and_function',
  orFunction: 'or_function',
  notFunction: 'not_function',
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
    block.appendValueInput('ROW_CONDITION').setCheck('EXPRESSION').appendField('for rows where');
    block.appendValueInput('EXPRESSION').setCheck('EXPRESSION').appendField('apply');
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
    block.appendValueInput('CONDITION').setCheck('EXPRESSION').appendField('where');
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

  createUnaryFunctionBlock(BLOCK_TYPES.trimFunction, 'trim', FUNCTION_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.lowerFunction, 'lower', FUNCTION_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.upperFunction, 'upper', FUNCTION_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.collapseWhitespaceFunction, 'collapse whitespace', FUNCTION_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.firstFunction, 'first', FUNCTION_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.lastFunction, 'last', FUNCTION_COLOR);

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

  createBinaryFunctionBlock(BLOCK_TYPES.coalesceFunction, 'coalesce', 'FIRST', 'fallback', 'SECOND', FUNCTION_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.concatFunction, 'concat', 'FIRST', 'with', 'SECOND', FUNCTION_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.isEmptyFunction, 'is empty', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.equalsFunction, 'equals', 'FIRST', 'and', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.containsFunction, 'contains', 'FIRST', 'text', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.startsWithFunction, 'starts with', 'FIRST', 'text', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.endsWithFunction, 'ends with', 'FIRST', 'text', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.matchesRegexFunction, 'matches regex', 'FIRST', 'pattern', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.greaterThanFunction, 'greater than', 'FIRST', 'and', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.lessThanFunction, 'less than', 'FIRST', 'and', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.andFunction, 'and', 'FIRST', 'and', 'SECOND', LOGIC_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.orFunction, 'or', 'FIRST', 'or', 'SECOND', LOGIC_COLOR);
  createUnaryFunctionBlock(BLOCK_TYPES.notFunction, 'not', LOGIC_COLOR);
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
        name: 'Logic',
        colour: LOGIC_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.isEmptyFunction },
          { kind: 'block', type: BLOCK_TYPES.equalsFunction },
          { kind: 'block', type: BLOCK_TYPES.containsFunction },
          { kind: 'block', type: BLOCK_TYPES.startsWithFunction },
          { kind: 'block', type: BLOCK_TYPES.endsWithFunction },
          { kind: 'block', type: BLOCK_TYPES.matchesRegexFunction },
          { kind: 'block', type: BLOCK_TYPES.greaterThanFunction },
          { kind: 'block', type: BLOCK_TYPES.lessThanFunction },
          { kind: 'block', type: BLOCK_TYPES.andFunction },
          { kind: 'block', type: BLOCK_TYPES.orFunction },
          { kind: 'block', type: BLOCK_TYPES.notFunction },
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

function createUnaryFunctionBlock(type: string, label: string, colour: string) {
  Blockly.Blocks[type] = {
    init() {
      this.appendValueInput('INPUT').setCheck('EXPRESSION').appendField(label);
      this.setOutput(true, 'EXPRESSION');
      this.setColour(colour);
    },
  };
}

function createBinaryFunctionBlock(
  type: string,
  label: string,
  firstInput: string,
  secondLabel: string,
  secondInput: string,
  colour: string,
) {
  Blockly.Blocks[type] = {
    init() {
      this.appendValueInput(firstInput).setCheck('EXPRESSION').appendField(label);
      this.appendValueInput(secondInput).setCheck('EXPRESSION').appendField(secondLabel);
      this.setOutput(true, 'EXPRESSION');
      this.setColour(colour);
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
