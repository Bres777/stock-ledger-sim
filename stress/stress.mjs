// Stress test for stage 1: tries to break the ledger. Run: npm run stress
// Not part of npm test: it starts many processes and takes about 15 seconds.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const LEDGER_URL = pathToFileURL(path.join(REPO, 'src', 'ledger.js')).href;
const ENTRY = path.join(REPO, 'bin', 'stock-ledger.js');
const { readMovements, recordMovement, quantityOf, quantities } = await import(LEDGER_URL);

// Worker mode: node stress/stress.mjs worker <file> <type> <count>  -> prints JSON of outcome counts.
if (process.argv[2] === 'worker') {
  const [, , , file, type, count] = process.argv;
  const tally = {};
  for (let i = 0; i < Number(count); i += 1) {
    try {
      if (type === 'read') { quantityOf(readMovements(file), 'widget'); tally.ok = (tally.ok ?? 0) + 1; }
      else { recordMovement(file, { item: 'widget', type, qty: 1 }); tally.ok = (tally.ok ?? 0) + 1; }
    } catch (err) {
      const key = err.code ?? `CRASH:${err.message}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify(tally));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-stress-'));
const SELF = fileURLToPath(import.meta.url);
const results = [];
const report = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
const worker = (file, type, count) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SELF, 'worker', file, type, String(count)]);
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, tally: out ? JSON.parse(out) : {}, err }));
});
const sum = (runs, key) => runs.reduce((n, r) => n + (r.tally[key] ?? 0), 0);
const otherKeys = (runs, allowed) => [...new Set(runs.flatMap((r) => Object.keys(r.tally)))].filter((k) => !allowed.includes(k));

// 1. Size: 50,000 movements.
{
  const file = path.join(dir, 'big.jsonl');
  const lines = [];
  let expected = 0;
  for (let i = 0; i < 50000; i += 1) {
    const item = `item-${i % 100}`;
    const isOut = i % 100 === 7 && i > 200 && i % 3 === 0;
    lines.push(JSON.stringify({ at: new Date(1760000000000 + i * 1000).toISOString(), item, type: isOut ? 'out' : 'in', qty: isOut ? 1 : 2 }));
    if (item === 'item-7') expected += isOut ? -1 : 2;
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const bytes = fs.statSync(file).size;
  let t = performance.now();
  const got = quantityOf(readMovements(file), 'item-7');
  const readMs = performance.now() - t;
  t = performance.now();
  const { quantity } = recordMovement(file, { item: 'item-7', type: 'in', qty: 1 });
  const writeMs = performance.now() - t;
  t = performance.now();
  const cli = spawnSync(process.execPath, [ENTRY, 'qty', 'item-7', '--file', file], { encoding: 'utf8' });
  const cliMs = performance.now() - t;
  report('50,000 movements: quantity right, one more movement right',
    got === expected && quantity === expected + 1 && cli.stdout === `item-7: ${expected + 1}\n` && readMovements(file).length === 50001,
    `file ${bytes} bytes; expected ${expected}, read ${got} in ${readMs.toFixed(0)} ms; record one in ${writeMs.toFixed(0)} ms; qty through the command line ${cliMs.toFixed(0)} ms (includes starting node)`);
}

// 2. Many writers at once: 8 processes x 100 goods in.
{
  const file = path.join(dir, 'many-writers.jsonl');
  const t = performance.now();
  const runs = await Promise.all(Array.from({ length: 8 }, () => worker(file, 'in', 100)));
  const ms = performance.now() - t;
  const text = fs.readFileSync(file, 'utf8');
  const lineCount = text.split('\n').filter((l) => l !== '').length;
  let qty; let readError = null;
  try { qty = quantityOf(readMovements(file), 'widget'); } catch (err) { readError = err.message; }
  const ok = sum(runs, 'ok');
  report('8 processes x 100 goods in at once: every accepted movement is in the file, none merged or lost',
    readError === null && lineCount === ok && qty === ok && otherKeys(runs, ['ok', 'LOCKED']).length === 0 && runs.every((r) => r.code === 0) && !fs.existsSync(`${file}.lock`),
    `accepted ${ok}, refused LOCKED ${sum(runs, 'LOCKED')}, other outcomes ${JSON.stringify(otherKeys(runs, ['ok', 'LOCKED']))}; lines ${lineCount}; quantity ${qty}; read error ${readError}; lock file left behind: ${fs.existsSync(`${file}.lock`)}; ${ms.toFixed(0)} ms`);
}

// 3. The stock rule under a race: 100 in stock, 8 processes each try to take 30.
{
  const file = path.join(dir, 'race-out.jsonl');
  recordMovement(file, { item: 'widget', type: 'in', qty: 100 });
  const runs = await Promise.all(Array.from({ length: 8 }, () => worker(file, 'out', 30)));
  const movements = readMovements(file);
  let running = 0; let lowest = Infinity;
  for (const m of movements) { running += m.type === 'in' ? m.qty : -m.qty; lowest = Math.min(lowest, running); }
  const ok = sum(runs, 'ok'); const refused = sum(runs, 'INSUFFICIENT_STOCK'); const locked = sum(runs, 'LOCKED');
  report('100 in stock, 240 attempts to take 1 from 8 processes: exactly 100 succeed, stock never below zero',
    ok === 100 && running === 0 && lowest === 0 && ok + refused + locked === 240 && otherKeys(runs, ['ok', 'INSUFFICIENT_STOCK', 'LOCKED']).length === 0,
    `taken ${ok}, refused for stock ${refused}, refused LOCKED ${locked}, other ${JSON.stringify(otherKeys(runs, ['ok', 'INSUFFICIENT_STOCK', 'LOCKED']))}; final ${running}; lowest point ${lowest}`);
}

// 4. Readers while writers write (qty takes no lock).
{
  const file = path.join(dir, 'read-while-write.jsonl');
  const runs = await Promise.all([
    ...Array.from({ length: 4 }, () => worker(file, 'in', 150)),
    ...Array.from({ length: 4 }, () => worker(file, 'read', 600)),
  ]);
  const readers = runs.slice(4);
  report('4 readers x 600 reads while 4 writers x 150 write: no read ever saw a half-written line',
    otherKeys(readers, ['ok']).length === 0 && sum(readers, 'ok') === 2400,
    `reads ok ${sum(readers, 'ok')} of 2400; other read outcomes ${JSON.stringify(readers.map((r) => r.tally))}; writes ok ${sum(runs.slice(0, 4), 'ok')}, LOCKED ${sum(runs.slice(0, 4), 'LOCKED')}`);
}

// 5. A writer killed while holding the lock.
{
  const file = path.join(dir, 'killed.jsonl');
  recordMovement(file, { item: 'widget', type: 'in', qty: 5 });
  fs.writeFileSync(`${file}.lock`, '');   // what a killed writer leaves behind
  const t = performance.now();
  const blocked = spawnSync(process.execPath, [ENTRY, 'in', 'widget', '1', '--file', file], { encoding: 'utf8' });
  const ms = performance.now() - t;
  const read = spawnSync(process.execPath, [ENTRY, 'qty', 'widget', '--file', file], { encoding: 'utf8' });
  fs.unlinkSync(`${file}.lock`);
  const after = spawnSync(process.execPath, [ENTRY, 'in', 'widget', '1', '--file', file], { encoding: 'utf8' });
  report('a lock left by a killed writer: writes refused (not hung, not forced), reads still work, deleting it restores writes',
    blocked.status === 1 && /locked/.test(blocked.stderr) && read.stdout === 'widget: 5\n' && after.stdout === 'recorded in 1 widget; quantity now 6\n',
    `blocked write exit ${blocked.status} after ${ms.toFixed(0)} ms; read "${read.stdout.trim()}"; after deleting the lock "${after.stdout.trim()}"`);
}

// 6. Awkward ledger files.
{
  const good = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}';
  const cases = [
    ['empty file', '', 0, null],
    ['only blank lines', '\n\n  \n', 0, null],
    ['no final line break', good, 5, null],
    ['last line cut off mid-write', `${good}\n${good.slice(0, 30)}`, null, 'DAMAGED_LEDGER'],
    ['two records glued on one line', `${good}${good}\n`, null, 'DAMAGED_LEDGER'],
    ['binary rubbish', '\u0000\u0001\u0002\n', null, 'DAMAGED_LEDGER'],
    ['hand-edited to go negative', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"out","qty":5}\n', -5, null],
    ['duplicate keys in a record', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5,"qty":7}\n', 7, null],
    ['qty written 5.0', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5.0}\n', 5, null],
    ['qty 1e400', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":1e400}\n', null, 'DAMAGED_LEDGER'],
  ];
  const lines = []; let allOk = true;
  for (const [name, text, wantQty, wantCode] of cases) {
    const file = path.join(dir, 'awkward.jsonl');
    fs.writeFileSync(file, text);
    let got; let code = null;
    try { got = quantityOf(readMovements(file), 'widget'); } catch (err) { code = err.code ?? `CRASH:${err.message}`; }
    const ok = wantCode ? code === wantCode : (code === null && got === wantQty);
    allOk &&= ok;
    lines.push(`${ok ? 'ok ' : 'BAD'} ${name}: ${code ?? `quantity ${got}`}`);
  }
  report('awkward ledger files behave as the README says', allOk, lines.join('\n      '));
}

// 7. Awkward input on the real command line.
{
  const cwd = fs.mkdtempSync(path.join(dir, 'cli-'));
  const run = (args, opts = {}) => spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: 'utf8', ...opts });
  const lines = []; let allOk = true;
  const expect = (name, r, status, pattern) => {
    const text = r.stdout + r.stderr;
    const ok = r.status === status && pattern.test(text) && !/\n\s+at .*\(/.test(text);
    allOk &&= ok;
    lines.push(`${ok ? 'ok ' : 'BAD'} ${name}: exit ${r.status}: ${text.trim().split('\n')[0].slice(0, 110)}`);
  };
  expect('unicode item', run(['in', 'Größe ④ 🧰', '3']), 0, /recorded in 3 größe ④ 🧰; quantity now 3/);
  expect('unicode item read back in other case', run(['qty', 'GRÖSSE ④ 🧰']), 0, /: 0$/m);
  expect('item of 30,000 characters', run(['in', 'x'.repeat(30000), '1']), 0, /quantity now 1/);
  expect('quantity beyond exact counting', run(['in', 'widget', '9007199254740992']), 1, /whole number/);
  expect('largest quantity', run(['in', 'big', '9007199254740991']), 0, /quantity now 9007199254740991/);
  expect('one more than the largest', run(['in', 'big', '1']), 1, /beyond what can be counted exactly/);
  expect('quantity of 400 digits', run(['in', 'widget', '9'.repeat(400)]), 1, /whole number/);
  expect('quantity in Arabic-Indic digits', run(['in', 'widget', '٥']), 1, /whole number/);
  expect('item with a line break', run(['in', 'a\nb', '1']), 1, /control characters/);
  expect('item that is JSON', run(['in', '{"item":"x"}', '1']), 0, /quantity now 1/);
  expect('item that is JSON reads back', run(['qty', '{"item":"x"}']), 0, /: 1$/m);
  expect('ledger path is a folder', run(['in', 'widget', '1', '--file', cwd]), 1, /cannot use ledger file/);
  expect('qty when ledger path is a folder', run(['qty', 'widget', '--file', cwd]), 1, /cannot use ledger file/);
  expect('ledger folder does not exist', run(['in', 'widget', '1', '--file', 'no/such/x.jsonl']), 1, /cannot use ledger file/);
  const ro = path.join(cwd, 'read-only.jsonl');
  fs.writeFileSync(ro, ''); fs.chmodSync(ro, 0o444);
  expect('read-only ledger file', run(['in', 'widget', '1', '--file', ro]), 1, /cannot use ledger file/);
  const roLock = fs.existsSync(`${ro}.lock`);
  allOk &&= !roLock;
  lines.push(`${roLock ? 'BAD' : 'ok '} read-only ledger file leaves no lock behind: lock present = ${roLock}`);
  fs.chmodSync(ro, 0o666);
  expect('empty STOCK_LEDGER_FILE falls back to the default', run(['qty', 'big'], { env: { ...process.env, STOCK_LEDGER_FILE: '' } }), 0, /big: 9007199254740991/);
  let parsed = true;
  try { readMovements(path.join(cwd, 'stock-ledger.jsonl')); } catch { parsed = false; }
  allOk &&= parsed;
  lines.push(`${parsed ? 'ok ' : 'BAD'} the ledger is still readable after all of the above`);
  report('awkward input on the command line: refused or handled, never a crash with a stack trace', allOk, lines.join('\n      '));
}

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} of ${results.length} stress checks passed`);
process.exit(failed.length ? 1 : 0);
