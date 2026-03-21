import { readFile } from 'node:fs/promises';
import path from 'node:path';

import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { exportTableToCsv, importCsvWorkbook } from './csv';
import { getActiveTable, setActiveTable } from './model';
import { importXlsxWorkbook, exportTableToXlsxBytes } from './xlsx';

describe('Milestone 1 normalization and export', () => {
  it('normalizes the simple customers CSV fixture', async () => {
    const workbook = importCsvWorkbook('simple-customers.csv', await readFixture('simple-customers.csv'));
    const table = getActiveTable(workbook);

    expect(workbook.sourceFormat).toBe('csv');
    expect(workbook.tables).toHaveLength(1);
    expect(table?.schema.columns.map((column) => column.columnId)).toEqual([
      'col_customer_id',
      'col_first_name',
      'col_last_name',
      'col_email',
      'col_city',
      'col_state',
      'col_created_at',
    ]);
    expect(table?.rowOrder).toEqual(['row_1', 'row_2', 'row_3', 'row_4', 'row_5']);
    expect(table?.schema.columns.find((column) => column.columnId === 'col_created_at')?.logicalType).toBe('date');
    expect(table?.schema.columns.find((column) => column.columnId === 'col_email')?.missingCount).toBe(0);
  });

  it('normalizes duplicate headers deterministically', () => {
    const workbook = importCsvWorkbook('duplicates.csv', 'Email, email ,EMAIL\r\none,two,three\r\n');
    const table = getActiveTable(workbook);

    expect(table?.schema.columns.map((column) => column.displayName)).toEqual(['Email', 'Email (2)', 'Email (3)']);
    expect(table?.schema.columns.map((column) => column.columnId)).toEqual(['col_email', 'col_email_2', 'col_email_3']);
    expect(table?.importWarnings.filter((warning) => warning.code === 'duplicateHeaderNormalized')).toHaveLength(2);
  });

  it('normalizes blank headers deterministically', () => {
    const workbook = importCsvWorkbook('blanks.csv', 'name,,\r\nAlice,,\r\n');
    const table = getActiveTable(workbook);

    expect(table?.schema.columns.map((column) => column.displayName)).toEqual(['name', 'Column', 'Column (2)']);
    expect(table?.schema.columns.map((column) => column.columnId)).toEqual(['col_name', 'col_column', 'col_column_2']);
    expect(table?.importWarnings.filter((warning) => warning.code === 'blankHeaderGenerated')).toHaveLength(2);
  });

  it('keeps column IDs stable when slugs collide', () => {
    const workbook = importCsvWorkbook('slug-collisions.csv', 'Customer ID,Customer-ID,Customer/ID\r\n1,2,3\r\n');
    const table = getActiveTable(workbook);

    expect(table?.schema.columns.map((column) => column.columnId)).toEqual([
      'col_customer_id',
      'col_customer_id_2',
      'col_customer_id_3',
    ]);
  });

  it('keeps row IDs stable and sequential from source order', () => {
    const workbook = importCsvWorkbook('rows.csv', 'name,value\r\nAlice,1\r\n,2\r\nCharlie,\r\n');
    const table = getActiveTable(workbook);

    expect(table?.rowOrder).toEqual(['row_1', 'row_2', 'row_3']);
    expect(table?.rowsById.row_2.cellsByColumnId.col_name).toBe(null);
    expect(table?.rowsById.row_3.cellsByColumnId.col_value).toBe(null);
  });

  it('infers logical types on the provided fixtures', async () => {
    const customersWorkbook = importCsvWorkbook('simple-customers.csv', await readFixture('simple-customers.csv'));
    const ordersWorkbook = importCsvWorkbook('orders-sample.csv', await readFixture('orders-sample.csv'));
    const customersTable = getActiveTable(customersWorkbook);
    const ordersTable = getActiveTable(ordersWorkbook);

    expect(customersTable?.schema.columns.find((column) => column.columnId === 'col_created_at')?.logicalType).toBe('date');
    expect(ordersTable?.schema.columns.find((column) => column.columnId === 'col_order_total')?.logicalType).toBe('number');
    expect(ordersTable?.schema.columns.find((column) => column.columnId === 'col_ordered_at')?.logicalType).toBe('datetime');
    expect(ordersTable?.schema.columns.find((column) => column.columnId === 'col_customer_email')?.missingCount).toBe(1);
  });

  it('normalizes XLSX workbooks with one table per sheet and supports active table selection', () => {
    const workbook = importXlsxWorkbook('multi-sheet.xlsx', buildMultiSheetWorkbook());

    expect(workbook.sourceFormat).toBe('xlsx');
    expect(workbook.tables.map((table) => table.sourceName)).toEqual(['Customers', 'Orders']);
    expect(workbook.activeTableId).toBe(workbook.tables[0].tableId);

    const updatedWorkbook = setActiveTable(workbook, workbook.tables[1].tableId);
    expect(getActiveTable(updatedWorkbook)?.sourceName).toBe('Orders');
  });

  it('treats formulas with cached results as imported values', () => {
    const workbook = importXlsxWorkbook('formulas.xlsx', buildFormulaWorkbook());
    const table = getActiveTable(workbook);

    expect(table?.rowsById.row_1.cellsByColumnId.col_total).toBe(3);
    expect(table?.rowsById.row_1.cellsByColumnId.col_missing_total).toBe(null);
    expect(table?.importWarnings.some((warning) => warning.code === 'formulaImportedAsValue')).toBe(true);
  });

  it('roundtrips exported CSV back into the canonical model', async () => {
    const originalWorkbook = importCsvWorkbook('messy-customers.csv', await readFixture('messy-customers.csv'));
    const originalTable = getActiveTable(originalWorkbook);

    if (!originalTable) {
      throw new Error('Expected active table for CSV roundtrip test.');
    }

    const exportedCsv = exportTableToCsv(originalTable);
    const roundtripWorkbook = importCsvWorkbook('roundtrip.csv', exportedCsv);
    const roundtripTable = getActiveTable(roundtripWorkbook);

    expect(roundtripTable?.schema.columns.map((column) => column.displayName)).toEqual(
      originalTable.schema.columns.map((column) => column.displayName),
    );
    expect(roundtripTable?.rowOrder).toEqual(originalTable.rowOrder);
    expect(roundtripTable?.rowsById.row_1.cellsByColumnId.col_full_name).toBe('  Alice   Ng  ');
    expect(roundtripTable?.rowsById.row_3.cellsByColumnId.col_email).toBe('');
  });

  it('roundtrips exported XLSX back into the canonical model', async () => {
    const originalWorkbook = importCsvWorkbook('orders-sample.csv', await readFixture('orders-sample.csv'));
    const originalTable = getActiveTable(originalWorkbook);

    if (!originalTable) {
      throw new Error('Expected active table for XLSX roundtrip test.');
    }

    const exportedWorkbook = importXlsxWorkbook('orders-sample.xlsx', exportTableToXlsxBytes(originalTable));
    const roundtripTable = getActiveTable(exportedWorkbook);

    expect(roundtripTable?.schema.columns.map((column) => column.displayName)).toEqual(
      originalTable.schema.columns.map((column) => column.displayName),
    );
    expect(roundtripTable?.rowsById.row_1.cellsByColumnId.col_order_total).toBe(120.5);
    expect(roundtripTable?.rowsById.row_4.cellsByColumnId.col_customer_email).toBe(null);
  });
});

async function readFixture(fileName: string): Promise<string> {
  const fixturePath = path.resolve(process.cwd(), 'fixtures', fileName);
  return readFile(fixturePath, 'utf8');
}

function buildMultiSheetWorkbook(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const customers = XLSX.utils.aoa_to_sheet([
    ['customer_id', 'email'],
    ['C001', 'alice.ng@example.com'],
  ]);
  const orders = XLSX.utils.aoa_to_sheet([
    ['order_id', 'order_total'],
    ['O100', 42],
  ]);

  XLSX.utils.book_append_sheet(workbook, customers, 'Customers');
  XLSX.utils.book_append_sheet(workbook, orders, 'Orders');

  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

function buildFormulaWorkbook(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['left', 'right', 'total', 'missing_total'],
    [1, 2, null, null],
  ]);

  sheet.C2 = { t: 'n', f: 'A2+B2', v: 3 };
  sheet.D2 = { t: 'n', f: 'A2+B2' };
  sheet['!ref'] = 'A1:D2';

  XLSX.utils.book_append_sheet(workbook, sheet, 'Formulas');

  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
