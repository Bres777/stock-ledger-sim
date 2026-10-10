// Stage 5. What happens when the system itself refuses the append to the ITEMS file: what the user is
// told by `level` and `price`, and what is in the items file afterwards. Each failure here is a real
// refusal by the operating system of the one fs.appendFileSync call in recordSetting (src/items.js); no
// half line is made by hand and nothing is faked. It is the items-file counterpart of
// test/append-failure.test.js, which does the same for the ledger file.
//
// What these tests show: in the two failures below the system took none of the text, and the items file
// is byte for byte what it was. What they do NOT show: what is left when the system takes part of the
// text and then fails (a disk that fills), or when the process is killed while writing. Neither can be
// produced on demand here. src/items.js does not undo an append, so the README's known limits apply.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { LedgerError } from '../src/ledger.js';
import { readSettings, recordSetting } from '../src/items.js';

const ENTRY = fileURLToPath(new URL('../bin/stock-ledger.js', import.meta.url));
const LEDGER = 'stock-ledger.jsonl';
const ITEMS = `${LEDGER}.items.jsonl`;
const EARLIER_LEDGER = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}\n';
const EARLIER_ITEMS = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":10}\n';
// With 5 widgets in and a level of 10, `low` reads BOTH files and lists widget: proof the items file is read.
const LOW_BEFORE = 'widget: 5 (re-order level 10)\n1 item below its re-order level\n';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-items-append-'));
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

test('the append refused because the items file is read-only: level and price exit 1 with the system\'s reason on stderr, and the items file is left as it was', { skip: cannotBeRefused ? 'this user can write to a read-only file' : false }, (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, ITEMS);
  fs.writeFileSync(path.join(dir, LEDGER), EARLIER_LEDGER);
  fs.writeFileSync(file, EARLIER_ITEMS);
  fs.chmodSync(file, 0o444);

  // The file can still be read, so the items file is read and checked and the lock is taken: it is the append that fails.
  assert.equal(cli(dir, ['low']).out, LOW_BEFORE);

  // The command line: a level and a price, each a valid setting the system then refuses to write.
  for (const args of [['level', 'widget', '20'], ['price', 'widget', '12.5']]) {
    const result = cli(dir, args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.out, '', args.join(' '));
    assert.match(result.err, /^stock-ledger: cannot use items file [^\n]*: (EPERM|EACCES)[^\n]*\n$/, args.join(' '));
    assert.ok(result.err.includes(file), 'the message names the items file');
    // The user is told why, not what is in the file: the message makes no statement either way.
    assert.doesNotMatch(result.err, /nothing was written/i);
  }

  // The library: recordSetting throws FILE_ERROR for either setting.
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'level', value: '20' }), refuses('FILE_ERROR'));
  assert.throws(() => recordSetting(file, { item: 'widget', set: 'price', value: '12.5' }), refuses('FILE_ERROR'));

  // What is left: both files as they were, no lock, and the items file still readable.
  assert.equal(fs.readFileSync(file, 'utf8'), EARLIER_ITEMS);
  assert.equal(fs.readFileSync(path.join(dir, LEDGER), 'utf8'), EARLIER_LEDGER);
  assert.deepEqual(fs.readdirSync(dir).sort(), [LEDGER, ITEMS]);
  assert.equal(cli(dir, ['low']).out, LOW_BEFORE);
});

// Holds a lock on ONE byte of the file, at `offset`, from another process, until release() is called.
// Windows refuses any read or write that would cover a byte another process has locked. The items file
// is far shorter than the offset and Node's read of it stops well before that byte, so the file still
// opens and is still read; an append long enough to reach that byte is refused at the write. An append
// that ends before that byte is not affected. (Same helper as test/append-failure.test.js, with the
// offset as a parameter.)
async function lockOneByte(file, offset) {
  const script = `$f=[IO.File]::Open($env:STOCK_LEDGER_TEST_FILE,'Open','ReadWrite','ReadWrite,Delete');$f.Lock(${offset},1);[Console]::Out.WriteLine('HELD');[Console]::Out.Flush();[void][Console]::In.ReadLine();$f.Close()`;
  const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, STOCK_LEDGER_TEST_FILE: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  const closed = new Promise((resolve) => { helper.on('close', resolve); helper.on('error', (error) => { err += error.message; resolve(); }); });
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

// A setting line is about 80 bytes, so to reach a locked byte beyond the read the line has to be long:
// the item name carries the length (an item name has no length limit, rule 3). 20,000 characters is as
// much as fits comfortably in a Windows command line; the locked byte is 16 KiB from the start of a
// file of 80 bytes, which a read of that file (seen to reach about 8 KiB past its end) does not touch.
const LOCKED_BYTE = 16 * 1024;
const LONG_ITEM = 'w'.repeat(20000);

test('the write of a setting refused by the system after the items file was opened: exit 1, the system\'s reason on stderr, none of the setting in the items file, and the same setting works once the cause is gone', { skip: process.platform === 'win32' ? false : 'needs a Windows byte-range lock held by powershell.exe' }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, ITEMS);
  fs.writeFileSync(path.join(dir, LEDGER), EARLIER_LEDGER);
  fs.writeFileSync(file, EARLIER_ITEMS);
  const release = await lockOneByte(file, LOCKED_BYTE);
  try {
    // The items file is read past the lock without trouble: the read stops before the locked byte.
    const before = cli(dir, ['low']);
    assert.equal(before.out, LOW_BEFORE, `the read reached the locked byte (raise LOCKED_BYTE for this runtime): ${before.err}`);

    const refused = cli(dir, ['level', LONG_ITEM, '20']);
    assert.deepEqual(refused, { code: 1, out: '', err: `stock-ledger: cannot use items file ${file}: EBUSY: resource busy or locked, write\n` });
    assert.throws(
      () => recordSetting(file, { item: LONG_ITEM, set: 'price', value: '12.5' }),
      (err) => refuses('FILE_ERROR')(err) && err.message.endsWith(', write'),
    );

    // What is left: the items file as it was, readable, and no lock.
    assert.equal(fs.readFileSync(file, 'utf8'), EARLIER_ITEMS);
    assert.deepEqual(fs.readdirSync(dir).sort(), [LEDGER, ITEMS]);
    assert.equal(cli(dir, ['low']).out, LOW_BEFORE);

    // A short append ends before the locked byte, so it goes through: the refusal above was of that one long write.
    assert.equal(cli(dir, ['price', 'widget', '12.5']).out, 'price of widget set to 12.50\n');
  } finally {
    await release();
  }

  const again = cli(dir, ['level', LONG_ITEM, '20']);
  assert.deepEqual(again, { code: 0, out: `re-order level of ${LONG_ITEM} set to 20\n`, err: '' });
  assert.deepEqual([...readSettings(file)], [
    ['widget', { level: 10, price: '12.50' }],
    [LONG_ITEM, { level: 20, price: undefined }],
  ]);
  assert.equal(fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, 3, 'three settings, three lines');
});
