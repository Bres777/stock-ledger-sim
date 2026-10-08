import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LedgerError } from '../src/ledger.js';
import { centsToText, itemsFileFor, parseItemsText, parseLevel, parsePrice, priceToCents, readSettings, recordSetting, settingsFrom } from '../src/items.js';

function tempItems(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-items-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'ledger.jsonl.items.jsonl');
}

const refuses = (code) => (err) => err instanceof LedgerError && err.code === code;

test('the items file is the ledger file with .items.jsonl added', () => {
  assert.equal(itemsFileFor('stock-ledger.jsonl'), 'stock-ledger.jsonl.items.jsonl');
  assert.equal(itemsFileFor(path.join('a', 'b.txt')), `${path.join('a', 'b.txt')}.items.jsonl`);
});

test('an items file that does not exist yet has no settings and is not created by reading', (t) => {
  const file = tempItems(t);
  assert.deepEqual([...readSettings(file)], []);
  assert.equal(fs.existsSync(file), false);
});

test('each setting appends exactly one line and leaves earlier lines untouched', (t) => {
  const file = tempItems(t);
  const first = recordSetting(file, { item: ' Widget ', set: 'level', value: '5', at: new Date('2026-01-02T03:04:05.000Z') });
  assert.deepEqual(first, { at: '2026-01-02T03:04:05.000Z', item: 'widget', set: 'level', value: 5 });
  const afterFirst = fs.readFileSync(file, 'utf8');
  assert.equal(afterFirst, '{"at":"2026-01-02T03:04:05.000Z","item":"widget","set":"level","value":5}\n');

  recordSetting(file, { item: 'widget', set: 'price', value: '12.5', at: new Date('2026-01-03T00:00:00.000Z') });
  assert.equal(fs.readFileSync(file, 'utf8'), `${afterFirst}{"at":"2026-01-03T00:00:00.000Z","item":"widget","set":"price","value":"12.50"}\n`);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock file must be gone after a write');
});

test('the last level and the last price of an item win, each on its own', (t) => {
  const file = tempItems(t);
  recordSetting(file, { item: 'widget', set: 'level', value: 5 });
  recordSetting(file, { item: 'widget', set: 'price', value: '1' });
  recordSetting(file, { item: 'bolt', set: 'price', value: '0.25' });
  recordSetting(file, { item: 'WIDGET', set: 'level', value: 8 });
  recordSetting(file, { item: 'widget', set: 'price', value: '2.05' });
  recordSetting(file, { item: 'nut', set: 'level', value: 0 });

  assert.deepEqual([...readSettings(file)], [
    ['widget', { level: 8, price: '2.05' }],
    ['bolt', { level: undefined, price: '0.25' }],
    ['nut', { level: 0, price: undefined }],
  ]);
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 6, 'nothing is rewritten: six settings, six lines');
});

