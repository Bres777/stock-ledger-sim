// The stage 3 command through the real entry point, started as a separate process.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ENTRY = fileURLToPath(new URL('../bin/stock-ledger.js', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-import-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(cwd, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  if (!('STOCK_LEDGER_FILE' in extraEnv)) delete env.STOCK_LEDGER_FILE;
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const ledgerLines = (dir, name = 'stock-ledger.jsonl') => fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line)).map(({ item, type, qty }) => `${item} ${type} ${qty}`);

test('import records every row of a clean file, exits 0, and the other commands see the result', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,10\nwidget,out,3\nbolt,in,100\n');
  assert.deepEqual(cli(dir, ['import', 'moves.csv']), { code: 0, out: 'imported 3 movements from moves.csv\n', err: '' });
  assert.deepEqual(ledgerLines(dir), ['widget in 10', 'widget out 3', 'bolt in 100']);
  assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 7\n');
  cli(dir, ['price', 'bolt', '0.25']);
  assert.equal(cli(dir, ['value']).out, 'bolt: 100 x 0.25 = 25.00\nwidget: 7 x (no price) = not counted\ntotal: 25.00 (excludes 1 item with no price)\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'stock-ledger.jsonl', 'stock-ledger.jsonl.items.jsonl']);

  fs.writeFileSync(path.join(dir, 'one.csv'), 'item,type,quantity\nwidget,out,7\n');
  assert.deepEqual(cli(dir, ['import', 'one.csv']), { code: 0, out: 'imported 1 movement from one.csv\n', err: '' });
  assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 0\n');
});

test('import with bad rows records the good ones, names each bad one on stderr and exits 3', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '2']);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,10\nbolt,out,1\nwidget,in,x\nnut,in\ngadget,in,4\n');
  assert.deepEqual(cli(dir, ['import', 'moves.csv']), {
    code: 3,
    out: 'imported 2 movements from moves.csv; rejected 3 of 5 rows\n',
    err: 'stock-ledger: moves.csv line 3 rejected: cannot take 1 of "bolt" out: only 0 in stock at that point\n'
      + 'stock-ledger: moves.csv line 4 rejected: quantity must be a whole number of 1 or more, written in digits only (got "x")\n'
      + 'stock-ledger: moves.csv line 5 rejected: the row has 2 fields, the header has 3\n'
      + 'stock-ledger: 3 of 5 rows rejected and not in the ledger. The other 2 are recorded: do not import moves.csv again, correct the rejected rows and import only those.\n',
  });
  assert.deepEqual(ledgerLines(dir), ['widget in 2', 'widget in 10', 'gadget in 4']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'stock-ledger.jsonl']);
});

test('import where every row is bad records nothing, says so and exits 3', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,out,1\n');
  assert.deepEqual(cli(dir, ['import', 'moves.csv']), {
    code: 3,
    out: 'imported 0 movements from moves.csv; rejected 1 of 1 row\n',
    err: 'stock-ledger: moves.csv line 2 rejected: cannot take 1 of "widget" out: only 0 in stock at that point\n'
      + 'stock-ledger: 1 of 1 row rejected and not in the ledger. Nothing was recorded.\n',
  });
  assert.deepEqual(fs.readdirSync(dir), ['moves.csv']);

  fs.writeFileSync(path.join(dir, 'two.csv'), 'item,type,quantity\nwidget,in,1\nwidget,in,0\n');
  assert.match(cli(dir, ['import', 'two.csv']).err, /1 of 2 rows rejected and not in the ledger\. The other 1 is recorded: do not import two\.csv again/);
});

test('import of a file with a header and no rows says so and exits 0', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\n');
  assert.deepEqual(cli(dir, ['import', 'moves.csv']), { code: 0, out: 'imported 0 movements from moves.csv (the file has no rows)\n', err: '' });
  assert.deepEqual(fs.readdirSync(dir), ['moves.csv']);
});

test('--rejects writes the rejected rows to a new file that can be corrected and imported', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,10\nwidget,in,x\n"blue, widget",out,1\n');
  const first = cli(dir, ['import', 'moves.csv', '--rejects', 'rejects.csv']);
  assert.equal(first.code, 3);
  assert.equal(first.out, 'imported 1 movement from moves.csv; rejected 2 of 3 rows\n');
  assert.match(first.err, /^stock-ledger: the rejected rows were written to rejects\.csv$/m);
  assert.equal(fs.readFileSync(path.join(dir, 'rejects.csv'), 'utf8'), 'item,type,quantity\nwidget,in,x\n"blue, widget",out,1\n');

  fs.writeFileSync(path.join(dir, 'rejects.csv'), 'item,type,quantity\nwidget,in,5\n"blue, widget",in,1\n');
  assert.deepEqual(cli(dir, ['--rejects=again.csv', 'import', 'rejects.csv']), { code: 0, out: 'imported 2 movements from rejects.csv\n', err: '' });
  assert.equal(fs.existsSync(path.join(dir, 'again.csv')), false);
  assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 15\n');
  assert.equal(cli(dir, ['qty', 'blue, widget']).out, 'blue, widget: 1\n');
});

