// Item settings: the re-order level and the unit price of an item. They live in their own
// append-only file beside the ledger, one JSON object per line. The last entry for an item wins.
// The ledger file holds movements only and is never touched from here.

import fs from 'node:fs';
import { LedgerError, normalizeItem, withLock } from './ledger.js';

export const ITEMS_FILE_SUFFIX = '.items.jsonl';
export const SETTINGS = Object.freeze(['level', 'price']);

// The items file that belongs to a ledger file: the same path with ".items.jsonl" added.
export function itemsFileFor(ledgerFile) {
  return `${ledgerFile}${ITEMS_FILE_SUFFIX}`;
}

// A re-order level is a whole number of 0 or more. Text is accepted only as plain digits.
// 0 means the item can never be below its level, which is how a level is switched off.
export function parseLevel(raw) {
  let level = raw;
  if (typeof raw === 'string') {
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new LedgerError('BAD_LEVEL', `re-order level must be a whole number of 0 or more, written in digits only (got "${raw}")`);
    }
    level = Number(raw);
  }
  if (typeof level !== 'number' || !Number.isSafeInteger(level) || level < 0) {
    throw new LedgerError('BAD_LEVEL', `re-order level must be a whole number between 0 and ${Number.MAX_SAFE_INTEGER} (got "${raw}")`);
  }
  return level;
}

// A price is text: digits, then optionally a point and one or two digits. No sign, no currency
// symbol, no thousands separator, no exponent. Returned in its stored form, always two decimals
// ("12.5" -> "12.50"). It is never held as a floating-point number.
export function parsePrice(raw) {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(raw)) {
    throw new LedgerError('BAD_PRICE', `price must be an amount of 0 or more with at most two decimal places, such as 12.50, written in digits only (got "${raw}")`);
  }
  const [whole, decimals = ''] = raw.split('.');
  const price = `${whole}.${decimals.padEnd(2, '0')}`;
  if (priceToCents(price) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LedgerError('BAD_PRICE', `price must be at most ${centsToText(BigInt(Number.MAX_SAFE_INTEGER))} (got "${raw}")`);
  }
  return price;
}

// A stored price ("12.50") as a whole number of hundredths, exactly.
export function priceToCents(price) {
  return BigInt(price.replace('.', ''));
}

// A whole number of hundredths as amount text: 1250n -> "12.50".
export function centsToText(cents) {
  const digits = cents.toString().padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

function fileError(file, err) {
  return new LedgerError('FILE_ERROR', `cannot use items file ${file}: ${err.message}`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw fileError(file, err);
  }
}

// Turns the text of an items file into setting records, oldest first. As with the ledger, a line
// that is not a valid record stops everything with its line number and is never skipped:
// skipping it could bring back an older level or price with no warning.
export function parseItemsText(text, file = 'items file') {
  const records = [];
  text.replace(/^﻿/, '').split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === '') return;
    const where = `${file} line ${index + 1}`;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new LedgerError('DAMAGED_ITEMS', `${where} is not valid JSON. Nothing was read or written. Repair or remove that line by hand.`);
    }
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new LedgerError('DAMAGED_ITEMS', `${where} is not a setting record. Nothing was read or written.`);
    }
    try {
      if (normalizeItem(record.item) !== record.item) {
        throw new LedgerError('BAD_ITEM', 'item is not in its stored form (trimmed, lower case)');
      }
      if (record.set === 'level') {
        if (typeof record.value !== 'number') throw new LedgerError('BAD_LEVEL', 'a level must be a number');
        parseLevel(record.value);
      } else if (record.set === 'price') {
        if (typeof record.value !== 'string' || parsePrice(record.value) !== record.value) {
          throw new LedgerError('BAD_PRICE', 'a price must be text with exactly two decimal places');
        }
      } else {
        throw new LedgerError('BAD_SETTING', `set must be "level" or "price" (got "${record.set}")`);
      }
      if (typeof record.at !== 'string' || Number.isNaN(Date.parse(record.at))) {
        throw new LedgerError('BAD_TIME', 'at must be a date and time in text');
      }
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      throw new LedgerError('DAMAGED_ITEMS', `${where} is not a valid setting: ${err.message}. Nothing was read or written.`);
    }
    records.push(record);
  });
  return records;
}

// The settings in force: Map of item -> { level, price }. Either may be undefined (never set).
// level is a number, price is text in its stored form. The last record for an item wins.
export function settingsFrom(records) {
  const settings = new Map();
  for (const { item, set, value } of records) {
    const current = settings.get(item) ?? { level: undefined, price: undefined };
    current[set] = value;
    settings.set(item, current);
  }
  return settings;
}

// The settings in force in an items file. A file that does not exist yet has no settings.
export function readSettings(file) {
  return settingsFrom(parseItemsText(readText(file), file));
}

// Records one setting and returns the stored record. The line is written with one append
// call. If the system refuses that append the file is left as it was; an append that fails
// part-way is not undone. The item does not need to have any movements yet.
export function recordSetting(file, { item: rawItem, set, value: rawValue, at = new Date() }) {
  const item = normalizeItem(rawItem);
  if (!SETTINGS.includes(set)) {
    throw new LedgerError('BAD_SETTING', `set must be "level" or "price" (got "${set}")`);
  }
  const value = set === 'level' ? parseLevel(rawValue) : parsePrice(rawValue);
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new LedgerError('BAD_TIME', 'at must be a valid Date');
  }
  const record = { at: at.toISOString(), item, set, value };

  return withLock(file, () => {
    const text = readText(file);
    parseItemsText(text, file);   // a damaged items file is not written to
    const lineBreakFirst = text !== '' && !text.endsWith('\n') ? '\n' : '';
    try {
      fs.appendFileSync(file, `${lineBreakFirst}${JSON.stringify(record)}\n`);
    } catch (err) {
      throw fileError(file, err);
    }
    return record;
  });
}
