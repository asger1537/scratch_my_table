import * as XLSX from 'xlsx';

import { CellValue, ImportWarning, Table, Workbook, getOrderedRows } from './model';
import { ImportedCellInput, cellValueToHeaderText, normalizeImportedWorkbook } from './normalize';

export function importXlsxWorkbook(sourceFileName: string, data: ArrayBuffer): Workbook {
  const workbook = XLSX.read(data, {
    type: 'array',
    cellDates: true,
    cellFormula: true,
    raw: true,
  });

  const importWarnings: ImportWarning[] = [
    {
      code: 'xlsxValueOnlyImport',
      message: 'XLSX import preserves cell values only. Formatting, charts, comments, and macros are ignored.',
      scope: 'workbook',
    },
  ];

  return normalizeImportedWorkbook({
    sourceFileName,
    sourceFormat: 'xlsx',
    importWarnings,
    tables: workbook.SheetNames.map((sheetName) => ({
      sourceName: sheetName,
      rows: convertSheetToImportedRows(workbook.Sheets[sheetName]),
    })),
  });
}

export function exportTableToXlsxBytes(table: Table): ArrayBuffer {
  const headerRow = table.schema.columns.map((column) => column.displayName);
  const bodyRows = getOrderedRows(table).map((row) =>
    table.schema.columns.map((column) => serializeCellValue(row.cellsByColumnId[column.columnId])),
  );
  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...bodyRows]);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, sheet, sanitizeSheetName(table.sourceName));

  return XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx',
  }) as ArrayBuffer;
}

function convertSheetToImportedRows(sheet: XLSX.WorkSheet): ImportedCellInput[][] {
  const ref = sheet['!ref'];

  if (!ref) {
    return [];
  }

  const range = XLSX.utils.decode_range(ref);
  const rows: ImportedCellInput[][] = [];

  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    const row: ImportedCellInput[] = [];

    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = sheet[address] as XLSX.CellObject | undefined;

      row.push(convertSheetCell(cell));
    }

    rows.push(trimTrailingBlankCells(row));
  }

  return trimTrailingBlankRows(rows);
}

function convertSheetCell(cell: XLSX.CellObject | undefined): ImportedCellInput {
  if (!cell) {
    return {
      headerText: '',
      value: null,
    };
  }

  if (cell.f && typeof cell.v === 'undefined') {
    return {
      headerText: '',
      value: null,
      hadFormula: true,
      missingFormulaValue: true,
    };
  }

  const value = normalizeCellValue(cell);

  return {
    headerText: cellValueToHeaderText(value),
    value,
    hadFormula: Boolean(cell.f),
    missingFormulaValue: false,
  };
}

function normalizeCellValue(cell: XLSX.CellObject): CellValue {
  if (cell.v === null || typeof cell.v === 'undefined') {
    return null;
  }

  if (isDateCell(cell)) {
    return normalizeDateCellValue(cell);
  }

  if (typeof cell.v === 'boolean') {
    return cell.v;
  }

  if (typeof cell.v === 'number') {
    return cell.v;
  }

  if (typeof cell.v === 'string') {
    return cell.v;
  }

  if (cell.v instanceof Date) {
    return formatDateValue(cell.v);
  }

  return String(cell.v);
}

function isDateCell(cell: XLSX.CellObject): boolean {
  if (cell.t === 'd' || cell.v instanceof Date) {
    return true;
  }

  return typeof cell.v === 'number' && typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z);
}

function normalizeDateCellValue(cell: XLSX.CellObject): string | null {
  if (cell.v instanceof Date) {
    return formatDateValue(cell.v);
  }

  if (cell.t === 'd') {
    return formatDateValue(new Date(String(cell.v)));
  }

  if (typeof cell.v === 'number') {
    const parsed = XLSX.SSF.parse_date_code(cell.v);

    if (!parsed) {
      return null;
    }

    return formatParsedExcelDate(parsed);
  }

  if (typeof cell.v === 'string') {
    return cell.v;
  }

  return null;
}

function formatDateValue(value: Date): string {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1);
  const day = pad(value.getDate());
  const hours = value.getHours();
  const minutes = value.getMinutes();
  const seconds = value.getSeconds();
  const milliseconds = value.getMilliseconds();

  if (hours === 0 && minutes === 0 && seconds === 0 && milliseconds === 0) {
    return `${year}-${month}-${day}`;
  }

  return `${year}-${month}-${day}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatParsedExcelDate(parsed: ParsedExcelDate): string {
  const year = parsed.y;
  const month = pad(parsed.m);
  const day = pad(parsed.d);
  const hours = parsed.H ?? 0;
  const minutes = parsed.M ?? 0;
  const seconds = Math.floor(parsed.S ?? 0);

  if (hours === 0 && minutes === 0 && seconds === 0) {
    return `${year}-${month}-${day}`;
  }

  return `${year}-${month}-${day}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function trimTrailingBlankCells(row: ImportedCellInput[]): ImportedCellInput[] {
  let lastMeaningfulIndex = row.length - 1;

  while (lastMeaningfulIndex >= 0) {
    const cell = row[lastMeaningfulIndex];

    if (cell.headerText !== '' || cell.value !== null || cell.hadFormula || cell.missingFormulaValue) {
      break;
    }

    lastMeaningfulIndex -= 1;
  }

  return row.slice(0, lastMeaningfulIndex + 1);
}

function trimTrailingBlankRows(rows: ImportedCellInput[][]): ImportedCellInput[][] {
  let lastMeaningfulIndex = rows.length - 1;

  while (lastMeaningfulIndex >= 0) {
    const row = rows[lastMeaningfulIndex];
    const hasMeaningfulCell = row.some(
      (cell) => cell.headerText !== '' || cell.value !== null || cell.hadFormula || cell.missingFormulaValue,
    );

    if (hasMeaningfulCell) {
      break;
    }

    lastMeaningfulIndex -= 1;
  }

  return rows.slice(0, lastMeaningfulIndex + 1);
}

function sanitizeSheetName(sourceName: string): string {
  const sanitized = sourceName.replace(/[\\/?*[\]:]/g, ' ').trim();
  const fallback = sanitized === '' ? 'Sheet1' : sanitized;
  return fallback.slice(0, 31);
}

function serializeCellValue(value: CellValue): CellValue {
  return value;
}

interface ParsedExcelDate {
  y: number;
  m: number;
  d: number;
  H?: number;
  M?: number;
  S?: number;
}
