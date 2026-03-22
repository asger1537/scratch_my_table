import * as Blockly from 'blockly';

import type { LogicalType } from '../domain/model';

import { getEditorSchemaColumns, getSchemaColumnOptions } from './schemaOptions';

const EMPTY_SELECTION = '[]';
const TYPE_GROUP_ORDER: LogicalType[] = ['string', 'number', 'boolean', 'date', 'datetime', 'unknown', 'mixed'];
const TYPE_GROUP_LABELS: Record<LogicalType, string> = {
  string: 'All string columns',
  number: 'All numeric columns',
  boolean: 'All boolean columns',
  date: 'All date columns',
  datetime: 'All datetime columns',
  unknown: 'All unknown columns',
  mixed: 'All mixed columns',
};

export class FieldColumnMultiSelect extends Blockly.Field<string | string[] | undefined> {
  override EDITABLE = true;
  override SERIALIZABLE = true;

  constructor(value: string | string[] = EMPTY_SELECTION, validator?: Blockly.FieldValidator<string | string[] | undefined> | null) {
    super(EMPTY_SELECTION);

    this.setValue(serializeColumnSelectionValue(value), false);

    if (validator) {
      this.setValidator(validator);
    }
  }

  getSelectedColumnIds() {
    return normalizeColumnIdList(this.getValue() ?? EMPTY_SELECTION);
  }

  setSelectedColumnIds(columnIds: string[]) {
    this.setValue(serializeColumnSelectionValue(columnIds));
  }

  protected override initView() {
    super.initView();

    if (!this.clickTarget_) {
      this.clickTarget_ = this.getSvgRoot();
    }
  }

  protected override doClassValidation_(newValue?: string | string[]) {
    return normalizeColumnSelectionValue(newValue);
  }

  protected override getText_() {
    return formatColumnSelectionSummary(this.getSelectedColumnIds(), getSelectableColumns(), getSelectableColumnTypeGroups());
  }

  protected override showEditor_() {
    if (!this.isCurrentlyEditable() || typeof document === 'undefined') {
      return;
    }

    Blockly.DropDownDiv.hideIfOwner(this, true);
    Blockly.DropDownDiv.clearContent();
    const contentDiv = Blockly.DropDownDiv.getContentDiv();

    const wrapper = document.createElement('div');
    wrapper.className = 'blockly-column-multiselect';
    const stopPropagation = (event: Event) => event.stopPropagation();
    wrapper.addEventListener('mousedown', stopPropagation);
    wrapper.addEventListener('pointerdown', stopPropagation);
    wrapper.addEventListener('click', stopPropagation);

    const searchInput = document.createElement('input');
    searchInput.className = 'blockly-column-multiselect__search';
    searchInput.placeholder = 'Search columns';
    searchInput.type = 'search';
    wrapper.append(searchInput);

    const actionRow = document.createElement('div');
    actionRow.className = 'blockly-column-multiselect__actions';

    const selectAllButton = document.createElement('button');
    selectAllButton.className = 'blockly-column-multiselect__button';
    selectAllButton.textContent = 'Select all';
    selectAllButton.type = 'button';

    const clearButton = document.createElement('button');
    clearButton.className = 'blockly-column-multiselect__button';
    clearButton.textContent = 'Clear';
    clearButton.type = 'button';

    actionRow.append(selectAllButton, clearButton);
    wrapper.append(actionRow);

    const typeGroupActions = getSelectableColumnTypeGroups();

    if (typeGroupActions.length > 0) {
      const groupRow = document.createElement('div');
      groupRow.className = 'blockly-column-multiselect__actions blockly-column-multiselect__actions--wrap';

      typeGroupActions.forEach((group) => {
        const groupButton = document.createElement('button');
        groupButton.className = 'blockly-column-multiselect__button';
        groupButton.textContent = `${group.label} (${group.columnIds.length})`;
        groupButton.type = 'button';
        groupButton.addEventListener('click', () => {
          syncValue(group.columnIds);
        });
        groupRow.append(groupButton);
      });

      wrapper.append(groupRow);
    }

    const list = document.createElement('div');
    list.className = 'blockly-column-multiselect__list';
    wrapper.append(list);
    contentDiv.append(wrapper);

    const options = getSelectableColumns();
    let selectedColumnIds = this.getSelectedColumnIds();

    const syncValue = (nextSelectedColumnIds: string[]) => {
      selectedColumnIds = normalizeColumnIdList(nextSelectedColumnIds);
      this.setValue(serializeColumnSelectionValue(selectedColumnIds));
      renderList(searchInput.value, { preserveScroll: true });
    };

    const renderList = (query: string, renderOptions?: { preserveScroll?: boolean }) => {
      const nextScrollTop = renderOptions?.preserveScroll ? list.scrollTop : 0;
      list.replaceChildren();

      const normalizedQuery = query.trim().toLocaleLowerCase();
      const visibleOptions = options.filter((option) => option.searchText.includes(normalizedQuery));

      if (visibleOptions.length === 0) {
        const emptyState = document.createElement('div');
        emptyState.className = 'blockly-column-multiselect__empty';
        emptyState.textContent = 'No matching columns';
        list.append(emptyState);
        return;
      }

      visibleOptions.forEach((option) => {
        const label = document.createElement('label');
        label.className = 'blockly-column-multiselect__option';

        const checkbox = document.createElement('input');
        checkbox.checked = selectedColumnIds.includes(option.columnId);
        checkbox.type = 'checkbox';
        checkbox.addEventListener('change', () => {
          syncValue(
            checkbox.checked
              ? [...selectedColumnIds, option.columnId]
              : selectedColumnIds.filter((columnId) => columnId !== option.columnId),
          );
        });

        const text = document.createElement('span');
        text.textContent = option.label;

        label.append(checkbox, text);
        list.append(label);
      });

      if (renderOptions?.preserveScroll) {
        list.scrollTop = nextScrollTop;
      }
    };

    searchInput.addEventListener('input', () => {
      renderList(searchInput.value);
    });

    selectAllButton.addEventListener('click', () => {
      syncValue(options.map((option) => option.columnId));
    });

    clearButton.addEventListener('click', () => {
      syncValue([]);
    });

    Blockly.DropDownDiv.setColour('#fffaf3', '#d7b98c');
    Blockly.DropDownDiv.showPositionedByField(this, () => {
      wrapper.remove();
    });

    renderList('');
    setTimeout(() => searchInput.focus(), 0);
  }
}

