// These tests start the real entry point as a separate process, the way a person would.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../bin/stock-ledger.js', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(cwd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!('STOCK_LEDGER_FILE' in extraEnv)) delete env.STOCK_LEDGER_FILE;
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test('in, out and qty work end to end and keep the ledger in the current folder', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(cli(dir, ['in', 'widget', '10']), { code: 0, out: 'recorded in 10 widget; quantity now 10\n', err: '' });
  assert.deepEqual(cli(dir, ['out', 'Widget', '3']), { code: 0, out: 'recorded out 3 widget; quantity now 7\n', err: '' });
  assert.deepEqual(cli(dir, ['qty', 'widget']), { code: 0, out: 'widget: 7\n', err: '' });
  assert.deepEqual(cli(dir, ['qty', 'never-seen']), { code: 0, out: 'never-seen: 0\n', err: '' });

  const lines = fs.readFileSync(path.join(dir, 'stock-ledger.jsonl'), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ item, type, qty }) => ({ item, type, qty })), [
    { item: 'widget', type: 'in', qty: 10 },
    { item: 'widget', type: 'out', qty: 3 },
  ]);
  assert.deepEqual(fs.readdirSync(dir), ['stock-ledger.jsonl']);
});

test('the ledger file is --file, else STOCK_LEDGER_FILE, else the default', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '1']);
  cli(dir, ['in', 'widget', '2'], { STOCK_LEDGER_FILE: 'from-env.jsonl' });
  cli(dir, ['in', 'widget', '4', '--file', 'from-option.jsonl'], { STOCK_LEDGER_FILE: 'from-env.jsonl' });
  cli(dir, ['--file=from-option.jsonl', 'in', 'widget', '8']);

  assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 1\n');
  assert.equal(cli(dir, ['qty', 'widget'], { STOCK_LEDGER_FILE: 'from-env.jsonl' }).out, 'widget: 2\n');
  assert.equal(cli(dir, ['qty', 'widget', '--file', path.join(dir, 'from-option.jsonl')]).out, 'widget: 12\n');
});

test('a refusal by the ledger exits 1, explains on stderr and writes nothing', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '5']);
  const before = fs.readFileSync(path.join(dir, 'stock-ledger.jsonl'), 'utf8');

  const tooMany = cli(dir, ['out', 'widget', '6']);
  assert.equal(tooMany.code, 1);
  assert.equal(tooMany.out, '');
  assert.match(tooMany.err, /cannot take 6 of "widget" out: only 5 in stock/);

  for (const qty of ['0', '-5', '1.5', 'five', '1e3']) {
    const result = cli(dir, ['in', 'widget', qty]);
    assert.equal(result.code, 1, `quantity ${qty}`);
    assert.equal(result.out, '');
    assert.match(result.err, /quantity must be a whole number/);
  }
  assert.equal(cli(dir, ['in', '  ', '5']).code, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'stock-ledger.jsonl'), 'utf8'), before);
});

test('a damaged ledger stops qty with exit 1 and the line number', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '5']);
  fs.appendFileSync(path.join(dir, 'stock-ledger.jsonl'), '{"at":"2026-01-01T00:00:00.000Z","item":"widg');
  const result = cli(dir, ['qty', 'widget']);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /line 2 is not valid JSON/);
});

test('a command that is not understood exits 2, shows the usage and writes nothing', (t) => {
  const dir = tempDir(t);
  const cases = [[], ['bogus'], ['in'], ['in', 'widget'], ['in', 'widget', '5', 'extra'], ['qty'], ['qty', 'a', 'b'], ['in', 'widget', '5', '--nope'], ['qty', 'widget', '--file'], ['qty', 'widget', '--file=']];
  for (const args of cases) {
    const result = cli(dir, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, /Usage:/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('--help shows the usage and exits 0', (t) => {
  const dir = tempDir(t);
  const result = cli(dir, ['--help']);
  assert.equal(result.code, 0);
  assert.match(result.out, /Usage:/);
  assert.equal(result.err, '');
});

test('after --, a word starting with dashes is an item and not an option', (t) => {
  const dir = tempDir(t);
  assert.equal(cli(dir, ['in', '5', '--', '--odd']).code, 1, 'item "5", quantity "--odd" is a bad quantity');
  assert.equal(cli(dir, ['in', '--', '--odd', '5']).out, 'recorded in 5 --odd; quantity now 5\n');
  assert.equal(cli(dir, ['qty', '--', '--odd']).out, '--odd: 5\n');
});
