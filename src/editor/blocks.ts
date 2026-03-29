import * as Blockly from 'blockly';

import { FieldCommentInput } from './FieldCommentInput';
import { FieldColorInput } from './FieldColorInput';
import { FieldColumnMultiSelect } from './FieldColumnMultiSelect';
import { FieldSearchDropdown } from './FieldSearchDropdown';
import { getSchemaColumnOptions } from './schemaOptions';

const TRANSFORM_COLOR = '#b04a1f';
const FORMAT_COLOR = '#8f5d2d';
const TABLE_OPERATION_COLOR = '#8c3a18';
const COMMENT_COLOR = '#7a6f62';
const SUPPORT_COLOR = '#6b6a5c';
const VALUE_COLOR = '#2d6a4f';
const FUNCTION_COLOR = '#457b9d';
const DATE_COLOR = '#2a9d8f';
const MATH_COLOR = '#6b3a8c';
const LOGIC_COLOR = '#355070';
const LOGICAL_GROUP_ACTION_ICON_SIZE = 18;
const CHECKBOX_TRUE = 'TRUE';
const CHECKBOX_FALSE = 'FALSE';
const CREATE_COLUMN_INPUT_NAMES = {
  mode: 'CREATE_MODE',
  copySource: 'COPY_COLUMN_ID',
  copySourceRow: 'COPY_COLUMN_ROW',
  expression: 'EXPRESSION',
} as const;
const SCOPED_RULE_INPUT_NAMES = {
  cases: 'CASES',
  singleValueEnabled: 'SINGLE_VALUE_ENABLED',
  singleValue: 'SINGLE_VALUE',
  singleFormatEnabled: 'SINGLE_FORMAT_ENABLED',
  singleFormatRow: 'SINGLE_FORMAT_ROW',
  singleColor: 'SINGLE_COLOR',
  defaultValueEnabled: 'DEFAULT_VALUE_ENABLED',
  defaultValueRow: 'DEFAULT_VALUE_ROW',
  defaultValue: 'DEFAULT_VALUE',
  defaultFormatEnabled: 'DEFAULT_FORMAT_ENABLED',
  defaultFormatRow: 'DEFAULT_FORMAT_ROW',
  defaultColor: 'DEFAULT_COLOR',
} as const;
const RULE_CASE_INPUT_NAMES = {
  when: 'WHEN',
  valueEnabled: 'VALUE_ENABLED',
  valueRow: 'VALUE_ROW',
  value: 'VALUE',
  formatEnabled: 'FORMAT_ENABLED',
  formatRow: 'FORMAT_ROW',
  color: 'COLOR',
} as const;

let blocksRegistered = false;
export const CREATE_COLUMN_MODES = {
  blank: 'blank',
  copy: 'copy',
  expression: 'expression',
} as const;
export type CreateColumnMode = typeof CREATE_COLUMN_MODES[keyof typeof CREATE_COLUMN_MODES];
type LogicalGroupBlock = Blockly.Block & {
  itemCount_?: number;
  updateShape_?: () => void;
};
type ScopedRuleBlock = Blockly.Block & {
  updateShape_?: () => void;
};
type RuleCaseBlock = Blockly.Block & {
  updateShape_?: () => void;
};
type SwitchGroupBlock = Blockly.Block & {
  itemCount_?: number;
  updateShape_?: () => void;
};
type PredicateFunctionBlock = Blockly.Block & {
  updateShape_?: (operator?: PredicateFunctionOperator) => void;
};
type ComparatorOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
type PredicateFunctionOperator = 'contains' | 'startsWith' | 'endsWith' | 'matchesRegex' | 'isEmpty';
const COMPARATOR_OPTIONS: Array<[string, ComparatorOperator]> = [
  ['=', 'eq'],
  ['≠', 'ne'],
  ['<', 'lt'],
  ['≤', 'lte'],
  ['>', 'gt'],
  ['≥', 'gte'],
];
const PREDICATE_FUNCTION_OPTIONS: Array<{ label: string; value: PredicateFunctionOperator; searchText: string }> = [
  { label: 'contains', value: 'contains', searchText: 'contains includes has text substring' },
  { label: 'starts with', value: 'startsWith', searchText: 'starts with begins prefix' },
  { label: 'ends with', value: 'endsWith', searchText: 'ends with suffix' },
  { label: 'matches regex', value: 'matchesRegex', searchText: 'matches regex pattern regular expression' },
  { label: 'is empty', value: 'isEmpty', searchText: 'is empty blank null missing' },
];

