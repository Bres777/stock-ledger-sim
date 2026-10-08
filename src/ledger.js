// The ledger: an append-only file of stock movements, one JSON object per line.
// A quantity is never stored. It is always worked out from the movements.

import fs from 'node:fs';

export const DEFAULT_LEDGER_FILE = 'stock-ledger.jsonl';
export const MOVEMENT_TYPES = Object.freeze(['in', 'out']);

const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 20;

// Every refusal this module makes on purpose is a LedgerError with a code.
// Anything else that escapes is a bug.
export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

// Item names are trimmed and lower-cased, so "Widget" and " widget " are one item.
export function normalizeItem(raw) {
  if (typeof raw !== 'string') {
    throw new LedgerError('BAD_ITEM', 'item must be text');
  }
  const item = raw.trim().toLowerCase();
  if (item === '') {
    throw new LedgerError('BAD_ITEM', 'item must not be empty');
  }
  if (/[\u0000-\u001f\u007f]/.test(item)) {
    throw new LedgerError('BAD_ITEM', 'item must not contain control characters');
  }
  return item;
}

// A quantity is a whole number of 1 or more. Text is accepted only as plain digits:
// no sign, no decimal point, no exponent, no leading zero, no spaces.
export function parseQuantity(raw) {
  let qty = raw;
  if (typeof raw === 'string') {
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new LedgerError('BAD_QUANTITY', `quantity must be a whole number of 1 or more, written in digits only (got "${raw}")`);
    }
    qty = Number(raw);
  }
  if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty < 1) {
    throw new LedgerError('BAD_QUANTITY', `quantity must be a whole number between 1 and ${Number.MAX_SAFE_INTEGER} (got "${raw}")`);
  }
  return qty;
}

function checkType(type) {
  if (!MOVEMENT_TYPES.includes(type)) {
    throw new LedgerError('BAD_TYPE', `movement type must be "in" or "out" (got "${type}")`);
  }
  return type;
}

function fileError(file, err) {
  return new LedgerError('FILE_ERROR', `cannot use ledger file ${file}: ${err.message}`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw fileError(file, err);
  }
}

// Turns the text of a ledger file into movements. A line that is not a valid movement
// stops everything with its line number: it is never skipped, because skipping it would
// give a wrong quantity with no warning. Lines holding only spaces carry nothing and are passed over.
export function parseLedgerText(text, file = 'ledger') {
  const movements = [];
  const lines = text.replace(/^﻿/, '').split('\n');
  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;
    const where = `${file} line ${index + 1}`;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new LedgerError('DAMAGED_LEDGER', `${where} is not valid JSON. Nothing was read or written. Repair or remove that line by hand.`);
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new LedgerError('DAMAGED_LEDGER', `${where} is not a movement record. Nothing was read or written.`);
    }
    try {
      if (normalizeItem(record.item) !== record.item) {
        throw new LedgerError('BAD_ITEM', 'item is not in its stored form (trimmed, lower case)');
      }
      checkType(record.type);
      if (typeof record.qty !== 'number') {
        throw new LedgerError('BAD_QUANTITY', 'qty must be a number');
      }
      parseQuantity(record.qty);
      if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) {
        throw new LedgerError('BAD_TIME', 'at must be a date and time in text');
      }
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      throw new LedgerError('DAMAGED_LEDGER', `${where} is not a valid movement: ${err.message}. Nothing was read or written.`);
    }
    movements.push(record);
  });
  return movements;
}

// All movements in the file, oldest first. A file that does not exist yet is an empty ledger.
export function readMovements(file) {
  return parseLedgerText(readText(file), file);
}

// Current quantity of every item that has at least one movement: Map of item -> quantity.
export function quantities(movements) {
  const totals = new Map();
  for (const { item, type, qty } of movements) {
    const next = (totals.get(item) ?? 0) + (type === 'in' ? qty : -qty);
    if (!Number.isSafeInteger(next)) {
      throw new LedgerError('QUANTITY_TOO_LARGE', `the quantity of "${item}" is beyond what can be counted exactly`);
    }
    totals.set(item, next);
  }
  return totals;
}

