import { SourceFormat, Table, Workbook } from './model';
import { exportTableToCsv, importCsvWorkbook } from './csv';
import { exportTableToXlsxBytes, importXlsxWorkbook } from './xlsx';

type FileLike = Pick<File, 'name' | 'text' | 'arrayBuffer'>;

export async function importWorkbookFromFile(file: FileLike): Promise<Workbook> {
  const format = detectSourceFormat(file.name);

  if (format === 'csv') {
    return importCsvWorkbook(file.name, await file.text());
  }

  return importXlsxWorkbook(file.name, await file.arrayBuffer());
}

export function detectSourceFormat(fileName: string): SourceFormat {
  if (/\.csv$/i.test(fileName)) {
    return 'csv';
  }

  if (/\.xlsx$/i.test(fileName)) {
    return 'xlsx';
  }

  throw new Error(`Unsupported file format for '${fileName}'. Expected .csv or .xlsx.`);
}

export function exportTableCsvBlob(table: Table): Blob {
  return new Blob([exportTableToCsv(table)], {
    type: 'text/csv;charset=utf-8',
  });
}

export function exportTableXlsxBlob(table: Table): Blob {
  return new Blob([exportTableToXlsxBytes(table)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function buildCsvExportFileName(table: Table): string {
  return `${slugifyFileStem(table.sourceName)}.csv`;
}

export function buildXlsxExportFileName(table: Table): string {
  return `${slugifyFileStem(table.sourceName)}.xlsx`;
}

function slugifyFileStem(value: string): string {
  const stem = value.replace(/\.[^.]+$/, '');
  const slug = stem
    .trim()
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '-');

  return slug === '' ? 'export' : slug;
}
