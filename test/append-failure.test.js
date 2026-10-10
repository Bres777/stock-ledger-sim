// Stage 4. What happens when the system itself refuses the append to the ledger file: what the user is
// told, and what is in the ledger file afterwards. Each failure here is a real refusal by the operating
// system of the one fs.appendFileSync call in src/ledger.js; no half line is made by hand and nothing is
// faked.
//
// What these tests show: in the two failures below the system took none of the text, and the ledger
// file is byte for byte what it was. What they do NOT show: what is left when the system takes part of
// the text and then fails (a disk that fills), or when the process is killed while writing. Neither can
// be produced on demand here. src/ledger.js does not undo an append, so the README's known limits apply.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LedgerError, readMovements, recordMovement, recordMovements } from '../src/ledger.js';

const ENTRY = fileURLToPath(new URL('../bin/stock-ledger.js', import.meta.url));
const EARLIER = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}\n';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-append-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(cwd, args) {
  const env = { ...process.env };
  delete env.STOCK_LEDGER_FILE;
  const result = spawnSync(process.execPath, [ENTRY, ...args], { cwd, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const refuses = (code) => (err) => err instanceof LedgerError && err.code === code;

// A user who can write to any file whatever its mode (root) cannot be refused this way.
const cannotBeRefused = typeof process.getuid === 'function' && process.getuid() === 0;

test('the append refused because the ledger file is read-only: exit 1, the system\'s reason on stderr, and the ledger file is left as it was', { skip: cannotBeRefused ? 'this user can write to a read-only file' : false }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'stock-ledger.jsonl');
  fs.writeFileSync(file, EARLIER);
  fs.chmodSync(file, 0o444);
  fs.writeFileSync(path.join(dir, 'moves.csv'), 'item,type,quantity\nwidget,in,1\nbolt,in,2\nnut,in,x\n');

  // The file can still be read, so the ledger is read and checked and the lock is taken: it is the append that fails.
  assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 5\n');

  // The command line: an import of two good rows and one bad one, and a single movement.
  for (const args of [['import', 'moves.csv', '--rejects', 'rejects.csv'], ['in', 'widget', '1']]) {
    const result = cli(dir, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '', args.join(' '));
    assert.match(result.err, /^stock-ledger: cannot use ledger file [^\n]*: (EPERM|EACCES)[^\n]*\n$/, args.join(' '));
    assert.ok(result.err.includes(file), 'the message names the ledger file');
    // The user is told why, not what is in the file: the message makes no statement either way.
    assert.doesNotMatch(result.err, /nothing was written/i);
  }

  // The library: the batch and the single movement both throw FILE_ERROR.
  assert.throws(() => recordMovements(file, [{ item: 'widget', type: 'in', qty: 1 }, { item: 'bolt', type: 'in', qty: 2 }]), refuses('FILE_ERROR'));
  assert.throws(() => recordMovement(file, { item: 'widget', type: 'in', qty: 1 }), refuses('FILE_ERROR'));

  // What is left: the ledger file as it was, and no lock and no rejects file.
  assert.equal(fs.readFileSync(file, 'utf8'), EARLIER);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'stock-ledger.jsonl']);
});

// Holds a lock on ONE byte of the file, 1 MiB from its start, from another process, until release() is
// called. Windows refuses any write that would cover a byte another process has locked, so the ledger
// file still opens and is still read (it is far shorter than 1 MiB), and an append long enough to reach
// that byte is refused at the write. An append that ends before that byte is not affected.
const LOCKED_BYTE = 1024 * 1024;
async function lockOneByte(file) {
  const script = `$f=[IO.File]::Open($env:STOCK_LEDGER_TEST_FILE,'Open','ReadWrite','ReadWrite,Delete');$f.Lock(${LOCKED_BYTE},1);[Console]::Out.WriteLine('HELD');[Console]::Out.Flush();[void][Console]::In.ReadLine();$f.Close()`;
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, STOCK_LEDGER_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise((resolve) => { helper.on('close', resolve); helper.on('error', resolve); });
  // The helper ends when its input ends. It is always ended, and waited for, before the test is over:
  // a helper left running would keep the file open and the test run from finishing.
  let released;
  const release = () => {
    released ??= (async () => {
      const kill = setTimeout(() => helper.kill(), 10000);
      helper.stdin.on('error', () => {});
      helper.stdin.end('\n');
      await closed;
      clearTimeout(kill);
    })();
    return released;
  };
  let out = '';
  let err = '';
  helper.stderr.on('data', (data) => { err += data; });
  try {
    await new Promise((resolve, reject) => {
      const giveUp = setTimeout(() => reject(new Error(`the lock helper did not answer in 30 seconds: ${err}`)), 30000);
      helper.stdout.on('data', (data) => { out += data; if (out.includes('HELD')) { clearTimeout(giveUp); resolve(); } });
      closed.then(() => { clearTimeout(giveUp); reject(new Error(`the lock helper ended before it held the lock: ${err}`)); });
    });
  } catch (error) {
    helper.kill();
    await release();
    throw error;
  }
  return release;
}

test('the write of an import refused by the system after the file was opened: exit 1, the system\'s reason on stderr, none of the import in the ledger file, and the same import works once the cause is gone', { skip: process.platform === 'win32' ? false : 'needs a Windows byte-range lock held by powershell.exe' }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'stock-ledger.jsonl');
  fs.writeFileSync(file, EARLIER);
  // 20,000 rows are about 1.3 MB of ledger text in one append: it reaches the locked byte.
  const rows = Array.from({ length: 20000 }, (_, i) => `row-${i},in,1`);
  fs.writeFileSync(path.join(dir, 'moves.csv'), `item,type,quantity\n${rows.join('\n')}\nnut,in,x\n`);
  const release = await lockOneByte(file);
  try {
    const refused = cli(dir, ['import', 'moves.csv', '--rejects', 'rejects.csv']);
    assert.deepEqual(refused, { code: 1, out: '', err: `stock-ledger: cannot use ledger file ${file}: EBUSY: resource busy or locked, write\n` });
    assert.throws(
      () => recordMovements(file, rows.map((_, i) => ({ item: `row-${i}`, type: 'in', qty: 1 }))),
      (err) => refuses('FILE_ERROR')(err) && err.message.endsWith(', write'),
    );

    // What is left: the ledger file as it was, readable, and no lock and no rejects file.
    assert.equal(fs.readFileSync(file, 'utf8'), EARLIER);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['moves.csv', 'stock-ledger.jsonl']);
    assert.equal(cli(dir, ['qty', 'widget']).out, 'widget: 5\n');

    // A short append ends before the locked byte, so it goes through: the refusal above was of that one long write.
    assert.equal(cli(dir, ['in', 'widget', '1']).out, 'recorded in 1 widget; quantity now 6\n');
  } finally {
    await release();
  }

  const again = cli(dir, ['import', 'moves.csv', '--rejects', 'rejects.csv']);
  assert.equal(again.code, 3);
  assert.equal(again.out, 'imported 20000 movements from moves.csv; rejected 1 of 20001 rows\n');
  const movements = readMovements(file);
  assert.equal(movements.length, 20002);
  assert.deepEqual(movements.slice(2).map(({ item }) => item), rows.map((_, i) => `row-${i}`));
  assert.equal(fs.readFileSync(path.join(dir, 'rejects.csv'), 'utf8'), 'item,type,quantity\nnut,in,x\n');
});