test('parseLevel accepts whole numbers of 0 or more, as number or digits', () => {
  assert.equal(parseLevel(0), 0);
  assert.equal(parseLevel('0'), 0);
  assert.equal(parseLevel('12'), 12);
  assert.equal(parseLevel('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const bad of [-1, 1.5, NaN, Infinity, 2 ** 53, '-1', '1.5', '1e3', '0x10', '+5', ' 5', '5 ', '05', '00', '', 'five', '9007199254740992', null, undefined, true, [5], {}]) {
    assert.throws(() => parseLevel(bad), refuses('BAD_LEVEL'), `level ${String(bad)}`);
  }
});

test('parsePrice accepts digits with at most two decimals and returns two decimals', () => {
  assert.equal(parsePrice('0'), '0.00');
  assert.equal(parsePrice('12'), '12.00');
  assert.equal(parsePrice('12.5'), '12.50');
  assert.equal(parsePrice('12.05'), '12.05');
  assert.equal(parsePrice('0.01'), '0.01');
  assert.equal(parsePrice('90071992547409.91'), '90071992547409.91');
  for (const bad of ['-1', '+1', '1.234', '1.', '.5', '1,50', '1 000', '1e3', '0x10', '£5', '$5', '5p', '05', '00.50', ' 5', '5 ', '', 'free', '٥', '90071992547409.92', '1'.repeat(400), 12.5, 12, 0, null, undefined, true, ['1'], {}]) {
    assert.throws(() => parsePrice(bad), refuses('BAD_PRICE'), `price ${String(bad)}`);
  }
});

test('amounts convert to hundredths and back exactly', () => {
  assert.equal(priceToCents('12.50'), 1250n);
  assert.equal(priceToCents('0.07'), 7n);
  assert.equal(centsToText(0n), '0.00');
  assert.equal(centsToText(7n), '0.07');
  assert.equal(centsToText(1250n), '12.50');
  assert.equal(centsToText(123456789012345678901234567890n), '1234567890123456789012345678.90');
});

test('bad input is refused and writes nothing', (t) => {
  const file = tempItems(t);
  recordSetting(file, { item: 'widget', set: 'level', value: 5 });
  const before = fs.readFileSync(file, 'utf8');

  for (const item of ['', '   ', 'a\tb', 'a\nb', 5, null, undefined]) {
    assert.throws(() => recordSetting(file, { item, set: 'level', value: 1 }), refuses('BAD_ITEM'), `item ${String(item)}`);
  }
  for (const set of ['Level', 'cost', '', undefined, null, '__proto__']) {
    assert.throws(() => recordSetting(file, { item: 'widget', set, value: 1 }), refuses('BAD_SETTING'), `set ${String(set)}`);
  }
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'level', value: '1.5' }), refuses('BAD_LEVEL'));
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'level', value: '12.50' }), refuses('BAD_LEVEL'));
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'price', value: 12.5 }), refuses('BAD_PRICE'));
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'price', value: '-1' }), refuses('BAD_PRICE'));
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'level', value: 1, at: new Date('nonsense') }), refuses('BAD_TIME'));

  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a damaged line stops the read and names the line; it is never skipped', (t) => {
  const file = tempItems(t);
  const good = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":5}';
  const damaged = [
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"lev',
    'not json',
    '[]',
    'null',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":"5"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":-1}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":1.5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"price","value":12.5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"price","value":"12.5"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"price","value":"-1.00"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"colour","value":"red"}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","value":5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"Widget","set":"level","value":5}',
    '{"at":"yesterday-ish","item":"widget","set":"level","value":5}',
    '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}',
  ];
  for (const line of damaged) {
    fs.writeFileSync(file, `${good}\n${line}\n${good}\n`);
    assert.throws(() => readSettings(file), (err) => refuses('DAMAGED_ITEMS')(err) && err.message.includes('line 2'), line);
    assert.throws(() => recordSetting(file, { item: 'widget', set: 'level', value: 1 }), refuses('DAMAGED_ITEMS'), line);
    assert.equal(fs.readFileSync(file, 'utf8'), `${good}\n${line}\n${good}\n`, 'a damaged items file must not be written to');
    assert.equal(fs.existsSync(`${file}.lock`), false);
  }
});

test('blank lines, Windows line ends, a byte-order mark and extra fields are read without loss', () => {
  const text = '﻿{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":5,"note":"kept"}\r\n\r\n   \n{"at":"2026-01-02T00:00:00.000Z","item":"widget","set":"price","value":"3.00"}';
  const records = parseItemsText(text);
  assert.equal(records.length, 2);
  assert.equal(records[0].note, 'kept');
  assert.deepEqual([...settingsFrom(records)], [['widget', { level: 5, price: '3.00' }]]);
});

test('an item named like a built-in property is an ordinary item', () => {
  const records = parseItemsText('{"at":"2026-01-01T00:00:00.000Z","item":"__proto__","set":"level","value":5}\n{"at":"2026-01-01T00:00:00.000Z","item":"constructor","set":"price","value":"1.00"}');
  assert.deepEqual([...settingsFrom(records)], [['__proto__', { level: 5, price: undefined }], ['constructor', { level: undefined, price: '1.00' }]]);
});

test('a file without a final line break is not glued to the next setting', (t) => {
  const file = tempItems(t);
  fs.writeFileSync(file, '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":5}');
  recordSetting(file, { item: 'widget', set: 'price', value: '1' });
  assert.deepEqual([...readSettings(file)], [['widget', { level: 5, price: '1.00' }]]);
});

test('an items path that cannot be used is refused, not crashed on', (t) => {
  const file = tempItems(t);
  const missingFolder = path.join(path.dirname(file), 'no-such-folder', 'x.items.jsonl');
  assert.throws(() => recordSetting(missingFolder, { item: 'widget', set: 'level', value: 1 }), refuses('FILE_ERROR'));
  assert.throws(() => readSettings(path.dirname(file)), refuses('FILE_ERROR'));
});
