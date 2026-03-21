import { Table, Workbook, CellValue, getOrderedRows } from './model';
import { ImportedCellInput, normalizeImportedWorkbook, isIsoDate, isIsoDateTime } from './normalize';

interface CsvFieldToken {
  rawText: string;
  quoted: boolean;
}

export function importCsvWorkbook(sourceFileName: string, text: string): Workbook {
  const rows = parseCsv(text).map((row) => row.map(convertCsvFieldToImportedCell));

  return normalizeImportedWorkbook({
    sourceFileName,
    sourceFormat: 'csv',
    tables: [
      {
        sourceName: sourceFileName,
        rows,
      },
    ],
  });
}

export function exportTableToCsv(table: Table): string {
  const header = table.schema.columns.map((column) => escapeCsvField(column.displayName)).join(',');
  const lines = [header];

  for (const row of getOrderedRows(table)) {
    const values = table.schema.columns.map((column) => escapeCsvField(serializeCellValue(row.cellsByColumnId[column.columnId])));
    lines.push(values.join(','));
  }

  return `${lines.join('\r\n')}\r\n`;
}

export function parseCsv(text: string): CsvFieldToken[][] {
  if (text === '') {
    return [];
  }

  const rows: CsvFieldToken[][] = [];
  let currentRow: CsvFieldToken[] = [];
  let currentValue = '';
  let inQuotes = false;
  let quoted = false;

  const pushField = () => {
    currentRow.push({
      rawText: currentValue,
      quoted,
    });
    currentValue = '';
    quoted = false;
  };

  const pushRow = () => {
    rows.push(currentRow);
    currentRow = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          currentValue += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentValue += character;
      }

      continue;
    }

    if (character === ',' && !inQuotes) {
      pushField();
      continue;
    }

    if (character === '\r' || character === '\n') {
      pushField();
      pushRow();

      if (character === '\r' && text[index + 1] === '\n') {
        index += 1;
      }

      continue;
    }

    if (character === '"' && currentValue === '') {
      inQuotes = true;
      quoted = true;
      continue;
    }

    currentValue += character;
  }

  pushField();

  if (currentRow.length > 1 || currentRow[0]?.rawText !== '' || currentRow[0]?.quoted) {
    pushRow();
  }

  return rows;
}

function convertCsvFieldToImportedCell(field: CsvFieldToken): ImportedCellInput {
  return {
    headerText: field.rawText,
    value: parseCsvCellValue(field),
  };
}

function parseCsvCellValue(field: CsvFieldToken): CellValue {
  if (field.rawText === '' && !field.quoted) {
    return null;
  }

  if (field.rawText === '' && field.quoted) {
    return '';
  }

  if (/^(true|false)$/i.test(field.rawText)) {
    return /^true$/i.test(field.rawText);
  }

  if (isUnambiguousNumber(field.rawText)) {
    return Number(field.rawText);
  }

  if (isIsoDate(field.rawText) || isIsoDateTime(field.rawText)) {
    return field.rawText;
  }

  return field.rawText;
}

function serializeCellValue(value: CellValue): string {
  if (value === null) {
    return '';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
}

function escapeCsvField(value: string): string {
  if (value === '') {
    return '""';
  }

  if (/[",\r\n]/.test(value) || /^\s/.test(value) || /\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function isUnambiguousNumber(value: string): boolean {
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
}
