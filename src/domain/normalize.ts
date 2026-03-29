import { CellValue, Column, ImportWarning, LogicalType, SourceFormat, Table, TableRow, Workbook, isMissingValue } from './model';

export interface ImportedCellInput {
  headerText: string;
  displayHeaderText?: string;
  value: CellValue;
  hadFormula?: boolean;
  missingFormulaValue?: boolean;
}

export interface ImportedTableInput {
  sourceName: string;
  rows: ImportedCellInput[][];
  headerRowIndex: number;
}

export interface NormalizeWorkbookInput {
  sourceFileName: string;
  sourceFormat: SourceFormat;
  tables: ImportedTableInput[];
  importWarnings?: ImportWarning[];
}

export function normalizeImportedWorkbook(input: NormalizeWorkbookInput): Workbook {
  const tableIdCounts = new Map<string, number>();
  const tables = input.tables.map((tableInput) => normalizeImportedTable(tableInput, tableIdCounts));

  return {
    workbookId: `workbook_${slugify(stripFileExtension(input.sourceFileName))}`,
    sourceFileName: input.sourceFileName,
    sourceFormat: input.sourceFormat,
    tables,
    activeTableId: tables[0]?.tableId ?? '',
    importWarnings: input.importWarnings ?? [],
  };
}

function normalizeImportedTable(input: ImportedTableInput, tableIdCounts: Map<string, number>): Table {
  validateHeaderRowIndex(input);

  const width = input.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const headerRow = input.rows[input.headerRowIndex] ?? [];
  const columnNameCounts = new Map<string, number>();
  const duplicateBaseNames = new Map<string, string>();
  const columnIdCounts = new Map<string, number>();
  const baseTableId = `table_${slugify(stripFileExtension(input.sourceName))}`;
  const tableId = makeUniqueId(baseTableId, tableIdCounts);
  const importWarnings: ImportWarning[] = [];
  const columns: Column[] = [];

  for (let sourceIndex = 0; sourceIndex < width; sourceIndex += 1) {
    const headerCell = headerRow[sourceIndex];
    const rawHeaderText = headerCell?.headerText ?? '';
    const displayHeaderText = headerCell?.displayHeaderText ?? rawHeaderText;
    const normalizedHeader = normalizeHeaderText(displayHeaderText);
    const duplicateKey = normalizedHeader.toLocaleLowerCase();
    const duplicateCount = (columnNameCounts.get(duplicateKey) ?? 0) + 1;

    columnNameCounts.set(duplicateKey, duplicateCount);

    if (!duplicateBaseNames.has(duplicateKey)) {
      duplicateBaseNames.set(duplicateKey, normalizedHeader);
    }

    const baseDisplayName = duplicateBaseNames.get(duplicateKey) ?? normalizedHeader;
    const displayName = duplicateCount === 1 ? baseDisplayName : `${baseDisplayName} (${duplicateCount})`;
    const columnId = makeUniqueId(`col_${slugify(baseDisplayName)}`, columnIdCounts);

    if (normalizeWhitespace(displayHeaderText) === '') {
      importWarnings.push({
        code: 'blankHeaderGenerated',
        message: `Column ${sourceIndex + 1} had a blank header. Generated display name '${displayName}'.`,
        scope: 'column',
        tableId,
        columnId,
      });
    }

    if (duplicateCount > 1) {
      importWarnings.push({
        code: 'duplicateHeaderNormalized',
        message: `Column ${sourceIndex + 1} duplicated header '${baseDisplayName}'. Renamed to '${displayName}'.`,
        scope: 'column',
        tableId,
        columnId,
      });
    }

    columns.push({
      columnId,
      displayName,
      logicalType: 'unknown',
      nullable: false,
      sourceIndex,
      missingCount: 0,
    });
  }

  const rowsById: Record<string, TableRow> = {};
  const rowOrder: string[] = [];

  for (let rowIndex = input.headerRowIndex + 1; rowIndex < input.rows.length; rowIndex += 1) {
    const rowId = `row_${rowIndex - input.headerRowIndex}`;
    const sourceRow = input.rows[rowIndex] ?? [];
    const cellsByColumnId: Record<string, CellValue> = {};

    columns.forEach((column) => {
      cellsByColumnId[column.columnId] = sourceRow[column.sourceIndex]?.value ?? null;
    });

    rowsById[rowId] = {
      rowId,
      cellsByColumnId,
      stylesByColumnId: {},
    };
    rowOrder.push(rowId);
  }

  columns.forEach((column) => {
    const values = rowOrder.map((rowId) => rowsById[rowId].cellsByColumnId[column.columnId]);
    const logicalType = inferLogicalType(values);

    column.logicalType = logicalType;
    column.nullable = values.some((value) => value === null);
    column.missingCount = values.filter(isMissingValue).length;

    if (logicalType === 'mixed') {
      importWarnings.push({
        code: 'mixedTypeColumn',
        message: `Column '${column.displayName}' inferred as mixed type.`,
        scope: 'column',
        tableId,
        columnId: column.columnId,
      });
    }
  });

  let formulaImportedCount = 0;
  let formulaMissingValueCount = 0;

  for (let rowIndex = input.headerRowIndex + 1; rowIndex < input.rows.length; rowIndex += 1) {
    const row = input.rows[rowIndex] ?? [];

    for (const cell of row) {
      if (cell.hadFormula) {
        formulaImportedCount += 1;
      }

      if (cell.missingFormulaValue) {
        formulaMissingValueCount += 1;
      }
    }
  }

  if (formulaImportedCount > 0) {
    importWarnings.push({
      code: 'formulaImportedAsValue',
      message: `${formulaImportedCount} ${pluralize(formulaImportedCount, 'formula cell')} in '${input.sourceName}' ${formulaImportedCount === 1 ? 'was' : 'were'} imported as value${formulaImportedCount === 1 ? '' : 's'}.`,
      scope: 'table',
      tableId,
    });
  }

  if (formulaMissingValueCount > 0) {
    importWarnings.push({
      code: 'formulaValueUnavailable',
      message: `${formulaMissingValueCount} ${pluralize(formulaMissingValueCount, 'formula cell')} in '${input.sourceName}' had no cached value and ${formulaMissingValueCount === 1 ? 'was' : 'were'} imported as null.`,
      scope: 'table',
      tableId,
    });
  }

  return {
    tableId,
    sourceName: input.sourceName,
    schema: { columns },
    rowsById,
    rowOrder,
    importWarnings,
  };
}

