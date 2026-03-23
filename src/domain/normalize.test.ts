import { describe, expect, it } from 'vitest';

import { CellValue, getActiveTable } from './model';
import { ImportedCellInput, extractDisplayHeaderLine, normalizeImportedWorkbook } from './normalize';

describe('header row normalization', () => {
  it('respects explicit headerRowIndex and starts data rows after the selected header row', () => {
    const workbook = normalizeImportedWorkbook({
      sourceFileName: 'elements.xlsx',
      sourceFormat: 'xlsx',
      tables: [
        {
          sourceName: 'Elements',
          headerRowIndex: 1,
          rows: [
            [valueCell('{"UniqueId":"sheet_metadata"}'), valueCell('{"DisplayName":"Element Status"}')],
            [xlsxHeaderCell('Element ID'), xlsxHeaderCell('Status')],
            [valueCell('E-001'), valueCell('Active')],
            [valueCell('E-002'), valueCell('Inactive')],
          ],
        },
      ],
    });
    const table = getActiveTable(workbook);

    expect(table?.schema.columns.map((column) => column.displayName)).toEqual(['Element ID', 'Status']);
    expect(table?.schema.columns.map((column) => column.columnId)).toEqual(['col_element_id', 'col_status']);
    expect(table?.rowOrder).toEqual(['row_1', 'row_2']);
    expect(table?.rowsById.row_1.cellsByColumnId.col_element_id).toBe('E-001');
    expect(table?.rowsById.row_1.cellsByColumnId.col_status).toBe('Active');
  });

  it('uses XLSX first-line header extraction before duplicate and blank normalization', () => {
    const workbook = normalizeImportedWorkbook({
      sourceFileName: 'multiline-headers.xlsx',
      sourceFormat: 'xlsx',
      tables: [
        {
          sourceName: 'Headers',
          headerRowIndex: 0,
          rows: [
            [
              xlsxHeaderCell('Status\nstring'),
              xlsxHeaderCell('\nStatus\nnumber'),
              xlsxHeaderCell('\n  \r\n'),
              xlsxHeaderCell('\r\n'),
            ],
            [valueCell('Open'), valueCell('Closed'), valueCell('A'), valueCell('B')],
          ],
        },
      ],
    });
    const table = getActiveTable(workbook);

    expect(table?.schema.columns.map((column) => column.displayName)).toEqual([
      'Status',
      'Status (2)',
      'Column',
      'Column (2)',
    ]);
    expect(table?.schema.columns.map((column) => column.columnId)).toEqual([
      'col_status',
      'col_status_2',
      'col_column',
      'col_column_2',
    ]);
    expect(table?.importWarnings.filter((warning) => warning.code === 'multilineHeaderFirstLineUsed')).toHaveLength(0);
    expect(table?.importWarnings.filter((warning) => warning.code === 'duplicateHeaderNormalized')).toHaveLength(2);
    expect(table?.importWarnings.filter((warning) => warning.code === 'blankHeaderGenerated')).toHaveLength(2);
  });
});

function xlsxHeaderCell(text: string): ImportedCellInput {
  return {
    headerText: text,
    displayHeaderText: extractDisplayHeaderLine(text),
    value: text,
  };
}

function valueCell(value: CellValue): ImportedCellInput {
  return {
    headerText: value === null ? '' : String(value),
    value,
  };
}
