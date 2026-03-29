export type SourceFormat = 'csv' | 'xlsx';

export type LogicalType =
  | 'unknown'
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'mixed';

export type CellValue = string | number | boolean | null;
export interface CellStyle {
  fillColor?: string;
}

export type ImportWarningScope = 'workbook' | 'table' | 'column' | 'cell';

export interface ImportWarning {
  code: string;
  message: string;
  scope: ImportWarningScope;
  tableId?: string;
  columnId?: string;
  rowId?: string;
}

export interface Column {
  columnId: string;
  displayName: string;
  logicalType: LogicalType;
  nullable: boolean;
  sourceIndex: number;
  missingCount: number;
}

export interface Schema {
  columns: Column[];
}

export interface TableRow {
  rowId: string;
  cellsByColumnId: Record<string, CellValue>;
  stylesByColumnId: Record<string, CellStyle>;
}

export interface Table {
  tableId: string;
  sourceName: string;
  schema: Schema;
  rowsById: Record<string, TableRow>;
  rowOrder: string[];
  importWarnings: ImportWarning[];
}

export interface Workbook {
  workbookId: string;
  sourceFileName: string;
  sourceFormat: SourceFormat;
  tables: Table[];
  activeTableId: string;
  importWarnings: ImportWarning[];
}

export function getActiveTable(workbook: Workbook | null): Table | null {
  if (!workbook) {
    return null;
  }

  return workbook.tables.find((table) => table.tableId === workbook.activeTableId) ?? null;
}

export function requireActiveTable(workbook: Workbook): Table {
  const table = getActiveTable(workbook);

  if (!table) {
    throw new Error(`Active table '${workbook.activeTableId}' was not found.`);
  }

  return table;
}

export function setActiveTable(workbook: Workbook, tableId: string): Workbook {
  if (!workbook.tables.some((table) => table.tableId === tableId)) {
    throw new Error(`Cannot select missing table '${tableId}'.`);
  }

  return {
    ...workbook,
    activeTableId: tableId,
  };
}

export function getOrderedRows(table: Table): TableRow[] {
  return table.rowOrder
    .map((rowId) => table.rowsById[rowId])
    .filter((row): row is TableRow => Boolean(row));
}

export function isMissingValue(value: CellValue): boolean {
  return value === null || value === '';
}

export function isValidFillColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function normalizeFillColor(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function getCellStyle(row: TableRow, columnId: string): CellStyle | undefined {
  return row.stylesByColumnId[columnId];
}

export function getReadableTextColor(fillColor: string): string {
  const normalized = normalizeFillColor(fillColor).slice(1);
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);

  return luminance >= 160 ? '#1c1a17' : '#fffdf9';
}
