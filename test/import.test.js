import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LedgerError, quantities, readMovements, recordMovement, recordMovements } from '../src/ledger.js';
import { importCsv, importCsvText } from '../src/import.js';

function tempLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ledger.jsonl');
}

const refuses = (code) => (err) => err instanceof LedgerError && err.code === code;
const AT = new Date('2026-03-04T05:06:07.000Z');
const stored = (file) => readMovements(file).map(({ item, type, qty }) => `${item} ${type} ${qty}`);

// ---- recordMovements (src/ledger.js) ----

test('recordMovements appends every good entry in order, in one go, with one time', (t) => {
  const file = tempLedger(t);
  const results = recordMovements(file, [
    { item: ' Widget ', type: 'in', qty: '10' },
    { item: 'bolt', type: 'in', qty: 5 },
    { item: 'widget', type: 'out', qty: '3' },
  ], { at: AT });
  assert.deepEqual(results, [
    { movement: { at: AT.toISOString(), item: 'widget', type: 'in', qty: 10 }, quantity: 10 },
    { movement: { at: AT.toISOString(), item: 'bolt', type: 'in', qty: 5 }, quantity: 5 },
    { movement: { at: AT.toISOString(), item: 'widget', type: 'out', qty: 3 }, quantity: 7 },
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'),
    '{"at":"2026-03-04T05:06:07.000Z","item":"widget","type":"in","qty":10}\n'
    + '{"at":"2026-03-04T05:06:07.000Z","item":"bolt","type":"in","qty":5}\n'
    + '{"at":"2026-03-04T05:06:07.000Z","item":"widget","type":"out","qty":3}\n');
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('recordMovements: a bad entry gets an error and never stops the entries round it', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'widget', type: 'in', qty: 2 });
  const before = fs.readFileSync(file, 'utf8');
  const results = recordMovements(file, [
    { item: 'widget', type: 'in', qty: '1' },
    { item: '', type: 'in', qty: '1' },
    { item: 'widget', type: 'sideways', qty: '1' },
    { item: 'widget', type: 'in', qty: '1.5' },
    null,
    { item: 'widget', type: 'out', qty: '9' },
    { item: 'never-seen', type: 'out', qty: '1' },
    { item: 'widget', type: 'in', qty: '4' },
  ], { at: AT });
  assert.deepEqual(results.map((r) => r.error?.code ?? r.quantity), [3, 'BAD_ITEM', 'BAD_TYPE', 'BAD_QUANTITY', 'BAD_ITEM', 'INSUFFICIENT_STOCK', 'INSUFFICIENT_STOCK', 7]);
  assert.ok(results.every((r) => r.error === undefined || r.error instanceof LedgerError));
  assert.match(results[5].error.message, /cannot take 9 of "widget" out: only 3 in stock at that point/);
  assert.equal(fs.readFileSync(file, 'utf8'),
    `${before}{"at":"2026-03-04T05:06:07.000Z","item":"widget","type":"in","qty":1}\n{"at":"2026-03-04T05:06:07.000Z","item":"widget","type":"in","qty":4}\n`);
});

test('recordMovements checks each entry against the stock as the entries before it left it', (t) => {
  const file = tempLedger(t);
  const results = recordMovements(file, [
    { item: 'widget', type: 'out', qty: 1 },   // nothing in yet: refused
    { item: 'widget', type: 'in', qty: 5 },
    { item: 'widget', type: 'out', qty: 5 },   // uses the goods the entry before brought in
    { item: 'widget', type: 'out', qty: 1 },   // none left: refused
    { item: 'widget', type: 'in', qty: 2 },
    { item: 'widget', type: 'out', qty: 2 },
  ]);
  assert.deepEqual(results.map((r) => r.error?.code ?? r.quantity), ['INSUFFICIENT_STOCK', 5, 0, 'INSUFFICIENT_STOCK', 2, 0]);
  let running = 0;
  for (const { type, qty } of readMovements(file)) { running += type === 'in' ? qty : -qty; assert.ok(running >= 0, 'stock never below zero at any line'); }
  assert.equal(running, 0);
});

test('recordMovements refuses an entry that would pass what can be counted exactly, and keeps going', (t) => {
  const file = tempLedger(t);
  const results = recordMovements(file, [
    { item: 'widget', type: 'in', qty: Number.MAX_SAFE_INTEGER },
    { item: 'widget', type: 'in', qty: 1 },
    { item: 'bolt', type: 'in', qty: 1 },
  ]);
  assert.deepEqual(results.map((r) => r.error?.code ?? r.quantity), [Number.MAX_SAFE_INTEGER, 'QUANTITY_TOO_LARGE', 1]);
  assert.deepEqual([...quantities(readMovements(file))], [['widget', Number.MAX_SAFE_INTEGER], ['bolt', 1]]);
});

