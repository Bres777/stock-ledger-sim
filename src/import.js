// Importing movements from a CSV file. Reads the CSV (src/csv.js), turns each row into a movement
// and hands them all to recordMovements (src/ledger.js), which is still the only code that
// writes the ledger. A row that cannot be recorded is rejected with its line number and the
// reason, and never stops the rows around it.

import fs from 'node:fs';
import path from 'node:path';
import { parseCsv } from './csv.js';
import { LedgerError, recordMovements } from './ledger.js';

export const IMPORT_COLUMNS = Object.freeze(['item', 'type', 'quantity']);

const columnsWanted = 'item, type and quantity, separated by commas';

function csvError(file, err) {
  return new LedgerError('FILE_ERROR', `cannot use CSV file ${file}: ${err.message}`);
}

// The CSV file as text. Unlike a ledger, a CSV file that does not exist is an error.
// Bytes that are not UTF-8 arrive as U+FFFD and are dealt with row by row.
function readCsvFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw csvError(file, err);
  }
}

// Which field of a row is the item, the type and the quantity, from the header row.
// The header is the one thing that must be right for any row to be read, so a wrong header
// refuses the whole file. Column names may be in any order and any case; "qty" is "quantity".
function readHeader(records, name) {
  const header = records[0];
  if (header === undefined) {
    throw new LedgerError('BAD_CSV', `${name} is empty. Its first line must name the columns ${columnsWanted}. Nothing was written.`);
  }
  if (/[�\u0000]/.test(header.raw)) {
    throw new LedgerError('BAD_CSV', `${name} is not UTF-8 text (it may have been saved as UTF-16 or in an older encoding). Save it as "CSV UTF-8" and try again. Nothing was written.`);
  }
  const names = header.fields.map((field) => field.trim().toLowerCase()).map((field) => (field === 'qty' ? 'quantity' : field));
  const wellFormed = header.problem === undefined && names.length === IMPORT_COLUMNS.length && IMPORT_COLUMNS.every((column) => names.includes(column));
  if (!wellFormed) {
    throw new LedgerError('BAD_CSV', `${name} line ${header.line} must name the columns ${columnsWanted}, and no others (got "${header.raw}"). Nothing was written.`);
  }
  return Object.fromEntries(IMPORT_COLUMNS.map((column) => [column, names.indexOf(column)]));
}

// Why a row cannot even be offered to the ledger, or undefined if it can.
function rowProblem({ fields, raw, problem }) {
  if (raw.includes('�')) return 'the row holds bytes that are not UTF-8 text; save the file as "CSV UTF-8"';
  if (problem !== undefined) return problem;
  if (fields.length !== IMPORT_COLUMNS.length) {
    return `the row has ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}, the header has ${IMPORT_COLUMNS.length}`;
  }
  return undefined;
}

// Imports CSV text that is already in memory. `name` is how the CSV is called in messages.
// Returns { rows, recorded: [{ line, movement, quantity }], rejected: [{ line, code, reason, raw }], header }.
//   rows      how many rows the CSV has, not counting the header and blank lines
//   recorded  the rows now in the ledger, in file order; quantity is the item's quantity after that row
//   rejected  the rows not in the ledger, in file order; raw is the row's own text
//   header    the header row's own text
// rows === recorded.length + rejected.length, always. Throws a LedgerError, with nothing
// written, when the header is wrong or the ledger itself refuses (damaged, locked, unusable).
export function importCsvText(ledgerFile, text, { name = 'CSV', at = new Date() } = {}) {
  const records = parseCsv(text);
  const column = readHeader(records, name);
  const rows = records.slice(1);

  const outcomes = rows.map((row) => {
    const reason = rowProblem(row);
    return reason === undefined ? { row } : { row, rejected: { line: row.line, code: 'BAD_ROW', reason, raw: row.raw } };
  });
  const offered = outcomes.filter((outcome) => !outcome.rejected);
  // Spaces round a field are dropped and the type may be in any case, as an item name may.
  // The quantity then has to pass the same rule as on the command line: digits only.
  const results = recordMovements(ledgerFile, offered.map(({ row }) => ({
    item: row.fields[column.item].trim(),
    type: row.fields[column.type].trim().toLowerCase(),
    qty: row.fields[column.quantity].trim(),
  })), { at });

  const recorded = [];
  const rejected = [];
  offered.forEach((outcome, index) => {
    const { movement, quantity, error } = results[index];
    if (error) outcome.rejected = { line: outcome.row.line, code: error.code, reason: error.message, raw: outcome.row.raw };
    else outcome.recorded = { line: outcome.row.line, movement, quantity };
  });
  for (const outcome of outcomes) {
    if (outcome.rejected) rejected.push(outcome.rejected);
    else recorded.push(outcome.recorded);
  }
  return { rows: rows.length, recorded, rejected, header: records[0].raw };
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

// Imports a CSV file into a ledger file. Returns what importCsvText returns, plus
//   rejectsFile   the file the rejected rows were written to, or undefined if none was written
//   rejectsError  why that file could not be written although rows were rejected, or undefined
// With `rejectsFile`, the rejected rows are written there under the CSV's own header, each
// exactly as it was, so the file can be corrected and imported in turn. It is created only if
// a row was rejected, its name must end in .csv, and a file already there is never overwritten:
// any of that is checked before the ledger is touched and refuses the whole import.
export function importCsv(ledgerFile, csvFile, { at = new Date(), rejectsFile } = {}) {
  const text = readCsvFile(csvFile);
  const name = path.basename(csvFile);
  if (rejectsFile === undefined) return { ...importCsvText(ledgerFile, text, { name, at }), rejectsFile: undefined, rejectsError: undefined };

  if (!/\.csv$/i.test(rejectsFile) || samePath(path.resolve(rejectsFile), path.resolve(ledgerFile))) {
    throw new LedgerError('FILE_ERROR', `cannot use rejects file ${rejectsFile}: its name must end in .csv and it must not be the ledger file. Nothing was written.`);
  }
  readHeader(parseCsv(text), name);   // a CSV that will be refused must not leave an empty rejects file behind
  let handle;
  try {
    handle = fs.openSync(rejectsFile, 'wx');
  } catch (err) {
    const why = err.code === 'EEXIST' ? 'it already exists and is not overwritten' : err.message;
    throw new LedgerError('FILE_ERROR', `cannot use rejects file ${rejectsFile}: ${why}. Nothing was written.`);
  }
  let result;
  try {
    result = importCsvText(ledgerFile, text, { name, at });
  } catch (err) {
    fs.closeSync(handle);
    fs.unlinkSync(rejectsFile);
    throw err;
  }
  if (result.rejected.length === 0) {
    fs.closeSync(handle);
    fs.unlinkSync(rejectsFile);
    return { ...result, rejectsFile: undefined, rejectsError: undefined };
  }
  // From here the good rows are in the ledger, so a failure is reported, not thrown.
  try {
    fs.writeSync(handle, `${[result.header, ...result.rejected.map(({ raw }) => raw)].join('\n')}\n`);
    fs.closeSync(handle);
    return { ...result, rejectsFile, rejectsError: undefined };
  } catch (err) {
    try { fs.closeSync(handle); } catch { /* already closed */ }
    return { ...result, rejectsFile: undefined, rejectsError: `could not write the rejected rows to ${rejectsFile}: ${err.message}` };
  }
}