function createSchemaColumnDropdown() {
  return new Blockly.FieldDropdown(function (this: Blockly.FieldDropdown) {
    return getSchemaColumnOptions(this.getSourceBlock()?.id);
  });
}

export const BLOCK_TYPES = {
  commentStep: 'comment_step',
  scopedRuleCasesStep: 'scoped_rule_cases_step',
  ruleCaseItem: 'rule_case_item',
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
  extractRegexFunction: 'extract_regex_function',
  replaceRegexFunction: 'replace_regex_function',
  splitFunction: 'split_function',
  atIndexFunction: 'at_index_function',
  firstFunction: 'first_function',
  lastFunction: 'last_function',
  nowFunction: 'now_function',
  datePartFunction: 'date_part_function',
  dateDiffFunction: 'date_diff_function',
  dateAddFunction: 'date_add_function',
  coalesceFunction: 'coalesce_function',
  switchFunction: 'switch_function',
  concatFunction: 'concat_function',
  arithmeticFunction: 'arithmetic_function',
  mathRoundingFunction: 'math_rounding_function',
  comparisonFunction: 'comparison_function',
  predicateFunction: 'predicate_function',
  logicalBinaryFunction: 'logical_binary_function',
  notFunction: 'not_function',
} as const;

export function registerWorkflowBlocks() {
  if (blocksRegistered) {
    return;
  }

  blocksRegistered = true;

  createStepBlock(BLOCK_TYPES.commentStep, COMMENT_COLOR, (block) => {
    block.appendDummyInput().appendField('comment');
    block.appendDummyInput()
      .appendField(new FieldCommentInput('Add a workflow note'), 'TEXT');
  });

  Blockly.Blocks[BLOCK_TYPES.scopedRuleCasesStep] = {
    init(this: ScopedRuleBlock) {
      this.appendDummyInput()
        .appendField('on columns')
        .appendField(new FieldColumnMultiSelect(), 'COLUMN_IDS');
      this.appendValueInput('ROW_CONDITION').setCheck('EXPRESSION').appendField('for rows where');
      this.appendStatementInput(SCOPED_RULE_INPUT_NAMES.cases).setCheck('RULE_CASE_ITEM').appendField('cases');
      this.appendDummyInput('DEFAULT_TOGGLE_ROW')
        .appendField('apply by default')
        .appendField('set value')
        .appendField(createShapeAwareCheckbox(this, CHECKBOX_FALSE), SCOPED_RULE_INPUT_NAMES.defaultValueEnabled)
        .appendField('fill color')
        .appendField(createShapeAwareCheckbox(this, CHECKBOX_FALSE), SCOPED_RULE_INPUT_NAMES.defaultFormatEnabled);
      this.appendValueInput(SCOPED_RULE_INPUT_NAMES.defaultValue).setCheck('EXPRESSION').appendField('default set value');
      this.appendDummyInput(SCOPED_RULE_INPUT_NAMES.defaultFormatRow)
        .appendField('default fill color')
        .appendField(new FieldColorInput(), SCOPED_RULE_INPUT_NAMES.defaultColor);
      this.setPreviousStatement(true, 'AUTHORING_STEP');
      this.setNextStatement(true, 'AUTHORING_STEP');
      this.setColour(TRANSFORM_COLOR);
      this.updateShape_ = () => updateScopedRuleCasesShape(this);
      this.updateShape_();
    },
  };

  Blockly.Blocks[BLOCK_TYPES.ruleCaseItem] = {
    init(this: RuleCaseBlock) {
      this.appendValueInput(RULE_CASE_INPUT_NAMES.when).setCheck('EXPRESSION').appendField('when');
      this.appendDummyInput('CASE_TOGGLE_ROW')
        .appendField('then')
        .appendField('set value')
        .appendField(createShapeAwareCheckbox(this, CHECKBOX_TRUE), RULE_CASE_INPUT_NAMES.valueEnabled)
        .appendField('fill color')
        .appendField(createShapeAwareCheckbox(this, CHECKBOX_FALSE), RULE_CASE_INPUT_NAMES.formatEnabled);
      this.appendValueInput(RULE_CASE_INPUT_NAMES.value).setCheck('EXPRESSION').appendField('set value');
      this.appendDummyInput(RULE_CASE_INPUT_NAMES.formatRow)
        .appendField('fill color')
        .appendField(new FieldColorInput(), RULE_CASE_INPUT_NAMES.color);
      this.setPreviousStatement(true, 'RULE_CASE_ITEM');
      this.setNextStatement(true, 'RULE_CASE_ITEM');
      this.setColour(SUPPORT_COLOR);
      this.updateShape_ = () => updateRuleCaseShape(this);
      this.updateShape_();
    },
  };

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
  Blockly.Blocks[BLOCK_TYPES.nowFunction] = {
    init() {
      this.appendDummyInput().appendField('current date and time');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(DATE_COLOR);
    },
  };
  Blockly.Blocks[BLOCK_TYPES.datePartFunction] = {
    init() {
      this.appendValueInput('INPUT')
        .setCheck('EXPRESSION')
        .appendField('get')
        .appendField(new Blockly.FieldDropdown([
          ['year', 'year'],
          ['month', 'month'],
          ['day', 'day'],
          ['day of week', 'dayOfWeek'],
          ['hour', 'hour'],
          ['minute', 'minute'],
          ['second', 'second'],
        ]), 'PART')
        .appendField('from');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(DATE_COLOR);
    },
  };
  Blockly.Blocks[BLOCK_TYPES.dateDiffFunction] = {
    init() {
      this.appendValueInput('START').setCheck('EXPRESSION').appendField('difference between');
      this.appendValueInput('END').setCheck('EXPRESSION').appendField('and');
      this.appendDummyInput()
        .appendField('in')
        .appendField(new Blockly.FieldDropdown([
          ['years', 'years'],
          ['months', 'months'],
          ['days', 'days'],
          ['hours', 'hours'],
          ['minutes', 'minutes'],
          ['seconds', 'seconds'],
        ]), 'UNIT');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(DATE_COLOR);
    },
  };
  Blockly.Blocks[BLOCK_TYPES.dateAddFunction] = {
    init() {
      this.appendValueInput('AMOUNT').setCheck('EXPRESSION').appendField('add');
      this.appendValueInput('INPUT')
        .setCheck('EXPRESSION')
        .appendField(new Blockly.FieldDropdown([
          ['years', 'years'],
          ['months', 'months'],
          ['days', 'days'],
          ['hours', 'hours'],
          ['minutes', 'minutes'],
          ['seconds', 'seconds'],
        ]), 'UNIT')
        .appendField('to');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(DATE_COLOR);
    },
  };

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

  createBinaryFunctionBlock(BLOCK_TYPES.extractRegexFunction, 'extract regex', 'INPUT', 'pattern', 'PATTERN', FUNCTION_COLOR);
  Blockly.Blocks[BLOCK_TYPES.replaceRegexFunction] = {
    init() {
      this.appendValueInput('INPUT').setCheck('EXPRESSION').appendField('replace regex');
      this.appendValueInput('PATTERN').setCheck('EXPRESSION').appendField('pattern');
      this.appendValueInput('REPLACEMENT').setCheck('EXPRESSION').appendField('with');
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

  createBinaryFunctionBlock(BLOCK_TYPES.atIndexFunction, 'get item at', 'INPUT', 'index', 'INDEX', FUNCTION_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.coalesceFunction, 'coalesce', 'FIRST', 'fallback', 'SECOND', FUNCTION_COLOR);
  createBinaryFunctionBlock(BLOCK_TYPES.concatFunction, 'concat', 'FIRST', 'with', 'SECOND', FUNCTION_COLOR);
  createDropdownBinaryFunctionBlock(
    BLOCK_TYPES.arithmeticFunction,
    [['+', 'add'], ['-', 'subtract'], ['×', 'multiply'], ['÷', 'divide'], ['%', 'modulo']],
    'OPERATOR',
    MATH_COLOR,
  );
  Blockly.Blocks[BLOCK_TYPES.mathRoundingFunction] = {
    init() {
      this.appendValueInput('INPUT')
        .setCheck('EXPRESSION')
        .appendField(new Blockly.FieldDropdown([
          ['round', 'round'],
          ['floor', 'floor'],
          ['ceil', 'ceil'],
          ['abs', 'abs'],
        ]), 'OPERATOR');
      this.setOutput(true, 'EXPRESSION');
      this.setColour(MATH_COLOR);
    },
  };
  createDropdownBinaryFunctionBlock(BLOCK_TYPES.comparisonFunction, COMPARATOR_OPTIONS, 'OPERATOR', LOGIC_COLOR);
  Blockly.Blocks[BLOCK_TYPES.predicateFunction] = {
    init(this: PredicateFunctionBlock) {
      this.setOutput(true, 'EXPRESSION');
      this.setInputsInline(true);
      this.setColour(LOGIC_COLOR);
      this.updateShape_ = (operator?: PredicateFunctionOperator) => updatePredicateFunctionShape(this, operator);
      this.updateShape_('contains');
    },
  };
  Blockly.Blocks[BLOCK_TYPES.logicalBinaryFunction] = {
    init(this: LogicalGroupBlock) {
      this.itemCount_ = 2;
      this.setOutput(true, 'EXPRESSION');
      this.setInputsInline(false);
      this.setColour(LOGIC_COLOR);
      this.updateShape_ = () => updateLogicalGroupShape(this);
      this.updateShape_();
    },
    saveExtraState(this: LogicalGroupBlock) {
      return {
        itemCount: Math.max(2, this.itemCount_ ?? 2),
      };
    },
    loadExtraState(this: LogicalGroupBlock, state: { itemCount?: number }) {
      this.itemCount_ = Math.max(2, Number(state.itemCount) || 2);
      this.updateShape_?.();
    },
  };
  Blockly.Blocks[BLOCK_TYPES.switchFunction] = {
    init(this: SwitchGroupBlock) {
      this.itemCount_ = 1;
      this.appendValueInput('TARGET').setCheck('EXPRESSION').appendField('switch');
      this.setOutput(true, 'EXPRESSION');
      this.setInputsInline(false);
      this.setColour(LOGIC_COLOR);
      this.updateShape_ = () => updateSwitchGroupShape(this);
      this.updateShape_();
    },
    saveExtraState(this: SwitchGroupBlock) {
      return {
        itemCount: Math.max(1, this.itemCount_ ?? 1),
      };
    },
    loadExtraState(this: SwitchGroupBlock, state: { itemCount?: number }) {
      this.itemCount_ = Math.max(1, Number(state.itemCount) || 1);
      this.updateShape_?.();
    },
  };
  createUnaryFunctionBlock(BLOCK_TYPES.notFunction, 'not', LOGIC_COLOR);
}

export function getWorkflowToolboxDefinition(): Blockly.utils.toolbox.ToolboxInfo {
  return {
    kind: 'categoryToolbox',
    contents: [
      {
        kind: 'category',
        name: 'Scoped rules',
        colour: TRANSFORM_COLOR,
        contents: [
          {
            kind: 'block',
            type: BLOCK_TYPES.scopedRuleCasesStep,
            fields: {
              [SCOPED_RULE_INPUT_NAMES.defaultValueEnabled]: CHECKBOX_TRUE,
              [SCOPED_RULE_INPUT_NAMES.defaultFormatEnabled]: CHECKBOX_FALSE,
            },
          },
          { kind: 'block', type: BLOCK_TYPES.ruleCaseItem },
        ],
      },
      {
        kind: 'category',
        name: 'Formatting',
        colour: FORMAT_COLOR,
        contents: [
          {
            kind: 'block',
            type: BLOCK_TYPES.scopedRuleCasesStep,
            fields: {
              [SCOPED_RULE_INPUT_NAMES.defaultValueEnabled]: CHECKBOX_FALSE,
              [SCOPED_RULE_INPUT_NAMES.defaultFormatEnabled]: CHECKBOX_TRUE,
            },
          },
        ],
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
        name: 'Comments',
        colour: COMMENT_COLOR,
        contents: [{ kind: 'block', type: BLOCK_TYPES.commentStep }],
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
          { kind: 'block', type: BLOCK_TYPES.extractRegexFunction },
          { kind: 'block', type: BLOCK_TYPES.replaceRegexFunction },
          { kind: 'block', type: BLOCK_TYPES.splitFunction },
          { kind: 'block', type: BLOCK_TYPES.firstFunction },
          { kind: 'block', type: BLOCK_TYPES.lastFunction },
          { kind: 'block', type: BLOCK_TYPES.atIndexFunction },
          { kind: 'block', type: BLOCK_TYPES.coalesceFunction },
          { kind: 'block', type: BLOCK_TYPES.concatFunction },
        ],
      },
      {
        kind: 'category',
        name: 'Date & time',
        colour: DATE_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.nowFunction },
          { kind: 'block', type: BLOCK_TYPES.datePartFunction },
          { kind: 'block', type: BLOCK_TYPES.dateDiffFunction },
          { kind: 'block', type: BLOCK_TYPES.dateAddFunction },
        ],
      },
      {
        kind: 'category',
        name: 'Math',
        colour: MATH_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.arithmeticFunction },
          { kind: 'block', type: BLOCK_TYPES.mathRoundingFunction },
        ],
      },
      {
        kind: 'category',
        name: 'Logic',
        colour: LOGIC_COLOR,
        contents: [
          { kind: 'block', type: BLOCK_TYPES.comparisonFunction },
          { kind: 'block', type: BLOCK_TYPES.predicateFunction },
          { kind: 'block', type: BLOCK_TYPES.logicalBinaryFunction },
          { kind: 'block', type: BLOCK_TYPES.switchFunction },
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
      this.setInputsInline(true);
      this.setOutput(true, 'EXPRESSION');
      this.setColour(colour);
    },
  };
}

