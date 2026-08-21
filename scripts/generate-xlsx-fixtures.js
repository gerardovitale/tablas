#!/usr/bin/env node
/**
 * Regenerates the binary .xlsx fixtures under test/fixtures/.
 *
 * XLSX files are binary (a ZIP/OOXML package) and can't be hand-authored
 * like the CSV fixtures, so this script exists to make them reproducible
 * instead of opaque committed binaries. Unlike the Parquet/SQLite fixture
 * scripts (Python, needing pyarrow/stdlib sqlite3 respectively), this one
 * is a plain Node script using the `exceljs` dependency already added for
 * src/xlsxParser.ts -- no second new dependency (e.g. openpyxl) just for
 * fixture generation. Run from the repo root:
 *
 *     node scripts/generate-xlsx-fixtures.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');

async function write(name, build) {
  const workbook = new ExcelJS.Workbook();
  await build(workbook);
  const filePath = path.join(FIXTURES_DIR, name);
  await workbook.xlsx.writeFile(filePath);
  console.log(`wrote ${filePath}`);
}

async function main() {
  // simple.xlsx -- mixed types mirroring simple.csv/simple.parquet/simple.db's
  // shape, so readXlsxSheet/stringifyXlsxCell get real coverage of numbers,
  // strings, and booleans.
  await write('simple.xlsx', async (workbook) => {
    const sheet = workbook.addWorksheet('people');
    sheet.addRow(['id', 'name', 'score', 'active']);
    sheet.addRow([1, 'Alice', 9.5, true]);
    sheet.addRow([2, 'Bob', 4, false]);
    sheet.addRow([3, 'Carol', 7.25, true]);
  });

  // empty.xlsx -- header row present, zero data rows (mirrors empty.parquet's
  // intent: headers must come from row 1, not inferred from data rows).
  await write('empty.xlsx', async (workbook) => {
    const sheet = workbook.addWorksheet('items');
    sheet.addRow(['id', 'label']);
  });

  // multi-sheet.xlsx -- two sheets, to exercise the sheet-picker dropdown
  // and listXlsxSheets, mirroring multi-table.db's role for SQLite.
  await write('multi-sheet.xlsx', async (workbook) => {
    const customers = workbook.addWorksheet('customers');
    customers.addRow(['id', 'name']);
    customers.addRow([1, 'Acme']);
    customers.addRow([2, 'Globex']);

    const orders = workbook.addWorksheet('orders');
    orders.addRow(['id', 'customer_id', 'total']);
    orders.addRow([1, 1, 19.99]);
    orders.addRow([2, 1, 5.5]);
    orders.addRow([3, 2, 42.0]);
  });

  // nulls.xlsx -- blank cells interspersed with values, mirrors nulls.parquet/nulls.db.
  await write('nulls.xlsx', async (workbook) => {
    const sheet = workbook.addWorksheet('readings');
    sheet.addRow(['a', 'b']);
    sheet.addRow([1, null]);
    sheet.addRow([null, null]);
    sheet.addRow([3, 'x']);
  });

  // dates-and-formulas.xlsx -- a real Date cell and a formula cell with a
  // cached result, to exercise stringifyXlsxCell's reliance on exceljs's
  // own `cell.text` formatting/resolution rather than manual type-switching.
  await write('dates-and-formulas.xlsx', async (workbook) => {
    const sheet = workbook.addWorksheet('sheet1');
    sheet.addRow(['label', 'when', 'total']);
    const row = sheet.addRow(['first', new Date('2023-11-14T00:00:00.000Z'), null]);
    row.getCell(3).value = { formula: 'SUM(1,2,3)', result: 6 };
  });

  // corrupt.xlsx -- not a ZIP/xlsx file at all, to exercise the magic-byte
  // sniff in openXlsxWorkbook.
  const corruptPath = path.join(FIXTURES_DIR, 'corrupt.xlsx');
  fs.writeFileSync(corruptPath, 'this is not a valid xlsx file');
  console.log(`wrote ${corruptPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