export function inferLogicalType(values: CellValue[]): LogicalType {
  const nonNullValues = values.filter((value): value is Exclude<CellValue, null> => value !== null);

  if (nonNullValues.length === 0) {
    return 'unknown';
  }

  if (nonNullValues.every((value) => typeof value === 'boolean')) {
    return 'boolean';
  }

  if (nonNullValues.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return 'number';
  }

  if (nonNullValues.every((value) => typeof value === 'string' && isIsoDate(value))) {
    return 'date';
  }

  if (nonNullValues.every((value) => typeof value === 'string' && isIsoDateTime(value))) {
    return 'datetime';
  }

  if (nonNullValues.every((value) => typeof value === 'string')) {
    return 'string';
  }

  return 'mixed';
}

export function normalizeHeaderText(value: string): string {
  const normalized = normalizeWhitespace(value);
  return normalized === '' ? 'Column' : normalized;
}

export function splitHeaderLines(text: string): string[] {
  return text.split(/\r\n|\n/).map((line) => line.trim());
}

export function extractDisplayHeaderLine(text: string): string {
  return splitHeaderLines(text).find((line) => line !== '') ?? '';
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function slugify(value: string): string {
  const slug = value
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');

  return slug === '' ? 'column' : slug;
}

export function cellValueToHeaderText(value: CellValue): string {
  if (value === null) {
    return '';
  }

  return String(value);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp);
}

export function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp);
}

function stripFileExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function validateHeaderRowIndex(input: ImportedTableInput): void {
  if (!Number.isInteger(input.headerRowIndex) || input.headerRowIndex < 0) {
    throw new Error(`Invalid header row index '${input.headerRowIndex}' for '${input.sourceName}'.`);
  }

  if (input.rows.length === 0) {
    if (input.headerRowIndex !== 0) {
      throw new Error(`Invalid header row index '${input.headerRowIndex}' for empty table '${input.sourceName}'.`);
    }

    return;
  }

  if (input.headerRowIndex >= input.rows.length) {
    throw new Error(
      `Header row index '${input.headerRowIndex}' is out of range for '${input.sourceName}' with ${input.rows.length} row${input.rows.length === 1 ? '' : 's'}.`,
    );
  }
}

function makeUniqueId(baseId: string, counts: Map<string, number>): string {
  const nextCount = (counts.get(baseId) ?? 0) + 1;
  counts.set(baseId, nextCount);

  return nextCount === 1 ? baseId : `${baseId}_${nextCount}`;
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
