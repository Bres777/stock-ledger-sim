import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LedgerError, normalizeItem, parseLedgerText, parseQuantity, quantities, quantityOf, readMovements, recordMovement } from '../src/ledger.js';

function tempLedger(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ledger.jsonl');
}

const refuses = (code) => (err) => err instanceof LedgerError && err.code === code;

test('a ledger file that does not exist yet is an empty ledger', (t) => {
  const file = tempLedger(t);
  assert.deepEqual(readMovements(file), []);
  assert.equal(quantityOf(readMovements(file), 'widget'), 0);
  assert.equal(fs.existsSync(file), false, 'reading must not create the file');
});

test('each movement appends exactly one line and leaves earlier lines untouched', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'widget', type: 'in', qty: 10, at: new Date('2026-01-02T03:04:05.000Z') });
  const afterFirst = fs.readFileSync(file, 'utf8');
  assert.equal(afterFirst, '{"at":"2026-01-02T03:04:05.000Z","item":"widget","type":"in","qty":10}\n');

  recordMovement(file, { item: 'widget', type: 'out', qty: 3, at: new Date('2026-01-03T00:00:00.000Z') });
  const afterSecond = fs.readFileSync(file, 'utf8');
  assert.equal(afterSecond, `${afterFirst}{"at":"2026-01-03T00:00:00.000Z","item":"widget","type":"out","qty":3}\n`);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock file must be gone after a write');
});

test('quantity is goods in minus goods out, per item, read back from the file', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'widget', type: 'in', qty: 10 });
  recordMovement(file, { item: 'bolt', type: 'in', qty: 100 });
  recordMovement(file, { item: 'widget', type: 'out', qty: 3 });
  recordMovement(file, { item: 'widget', type: 'in', qty: 5 });
  recordMovement(file, { item: 'bolt', type: 'out', qty: 100 });

  const movements = readMovements(file);
  assert.equal(movements.length, 5);
  assert.equal(quantityOf(movements, 'widget'), 12);
  assert.equal(quantityOf(movements, 'bolt'), 0);
  assert.equal(quantityOf(movements, 'never-seen'), 0);
  assert.deepEqual([...quantities(movements)], [['widget', 12], ['bolt', 0]]);
});

test('recordMovement returns the stored movement and the quantity after it', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'widget', type: 'in', qty: 10 });
  const { movement, quantity } = recordMovement(file, { item: 'widget', type: 'out', qty: '4' });
  assert.equal(quantity, 6);
  assert.equal(movement.item, 'widget');
  assert.equal(movement.type, 'out');
  assert.equal(movement.qty, 4);
  assert.equal(new Date(movement.at).toISOString(), movement.at);
  assert.deepEqual(readMovements(file).at(-1), movement);
});

test('item names are trimmed and lower-cased, so spellings of one item add up', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'Widget', type: 'in', qty: 2 });
  recordMovement(file, { item: '  WIDGET ', type: 'in', qty: 3 });
  recordMovement(file, { item: 'Blue Widget', type: 'in', qty: 1 });
  assert.equal(quantityOf(readMovements(file), 'wIdGeT'), 5);
  assert.equal(quantityOf(readMovements(file), 'blue widget'), 1);
  assert.equal(normalizeItem(' Ünïcode Größe '), 'ünïcode größe');
});

