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
