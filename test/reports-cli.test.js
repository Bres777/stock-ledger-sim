// Stage 2 commands through the real entry point, started as a separate process.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../bin/stock-ledger.js', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-reports-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(cwd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!('STOCK_LEDGER_FILE' in extraEnv)) delete env.STOCK_LEDGER_FILE;
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('level, price, low and value work end to end', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '10']);
  cli(dir, ['out', 'widget', '7']);
  cli(dir, ['in', 'bolt', '100']);
  assert.deepEqual(cli(dir, ['level', 'Widget', '5']), { code: 0, out: 're-order level of widget set to 5\n', err: '' });
  assert.deepEqual(cli(dir, ['level', 'bolt', '100']), { code: 0, out: 're-order level of bolt set to 100\n', err: '' });
  assert.deepEqual(cli(dir, ['price', 'widget', '12.5']), { code: 0, out: 'price of widget set to 12.50\n', err: '' });
  assert.deepEqual(cli(dir, ['price', 'bolt', '0.25']), { code: 0, out: 'price of bolt set to 0.25\n', err: '' });

  assert.deepEqual(cli(dir, ['low']), { code: 0, out: 'widget: 3 (re-order level 5)\n1 item below its re-order level\n', err: '' });
  assert.deepEqual(cli(dir, ['value']), { code: 0, out: 'bolt: 100 x 0.25 = 25.00\nwidget: 3 x 12.50 = 37.50\ntotal: 62.50\n', err: '' });

  cli(dir, ['out', 'bolt', '1']);
  assert.deepEqual(cli(dir, ['low']), { code: 0, out: 'bolt: 99 (re-order level 100)\nwidget: 3 (re-order level 5)\n2 items below their re-order level\n', err: '' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['stock-ledger.jsonl', 'stock-ledger.jsonl.items.jsonl']);
});

test('the reports on an empty folder say so, exit 0 and create no file', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(cli(dir, ['low']), { code: 0, out: 'no items below their re-order level (no re-order levels are set)\n', err: '' });
  assert.deepEqual(cli(dir, ['value']), { code: 0, out: 'total: 0.00\n', err: '' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('low says when levels are set and nothing is below them', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '5']);
  cli(dir, ['level', 'widget', '5']);
  assert.deepEqual(cli(dir, ['low']), { code: 0, out: 'no items below their re-order level\n', err: '' });
});

test('value names an item with no price on the total line and on stderr, and leaves it out of the total', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '2']);
  cli(dir, ['in', 'gadget', '4']);
  cli(dir, ['price', 'widget', '1']);
  assert.deepEqual(cli(dir, ['value']), {
    code: 0,
    out: 'widget: 2 x 1.00 = 2.00\ngadget: 4 x (no price) = not counted\ntotal: 2.00 (excludes 1 item with no price)\n',
    err: 'stock-ledger: the total excludes 1 item with no price\n',
  });
  cli(dir, ['in', 'gizmo', '1']);
  const two = cli(dir, ['value']);
  assert.match(two.out, /^total: 2\.00 \(excludes 2 items with no price\)$/m);
  assert.equal(two.err, 'stock-ledger: the total excludes 2 items with no price\n');
});

test('levels and prices follow the ledger file chosen by --file and STOCK_LEDGER_FILE', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '1', '--file', 'a.jsonl']);
  cli(dir, ['price', 'widget', '3', '--file', 'a.jsonl']);
  cli(dir, ['in', 'widget', '1'], { STOCK_LEDGER_FILE: 'b.jsonl' });
  cli(dir, ['price', 'widget', '7'], { STOCK_LEDGER_FILE: 'b.jsonl' });
  assert.equal(cli(dir, ['value', '--file', 'a.jsonl']).out, 'widget: 1 x 3.00 = 3.00\ntotal: 3.00\n');
  assert.equal(cli(dir, ['value'], { STOCK_LEDGER_FILE: 'b.jsonl' }).out, 'widget: 1 x 7.00 = 7.00\ntotal: 7.00\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.jsonl', 'a.jsonl.items.jsonl', 'b.jsonl', 'b.jsonl.items.jsonl']);
});

