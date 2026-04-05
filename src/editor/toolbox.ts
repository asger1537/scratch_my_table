import * as Blockly from 'blockly';

import {
  BLOCK_TYPES,
  WORKFLOW_TOOLBOX_COLOURS,
} from './blocks';

export interface ToolboxEntrySource {
  type: string;
  fields?: Record<string, string>;
  searchText?: string;
}

export interface ToolboxCategorySource {
  id: string;
  name: string;
  colour: string;
  entries: ToolboxEntrySource[];
}

export const WORKFLOW_TOOLBOX_CATEGORIES: ToolboxCategorySource[] = [
  {
    id: 'category_scoped_rules',
    name: 'Scoped rules',
    colour: WORKFLOW_TOOLBOX_COLOURS.scopedRules,
    entries: [
      {
        type: BLOCK_TYPES.scopedRuleCasesStep,
        searchText: 'scoped rule transform update cells value color format highlight case default apply',
      },
      {
        type: BLOCK_TYPES.ruleCaseItem,
        searchText: 'rule case branch when then condition result color format value',
      },
    ],
  },
  {
    id: 'category_cell_actions',
    name: 'Cell actions',
    colour: WORKFLOW_TOOLBOX_COLOURS.cellActions,
    entries: [
      {
        type: BLOCK_TYPES.setValueActionItem,
        searchText: 'cell actions set value update replace expression patch current cell',
      },
      {
        type: BLOCK_TYPES.highlightActionItem,
        searchText: 'cell actions highlight fill color format patch annotate emphasis',
      },
    ],
  },
  {
    id: 'category_table_operations',
    name: 'Table operations',
    colour: WORKFLOW_TOOLBOX_COLOURS.tableOperations,
    entries: [
      { type: BLOCK_TYPES.dropColumnsStep, searchText: 'drop columns remove delete hide column fields' },
      { type: BLOCK_TYPES.renameColumnStep, searchText: 'rename column display name header label' },
      { type: BLOCK_TYPES.deriveColumnStep, searchText: 'create new column derive copy expression blank' },
      { type: BLOCK_TYPES.filterRowsStep, searchText: 'filter rows keep drop where condition subset' },
      { type: BLOCK_TYPES.splitColumnStep, searchText: 'split column delimiter output columns parts tokens' },
      { type: BLOCK_TYPES.combineColumnsStep, searchText: 'combine columns join merge separator concatenate' },
      { type: BLOCK_TYPES.deduplicateRowsStep, searchText: 'deduplicate rows unique duplicates keep first' },
      { type: BLOCK_TYPES.sortRowsStep, searchText: 'sort rows order asc desc ordering' },
    ],
  },
  {
    id: 'category_comments',
    name: 'Comments',
    colour: WORKFLOW_TOOLBOX_COLOURS.comments,
    entries: [{ type: BLOCK_TYPES.commentStep, searchText: 'comment note annotate documentation describe workflow' }],
  },
  {
    id: 'category_values',
    name: 'Values',
    colour: WORKFLOW_TOOLBOX_COLOURS.values,
    entries: [
      { type: BLOCK_TYPES.currentValueExpression, searchText: 'current value selected cell input value' },
      { type: BLOCK_TYPES.literalString, searchText: 'text string literal value characters' },
      { type: BLOCK_TYPES.literalColor, searchText: 'color hex highlight fill swatch literal value' },
      { type: BLOCK_TYPES.literalNumber, searchText: 'number numeric literal integer decimal' },
      { type: BLOCK_TYPES.literalBoolean, searchText: 'boolean true false literal flag' },
      { type: BLOCK_TYPES.columnExpression, searchText: 'column value row lookup other column reference' },
    ],
  },
  {
    id: 'category_functions',
    name: 'Functions',
    colour: WORKFLOW_TOOLBOX_COLOURS.functions,
    entries: [
      { type: BLOCK_TYPES.trimFunction, searchText: 'trim whitespace spaces remove leading trailing' },
      { type: BLOCK_TYPES.lowerFunction, searchText: 'lower lowercase text case' },
      { type: BLOCK_TYPES.upperFunction, searchText: 'upper uppercase text case' },
      { type: BLOCK_TYPES.toNumberFunction, searchText: 'to number cast convert parse numeric decimal integer' },
      { type: BLOCK_TYPES.toStringFunction, searchText: 'to string cast convert stringify text' },
      { type: BLOCK_TYPES.toBooleanFunction, searchText: 'to boolean cast convert parse true false yes no' },
      { type: BLOCK_TYPES.collapseWhitespaceFunction, searchText: 'collapse whitespace spaces normalize text' },
      { type: BLOCK_TYPES.substringFunction, searchText: 'substring text slice start length extract part' },
      { type: BLOCK_TYPES.replaceFunction, searchText: 'replace text string from to substitute' },
      { type: BLOCK_TYPES.extractRegexFunction, searchText: 'extract regex regular expression pattern match text' },
      { type: BLOCK_TYPES.replaceRegexFunction, searchText: 'replace regex regular expression pattern global text' },
      { type: BLOCK_TYPES.splitFunction, searchText: 'split delimiter tokenize list parts words' },
      { type: BLOCK_TYPES.firstFunction, searchText: 'first first item first character list string' },
      { type: BLOCK_TYPES.lastFunction, searchText: 'last last item last character list string' },
      { type: BLOCK_TYPES.atIndexFunction, searchText: 'at index item by index nth element list string' },
      { type: BLOCK_TYPES.coalesceFunction, searchText: 'coalesce fallback default null empty first non empty' },
      { type: BLOCK_TYPES.concatFunction, searchText: 'concat concatenate join combine strings text' },
    ],
  },
  {
    id: 'category_date_time',
    name: 'Date & time',
    colour: WORKFLOW_TOOLBOX_COLOURS.dateTime,
    entries: [
      { type: BLOCK_TYPES.nowFunction, searchText: 'now current date time timestamp datetime today' },
      { type: BLOCK_TYPES.datePartFunction, searchText: 'date part year month day weekday hour minute second from date time' },
      { type: BLOCK_TYPES.dateDiffFunction, searchText: 'date diff difference between dates days hours minutes seconds months years' },
      { type: BLOCK_TYPES.dateAddFunction, searchText: 'date add add days hours minutes seconds months years to date time' },
    ],
  },
  {
    id: 'category_math',
    name: 'Math',
    colour: WORKFLOW_TOOLBOX_COLOURS.math,
    entries: [
      { type: BLOCK_TYPES.arithmeticFunction, searchText: 'add subtract multiply divide modulo arithmetic plus minus times percent' },
      { type: BLOCK_TYPES.mathRoundingFunction, searchText: 'round floor ceil abs absolute value math rounding' },
    ],
  },
  {
    id: 'category_logic',
    name: 'Logic',
    colour: WORKFLOW_TOOLBOX_COLOURS.logic,
    entries: [
      { type: BLOCK_TYPES.comparisonFunction, searchText: 'equals compare match not equals less greater less than greater than' },
      { type: BLOCK_TYPES.predicateFunction, searchText: 'contains starts with ends with matches regex predicate text logic binary' },
      { type: BLOCK_TYPES.unaryPredicateFunction, searchText: 'is empty blank null missing predicate unary logic' },
      { type: BLOCK_TYPES.logicalBinaryFunction, searchText: 'and or logical group combine conditions boolean' },
      { type: BLOCK_TYPES.matchExpression, searchText: 'match classify bucket branch first matching case exclusive subject' },
      { type: BLOCK_TYPES.matchCaseItem, searchText: 'match case branch guard then pattern result' },
      { type: BLOCK_TYPES.matchLiteralPattern, searchText: 'match literal pattern exact value enum' },
      { type: BLOCK_TYPES.matchOneOfPattern, searchText: 'match one of pattern values enum set list' },
      { type: BLOCK_TYPES.matchRangePattern, searchText: 'match range pattern between less greater bounds bucket' },
      { type: BLOCK_TYPES.matchWildcardPattern, searchText: 'match wildcard default fallback underscore _' },
      { type: BLOCK_TYPES.notFunction, searchText: 'not negate boolean invert logical' },
    ],
  },
  {
    id: 'category_lists',
    name: 'Lists',
    colour: WORKFLOW_TOOLBOX_COLOURS.lists,
    entries: [
      { type: BLOCK_TYPES.outputColumnItem, searchText: 'output column helper list split columns item' },
      { type: BLOCK_TYPES.sortItem, searchText: 'sort item helper sort key direction asc desc' },
    ],
  },
];