test('recordMovements with nothing to write does not create or touch the ledger', (t) => {
  const file = tempLedger(t);
  assert.deepEqual(recordMovements(file, []), []);
  assert.deepEqual(recordMovements(file, [{ item: 'widget', type: 'in', qty: '0' }]).map((r) => r.error.code), ['BAD_QUANTITY']);
  assert.deepEqual(recordMovements(file, [{ item: 'widget', type: 'out', qty: '1' }]).map((r) => r.error.code), ['INSUFFICIENT_STOCK']);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('recordMovements and import: a ledger that stays locked refuses the whole call and writes nothing', (t) => {
  const file = tempLedger(t);
  const dir = path.dirname(file);
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(
    () => recordMovements(file, [{ item: 'widget', type: 'in', qty: 1 }]),
    (err) => refuses('LOCKED')(err) && err.message.includes(`${file}.lock`),
  );
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,1\nbolt,in,x\n');
  assert.throws(() => importCsv(file, path.join(dir, 'moves.csv'), { rejectsFile: path.join(dir, 'r.csv') }), refuses('LOCKED'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ledger.jsonl.lock', 'moves.csv'], 'no ledger and no rejects file; a lock held by someone else is not removed');
});

test('recordMovements: a damaged ledger, an unusable path or a bad time refuses the whole call and writes nothing', (t) => {
  const file = tempLedger(t);
  const entries = [{ item: 'widget', type: 'in', qty: 1 }, { item: 'bolt', type: 'in', qty: 1 }];
  assert.throws(() => recordMovements(file, entries, { at: new Date('nonsense') }), refuses('BAD_TIME'));
  assert.throws(() => recordMovements(file, entries, { at: '2026-01-01' }), refuses('BAD_TIME'));
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}\nnot a movement\n');
  const damaged = fs.readFileSync(file, 'utf8');
  assert.throws(() => recordMovements(file, entries), (err) => refuses('DAMAGED_LEDGER')(err) && err.message.includes('line 2'));
  assert.equal(fs.readFileSync(file, 'utf8'), damaged);
  assert.equal(fs.existsSync(`${file}.lock`), false);

  const missingFolder = path.join(path.dirname(file), 'no-such-folder', 'ledger.jsonl');
  assert.throws(() => recordMovements(missingFolder, entries), refuses('FILE_ERROR'));
});

test('recordMovements does not glue its first line to a ledger that lacks a final line break', (t) => {
  const file = tempLedger(t);
  fs.writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}');
  recordMovements(file, [{ item: 'widget', type: 'in', qty: 1 }, { item: 'widget', type: 'out', qty: 6 }]);
  assert.deepEqual(stored(file), ['widget in 5', 'widget in 1', 'widget out 6']);
});

// ---- importCsvText and importCsv (src/import.js) ----

test('import: good rows are recorded in file order, bad rows are rejected with line and reason, none is lost', (t) => {
  const file = tempLedger(t);
  const csv = [
    'item,type,quantity',        // 1
    'widget,in,10',              // 2
    'Widget,OUT,3',              // 3  case of item and type does not matter
    'bolt,out,1',                // 4  rejected: nothing in stock
    '"blue, widget",in,x',       // 5  rejected: quantity
    'nut,in',                    // 6  rejected: two fields
    ',in,5',                     // 7  rejected: no item
    'gadget,sideways,5',         // 8  rejected: type
    'gadget,in,4,extra',         // 9  rejected: four fields
    ' gadget , in , 4 ',         // 10 spaces round a field are dropped
    '"6"" nail",in,100',         // 11
  ].join('\n');
  const result = importCsvText(file, csv, { name: 'moves.csv', at: AT });

  assert.equal(result.rows, 10);
  assert.equal(result.header, 'item,type,quantity');
  assert.deepEqual(result.recorded.map(({ line, movement, quantity }) => [line, movement.item, movement.type, movement.qty, quantity]), [
    [2, 'widget', 'in', 10, 10], [3, 'widget', 'out', 3, 7], [10, 'gadget', 'in', 4, 4], [11, '6" nail', 'in', 100, 100],
  ]);
  assert.deepEqual(result.rejected.map(({ line, code, raw }) => [line, code, raw]), [
    [4, 'INSUFFICIENT_STOCK', 'bolt,out,1'], [5, 'BAD_QUANTITY', '"blue, widget",in,x'], [6, 'BAD_ROW', 'nut,in'],
    [7, 'BAD_ITEM', ',in,5'], [8, 'BAD_TYPE', 'gadget,sideways,5'], [9, 'BAD_ROW', 'gadget,in,4,extra'],
  ]);
  assert.match(result.rejected[2].reason, /the row has 2 fields, the header has 3/);
  assert.equal(result.recorded.length + result.rejected.length, result.rows);
  assert.deepEqual(stored(file), ['widget in 10', 'widget out 3', 'gadget in 4', '6" nail in 100']);
  assert.ok(readMovements(file).every((m) => m.at === AT.toISOString()));
});

test('import: the columns may be in any order and any case, and qty means quantity', (t) => {
  const file = tempLedger(t);
  importCsvText(file, 'Quantity, TYPE ,Item\r\n5,in,widget\r\n');
  importCsvText(file, '﻿"type","qty","item"\n"out","2","widget"\n');
  assert.deepEqual(stored(file), ['widget in 5', 'widget out 2']);
});

test('import: a header that is not exactly the three columns refuses the whole file and writes nothing', (t) => {
  const file = tempLedger(t);
  const bad = [
    '',                                         // empty
    '\n\n',                                     // only blank lines
    'widget,in,5\nbolt,in,1\n',                 // no header: the first row is data
    'item,type\nwidget,in\n',                   // a column missing
    'item,type,quantity,note\nwidget,in,5,x\n', // a column too many
    'item,type,amount\nwidget,in,5\n',          // a column that is not known
    'item,item,quantity\nwidget,in,5\n',        // a column twice
    'item;type;quantity\nwidget;in;5\n',        // semicolons
    'item\ttype\tquantity\nwidget\tin\t5\n',    // tabs
    'it"em,type,quantity\nwidget,in,5\n',       // bad quoting in the header
    '"item,type,quantity\nwidget,in,5\n',       // unclosed quote in the header
  ];
  for (const text of bad) {
    assert.throws(() => importCsvText(file, text, { name: 'moves.csv' }), (err) => refuses('BAD_CSV')(err) && /Nothing was written/.test(err.message), JSON.stringify(text));
  }
  assert.throws(() => importCsvText(file, ''), /is empty/);
  assert.throws(() => importCsvText(file, 'item;type;quantity\n', { name: 'moves.csv' }), /moves\.csv line 1 must name the columns item, type and quantity, separated by commas, and no others \(got "item;type;quantity"\)/);
  assert.equal(fs.existsSync(file), false);
});

test('import: a file with a header and no rows imports nothing and is not an error', (t) => {
  const file = tempLedger(t);
  assert.deepEqual(importCsvText(file, 'item,type,quantity\n\n'), { rows: 0, recorded: [], rejected: [], header: 'item,type,quantity' });
  assert.equal(fs.existsSync(file), false);
});

test('import: bad quoting rejects that row only; an unclosed quote rejects from there to the end and keeps what came before', (t) => {
  const file = tempLedger(t);
  const result = importCsvText(file, 'item,type,quantity\nwid"get,in,1\nbolt,in,2\nnut,"in,3\ngadget,in,4\n');
  assert.deepEqual(stored(file), ['bolt in 2']);
  assert.deepEqual(result.rejected.map(({ line, code }) => [line, code]), [[2, 'BAD_ROW'], [4, 'BAD_ROW']]);
  assert.match(result.rejected[1].reason, /quote opened on line 4 is never closed/);
  assert.equal(result.rows, 3);
});

test('import: the quantity follows rule 4 exactly, as on the command line', (t) => {
  const file = tempLedger(t);
  const quantitiesTried = ['0', '-5', '1.5', '1e3', '0x10', '+5', '05', '', '"1,000"', 'five', '9007199254740992', '٥'];
  const result = importCsvText(file, `item,type,quantity\n${quantitiesTried.map((q) => `widget,in,${q}`).join('\n')}\nwidget,in,9007199254740991\n`);
  assert.deepEqual(result.rejected.map((r) => r.code), quantitiesTried.map(() => 'BAD_QUANTITY'));
  assert.deepEqual(stored(file), ['widget in 9007199254740991']);
});

test('import: an item with a line break or another control character is rejected, a unicode item is kept', (t) => {
  const file = tempLedger(t);
  const result = importCsvText(file, 'item,type,quantity\n"two\nlines",in,1\n"tab\there",in,1\nGröße ④ 🧰,in,3\n');
  assert.deepEqual(result.rejected.map(({ line, code }) => [line, code]), [[2, 'BAD_ITEM'], [4, 'BAD_ITEM']]);
  assert.deepEqual(result.recorded.map(({ line, movement }) => [line, movement.item]), [[5, 'größe ④ 🧰']]);
});

test('import: a row with bytes that are not UTF-8 is rejected, not recorded under a mangled name', (t) => {
  const file = tempLedger(t);
  const csv = path.join(path.dirname(file), 'latin1.csv');
  fs.writeFileSync(csv, Buffer.concat([Buffer.from('item,type,quantity\nwidget,in,1\nGr'), Buffer.from([0xf6, 0xdf]), Buffer.from('e,in,2\nbolt,in,3\n')]));
  const result = importCsv(file, csv);
  assert.deepEqual(result.rejected.map(({ line, code }) => [line, code]), [[3, 'BAD_ROW']]);
  assert.match(result.rejected[0].reason, /not UTF-8/);
  assert.deepEqual(stored(file), ['widget in 1', 'bolt in 3']);

  const utf16 = path.join(path.dirname(file), 'utf16.csv');
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('item,type,quantity\nwidget,in,1\n', 'utf16le')]));
  assert.throws(() => importCsv(file, utf16), (err) => refuses('BAD_CSV')(err) && /utf16\.csv is not UTF-8 text/.test(err.message));
  assert.deepEqual(stored(file), ['widget in 1', 'bolt in 3']);
});