test('goods out beyond the current stock is refused and writes nothing', (t) => {
  const file = tempLedger(t);
  assert.throws(() => recordMovement(file, { item: 'widget', type: 'out', qty: 1 }), refuses('INSUFFICIENT_STOCK'));
  assert.equal(fs.existsSync(file), false);

  recordMovement(file, { item: 'widget', type: 'in', qty: 5 });
  recordMovement(file, { item: 'bolt', type: 'in', qty: 50 });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => recordMovement(file, { item: 'widget', type: 'out', qty: 6 }), refuses('INSUFFICIENT_STOCK'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  recordMovement(file, { item: 'widget', type: 'out', qty: 5 });
  assert.equal(quantityOf(readMovements(file), 'widget'), 0);
});

test('bad input is refused and writes nothing', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'widget', type: 'in', qty: 5 });
  const before = fs.readFileSync(file, 'utf8');

  const badQuantities = [0, -1, 1.5, NaN, Infinity, 2 ** 53, '0', '-1', '1.5', '1e3', '0x10', '+5', ' 5', '5 ', '05', '', 'five', null, undefined, true, [5], {}];
  for (const qty of badQuantities) {
    assert.throws(() => recordMovement(file, { item: 'widget', type: 'in', qty }), refuses('BAD_QUANTITY'), `quantity ${String(qty)}`);
  }
  for (const item of ['', '   ', 'a\tb', 'a\nb', 'a\u0000b', 5, null, undefined]) {
    assert.throws(() => recordMovement(file, { item, type: 'in', qty: 1 }), refuses('BAD_ITEM'), `item ${String(item)}`);
  }
  for (const type of ['IN', 'add', '', undefined, null]) {
    assert.throws(() => recordMovement(file, { item: 'widget', type, qty: 1 }), refuses('BAD_TYPE'), `type ${String(type)}`);
  }
  assert.throws(() => recordMovement(file, { item: 'widget', type: 'in', qty: 1, at: new Date('nonsense') }), refuses('BAD_TIME'));
  assert.throws(() => recordMovement(file, { item: 'widget', type: 'in', qty: 1, at: '2026-01-01' }), refuses('BAD_TIME'));

  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('parseQuantity accepts whole numbers of 1 or more, as number or digits', () => {
  assert.equal(parseQuantity(1), 1);
  assert.equal(parseQuantity('1'), 1);
  assert.equal(parseQuantity('9007199254740991'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseQuantity('9007199254740992'), refuses('BAD_QUANTITY'));
});

test('a quantity that would pass what can be counted exactly is refused', (t) => {
  const file = tempLedger(t);
  recordMovement(file, { item: 'widget', type: 'in', qty: Number.MAX_SAFE_INTEGER });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => recordMovement(file, { item: 'widget', type: 'in', qty: 1 }), refuses('QUANTITY_TOO_LARGE'));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a damaged line stops the read and names the line; it is never skipped', (t) => {
  const file = tempLedger(t);
  const good = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}';
  const damaged = [
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qt',
    'not json',
    '[]',
    'null',
    '5',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":"5"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":-5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":1.5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"sideways","qty":5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"Widget","type":"in","qty":5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"","type":"in","qty":5}',
    '{"at":"yesterday-ish","item":"widget","type":"in","qty":5}',
    '{"item":"widget","type":"in","qty":5}',
  ];
  for (const line of damaged) {
    fs.writeFileSync(file, `${good}\n${line}\n${good}\n`);
    assert.throws(() => readMovements(file), (err) => refuses('DAMAGED_LEDGER')(err) && err.message.includes('line 2'), line);
    assert.throws(() => recordMovement(file, { item: 'widget', type: 'in', qty: 1 }), refuses('DAMAGED_LEDGER'), line);
    assert.equal(fs.readFileSync(file, 'utf8'), `${good}\n${line}\n${good}\n`, 'a damaged ledger must not be written to');
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
});

test('blank lines, Windows line ends, a byte-order mark and extra fields are read without loss', () => {
  const text = '﻿{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5,"note":"kept"}\r\n\r\n   \n{"at":"2026-01-02T00:00:00.000Z","item":"widget","type":"out","qty":2}';
  const movements = parseLedgerText(text);
  assert.equal(movements.length, 2);
  assert.equal(movements[0].note, 'kept');
  assert.equal(quantityOf(movements, 'widget'), 3);
});

test('a file without a final line break is not glued to the next movement', (t) => {
  const file = tempLedger(t);
  fs.writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}');
  recordMovement(file, { item: 'widget', type: 'in', qty: 1 });
  assert.equal(readMovements(file).length, 2);
  assert.equal(quantityOf(readMovements(file), 'widget'), 6);
});

test('a ledger that stays locked is refused with a message naming the lock file', (t) => {
  const file = tempLedger(t);
  fs.writeFileSync(`${file}.lock`, '');
  assert.throws(
    () => recordMovement(file, { item: 'widget', type: 'in', qty: 1 }),
    (err) => refuses('LOCKED')(err) && err.message.includes(`${file}.lock`),
  );
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(`${file}.lock`), true, 'a lock held by someone else must not be removed');
});

test('a ledger path that cannot be used is refused, not crashed on', (t) => {
  const file = tempLedger(t);
  const missingFolder = path.join(path.dirname(file), 'no-such-folder', 'ledger.jsonl');
  assert.throws(() => recordMovement(missingFolder, { item: 'widget', type: 'in', qty: 1 }), refuses('FILE_ERROR'));
  assert.throws(() => readMovements(path.dirname(file)), refuses('FILE_ERROR'));
});