test('a refused level or price exits 1, explains on stderr and writes nothing', (t) => {
  const dir = tempDir(t);
  cli(dir, ['level', 'widget', '5']);
  const before = fs.readFileSync(path.join(dir, 'stock-ledger.jsonl.items.jsonl'), 'utf8');
  for (const [args, pattern] of [
    [['level', 'widget', '-1'], /re-order level must be a whole number/],
    [['level', 'widget', '1.5'], /re-order level must be a whole number/],
    [['level', 'widget', 'five'], /re-order level must be a whole number/],
    [['price', 'widget', '-1'], /price must be an amount/],
    [['price', 'widget', '1.234'], /price must be an amount/],
    [['price', 'widget', '1,50'], /price must be an amount/],
    [['price', 'widget', '£5'], /price must be an amount/],
    [['price', '  ', '5'], /item must not be empty/],
  ]) {
    const result = cli(dir, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, pattern);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'stock-ledger.jsonl.items.jsonl'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['stock-ledger.jsonl.items.jsonl']);
});

test('a stage 2 command that is not understood exits 2, shows the usage and writes nothing', (t) => {
  const dir = tempDir(t);
  for (const args of [['level'], ['level', 'widget'], ['level', 'widget', '5', 'extra'], ['price'], ['price', 'widget'], ['price', 'widget', '1', '2'], ['low', 'widget'], ['value', 'widget'], ['report']]) {
    const result = cli(dir, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, /Usage:/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('--help lists the stage 2 commands', (t) => {
  const result = cli(tempDir(t), ['--help']);
  assert.equal(result.code, 0);
  for (const word of ['level <item> <number>', 'price <item> <amount>', 'stock-ledger low', 'stock-ledger value', '.items.jsonl']) {
    assert.ok(result.out.includes(word), word);
  }
});

test('a damaged items file stops level, price, low and value, but not in, out and qty', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '5']);
  cli(dir, ['price', 'widget', '2']);
  const items = path.join(dir, 'stock-ledger.jsonl.items.jsonl');
  fs.appendFileSync(items, '{"at":"2026-01-01T00:00:00.000Z","item":"widg');
  const damaged = fs.readFileSync(items, 'utf8');

  for (const args of [['low'], ['value'], ['level', 'widget', '1'], ['price', 'widget', '1']]) {
    const result = cli(dir, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, /items\.jsonl line 2 is not valid JSON/);
  }
  assert.equal(fs.readFileSync(items, 'utf8'), damaged);
  assert.equal(cli(dir, ['in', 'widget', '1']).out, 'recorded in 1 widget; quantity now 6\n');
  assert.equal(cli(dir, ['out', 'widget', '2']).out, 'recorded out 2 widget; quantity now 4\n');
  assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 4\n');
});

test('a damaged ledger stops low and value with exit 1 and the line number', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '5']);
  cli(dir, ['level', 'widget', '9']);
  fs.appendFileSync(path.join(dir, 'stock-ledger.jsonl'), 'not a movement\n');
  for (const args of [['low'], ['value']]) {
    const result = cli(dir, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, /stock-ledger\.jsonl line 2 is not valid JSON/);
  }
});

test('a ledger edited by hand to go below zero: value is refused, low shows the quantity as it is', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'stock-ledger.jsonl'), '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"out","qty":5}\n');
  cli(dir, ['level', 'widget', '1']);
  cli(dir, ['price', 'widget', '2']);
  const value = cli(dir, ['value']);
  assert.equal(value.code, 1);
  assert.equal(value.out, '');
  assert.match(value.err, /shows -5 of "widget", which is below zero/);
  assert.equal(cli(dir, ['low']).out, 'widget: -5 (re-order level 1)\n1 item below its re-order level\n');
});