test('import: a CSV file that is missing or is a folder is refused; a damaged ledger refuses the whole import', (t) => {
  const file = tempLedger(t);
  const dir = path.dirname(file);
  const csv = path.join(dir, 'moves.csv');
  assert.throws(() => importCsv(file, csv), (err) => refuses('FILE_ERROR')(err) && /cannot use CSV file/.test(err.message));
  assert.throws(() => importCsv(file, dir), refuses('FILE_ERROR'));

  fs.writeFileSync(csv, 'item,type,quantity\nwidget,in,1\nbolt,in,x\n');
  fs.writeFileSync(file, 'not a movement\n');
  assert.throws(() => importCsv(file, csv, { rejectsFile: path.join(dir, 'r.csv') }), refuses('DAMAGED_LEDGER'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'not a movement\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['ledger.jsonl', 'moves.csv'], 'no lock and no rejects file left behind');
});

test('import with a rejects file: the rejected rows are written under the header, as they were, and can be imported in turn', (t) => {
  const file = tempLedger(t);
  const dir = path.dirname(file);
  const csv = path.join(dir, 'moves.csv');
  const rejects = path.join(dir, 'rejects.csv');
  fs.writeFileSync(csv, 'Quantity,Item,Type\r\n5,widget,in\r\n9,widget,out\r\nx,"blue, widget",in\r\n2,bolt,in\r\n');
  const first = importCsv(file, csv, { rejectsFile: rejects });
  assert.equal(first.rejectsFile, rejects);
  assert.equal(first.rejectsError, undefined);
  assert.equal(fs.readFileSync(rejects, 'utf8'), 'Quantity,Item,Type\n9,widget,out\nx,"blue, widget",in\n');

  // Correct the rejected rows and import only those: nothing is recorded twice.
  fs.writeFileSync(rejects, fs.readFileSync(rejects, 'utf8').replace('9,widget,out', '4,widget,out').replace('x,', '7,'));
  const second = importCsv(file, rejects, { rejectsFile: path.join(dir, 'rejects-2.csv') });
  assert.equal(second.rejected.length, 0);
  assert.equal(second.rejectsFile, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'rejects-2.csv')), false, 'no rejects file when no row was rejected');
  assert.deepEqual([...quantities(readMovements(file))], [['widget', 1], ['bolt', 2], ['blue, widget', 7]]);
});