// Current quantity of one item. An item with no movements has quantity 0.
export function quantityOf(movements, rawItem) {
  return quantities(movements).get(normalizeItem(rawItem)) ?? 0;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// One writer at a time: the check "is there enough stock" and the write that follows
// must not be interleaved with another process doing the same.
// Exported for src/items.js, which guards its own file the same way.
export function withLock(file, action) {
  const lockFile = `${file}.lock`;
  const giveUpAt = Date.now() + LOCK_WAIT_MS;
  let handle;
  for (;;) {
    try {
      handle = fs.openSync(lockFile, 'wx');
      break;
    } catch (err) {
      // EPERM/EBUSY: on Windows, the moment another process is deleting its lock.
      if (!['EEXIST', 'EPERM', 'EBUSY'].includes(err.code)) throw fileError(file, err);
      if (Date.now() >= giveUpAt) {
        throw new LedgerError('LOCKED', `the ledger is locked by ${lockFile} and stayed locked for ${LOCK_WAIT_MS / 1000} seconds. Nothing was written. If no stock-ledger command is running, delete that file and try again.`);
      }
      sleep(LOCK_RETRY_MS);
    }
  }
  try {
    return action();
  } finally {
    fs.closeSync(handle);
    fs.unlinkSync(lockFile);
  }
}

// Records one movement and returns { movement, quantity } where quantity is the item's
// quantity after it. Either the whole line is appended or nothing is written.
export function recordMovement(file, { item: rawItem, type: rawType, qty: rawQty, at = new Date() }) {
  const item = normalizeItem(rawItem);
  const type = checkType(rawType);
  const qty = parseQuantity(rawQty);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new LedgerError('BAD_TIME', 'at must be a valid Date');
  }
  const movement = { at: at.toISOString(), item, type, qty };

  return withLock(file, () => {
    const text = readText(file);
    const current = quantities(parseLedgerText(text, file)).get(item) ?? 0;
    if (type === 'out' && qty > current) {
      throw new LedgerError('INSUFFICIENT_STOCK', `cannot take ${qty} of "${item}" out: only ${current} in stock. Nothing was written.`);
    }
    const quantity = type === 'in' ? current + qty : current - qty;
    if (!Number.isSafeInteger(quantity)) {
      throw new LedgerError('QUANTITY_TOO_LARGE', `adding ${qty} to "${item}" would go beyond what can be counted exactly. Nothing was written.`);
    }
    // A file edited by hand may lack its final line break; never glue two records together.
    const lineBreakFirst = text !== '' && !text.endsWith('\n') ? '\n' : '';
    try {
      fs.appendFileSync(file, `${lineBreakFirst}${JSON.stringify(movement)}\n`);
    } catch (err) {
      throw fileError(file, err);
    }
    return { movement, quantity };
  });
}

// Records many movements in one go, in the order given, and returns one result per entry, in
// the same order: { movement, quantity } for an entry that was recorded, { error } (a
// LedgerError) for one that was not. An entry that cannot be recorded never stops the others.
// Every entry is checked against the stock as it stands after the entries before it, so an
// "out" may use goods that an earlier entry of the same call brought in.
// One lock and one write for the whole call: no other writer can land between two entries,
// and the ledger is read once, not once per entry. All recorded movements carry the same `at`.
// A damaged or locked ledger is still a refusal of the whole call (it throws, nothing written).
export function recordMovements(file, entries, { at = new Date() } = {}) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new LedgerError('BAD_TIME', 'at must be a valid Date');
  }
  const stamp = at.toISOString();
  const results = entries.map((entry) => {
    try {
      return { movement: { at: stamp, item: normalizeItem(entry?.item), type: checkType(entry?.type), qty: parseQuantity(entry?.qty) } };
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      return { error: err };
    }
  });
  if (results.every((result) => result.error)) return results;   // nothing to write: the ledger is not touched

  return withLock(file, () => {
    const text = readText(file);
    const totals = quantities(parseLedgerText(text, file));
    const lines = [];
    results.forEach((result, index) => {
      if (result.error) return;
      const { item, type, qty } = result.movement;
      const current = totals.get(item) ?? 0;
      if (type === 'out' && qty > current) {
        results[index] = { error: new LedgerError('INSUFFICIENT_STOCK', `cannot take ${qty} of "${item}" out: only ${current} in stock at that point`) };
        return;
      }
      const quantity = type === 'in' ? current + qty : current - qty;
      if (!Number.isSafeInteger(quantity)) {
        results[index] = { error: new LedgerError('QUANTITY_TOO_LARGE', `adding ${qty} to "${item}" would go beyond what can be counted exactly`) };
        return;
      }
      totals.set(item, quantity);
      result.quantity = quantity;
      lines.push(`${JSON.stringify(result.movement)}\n`);
    });
    if (lines.length > 0) {
      const lineBreakFirst = text !== '' && !text.endsWith('\n') ? '\n' : '';
      try {
        fs.appendFileSync(file, `${lineBreakFirst}${lines.join('')}`);
      } catch (err) {
        throw fileError(file, err);
      }
    }
    return results;
  });
}
