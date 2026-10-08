// Stress test for stage 2: tries to break the levels, the prices and the two reports.
// Run: npm run stress:reports. Not part of npm test: it starts many processes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const load = (name) => import(pathToFileURL(path.join(REPO, 'src', name)).href);
const ENTRY = path.join(REPO, 'bin', 'stock-ledger.js');
const { readMovements, recordMovement, quantities } = await load('ledger.js');
const { itemsFileFor, readSettings, recordSetting } = await load('items.js');
const { lowStock, stockValue } = await load('reports.js');

// Worker mode: node stress/stress-reports.mjs worker <ledger file> <what> <count> <id>  -> prints JSON of outcome counts.
if (process.argv[2] === 'worker') {
  const [, , , file, what, count, id] = process.argv;
  const items = itemsFileFor(file);
  const tally = {};
  for (let i = 0; i < Number(count); i += 1) {
    try {
      if (what === 'level') recordSetting(items, { item: `item-${i % 10}`, set: 'level', value: Number(id) * 1000 + i });
      else if (what === 'price') recordSetting(items, { item: `item-${i % 10}`, set: 'price', value: `${id}.${String(i % 100).padStart(2, '0')}` });
      else if (what === 'in') recordMovement(file, { item: `item-${i % 10}`, type: 'in', qty: 1 });
      else {
        const stock = quantities(readMovements(file));
        const settings = readSettings(items);
        lowStock(stock, settings);
        stockValue(stock, settings);
      }
      tally.ok = (tally.ok ?? 0) + 1;
    } catch (err) {
      const key = err.code ?? `CRASH:${err.message}`;
      tally[key] = (tally[key] ?? 0) + 1;
    }
  }
  console.log(JSON.stringify(tally));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-stress-reports-'));
const SELF = fileURLToPath(import.meta.url);
const results = [];
const report = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
const worker = (file, what, count, id) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SELF, 'worker', file, what, String(count), String(id)]);
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, tally: out ? JSON.parse(out) : {}, err }));
});
const sum = (runs, key) => runs.reduce((n, r) => n + (r.tally[key] ?? 0), 0);
const otherKeys = (runs, allowed) => [...new Set(runs.flatMap((r) => Object.keys(r.tally)))].filter((k) => !allowed.includes(k));
const cliIn = (cwd) => (args, opts = {}) => spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: 'utf8', ...opts });
const stamp = (i) => new Date(1760000000000 + i * 1000).toISOString();