function createDropdownBinaryFunctionBlock(
  type: string,
  options: [string, string][],
  fieldName: string,
  colour: string,
) {
  Blockly.Blocks[type] = {
    init() {
      this.appendValueInput('FIRST').setCheck('EXPRESSION');
      this.appendValueInput('SECOND')
        .setCheck('EXPRESSION')
        .appendField(new Blockly.FieldDropdown(options), fieldName);
      this.setInputsInline(true);
      this.setOutput(true, 'EXPRESSION');
      this.setColour(colour);
    },
  };
}

function updateLogicalGroupShape(block: LogicalGroupBlock) {
  const currentOperator = normalizeLogicalGroupOperator(block.getFieldValue('OPERATOR'));
  if (block.getInput('HEADER')) {
    block.removeInput('HEADER');
  }

  let index = 0;

  while (block.getInput(`ITEM${index}`)) {
    block.removeInput(`ITEM${index}`);
    index += 1;
  }

  block.appendDummyInput('HEADER')
    .appendField('conditions')
    .appendField(createLogicalGroupOperatorField(block), 'OPERATOR')
    .appendField(createLogicalGroupActionField('add', 'Add condition', (field) => {
      const sourceBlock = field.getSourceBlock() as LogicalGroupBlock | null;

      if (!sourceBlock) {
        return;
      }

      resizeLogicalGroup(sourceBlock, Math.max(2, sourceBlock.itemCount_ ?? 2) + 1);
    }), 'ADD_ITEM')
    .appendField(createLogicalGroupActionField('remove', 'Remove condition', (field) => {
      const sourceBlock = field.getSourceBlock() as LogicalGroupBlock | null;

      if (!sourceBlock) {
        return;
      }

      resizeLogicalGroup(sourceBlock, Math.max(2, sourceBlock.itemCount_ ?? 2) - 1);
    }), 'REMOVE_ITEM');
  block.setFieldValue(currentOperator, 'OPERATOR');

  const itemCount = Math.max(2, block.itemCount_ ?? 2);

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    block.appendValueInput(`ITEM${itemIndex}`)
      .setCheck('EXPRESSION')
      .appendField(`condition ${itemIndex + 1}`);
  }

  block.setInputsInline(false);
}