export function getWorkflowToolboxDefinition(): Blockly.utils.toolbox.ToolboxInfo {
  return {
    kind: 'categoryToolbox',
    contents: WORKFLOW_TOOLBOX_CATEGORIES.map((category) => ({
      kind: 'category',
      name: category.name,
      colour: category.colour,
      custom: category.id,
      toolboxitemid: category.id,
    })),
  };
}

export function filterWorkflowToolboxEntries(
  entries: ToolboxEntrySource[],
  query: string,
): Blockly.utils.toolbox.FlyoutItemInfoArray {
  const normalizedQuery = normalizeSearchQuery(query);
  const visibleEntries = normalizedQuery.length === 0
    ? entries
    : entries.filter((entry) => normalizeSearchText(entry).includes(normalizedQuery));

  if (visibleEntries.length === 0) {
    return [
      {
        kind: 'label',
        text: 'No matching blocks',
      },
    ];
  }

  return visibleEntries.map((entry) => ({
    kind: 'block',
    type: entry.type,
    ...(entry.fields ? { fields: { ...entry.fields } } : {}),
  }));
}

export function getWorkflowToolboxCategory(categoryId: string | null | undefined) {
  if (!categoryId) {
    return null;
  }

  return WORKFLOW_TOOLBOX_CATEGORIES.find((category) => category.id === categoryId) ?? null;
}

export function getWorkflowToolboxCategoryContents(
  categoryId: string,
  query: string,
): Blockly.utils.toolbox.FlyoutItemInfoArray {
  const category = getWorkflowToolboxCategory(categoryId);

  if (!category) {
    return [
      {
        kind: 'label',
        text: 'No matching blocks',
      },
    ];
  }

  return filterWorkflowToolboxEntries(category.entries, query);
}

export function getSelectedWorkflowToolboxCategoryId(workspace: Blockly.WorkspaceSvg) {
  const selectedItem = workspace.getToolbox()?.getSelectedItem();

  return getWorkflowToolboxCategory(selectedItem?.getId()) ? selectedItem?.getId() ?? null : null;
}

export function registerWorkflowToolboxCategoryCallbacks(
  workspace: Blockly.WorkspaceSvg,
  getQuery: () => string,
) {
  WORKFLOW_TOOLBOX_CATEGORIES.forEach((category) => {
    workspace.registerToolboxCategoryCallback(category.id, () => getWorkflowToolboxCategoryContents(category.id, getQuery()));
  });
}

function normalizeSearchQuery(query: string) {
  return query.trim().toLocaleLowerCase();
}

function normalizeSearchText(entry: ToolboxEntrySource) {
  return (entry.searchText ?? entry.type).toLocaleLowerCase();
}