// 1. Size: 50,000 movements over 2,000 items, 24,000 settings of which 20,000 are superseded.
//    The expected answers are worked out here, separately from src/reports.js.
{
  const file = path.join(dir, 'big.jsonl');
  const stock = new Array(2000).fill(0);
  const lines = [];
  for (let i = 0; i < 50000; i += 1) {
    const n = (i * 7919) % 2000;
    const isOut = stock[n] > 3 && i % 4 === 0;
    const qty = isOut ? 3 : (i % 5) + 1;
    stock[n] += isOut ? -qty : qty;
    lines.push(JSON.stringify({ at: stamp(i), item: `item-${n}`, type: isOut ? 'out' : 'in', qty }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const settingLines = [];
  for (let round = 0; round < 6; round += 1) {
    for (let n = 0; n < 2000; n += 1) {
      const last = round === 5;
      // Items 0-99 get no level, items 100-199 get no price; the rest get both. Earlier rounds are decoys.
      if (n >= 100) settingLines.push(JSON.stringify({ at: stamp(n), item: `item-${n}`, set: 'level', value: last ? 40 + (n % 30) : 999999 }));
      if (n < 100 || n >= 200) settingLines.push(JSON.stringify({ at: stamp(n), item: `item-${n}`, set: 'price', value: last ? `${n % 50}.${String(n % 100).padStart(2, '0')}` : '99999.99' }));
    }
  }
  fs.writeFileSync(itemsFileFor(file), `${settingLines.join('\n')}\n`);

  let wantLow = 0; let wantCents = 0; let wantUnpriced = 0;
  for (let n = 0; n < 2000; n += 1) {
    if (n >= 100 && stock[n] < 40 + (n % 30)) wantLow += 1;
    if (stock[n] > 0 && n >= 100 && n < 200) wantUnpriced += 1;
    else wantCents += stock[n] * ((n % 50) * 100 + (n % 100));   // small enough to be exact as a number
  }
  const wantTotal = `${Math.floor(wantCents / 100)}.${String(wantCents % 100).padStart(2, '0')}`;

  let t = performance.now();
  const settings = readSettings(itemsFileFor(file));
  const quantitiesNow = quantities(readMovements(file));
  const low = lowStock(quantitiesNow, settings);
  const value = stockValue(quantitiesNow, settings);
  const libMs = performance.now() - t;
  t = performance.now();
  const cliLow = cliIn(dir)(['low', '--file', file]);
  const cliValue = cliIn(dir)(['value', '--file', file]);
  const cliMs = (performance.now() - t) / 2;
  const cliTotalLine = cliValue.stdout.trimEnd().split('\n').at(-1);
  report('50,000 movements, 2,000 items, 24,000 settings (20,000 superseded): both reports match a separate calculation',
    low.length === wantLow && value.total === wantTotal && value.unpriced.length === wantUnpriced
      && cliLow.status === 0 && cliLow.stdout.trimEnd().split('\n').length === wantLow + 1 && cliLow.stdout.endsWith(`${wantLow} items below their re-order level\n`)
      && cliValue.status === 0 && cliTotalLine === `total: ${wantTotal} (excludes ${wantUnpriced} items with no price)`,
    `below level: expected ${wantLow}, got ${low.length}; total: expected ${wantTotal}, got ${value.total}; unpriced: expected ${wantUnpriced}, got ${value.unpriced.length}; command line last line "${cliTotalLine}"; both reports in the library ${libMs.toFixed(0)} ms; one report through the command line ${cliMs.toFixed(0)} ms (includes starting node)`);
}

// 2. Many writers at once on the items file: 4 processes x 100 levels and 4 x 100 prices.
{
  const file = path.join(dir, 'many-writers.jsonl');
  const items = itemsFileFor(file);
  const t = performance.now();
  const runs = await Promise.all(Array.from({ length: 8 }, (_, id) => worker(file, id < 4 ? 'level' : 'price', 100, id + 1)));
  const ms = performance.now() - t;
  const lineCount = fs.readFileSync(items, 'utf8').split('\n').filter((l) => l !== '').length;
  let settings; let readError = null;
  try { settings = readSettings(items); } catch (err) { readError = err.message; }
  const ok = sum(runs, 'ok');
  const complete = settings !== undefined && settings.size === 10 && [...settings.values()].every((s) => s.level !== undefined && s.price !== undefined);
  report('8 processes x 100 settings at once: every accepted setting is in the file, none merged or lost',
    readError === null && lineCount === ok && complete && otherKeys(runs, ['ok', 'LOCKED']).length === 0 && runs.every((r) => r.code === 0) && !fs.existsSync(`${items}.lock`),
    `accepted ${ok}, refused LOCKED ${sum(runs, 'LOCKED')}, other outcomes ${JSON.stringify(otherKeys(runs, ['ok', 'LOCKED']))}; lines ${lineCount}; items with both a level and a price ${complete ? 10 : 'NOT 10'}; read error ${readError}; lock file left behind: ${fs.existsSync(`${items}.lock`)}; ${ms.toFixed(0)} ms`);
}

// 3. Reports while movements and settings are being written (reports take no lock).
{
  const file = path.join(dir, 'report-while-write.jsonl');
  const runs = await Promise.all([
    worker(file, 'in', 150, 1), worker(file, 'in', 150, 2), worker(file, 'level', 150, 3), worker(file, 'price', 150, 4),
    ...Array.from({ length: 4 }, (_, id) => worker(file, 'report', 400, id)),
  ]);
  const readers = runs.slice(4); const writers = runs.slice(0, 4);
  report('4 processes x 400 pairs of reports while 4 others write movements and settings: no report ever saw a half-written line',
    otherKeys(readers, ['ok']).length === 0 && sum(readers, 'ok') === 1600 && otherKeys(writers, ['ok', 'LOCKED']).length === 0,
    `reports ok ${sum(readers, 'ok')} of 1600; other report outcomes ${JSON.stringify(otherKeys(readers, ['ok']))}; writes ok ${sum(writers, 'ok')}, LOCKED ${sum(writers, 'LOCKED')}, other ${JSON.stringify(otherKeys(writers, ['ok', 'LOCKED']))}`);
}

// 4. Amounts beyond what a JavaScript number can count, through the real command line.
{
  const cwd = fs.mkdtempSync(path.join(dir, 'big-'));
  const run = cliIn(cwd);
  run(['in', 'big', '9007199254740991']); run(['price', 'big', '90071992547409.91']);
  run(['in', 'big2', '9007199254740991']); run(['price', 'big2', '0.01']);
  run(['in', 'third', '3']); run(['price', 'third', '0.10']);
  const r = run(['value']);
  // (2^53-1)^2 = 2^106 - 2^54 + 1 hundredths; plus (2^53-1) hundredths; plus 30 hundredths.
  const want = 'big: 9007199254740991 x 90071992547409.91 = 811296384146066636813904956620.81\nbig2: 9007199254740991 x 0.01 = 90071992547409.91\nthird: 3 x 0.10 = 0.30\ntotal: 811296384146066726885897504031.02\n';
  const lost = Number('811296384146066636813904956620.81') + 90071992547409.91 + 0.3;
  report('largest quantity x largest price: every digit of the value and the total is right',
    r.status === 0 && r.stdout === want && r.stderr === '',
    `exit ${r.status}; total line "${r.stdout.trimEnd().split('\n').at(-1)}"; the same sum in floating point would print ${lost}`);
}

// 5. A setting writer killed while holding the items lock.
{
  const cwd = fs.mkdtempSync(path.join(dir, 'killed-'));
  const run = cliIn(cwd);
  run(['in', 'widget', '5']); run(['level', 'widget', '9']); run(['price', 'widget', '2']);
  const lock = path.join(cwd, 'stock-ledger.jsonl.items.jsonl.lock');
  fs.writeFileSync(lock, '');   // what a killed writer leaves behind
  const t = performance.now();
  const blocked = run(['price', 'widget', '3']);
  const ms = performance.now() - t;
  const low = run(['low']); const value = run(['value']); const movement = run(['in', 'widget', '1']);
  fs.unlinkSync(lock);
  const after = run(['price', 'widget', '3']);
  report('a lock left on the items file: settings refused (not hung, not forced), reports and movements still work, deleting it restores settings',
    blocked.status === 1 && /locked/.test(blocked.stderr) && low.stdout.startsWith('widget: 5 (re-order level 9)\n') && value.stdout === 'widget: 5 x 2.00 = 10.00\ntotal: 10.00\n'
      && movement.stdout === 'recorded in 1 widget; quantity now 6\n' && after.stdout === 'price of widget set to 3.00\n',
    `blocked setting exit ${blocked.status} after ${ms.toFixed(0)} ms; low "${low.stdout.trim().split('\n')[0]}"; value "${value.stdout.trim().split('\n').at(-1)}"; movement "${movement.stdout.trim()}"; after deleting the lock "${after.stdout.trim()}"`);
}

// 6. Awkward items files.
{
  const level = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":5}';
  const price = '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"price","value":"2.00"}';
  const cases = [
    ['empty file', '', 'none', null],
    ['only blank lines', '\n\n  \n', 'none', null],
    ['no final line break', `${level}\n${price}`, '5/2.00', null],
    ['last line cut off mid-write', `${level}\n${price.slice(0, 30)}`, null, 'DAMAGED_ITEMS'],
    ['two records glued on one line', `${level}${price}\n`, null, 'DAMAGED_ITEMS'],
    ['binary rubbish', '\u0000\u0001\u0002\n', null, 'DAMAGED_ITEMS'],
    ['a movement line in the items file', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}\n', null, 'DAMAGED_ITEMS'],
    ['price stored as a number', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"price","value":2}\n', null, 'DAMAGED_ITEMS'],
    ['price stored with one decimal', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"price","value":"2.0"}\n', null, 'DAMAGED_ITEMS'],
    ['level stored as text', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":"5"}\n', null, 'DAMAGED_ITEMS'],
    ['level 1e400', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":1e400}\n', null, 'DAMAGED_ITEMS'],
    ['level written 5.0', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":5.0}\n', '5/-', null],
    ['duplicate keys in a record', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"level","value":5,"value":7}\n', '7/-', null],
    ['set is __proto__', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","set":"__proto__","value":5}\n', null, 'DAMAGED_ITEMS'],
    ['level then level again then price', `${level}\n${level.replace(':5}', ':8}')}\n${price}\n`, '8/2.00', null],
  ];
  const lines = []; let allOk = true;
  for (const [name, text, want, wantCode] of cases) {
    const file = path.join(dir, 'awkward.items.jsonl');
    fs.writeFileSync(file, text);
    let got; let code = null;
    try { const s = readSettings(file).get('widget'); got = s ? `${s.level ?? '-'}/${s.price ?? '-'}` : 'none'; } catch (err) { code = err.code ?? `CRASH:${err.message}`; }
    const ok = wantCode ? code === wantCode : (code === null && got === want);
    allOk &&= ok;
    lines.push(`${ok ? 'ok ' : 'BAD'} ${name}: ${code ?? `level/price ${got}`}`);
  }
  report('awkward items files behave as the README says', allOk, lines.join('\n      '));
}

// 7. Awkward input on the real command line.
{
  const cwd = fs.mkdtempSync(path.join(dir, 'cli-'));
  const run = cliIn(cwd);
  const lines = []; let allOk = true;
  const expect = (name, r, status, pattern) => {
    const text = r.stdout + r.stderr;
    const ok = r.status === status && pattern.test(text) && !/\n\s+at .*\(/.test(text);
    allOk &&= ok;
    lines.push(`${ok ? 'ok ' : 'BAD'} ${name}: exit ${r.status}: ${text.trim().split('\n')[0].slice(0, 110)}`);
  };
  run(['in', 'Größe ④ 🧰', '3']);
  expect('unicode item, level in other case', run(['level', 'GRÖSSE ④ 🧰', '5']), 0, /re-order level of grösse ④ 🧰 set to 5/);
  expect('unicode item, price', run(['price', 'Größe ④ 🧰', '1.5']), 0, /price of größe ④ 🧰 set to 1\.50/);
  expect('low keeps the two spellings apart, as stage 1 does', run(['low']), 0, /^grösse ④ 🧰: 0 \(re-order level 5\)$/m);
  expect('item of 30,000 characters', run(['level', 'x'.repeat(30000), '1']), 0, /set to 1$/m);
  expect('item starting with dashes after --', run(['price', '--', '--odd', '4']), 0, /price of --odd set to 4\.00/);
  expect('item that is JSON', run(['level', '{"set":"price"}', '2']), 0, /set to 2$/m);
  expect('item with a line break', run(['level', 'a\nb', '1']), 1, /control characters/);
  expect('level beyond exact counting', run(['level', 'widget', '9007199254740992']), 1, /whole number/);
  expect('level of 400 digits', run(['level', 'widget', '9'.repeat(400)]), 1, /whole number/);
  expect('level in Arabic-Indic digits', run(['level', 'widget', '٥']), 1, /whole number/);
  expect('negative level is not read as an option', run(['level', 'widget', '-5']), 1, /whole number/);
  expect('largest price', run(['price', 'widget', '90071992547409.91']), 0, /set to 90071992547409\.91/);
  expect('one hundredth more than the largest price', run(['price', 'widget', '90071992547409.92']), 1, /at most 90071992547409\.91/);
  expect('price of 400 digits', run(['price', 'widget', '9'.repeat(400)]), 1, /at most/);
  expect('price with three decimals', run(['price', 'widget', '0.001']), 1, /at most two decimal places/);
  expect('price with a comma', run(['price', 'widget', '1,50']), 1, /price must be an amount/);
  expect('price with a currency sign', run(['price', 'widget', '€5']), 1, /price must be an amount/);
  expect('price in full-width digits', run(['price', 'widget', '１２']), 1, /price must be an amount/);
  expect('price that is an exponent', run(['price', 'widget', '1e2']), 1, /price must be an amount/);
  expect('price NaN', run(['price', 'widget', 'NaN']), 1, /price must be an amount/);
  expect('empty price', run(['price', 'widget', '']), 1, /price must be an amount/);
  expect('ledger path is a folder: low', run(['low', '--file', cwd]), 1, /cannot use ledger file/);
  expect('ledger folder does not exist: level', run(['level', 'widget', '1', '--file', 'no/such/x.jsonl']), 1, /cannot use ledger file/);
  expect('ledger folder does not exist: low is an empty report', run(['low', '--file', 'no/such/x.jsonl']), 0, /no re-order levels are set/);
  const asFolder = path.join(cwd, 'f.jsonl');
  fs.mkdirSync(`${asFolder}.items.jsonl`);
  expect('items path is a folder: value', run(['value', '--file', asFolder]), 1, /cannot use items file/);
  expect('items path is a folder: price', run(['price', 'widget', '1', '--file', asFolder]), 1, /cannot use items file/);
  const roLedger = path.join(cwd, 'ro.jsonl'); const ro = `${roLedger}.items.jsonl`;
  fs.writeFileSync(ro, ''); fs.chmodSync(ro, 0o444);
  expect('read-only items file', run(['level', 'widget', '1', '--file', roLedger]), 1, /cannot use items file/);
  const roLock = fs.existsSync(`${ro}.lock`);
  allOk &&= !roLock;
  lines.push(`${roLock ? 'BAD' : 'ok '} read-only items file leaves no lock behind: lock present = ${roLock}`);
  fs.chmodSync(ro, 0o666);
  const final = run(['value']);
  expect('value still works after all of the above', final, 0, /^größe ④ 🧰: 3 x 1\.50 = 4\.50\ntotal: 4\.50$/m);
  let parsed = true;
  try { readSettings(path.join(cwd, 'stock-ledger.jsonl.items.jsonl')); readMovements(path.join(cwd, 'stock-ledger.jsonl')); } catch { parsed = false; }
  allOk &&= parsed;
  lines.push(`${parsed ? 'ok ' : 'BAD'} both files are still readable after all of the above`);
  report('awkward input on the command line: refused or handled, never a crash with a stack trace', allOk, lines.join('\n      '));
}

// 8. One item re-priced 2,000 times through the library: the last price is the one used.
{
  const file = path.join(dir, 'reprice.jsonl');
  const items = itemsFileFor(file);
  recordMovement(file, { item: 'widget', type: 'in', qty: 7 });
  const t = performance.now();
  for (let i = 1; i <= 2000; i += 1) recordSetting(items, { item: 'widget', set: 'price', value: `${i}.${String(i % 100).padStart(2, '0')}` });
  const ms = performance.now() - t;
  const { total } = stockValue(quantities(readMovements(file)), readSettings(items));
  report('one item re-priced 2,000 times: the value uses the last price, and every earlier line is still in the file',
    total === '14000.00' && fs.readFileSync(items, 'utf8').split('\n').filter((l) => l !== '').length === 2000,
    `total ${total} (expected 7 x 2000.00 = 14000.00); 2,000 settings written in ${ms.toFixed(0)} ms`);
}

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} of ${results.length} stress checks passed`);
process.exit(failed.length ? 1 : 0);