test('import with a rejects file that cannot be used is refused before the ledger is touched', (t) => {
  const file = tempLedger(t);
  const dir = path.dirname(file);
  const csv = path.join(dir, 'moves.csv');
  fs.writeFileSync(csv, 'item,type,quantity\nwidget,in,1\nbolt,in,x\n');
  fs.writeFileSync(path.join(dir, 'there.csv'), 'keep me');

  const refused = [
    [path.join(dir, 'there.csv'), /already exists and is not overwritten/],
    [csv, /already exists and is not overwritten/],
    [path.join(dir, 'no-such-folder', 'r.csv'), /cannot use rejects file/],
    [path.join(dir, 'rejects.txt'), /must end in \.csv/],
    [file, /must end in \.csv/],
    [`${file}.items.jsonl`, /must end in \.csv/],
  ];
  for (const [rejectsFile, pattern] of refused) {
    assert.throws(() => importCsv(file, csv, { rejectsFile }), (err) => refuses('FILE_ERROR')(err) && pattern.test(err.message) && /Nothing was written/.test(err.message), rejectsFile);
  }
  const csvLedger = path.join(dir, 'ledger.csv');
  assert.throws(() => importCsv(csvLedger, csv, { rejectsFile: csvLedger }), /must not be the ledger file/);
  assert.equal(fs.readFileSync(path.join(dir, 'there.csv'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'there.csv']);

  // A CSV that is refused as a whole leaves no empty rejects file behind either.
  fs.writeFileSync(csv, 'item;type;quantity\n');
  assert.throws(() => importCsv(file, csv, { rejectsFile: path.join(dir, 'r.csv') }), refuses('BAD_CSV'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'there.csv']);
});
