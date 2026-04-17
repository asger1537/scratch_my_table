import * as XLSX from 'xlsx-js-style';

import { CellValue, ImportWarning, Table, Workbook, getOrderedRows, getReadableTextColor } from './model';
import { ImportedCellInput, cellValueToHeaderText, extractDisplayHeaderLine, normalizeImportedWorkbook } from './normalize';

export interface ImportXlsxWorkbookOptions {
  headerRowBySheetName?: Record<string, number>;
}

const HEADER_CANDIDATE_LIMIT = 10;
const MACHINE_METADATA_PATTERN = /(?:["'])?(UniqueId|DisplayName|Name)(?:["'])?\s*[:=]/i;

export function importXlsxWorkbook(
  sourceFileName: string,
  data: ArrayBuffer,
  options: ImportXlsxWorkbookOptions = {},
): Workbook {
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
  const importedTables = workbook.SheetNames.map((sheetName) => {
    const rows = convertSheetToImportedRows(workbook.Sheets[sheetName]);
    const override = options.headerRowBySheetName?.[sheetName];
    const headerRowIndex = override ?? detectHeaderRowIndex(rows);

    validateSelectedHeaderRowIndex(sheetName, rows, headerRowIndex);

    return {
      sourceName: sheetName,
      rows,
      headerRowIndex,
      headerRowWasAutoDetected: override === undefined,
    };
  });

  const normalizedWorkbook = normalizeImportedWorkbook({
    sourceFileName,
    sourceFormat: 'xlsx',
    importWarnings,
    tables: importedTables.map(({ sourceName, rows, headerRowIndex }) => ({
      sourceName,
      rows,
      headerRowIndex,
    })),
  });

  return {
    ...normalizedWorkbook,
    tables: normalizedWorkbook.tables.map((table, index) => {
      const importedTable = importedTables[index];

      if (!importedTable.headerRowWasAutoDetected || importedTable.headerRowIndex === 0 || importedTable.rows.length === 0) {
        return table;
      }

      return {
        ...table,
        importWarnings: [
          ...table.importWarnings,
          {
            code: 'xlsxHeaderRowAutoDetected',
            message: `Auto-detected row ${importedTable.headerRowIndex + 1} as the header row for '${table.sourceName}'.`,
            scope: 'table',
            tableId: table.tableId,
          },
        ],
      };
    }),
  };
}

export function exportTableToXlsxBytes(table: Table): ArrayBuffer {
  const sheet = buildWorksheetFromTable(table);
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(workbook, sheet, sanitizeSheetName(table.sourceName));

  return XLSX.write(workbook, {
    type: 'array',
    bookType: 'xlsx',
    cellStyles: true,
  }) as ArrayBuffer;
}

export function buildWorksheetFromTable(table: Table): XLSX.WorkSheet {
  const headerRow = table.schema.columns.map((column) => column.displayName);
  const bodyRows = getOrderedRows(table).map((row) =>
    table.schema.columns.map((column) => serializeCellValue(row.cellsByColumnId[column.columnId])),
  );
  const sheet = XLSX.utils.aoa_to_sheet([headerRow, ...bodyRows]);

  getOrderedRows(table).forEach((row, rowIndex) => {
    table.schema.columns.forEach((column, columnIndex) => {
      const fillColor = row.stylesByColumnId[column.columnId]?.fillColor;

      if (!fillColor) {
        return;
      }

      const address = XLSX.utils.encode_cell({ r: rowIndex + 1, c: columnIndex });
      const cell = sheet[address] ?? (sheet[address] = { t: 's', v: '' });

      const rgb = `FF${fillColor.slice(1).toLocaleUpperCase()}`;
      const textRgb = `FF${getReadableTextColor(fillColor).slice(1).toLocaleUpperCase()}`;

      cell.s = {
        ...(cell.s ?? {}),
        fill: {
          patternType: 'solid',
          fgColor: { rgb },
          bgColor: { rgb },
        },
        font: {
          ...(cell.s?.font ?? {}),
          color: { rgb: textRgb },
        },
      };
    });
  });

  return sheet;
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
  const headerText = cellValueToHeaderText(value);

  return {
    headerText,
    displayHeaderText: extractDisplayHeaderLine(headerText),
    value,
    hadFormula: Boolean(cell.f),
    missingFormulaValue: false,
  };
}

function detectHeaderRowIndex(rows: ImportedCellInput[][]): number {
  if (rows.length === 0) {
    return 0;
  }

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const candidateCount = Math.min(rows.length, HEADER_CANDIDATE_LIMIT);
  let bestRowIndex = 0;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let rowIndex = 0; rowIndex < candidateCount; rowIndex += 1) {
    const score = scoreHeaderCandidateRow(rows[rowIndex] ?? [], width);

    if (score > bestScore) {
      bestScore = score;
      bestRowIndex = rowIndex;
    }
  }

  return bestRowIndex;
}

function scoreHeaderCandidateRow(row: ImportedCellInput[], width: number): number {
  let score = 0;
  let nonEmptyCellCount = 0;

  for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
    const cell = row[columnIndex];
    const rawHeaderText = cell?.headerText ?? '';
    const displayHeaderText = cell?.displayHeaderText ?? extractDisplayHeaderLine(rawHeaderText);
    const trimmedRawHeaderText = rawHeaderText.trim();

    if (displayHeaderText !== '') {
      nonEmptyCellCount += 1;
      score += 2;

      if (displayHeaderText.length <= 40) {
        score += 1;
      }
    }

    if (trimmedRawHeaderText.startsWith('{') && trimmedRawHeaderText.endsWith('}')) {
      score -= 3;
    }

    if (MACHINE_METADATA_PATTERN.test(rawHeaderText)) {
      score -= 2;
    }
  }

  score -= Math.max(width - nonEmptyCellCount, 0);

  return score;
}

function validateSelectedHeaderRowIndex(sheetName: string, rows: ImportedCellInput[][], headerRowIndex: number): void {
  if (!Number.isInteger(headerRowIndex) || headerRowIndex < 0) {
    throw new Error(`Invalid header row index '${headerRowIndex}' for sheet '${sheetName}'.`);
  }

  if (rows.length === 0) {
    if (headerRowIndex !== 0) {
      throw new Error(`Invalid header row index '${headerRowIndex}' for empty sheet '${sheetName}'.`);
    }

    return;
  }

  if (headerRowIndex >= rows.length) {
    throw new Error(
      `Header row index '${headerRowIndex}' is out of range for sheet '${sheetName}' with ${rows.length} row${rows.length === 1 ? '' : 's'}.`,
    );
  }
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