export function serializeColumnSelectionValue(value: string | string[]) {
  return JSON.stringify(normalizeColumnIdList(value));
}

export function parseColumnSelectionValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return normalizeColumnIdList(value);
  }

  try {
    const parsed = JSON.parse(value ?? EMPTY_SELECTION) as unknown;

    if (!Array.isArray(parsed)) {
      return [];
    }

    return normalizeColumnIdList(parsed);
  } catch {
    return [];
  }
}

export function formatColumnSelectionSummary(
  columnIds: string[],
  columns = getSelectableColumns(),
  typeGroups = getSelectableColumnTypeGroups(),
) {
  if (columnIds.length === 0) {
    return 'Select columns';
  }

  const labelsByColumnId = new Map(columns.map((column) => [column.columnId, column.shortLabel]));
  const labels = columnIds.map((columnId) => labelsByColumnId.get(columnId) ?? columnId);

  if (columns.length > 0 && columnIds.length === columns.length) {
    return `All columns (${columnIds.length})`;
  }

  const matchingGroup = typeGroups.find((group) => haveSameColumnIds(columnIds, group.columnIds));

  if (matchingGroup) {
    return `${matchingGroup.label} (${columnIds.length})`;
  }

  if (labels.length <= 2) {
    return labels.join(', ');
  }

  return `${labels[0]}, ${labels[1]} +${labels.length - 2}`;
}

export function getSelectableColumns() {
  return getSchemaColumnOptions()
    .filter(([, columnId]) => columnId !== '')
    .map(([label, columnId]) => ({
      columnId,
      label,
      shortLabel: label.replace(/\s*\[[^\]]+\]$/, ''),
      searchText: `${label} ${columnId}`.toLocaleLowerCase(),
    }));
}

export function getSelectableColumnTypeGroups() {
  const columns = getEditorSchemaColumns();

  return TYPE_GROUP_ORDER.flatMap((logicalType) => {
    const matchingColumns = columns.filter((column) => column.logicalType === logicalType);

    if (matchingColumns.length === 0) {
      return [];
    }

    return [{
      logicalType,
      label: TYPE_GROUP_LABELS[logicalType],
      columnIds: matchingColumns.map((column) => column.columnId),
    }];
  });
}

function normalizeColumnSelectionValue(value?: string | string[]) {
  return serializeColumnSelectionValue(value ?? EMPTY_SELECTION);
}

function normalizeColumnIdList(value: string | string[] | undefined) {
  const rawValues = Array.isArray(value) ? value : parseColumnSelectionValue(value);
  const deduped = new Set<string>();

  rawValues.forEach((item) => {
    const normalized = String(item ?? '').trim();

    if (normalized !== '') {
      deduped.add(normalized);
    }
  });

  return [...deduped];
}

function haveSameColumnIds(left: string[], right: string[]) {
  if (left.length !== right.length) {
    return false;
  }

  const leftSet = new Set(left);
  return right.every((columnId) => leftSet.has(columnId));
}