function updatePredicateFunctionShape(block: PredicateFunctionBlock, operator = normalizePredicateFunctionOperator(block.getFieldValue('OPERATOR'))) {
  const primaryConnection =
    block.getInput('FIRST')?.connection?.targetConnection
    ?? block.getInput('INPUT')?.connection?.targetConnection
    ?? null;
  const secondaryConnection = block.getInput('SECOND')?.connection?.targetConnection ?? null;

  ['FIRST', 'SECOND', 'INPUT'].forEach((inputName) => {
    if (block.getInput(inputName)) {
      block.removeInput(inputName);
    }
  });

  if (isUnaryPredicateFunctionOperator(operator)) {
    block.appendValueInput('INPUT')
      .setCheck('EXPRESSION')
      .appendField(createPredicateFunctionOperatorField(block, operator), 'OPERATOR');
    primaryConnection?.reconnect(block, 'INPUT');
  } else {
    block.appendValueInput('FIRST').setCheck('EXPRESSION');
    block.appendValueInput('SECOND')
      .setCheck('EXPRESSION')
      .appendField(createPredicateFunctionOperatorField(block, operator), 'OPERATOR');
    primaryConnection?.reconnect(block, 'FIRST');
    secondaryConnection?.reconnect(block, 'SECOND');
  }

  block.setInputsInline(true);

  if ('rendered' in block && (block as Blockly.BlockSvg).rendered) {
    (block as Blockly.BlockSvg).render();
  }
}

