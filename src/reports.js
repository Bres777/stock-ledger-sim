// The reports. Pure functions: they take the quantities (from src/ledger.js) and the settings
// (from src/items.js) and touch no file.

import { LedgerError } from './ledger.js';
import { centsToText, priceToCents } from './items.js';

// Item names in one fixed order, the same on every machine (by code unit, not by locale).
const byItem = (a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0);

// Items below their re-order level: [{ item, quantity, level }], sorted by item.
// "Below" is strictly less than: an item exactly at its level is not listed.
// An item with no level set is left out. An item with a level and no movements has quantity 0.
export function lowStock(quantities, settings) {
  const low = [];
  for (const [item, { level }] of settings) {
    if (level === undefined) continue;
    const quantity = quantities.get(item) ?? 0;
    if (quantity < level) low.push({ item, quantity, level });
  }
  return low.sort(byItem);
}

// The value of the stock: current quantity x unit price, per item and in total.
// Returns { lines: [{ item, quantity, price, value }], total, unpriced: [{ item, quantity }] }.
// price, value and total are amount text ("12.50"), worked out in whole hundredths, exactly.
// An item in stock with no price is NOT counted as zero: it is listed in unpriced and the
// total does not include it. Items with quantity 0 appear nowhere.
export function stockValue(quantities, settings) {
  const lines = [];
  const unpriced = [];
  let total = 0n;
  for (const [item, quantity] of quantities) {
    if (quantity < 0) {
      throw new LedgerError('NEGATIVE_STOCK', `the ledger shows ${quantity} of "${item}", which is below zero, so the stock cannot be valued. The ledger was edited by hand; correct it first.`);
    }
    if (quantity === 0) continue;
    const price = settings.get(item)?.price;
    if (price === undefined) {
      unpriced.push({ item, quantity });
      continue;
    }
    const cents = BigInt(quantity) * priceToCents(price);
    total += cents;
    lines.push({ item, quantity, price, value: centsToText(cents) });
  }
  return { lines: lines.sort(byItem), total: centsToText(total), unpriced: unpriced.sort(byItem) };
}