test('an import refused as a whole exits 1, explains on stderr and writes nothing', (t) => {
  const dir = tempDir(t);
  cli(dir, ['in', 'widget', '5']);
  const before = fs.readFileSync(path.join(dir, 'stock-ledger.jsonl'), 'utf8');
  fs.writeFileSync(path.join(dir, 'semicolons.csv'), 'item;type;quantity\nwidget;in;5\n');
  fs.writeFileSync(path.join(dir, 'no-header.csv'), 'widget,in,5\n');
  fs.writeFileSync(path.join(dir, 'empty.csv'), '');
  fs.writeFileSync(path.join(dir, 'good.csv'), 'item,type,quantity\nwidget,in,5\nwidget,in,x\n');
  fs.writeFileSync(path.join(dir, 'there.csv'), 'keep me');
  for (const [args, pattern] of [
    [['import', 'missing.csv'], /cannot use CSV file .*missing\.csv/],
    [['import', '.'], /cannot use CSV file/],
    [['import', 'semicolons.csv'], /semicolons\.csv line 1 must name the columns item, type and quantity, separated by commas/],
    [['import', 'no-header.csv'], /no-header\.csv line 1 must name the columns/],
    [['import', 'empty.csv'], /empty\.csv is empty/],
    [['import', 'stock-ledger.jsonl'], /stock-ledger\.jsonl line 1 must name the columns/],
    [['import', 'good.csv', '--rejects', 'there.csv'], /there\.csv: it already exists and is not overwritten/],
    [['import', 'good.csv', '--rejects', 'good.csv'], /already exists and is not overwritten/],
    [['import', 'good.csv', '--rejects', 'rejects.txt'], /must end in \.csv/],
    [['import', 'good.csv', '--rejects', 'no/such/r.csv'], /cannot use rejects file/],
    [['import', 'good.csv', '--file', 'no/such/x.jsonl'], /cannot use ledger file/],
  ]) {
    const result = cli(dir, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '', args.join(' '));
    assert.match(result.err, pattern, args.join(' '));
    assert.doesNotMatch(result.err, /\n\s+at .*\(/, 'no stack trace');
  }
  assert.equal(fs.readFileSync(path.join(dir, 'stock-ledger.jsonl'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(dir, 'there.csv'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['empty.csv', 'good.csv', 'no-header.csv', 'semicolons.csv', 'stock-ledger.jsonl', 'there.csv']);
});

test('a damaged ledger stops the import with exit 1 and the line number, and nothing is written', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'stock-ledger.jsonl'), 'not a movement\n');
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,5\nwidget,in,x\n');
  const result = cli(dir, ['import', 'moves.csv', '--rejects', 'r.csv']);
  assert.equal(result.code, 1);
  assert.equal(result.out, '');
  assert.match(result.err, /stock-ledger\.jsonl line 1 is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(dir, 'stock-ledger.jsonl'), 'utf8'), 'not a movement\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'stock-ledger.jsonl']);
});

test('import follows the ledger file chosen by --file and STOCK_LEDGER_FILE; the CSV path is taken from the current folder', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'moves.csv'), 'item,type,quantity\nwidget,in,5\n');
  assert.equal(cli(dir, ['import', path.join('sub', 'moves.csv'), '--file', 'a.jsonl']).code, 0);
  assert.equal(cli(dir, ['import', path.join(dir, 'sub', 'moves.csv')], { STOCK_LEDGER_FILE: 'b.jsonl' }).code, 0);
  assert.deepEqual(ledgerLines(dir, 'a.jsonl'), ['widget in 5']);
  assert.deepEqual(ledgerLines(dir, 'b.jsonl'), ['widget in 5']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.jsonl', 'b.jsonl', 'sub']);
});

test('an import command that is not understood exits 2, shows the usage and writes nothing', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,5\n');
  for (const args of [['import'], ['import', 'moves.csv', 'extra.csv'], ['import', 'moves.csv', '--rejects'], ['import', 'moves.csv', '--rejects='], ['in', 'widget', '5', '--rejects', 'r.csv'], ['qty', 'widget', '--rejects=r.csv'], ['low', '--rejects', 'r.csv']]) {
    const result = cli(dir, args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, /Usage:/);
  }
  assert.deepEqual(fs.readdirSync(dir), ['moves.csv']);
});

test('--help lists the import command and its option', (t) => {
  const result = cli(tempDir(t), ['--help']);
  assert.equal(result.code, 0);
  for (const word of ['stock-ledger import <csv file>', 'item,type,quantity', '--rejects <path>']) {
    assert.ok(result.out.includes(word), word);
  }
});