function createPredicateFunctionOperatorField(block: PredicateFunctionBlock, operator: PredicateFunctionOperator) {
  return new FieldSearchDropdown(
    operator,
    PREDICATE_FUNCTION_OPTIONS,
    (newValue) => {
      const normalizedValue = normalizePredicateFunctionOperator(newValue);
      block.updateShape_?.(normalizedValue);
      return normalizedValue;
    },
  );
}

function createLogicalGroupActionField(
  kind: 'add' | 'remove',
  alt: string,
  onClick: (field: Blockly.FieldImage) => void,
) {
  return new Blockly.FieldImage(
    createLogicalGroupActionIcon(kind),
    LOGICAL_GROUP_ACTION_ICON_SIZE,
    LOGICAL_GROUP_ACTION_ICON_SIZE,
    alt,
    onClick,
  );
}

function createLogicalGroupActionIcon(kind: 'add' | 'remove') {
  const glyph = kind === 'add'
    ? '<line x1="9" y1="4" x2="9" y2="14" stroke="#355070" stroke-width="1.6" stroke-linecap="round"/><line x1="4" y1="9" x2="14" y2="9" stroke="#355070" stroke-width="1.6" stroke-linecap="round"/>'
    : '<line x1="4" y1="9" x2="14" y2="9" stroke="#355070" stroke-width="1.6" stroke-linecap="round"/>';

  return `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGICAL_GROUP_ACTION_ICON_SIZE}" height="${LOGICAL_GROUP_ACTION_ICON_SIZE}" viewBox="0 0 18 18"><rect x="0.75" y="0.75" width="16.5" height="16.5" rx="4" fill="#f6efe6" stroke="#355070" stroke-width="1.5"/>${glyph}</svg>`,
  )}`;
}

function createLogicalGroupOperatorField(block: LogicalGroupBlock) {
  return new Blockly.FieldDropdown([
    ['and', 'and'],
    ['or', 'or'],
  ], (newValue) => {
    return normalizeLogicalGroupOperator(newValue);
  });
}

function normalizeLogicalGroupOperator(value: unknown) {
  return value === 'or' ? 'or' : 'and';
}

function normalizePredicateFunctionOperator(value: unknown): PredicateFunctionOperator {
  switch (value) {
    case 'startsWith':
    case 'endsWith':
    case 'matchesRegex':
    case 'isEmpty':
    case 'contains':
      return value;
    default:
      return 'contains';
  }
}

function isUnaryPredicateFunctionOperator(operator: PredicateFunctionOperator) {
  return operator === 'isEmpty';
}

function resizeLogicalGroup(block: LogicalGroupBlock, itemCount: number) {
  const nextCount = Math.max(2, itemCount);
  const currentCount = Math.max(2, block.itemCount_ ?? 2);

  if (nextCount === currentCount) {
    return;
  }

  const connections = Array.from({ length: currentCount }, (_, index) => (
    block.getInput(`ITEM${index}`)?.connection?.targetConnection ?? null
  ));

  for (let index = nextCount; index < currentCount; index += 1) {
    connections[index]?.disconnect();
  }

  block.itemCount_ = nextCount;
  block.updateShape_?.();

  const reconnectCount = Math.min(nextCount, connections.length);

  for (let index = 0; index < reconnectCount; index += 1) {
    connections[index]?.reconnect(block, `ITEM${index}`);
  }

  if ('rendered' in block && (block as Blockly.BlockSvg).rendered) {
    (block as Blockly.BlockSvg).render();
  }
}

function updateSwitchGroupShape(block: SwitchGroupBlock) {
  if (block.getInput('HEADER')) {
    block.removeInput('HEADER');
  }

  let index = 0;

  while (block.getInput(`MATCH${index}`)) {
    block.removeInput(`MATCH${index}`);
    block.removeInput(`RETURN${index}`);
    index += 1;
  }

  if (block.getInput('DEFAULT')) {
    block.removeInput('DEFAULT');
  }

  block.appendDummyInput('HEADER')
    .appendField('cases')
    .appendField(createLogicalGroupActionField('add', 'Add case', (field) => {
      const sourceBlock = field.getSourceBlock() as SwitchGroupBlock | null;

      if (!sourceBlock) {
        return;
      }

      resizeSwitchGroup(sourceBlock, Math.max(1, sourceBlock.itemCount_ ?? 1) + 1);
    }), 'ADD_ITEM')
    .appendField(createLogicalGroupActionField('remove', 'Remove case', (field) => {
      const sourceBlock = field.getSourceBlock() as SwitchGroupBlock | null;

      if (!sourceBlock) {
        return;
      }

      resizeSwitchGroup(sourceBlock, Math.max(1, sourceBlock.itemCount_ ?? 1) - 1);
    }), 'REMOVE_ITEM');

  const itemCount = Math.max(1, block.itemCount_ ?? 1);

  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    block.appendValueInput(`MATCH${itemIndex}`)
      .setCheck('EXPRESSION')
      .appendField(`case ${itemIndex + 1}`);
    block.appendValueInput(`RETURN${itemIndex}`)
      .setCheck('EXPRESSION')
      .appendField('then');
  }

  block.appendValueInput('DEFAULT')
    .setCheck('EXPRESSION')
    .appendField('default');
}

function resizeSwitchGroup(block: SwitchGroupBlock, itemCount: number) {
  const nextCount = Math.max(1, itemCount);
  const currentCount = Math.max(1, block.itemCount_ ?? 1);

  if (nextCount === currentCount) {
    return;
  }

  const matchConnections = Array.from({ length: currentCount }, (_, index) => (
    block.getInput(`MATCH${index}`)?.connection?.targetConnection ?? null
  ));
  const returnConnections = Array.from({ length: currentCount }, (_, index) => (
    block.getInput(`RETURN${index}`)?.connection?.targetConnection ?? null
  ));
  const defaultConnection = block.getInput('DEFAULT')?.connection?.targetConnection ?? null;

  for (let index = nextCount; index < currentCount; index += 1) {
    matchConnections[index]?.disconnect();
    returnConnections[index]?.disconnect();
  }

  defaultConnection?.disconnect();

  block.itemCount_ = nextCount;
  block.updateShape_?.();

  const reconnectCount = Math.min(nextCount, matchConnections.length);

  for (let index = 0; index < reconnectCount; index += 1) {
    matchConnections[index]?.reconnect(block, `MATCH${index}`);
    returnConnections[index]?.reconnect(block, `RETURN${index}`);
  }

  defaultConnection?.reconnect(block, 'DEFAULT');

  if ('rendered' in block && (block as Blockly.BlockSvg).rendered) {
    (block as Blockly.BlockSvg).render();
  }
}

function updateScopedRuleCasesShape(block: ScopedRuleBlock) {
  const defaultValueEnabled = isChecked(block.getFieldValue(SCOPED_RULE_INPUT_NAMES.defaultValueEnabled));
  const defaultFormatEnabled = isChecked(block.getFieldValue(SCOPED_RULE_INPUT_NAMES.defaultFormatEnabled));

  block.getInput('DEFAULT_TOGGLE_ROW')?.setVisible(true);
  block.getInput(SCOPED_RULE_INPUT_NAMES.defaultValue)?.setVisible(defaultValueEnabled);
  block.getInput(SCOPED_RULE_INPUT_NAMES.defaultFormatRow)?.setVisible(defaultFormatEnabled);

  if ('rendered' in block && (block as Blockly.BlockSvg).rendered) {
    (block as Blockly.BlockSvg).render();
  }
}

function updateRuleCaseShape(block: RuleCaseBlock) {
  const valueEnabled = isChecked(block.getFieldValue(RULE_CASE_INPUT_NAMES.valueEnabled));
  const formatEnabled = isChecked(block.getFieldValue(RULE_CASE_INPUT_NAMES.formatEnabled));

  block.getInput(RULE_CASE_INPUT_NAMES.value)?.setVisible(valueEnabled);
  block.getInput(RULE_CASE_INPUT_NAMES.formatRow)?.setVisible(formatEnabled);

  if ('rendered' in block && (block as Blockly.BlockSvg).rendered) {
    (block as Blockly.BlockSvg).render();
  }
}

function createShapeAwareCheckbox(block: { updateShape_?: () => void }, defaultValue: string) {
  return new Blockly.FieldCheckbox(defaultValue === CHECKBOX_TRUE, (newValue) => {
    queueMicrotask(() => {
      block.updateShape_?.();
    });
    return normalizeCheckboxValue(newValue);
  });
}

function normalizeCheckboxValue(value: unknown) {
  return String(value).toUpperCase() === CHECKBOX_TRUE ? CHECKBOX_TRUE : CHECKBOX_FALSE;
}

function isChecked(value: unknown) {
  return normalizeCheckboxValue(value) === CHECKBOX_TRUE;
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
