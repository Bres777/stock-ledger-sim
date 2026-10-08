import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LedgerError, quantities } from '../src/ledger.js';
import { lowStock, stockValue } from '../src/reports.js';

const at = '2026-01-01T00:00:00.000Z';
const move = (item, type, qty) => ({ at, item, type, qty });
const settings = (entries) => new Map(Object.entries(entries).map(([item, s]) => [item, { level: undefined, price: undefined, ...s }]));

test('low stock: strictly below the level is listed, exactly at the level is not', () => {
  const stock = quantities([move('under', 'in', 4), move('exact', 'in', 5), move('over', 'in', 6)]);
  const low = lowStock(stock, settings({ under: { level: 5 }, exact: { level: 5 }, over: { level: 5 } }));
  assert.deepEqual(low, [{ item: 'under', quantity: 4, level: 5 }]);
});

test('low stock: no level set means left out; level 0 can never be below', () => {
  const stock = quantities([move('no-level', 'in', 1), move('priced-only', 'in', 1), move('zero-level', 'in', 1), move('zero-level', 'out', 1)]);
  assert.deepEqual(lowStock(stock, settings({ 'priced-only': { price: '1.00' }, 'zero-level': { level: 0 } })), []);
});

test('low stock: an item with a level and no movements has quantity 0 and is listed', () => {
  assert.deepEqual(lowStock(quantities([]), settings({ 'never-seen': { level: 3 } })), [{ item: 'never-seen', quantity: 0, level: 3 }]);
});

test('low stock: the quantity is the current one, after goods out; the list is sorted by item', () => {
  const stock = quantities([move('widget', 'in', 10), move('bolt', 'in', 2), move('widget', 'out', 8), move('anvil', 'in', 1)]);
  const low = lowStock(stock, settings({ widget: { level: 5 }, bolt: { level: 3 }, anvil: { level: 2 } }));
  assert.deepEqual(low, [
    { item: 'anvil', quantity: 1, level: 2 },
    { item: 'bolt', quantity: 2, level: 3 },
    { item: 'widget', quantity: 2, level: 5 },
  ]);
});

test('value: quantity x unit price per item, and the total', () => {
  const stock = quantities([move('widget', 'in', 10), move('widget', 'out', 3), move('bolt', 'in', 100)]);
  assert.deepEqual(stockValue(stock, settings({ widget: { price: '12.50' }, bolt: { price: '0.25' } })), {
    lines: [
      { item: 'bolt', quantity: 100, price: '0.25', value: '25.00' },
      { item: 'widget', quantity: 7, price: '12.50', value: '87.50' },
    ],
    total: '112.50',
    unpriced: [],
  });
});

test('value: an item in stock with no price is listed as unpriced and is not in the total', () => {
  const stock = quantities([move('widget', 'in', 2), move('gadget', 'in', 4), move('gizmo', 'in', 1)]);
  assert.deepEqual(stockValue(stock, settings({ widget: { price: '1.00' }, gizmo: { level: 9 } })), {
    lines: [{ item: 'widget', quantity: 2, price: '1.00', value: '2.00' }],
    total: '2.00',
    unpriced: [{ item: 'gadget', quantity: 4 }, { item: 'gizmo', quantity: 1 }],
  });
});

test('value: items with nothing in stock appear nowhere, priced or not; a price of 0 is a price', () => {
  const stock = quantities([move('gone', 'in', 5), move('gone', 'out', 5), move('gone-unpriced', 'in', 1), move('gone-unpriced', 'out', 1), move('free', 'in', 3)]);
  assert.deepEqual(stockValue(stock, settings({ gone: { price: '9.99' }, free: { price: '0.00' }, 'never-stocked': { price: '5.00' } })), {
    lines: [{ item: 'free', quantity: 3, price: '0.00', value: '0.00' }],
    total: '0.00',
    unpriced: [],
  });
  assert.deepEqual(stockValue(quantities([]), new Map()), { lines: [], total: '0.00', unpriced: [] });
});

test('value: exact to the hundredth where floating point is not', () => {
  // 0.1 + 0.2 !== 0.3 and 3 * 1.1 !== 3.3 in floating point.
  const stock = quantities([move('a', 'in', 1), move('b', 'in', 1), move('c', 'in', 3), move('d', 'in', 1000000)]);
  const { lines, total } = stockValue(stock, settings({ a: { price: '0.10' }, b: { price: '0.20' }, c: { price: '1.10' }, d: { price: '0.07' } }));
  assert.deepEqual(lines.map((l) => l.value), ['0.10', '0.20', '3.30', '70000.00']);
  assert.equal(total, '70003.60');
});

test('value: exact beyond what a JavaScript number can count', () => {
  const stock = quantities([move('big', 'in', Number.MAX_SAFE_INTEGER), move('big2', 'in', Number.MAX_SAFE_INTEGER)]);
  const { lines, total } = stockValue(stock, settings({ big: { price: '90071992547409.91' }, big2: { price: '0.01' } }));
  // (2^53 - 1)^2 = 2^106 - 2^54 + 1 = 81129638414606663681390495662081 hundredths.
  assert.equal(lines[0].value, '811296384146066636813904956620.81');
  assert.equal(lines[1].value, '90071992547409.91');
  assert.equal(total, '811296384146066726885897504030.72');
});

test('value: a ledger edited by hand to go below zero is refused, not valued', () => {
  const stock = quantities([move('widget', 'out', 5)]);
  assert.throws(() => stockValue(stock, settings({ widget: { price: '1.00' } })), (err) => err instanceof LedgerError && err.code === 'NEGATIVE_STOCK' && err.message.includes('widget'));
  assert.throws(() => stockValue(stock, new Map()), (err) => err.code === 'NEGATIVE_STOCK', 'refused even when the item has no price');
  assert.deepEqual(lowStock(stock, settings({ widget: { level: 1 } })), [{ item: 'widget', quantity: -5, level: 1 }], 'the low report shows it as it is');
});
