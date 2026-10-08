// Stress test for stage 3: tries to break the CSV import. Run: npm run stress:import
// Not part of npm test: it starts many processes.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const load = (name) => import(pathToFileURL(path.join(REPO, 'src', name)).href);
const ENTRY = path.join(REPO, 'bin', 'stock-ledger.js');
const { readMovements, recordMovement, quantities } = await load('ledger.js');
const { importCsv, importCsvText } = await load('import.js');
const { parseCsv } = await load('csv.js');

// Worker mode: node stress/stress-import.mjs worker <ledger file> <what> <count> <arg>  -> prints JSON of outcome counts.
//   import  imports the CSV file <arg>, <count> times: tallies rows recorded and rejected
//   in      records <count> single movements of the item <arg>
//   read    reads the ledger <count> times
if (process.argv[2] === 'worker') {
  const [, , , file, what, count, arg] = process.argv;
  const tally = {};
  const add = (key, n = 1) => { tally[key] = (tally[key] ?? 0) + n; };
  for (let i = 0; i < Number(count); i += 1) {
    try {
      if (what === 'import') {
        const { recorded, rejected } = importCsv(file, arg);
        add('recorded', recorded.length);
        for (const { code } of rejected) add(`rejected:${code}`);
      } else if (what === 'in') {
        recordMovement(file, { item: arg, type: 'in', qty: 1 });
      } else {
        quantities(readMovements(file));
      }
      add('ok');
    } catch (err) {
      add(err.code ?? `CRASH:${err.message}`);
    }
  }
  console.log(JSON.stringify(tally));
  process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-ledger-stress-import-'));
const SELF = fileURLToPath(import.meta.url);
const results = [];
const report = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${detail}`); };
const worker = (file, what, count, arg) => new Promise((resolve) => {
  const child = spawn(process.execPath, [SELF, 'worker', file, what, String(count), String(arg)]);
  let out = ''; let err = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  child.on('close', (code) => resolve({ code, tally: out ? JSON.parse(out) : {}, err }));
});
const sum = (runs, key) => runs.reduce((n, r) => n + (r.tally[key] ?? 0), 0);
const otherKeys = (runs, allowed) => [...new Set(runs.flatMap((r) => Object.keys(r.tally)))].filter((k) => !allowed.includes(k));
const cliIn = (cwd) => (args, opts = {}) => spawnSync(process.execPath, [ENTRY, ...args], { cwd, encoding: 'utf8', ...opts });
const lowestPoint = (movements) => {
  const running = new Map(); let lowest = 0;
  for (const { item, type, qty } of movements) { const next = (running.get(item) ?? 0) + (type === 'in' ? qty : -qty); running.set(item, next); lowest = Math.min(lowest, next); }
  return lowest;
};

// 1. Size: 100,000 rows over 2,000 items, about one row in seven bad in six different ways.
//    What should be recorded and rejected is worked out here, separately from src/.
{
  const cwd = fs.mkdtempSync(path.join(dir, 'big-'));
  const stock = new Array(2000).fill(0);
  const rows = ['item,type,quantity'];
  const wantRejected = []; const wantLedger = [];
  for (let i = 0; i < 100000; i += 1) {
    const n = (i * 7919) % 2000;
    const item = `item-${n}`;
    const kind = i % 7 === 3 ? (i % 6) : -1;
    if (kind === 0) rows.push(`${item},in,${i % 9}.5`);                 // quantity not a whole number
    else if (kind === 1) rows.push(`${item},out,${stock[n] + 1}`);       // one more than is in stock
    else if (kind === 2) rows.push(`${item},in`);                        // a field missing
    else if (kind === 3) rows.push(`${item},sideways,3`);                // type
    else if (kind === 4) rows.push(`ite"m-${n},in,3`);                   // a quote in the wrong place
    else if (kind === 5) rows.push(`,in,3`);                             // no item
    else {
      const isOut = stock[n] > 3 && i % 4 === 0;
      const qty = isOut ? 3 : (i % 5) + 1;
      stock[n] += isOut ? -qty : qty;
      // Awkward but valid spellings of good rows: quotes, upper case, spaces.
      rows.push(i % 11 === 0 ? `"ITEM-${n}" , ${isOut ? 'Out' : 'IN'} , ${qty}`.replace('" ,', '",') : `${item},${isOut ? 'out' : 'in'},${qty}`);
      wantLedger.push(`${item} ${isOut ? 'out' : 'in'} ${qty}`);
      continue;
    }
    wantRejected.push(i + 2);   // line number: the header is line 1
  }
  fs.writeFileSync(path.join(cwd, 'big.csv'), `${rows.join('\r\n')}\r\n`);
  const bytes = fs.statSync(path.join(cwd, 'big.csv')).size;
  const t = performance.now();
  const r = cliIn(cwd)(['import', 'big.csv', '--rejects', 'rejects.csv'], { maxBuffer: 1 << 28 });
  const ms = performance.now() - t;
  const movements = readMovements(path.join(cwd, 'stock-ledger.jsonl'));
  const gotLedger = movements.map(({ item, type, qty }) => `${item} ${type} ${qty}`);
  const namedLines = [...r.stderr.matchAll(/^stock-ledger: big\.csv line (\d+) rejected: /gm)].map((m) => Number(m[1]));
  const rejectsRows = fs.readFileSync(path.join(cwd, 'rejects.csv'), 'utf8').trimEnd().split('\n');
  const wantRejectsRows = ['item,type,quantity', ...wantRejected.map((line) => rows[line - 1])];
  const now = quantities(movements);
  const stockRight = stock.every((qty, n) => (now.get(`item-${n}`) ?? 0) === qty);
  report('100,000 rows, 2,000 items, one row in seven bad in six ways: exactly the good rows are in the ledger, in order, and exactly the bad ones are named',
    r.status === 3 && gotLedger.length === wantLedger.length && gotLedger.every((line, i) => line === wantLedger[i])
      && namedLines.length === wantRejected.length && namedLines.every((line, i) => line === wantRejected[i])
      && rejectsRows.length === wantRejectsRows.length && rejectsRows.every((row, i) => row === wantRejectsRows[i])
      && r.stdout === `imported ${wantLedger.length} movements from big.csv; rejected ${wantRejected.length} of 100000 rows\n`
      && stockRight && lowestPoint(movements) === 0 && !fs.existsSync(path.join(cwd, 'stock-ledger.jsonl.lock')),
    `CSV ${bytes} bytes; exit ${r.status}; recorded: expected ${wantLedger.length}, got ${gotLedger.length}; rejected lines named: expected ${wantRejected.length}, got ${namedLines.length}; rejects file rows: expected ${wantRejectsRows.length}, got ${rejectsRows.length}; all 2,000 quantities right: ${stockRight}; lowest stock at any line ${lowestPoint(movements)}; "${r.stdout.trim()}"; ${ms.toFixed(0)} ms through the command line (includes starting node)`);

  // 1b. The same ledger again: a second large import on top of 85,000 movements, and the cost of one-at-a-time for comparison.
  const again = path.join(cwd, 'again.csv');
  fs.writeFileSync(again, `item,type,quantity\n${Array.from({ length: 20000 }, (_, i) => `item-${i % 2000},in,1`).join('\n')}\n`);
  let t2 = performance.now();
  const second = importCsv(path.join(cwd, 'stock-ledger.jsonl'), again);
  const batchMs = performance.now() - t2;
  const small = path.join(cwd, 'one-at-a-time.jsonl');
  t2 = performance.now();
  for (let i = 0; i < 300; i += 1) recordMovement(small, { item: `item-${i % 20}`, type: 'in', qty: 1 });
  const singleMs = performance.now() - t2;
  const afterSecond = quantities(readMovements(path.join(cwd, 'stock-ledger.jsonl')));
  report('a second import of 20,000 rows on top of the ledger the first one left: all recorded, all 2,000 quantities right',
    second.recorded.length === 20000 && second.rejected.length === 0 && stock.every((qty, n) => afterSecond.get(`item-${n}`) === qty + 10),
    `recorded ${second.recorded.length}, rejected ${second.rejected.length}; ${batchMs.toFixed(0)} ms for 20,000 rows in one import; for comparison 300 single movements into an EMPTY ledger took ${singleMs.toFixed(0)} ms`);
}

// 2. Many imports at once into one ledger: 8 processes each import the same 500-row file 3 times.
//    Each file brings 2 in and takes 1 out per pair of rows, plus rows that can never be recorded.
{
  const file = path.join(dir, 'many-imports.jsonl');
  const csv = path.join(dir, 'many-imports.csv');
  const rows = ['item,type,quantity'];
  for (let i = 0; i < 250; i += 1) { rows.push(`item-${i % 10},in,2`); rows.push(i % 25 === 0 ? `item-${i % 10},in,nonsense` : `item-${i % 10},out,1`); }
  fs.writeFileSync(csv, `${rows.join('\n')}\n`);
  const t = performance.now();
  const runs = await Promise.all(Array.from({ length: 8 }, () => worker(file, 'import', 3, csv)));
  const ms = performance.now() - t;
  const done = sum(runs, 'ok');
  let movements = []; let readError = null;
  try { movements = readMovements(file); } catch (err) { readError = err.message; }
  // Every import that ran recorded 250 in + 240 out and rejected 10. Imports never interleave: within each
  // block of 490 lines the items follow the file's own order.
  const blocksWhole = movements.length % 490 === 0 && Array.from({ length: movements.length / 490 }, (_, b) => movements.slice(b * 490, b * 490 + 490))
    .every((block) => block[0].type === 'in' && new Set(block.map((m) => m.at)).size === 1 && block.filter((m) => m.type === 'in').length === 250);
  const total = [...quantities(movements).values()].reduce((a, b) => a + b, 0);
  report('8 processes x 3 imports of one 500-row file at once: every import is in the ledger whole, none interleaved, none lost',
    readError === null && done + sum(runs, 'LOCKED') === 24 && movements.length === done * 490 && blocksWhole && total === done * 260
      && sum(runs, 'recorded') === done * 490 && sum(runs, 'rejected:BAD_QUANTITY') === done * 10
      && otherKeys(runs, ['ok', 'recorded', 'rejected:BAD_QUANTITY', 'LOCKED']).length === 0 && runs.every((r) => r.code === 0) && lowestPoint(movements) === 0 && !fs.existsSync(`${file}.lock`),
    `imports done ${done} of 24, refused LOCKED ${sum(runs, 'LOCKED')}, other outcomes ${JSON.stringify(otherKeys(runs, ['ok', 'recorded', 'rejected:BAD_QUANTITY', 'LOCKED']))}; lines ${movements.length} (expected ${done * 490}); every block of 490 lines is one import: ${blocksWhole}; total stock ${total} (expected ${done * 260}); read error ${readError}; lock left behind: ${fs.existsSync(`${file}.lock`)}; ${ms.toFixed(0)} ms`);
}

// 3. Imports racing single movements and readers. The stock rule must hold at every line, and a reader
//    that takes no lock (qty and the reports do not) must never see a half-written import.
{
  const file = path.join(dir, 'race.jsonl');
  const csv = path.join(dir, 'race.csv');
  // 4,000 rows: about 190 KB appended in one write, far more than one line.
  fs.writeFileSync(csv, `item,type,quantity\n${Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? `widget-with-a-long-name-${i % 50},in,3` : `widget-with-a-long-name-${(i - 1) % 50},out,2`)).join('\n')}\n`);
  const runs = await Promise.all([
    worker(file, 'import', 12, csv), worker(file, 'import', 12, csv),
    worker(file, 'in', 150, 'single-a'), worker(file, 'in', 150, 'single-b'),
    ...Array.from({ length: 4 }, () => worker(file, 'read', 300, '-')),
  ]);
  const importers = runs.slice(0, 2); const singles = runs.slice(2, 4); const readers = runs.slice(4);
  const movements = readMovements(file);
  const imported = sum(importers, 'ok'); const single = sum(singles, 'ok');
  const now = quantities(movements);
  const widgetTotal = [...now].filter(([item]) => item.startsWith('widget')).reduce((n, [, qty]) => n + qty, 0);
  const readerBad = otherKeys(readers, ['ok']);
  report('2 processes x 12 imports of 4,000 rows, 2 x 150 single movements and 4 x 300 lock-free reads, all at once: nothing lost, stock never below zero, no reader saw half an import',
    movements.length === imported * 4000 + single && widgetTotal === imported * 2000 && (now.get('single-a') ?? 0) + (now.get('single-b') ?? 0) === single
      && lowestPoint(movements) === 0 && readerBad.length === 0 && sum(readers, 'ok') === 1200
      && otherKeys(importers, ['ok', 'recorded', 'LOCKED']).length === 0 && otherKeys(singles, ['ok', 'LOCKED']).length === 0,
    `imports done ${imported} of 24 (LOCKED ${sum(importers, 'LOCKED')}); single movements done ${single} of 300 (LOCKED ${sum(singles, 'LOCKED')}); lines ${movements.length} (expected ${imported * 4000 + single}); lowest stock at any line ${lowestPoint(movements)}; reads ok ${sum(readers, 'ok')} of 1200, other read outcomes ${JSON.stringify(readers.map((r) => r.tally))}`);
}

// 4. A lock left behind, and a damaged ledger: the whole import is refused, nothing written, no rejects file left.
{
  const cwd = fs.mkdtempSync(path.join(dir, 'refused-'));
  const run = cliIn(cwd);
  run(['in', 'widget', '5']);
  fs.writeFileSync(path.join(cwd, 'moves.csv'), 'item,type,quantity\nwidget,in,1\nwidget,in,x\n');
  const ledger = path.join(cwd, 'stock-ledger.jsonl');
  const before = fs.readFileSync(ledger, 'utf8');
  fs.writeFileSync(`${ledger}.lock`, '');   // what a killed writer leaves behind
  const t = performance.now();
  const blocked = run(['import', 'moves.csv', '--rejects', 'r.csv']);
  const ms = performance.now() - t;
  const unchangedWhileLocked = fs.readFileSync(ledger, 'utf8') === before && !fs.existsSync(path.join(cwd, 'r.csv'));
  fs.unlinkSync(`${ledger}.lock`);
  fs.appendFileSync(ledger, '{"at":"2026-01-01T00:00:00.000Z","item":"widg');
  const damagedText = fs.readFileSync(ledger, 'utf8');
  const damaged = run(['import', 'moves.csv', '--rejects', 'r.csv']);
  const unchangedWhileDamaged = fs.readFileSync(ledger, 'utf8') === damagedText && !fs.existsSync(path.join(cwd, 'r.csv')) && !fs.existsSync(`${ledger}.lock`);
  fs.writeFileSync(ledger, before);
  const after = run(['import', 'moves.csv', '--rejects', 'r.csv']);
  report('a lock left behind, then a half-written ledger line: the import is refused whole (not hung, not forced), and works again once the cause is removed',
    blocked.status === 1 && /locked/.test(blocked.stderr) && unchangedWhileLocked && damaged.status === 1 && /line 2 is not valid JSON/.test(damaged.stderr) && unchangedWhileDamaged
      && after.status === 3 && after.stdout === 'imported 1 movement from moves.csv; rejected 1 of 2 rows\n' && fs.readFileSync(path.join(cwd, 'r.csv'), 'utf8') === 'item,type,quantity\nwidget,in,x\n',
    `locked: exit ${blocked.status} after ${ms.toFixed(0)} ms, ledger and folder unchanged: ${unchangedWhileLocked}; damaged: exit ${damaged.status}, unchanged: ${unchangedWhileDamaged}; afterwards: exit ${after.status} "${after.stdout.trim()}"`);
}

// 5. Awkward CSV files, through the library: [name, CSV text, items recorded "item:qty", rejected lines, or the code the whole file is refused with].
{
  const H = 'item,type,quantity\n';
  const cases = [
    ['header only', H, '', '', null],
    ['header with no line end', 'item,type,quantity', '', '', null],
    ['no final line end', `${H}widget,in,5`, 'widget:5', '', null],
    ['old Mac line ends (CR only)', 'item,type,quantity\rwidget,in,5\rbolt,in,2\r', 'widget:5 bolt:2', '', null],
    ['mixed line ends and blank lines', 'item,type,quantity\r\n\r\nwidget,in,5\n\n   \nbolt,in,2\r', 'widget:5 bolt:2', '', null],
    ['byte-order mark', `﻿${H}widget,in,5\n`, 'widget:5', '', null],
    // The second mark counts as a space round the first column name, and spaces round a field are dropped.
    ['two byte-order marks', `﻿﻿${H}widget,in,5\n`, 'widget:5', '', null],
    ['the header twice', `${H}${H}widget,in,5\n`, 'widget:5', '2', null],
    ['every field quoted', '"item","type","quantity"\n"widget","in","5"\n', 'widget:5', '', null],
    ['quoted field with comma, quote and line break', `${H}"a,b",in,1\n"6"" nail",in,2\n"two\nlines",in,3\nbolt,in,4\n`, 'a,b:1 6" nail:2 bolt:4', '4', null],
    ['unclosed quote in the last row', `${H}widget,in,5\nbolt,in,"2\n`, 'widget:5', '3', null],
    ['unclosed quote in the first row swallows the rest', `${H}"widget,in,5\nbolt,in,2\nnut,in,3\n`, '', '2', null],
    ['a quote closing an unclosed one many lines later', `${H}a,in,"1\nb,in,2\nc,in,"3\nd,in,4\n`, 'd:4', '2', null],
    ['item that is only a quoted space', `${H}" ",in,5\n`, '', '2', null],
    ['item that is JSON', `${H}"{""item"":""x""}",in,1\n`, '{"item":"x"}:1', '', null],
    ['item named like a built-in property', `${H}__proto__,in,1\nconstructor,in,2\ntoString,in,3\n`, '__proto__:1 constructor:2 tostring:3', '', null],
    ['item of 30,000 characters', `${H}${'x'.repeat(30000)},in,1\n`, `${'x'.repeat(30000)}:1`, '', null],
    ['unicode item in two cases is one item', `${H}Größe ④ 🧰,in,3\nGRÖßE ④ 🧰,in,1\n`, 'größe ④ 🧰:4', '', null],
    ['a NUL in a row', `${H}wid\u0000get,in,1\nbolt,in,2\n`, 'bolt:2', '2', null],
    ['a tab inside an item', `${H}wid\tget,in,1\n`, '', '2', null],
    ['a formula, as a spreadsheet attack would write it', `${H}"=cmd|' /C calc'!A0",in,1\n`, "=cmd|' /c calc'!a0:1", '', null],
    ['quantity with a thousands comma, unquoted then quoted', `${H}widget,in,1,000\nwidget,in,"1,000"\n`, '', '2 3', null],
    ['quantity 0, negative, decimal, exponent, hex, plus, leading zero, empty', `${H}${['0', '-5', '5.0', '1e3', '0x10', '+5', '05', ''].map((q) => `w,in,${q}`).join('\n')}\n`, '', '2 3 4 5 6 7 8 9', null],
    ['largest quantity, then one more', `${H}big,in,9007199254740991\nbig,in,1\nbig,out,9007199254740991\nbig,in,1\n`, 'big:1', '3', null],
    ['quantity of 400 digits', `${H}w,in,${'9'.repeat(400)}\n`, '', '2', null],
    ['quantity in Arabic-Indic and full-width digits', `${H}w,in,٥\nw,in,５\n`, '', '2 3', null],
    ['type in other languages and spellings', `${H}w,IN,1\nw, Out ,1\nw,input,1\nw,+,1\nw,,1\n`, 'w:0', '4 5 6', null],
    ['out before in, then in, then out', `${H}w,out,1\nw,in,1\nw,out,1\nw,out,1\n`, 'w:0', '2 5', null],
    ['too few and too many fields', `${H}w\nw,in\nw,in,1,\nw,in,1,2,3\n,,\n`, '', '2 3 4 5 6', null],
    ['50,000 commas on one line', `${H}${','.repeat(50000)}\nw,in,1\n`, 'w:1', '2', null],
    ['one field of a million characters', `${H}"${'y'.repeat(1000000)}",in,1\n`, `${'y'.repeat(1000000)}:1`, '', null],
    ['empty file', '', null, null, 'BAD_CSV'],
    ['only spaces and line ends', ' \n\r\n\t\n', null, null, 'BAD_CSV'],
    ['no header', 'widget,in,5\n', null, null, 'BAD_CSV'],
    ['header with a fourth column', 'item,type,quantity,date\nw,in,1,2026-01-01\n', null, null, 'BAD_CSV'],
    ['header with an empty fourth column (a trailing comma)', 'item,type,quantity,\nw,in,1,\n', null, null, 'BAD_CSV'],
    ['header missing a column', 'item,quantity\nw,1\n', null, null, 'BAD_CSV'],
    ['header names a column twice', 'item,qty,quantity\nw,1,1\n', null, null, 'BAD_CSV'],
    ['semicolons', 'item;type;quantity\nw;in;1\n', null, null, 'BAD_CSV'],
    ['tabs', 'item\ttype\tquantity\nw\tin\t1\n', null, null, 'BAD_CSV'],
    ['a ledger file given as the CSV', '{"at":"2026-01-01T00:00:00.000Z","item":"widget","type":"in","qty":5}\n', null, null, 'BAD_CSV'],
    ['binary rubbish', '\u0000\u0001\u0002�\n', null, null, 'BAD_CSV'],
  ];
  const lines = []; let allOk = true;
  cases.forEach(([name, text, wantStock, wantRejected, wantCode], index) => {
    const file = path.join(dir, `awkward-${index}.jsonl`);
    let got = null; let rejected = null; let code = null; let counted = true;
    try {
      const result = importCsvText(file, text, { name: 'x.csv' });
      got = [...quantities(readMovements(file))].map(([item, qty]) => `${item}:${qty}`).join(' ');
      rejected = result.rejected.map((r) => r.line).join(' ');
      counted = result.rows === result.recorded.length + result.rejected.length && result.rows === parseCsv(text).length - 1;
    } catch (err) { code = err.code ?? `CRASH:${err.message}`; }
    const ok = wantCode ? (code === wantCode && !fs.existsSync(file)) : (code === null && got === wantStock && rejected === wantRejected && counted);
    allOk &&= ok && !fs.existsSync(`${file}.lock`);
    const show = (s) => (s.length > 60 ? `${s.slice(0, 40)}… (${s.length} characters)` : s);
    lines.push(`${ok ? 'ok ' : 'BAD'} ${name}: ${code ?? `stock [${show(got)}] rejected lines [${rejected}]`}`);
  });
  report(`${cases.length} awkward CSV files behave as the README says, and every row is counted once as recorded or rejected`, allOk, lines.join('\n      '));
}

// 6. Files in the wrong encoding, as bytes on disk.
{
  const file = path.join(dir, 'encoding.jsonl');
  const lines = []; let allOk = true;
  const tryBytes = (name, bytes, wantStock, wantRejected, wantCode) => {
    const csv = path.join(dir, 'encoding.csv');
    fs.writeFileSync(csv, bytes);
    fs.rmSync(file, { force: true });
    let got = null; let rejected = null; let code = null;
    try { rejected = importCsv(file, csv).rejected.map((r) => r.line).join(' '); got = [...quantities(readMovements(file))].map(([item, qty]) => `${item}:${qty}`).join(' '); } catch (err) { code = err.code ?? `CRASH:${err.message}`; }
    const ok = wantCode ? code === wantCode && !fs.existsSync(file) : code === null && got === wantStock && rejected === wantRejected;
    allOk &&= ok;
    lines.push(`${ok ? 'ok ' : 'BAD'} ${name}: ${code ?? `stock [${got}] rejected lines [${rejected}]`}`);
  };
  const text = 'item,type,quantity\nwidget,in,1\nGröße,in,2\nbolt,in,3\n';
  tryBytes('UTF-8', Buffer.from(text, 'utf8'), 'widget:1 größe:2 bolt:3', '', null);
  tryBytes('Windows-1252 (Excel "CSV"): only the row with the accented item is rejected', Buffer.from(text, 'latin1'), 'widget:1 bolt:3', '3', null);
  tryBytes('UTF-16 little-endian with byte-order mark (Excel "Unicode Text")', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]), null, null, 'BAD_CSV');
  tryBytes('UTF-16 little-endian without byte-order mark', Buffer.from(text, 'utf16le'), null, null, 'BAD_CSV');
  tryBytes('UTF-8 cut off in the middle of a character at the end of the file', Buffer.from('item,type,quantity\nwidget,in,1\nGrö', 'utf8').subarray(0, -1), 'widget:1', '3', null);
  tryBytes('a zip file renamed .csv', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xff, 0xfe, 0x0a, 0x00]), null, null, 'BAD_CSV');
  report('files in the wrong encoding: a bad row is rejected, a file that is not text is refused, nothing is recorded under a mangled name', allOk, lines.join('\n      '));
}

// 7. Awkward use of the real command line.
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
  const good = 'item,type,quantity\nwidget,in,5\n';
  const mixed = 'item,type,quantity\nwidget,in,5\nwidget,in,x\n';
  fs.writeFileSync(path.join(cwd, 'good.csv'), good);
  fs.writeFileSync(path.join(cwd, 'mixed.csv'), mixed);
  fs.writeFileSync(path.join(cwd, '--odd.csv'), good);
  fs.writeFileSync(path.join(cwd, 'blue widgets ④.csv'), good);
  fs.mkdirSync(path.join(cwd, 'folder.csv'));
  expect('a clean file', run(['import', 'good.csv']), 0, /^imported 1 movement from good\.csv\n$/);
  expect('the same file again is recorded again (rule 24)', run(['import', 'good.csv']), 0, /^imported 1 movement/);
  expect('a CSV whose name starts with dashes, after --', run(['import', '--', '--odd.csv']), 0, /imported 1 movement from --odd\.csv/);
  expect('a CSV whose name has spaces and unicode', run(['import', 'blue widgets ④.csv']), 0, /imported 1 movement from blue widgets ④\.csv/);
  expect('the CSV is a folder', run(['import', 'folder.csv']), 1, /cannot use CSV file/);
  expect('the CSV does not exist', run(['import', 'nope.csv']), 1, /cannot use CSV file/);
  expect('the CSV is the ledger itself', run(['import', 'stock-ledger.jsonl']), 1, /must name the columns/);
  expect('the CSV is the ledger itself, by --file', run(['import', 'good.csv', '--file', 'good.csv']), 1, /good\.csv line 1 is not valid JSON/);
  expect('the rejects file is the CSV being imported', run(['import', 'mixed.csv', '--rejects', 'mixed.csv']), 1, /already exists and is not overwritten/);
  expect('the rejects file is the CSV being imported, other case and ./', run(['import', 'mixed.csv', '--rejects', './MIXED.CSV']), 1, /already exists and is not overwritten|cannot use rejects file/);
  expect('the rejects file is the ledger', run(['import', 'mixed.csv', '--rejects', 'stock-ledger.jsonl']), 1, /must end in \.csv/);
  expect('the rejects file is a ledger that does not exist yet and is named .csv', run(['import', 'mixed.csv', '--file', 'new.csv', '--rejects', 'NEW.csv']), 1, /must not be the ledger file|already exists/);
  expect('the rejects file is the ledger lock', run(['import', 'mixed.csv', '--rejects', 'stock-ledger.jsonl.lock']), 1, /must end in \.csv/);
  expect('the rejects file is a folder', run(['import', 'mixed.csv', '--rejects', 'folder.csv']), 1, /already exists and is not overwritten/);
  expect('the rejects folder does not exist', run(['import', 'mixed.csv', '--rejects', 'no/such/r.csv']), 1, /cannot use rejects file/);
  expect('--rejects given twice: the last one is used', run(['import', 'mixed.csv', '--rejects', 'first.csv', '--rejects', 'second.csv']), 3, /rejected rows were written to second\.csv/);
  expect('--rejects with a clean file leaves no file', run(['import', 'good.csv', '--rejects', 'clean.csv']), 0, /^imported 1 movement from good\.csv\n$/);
  expect('--rejects with another command', run(['qty', 'widget', '--rejects', 'r.csv']), 2, /--rejects is only for "import"/);
  expect('two CSV files', run(['import', 'good.csv', 'mixed.csv']), 2, /needs exactly one CSV file/);
  expect('no CSV file', run(['import']), 2, /needs exactly one CSV file/);
  expect('the ledger folder does not exist', run(['import', 'good.csv', '--file', 'no/such/x.jsonl']), 1, /cannot use ledger file/);
  const ro = path.join(cwd, 'ro.jsonl');
  fs.writeFileSync(ro, ''); fs.chmodSync(ro, 0o444);
  expect('read-only ledger file', run(['import', 'mixed.csv', '--file', ro, '--rejects', 'ro-rejects.csv']), 1, /cannot use ledger file/);
  fs.chmodSync(ro, 0o666);
  const left = fs.readdirSync(cwd).sort();
  const wantLeft = ['--odd.csv', 'blue widgets ④.csv', 'folder.csv', 'good.csv', 'mixed.csv', 'ro.jsonl', 'second.csv', 'stock-ledger.jsonl'];
  const leftOk = JSON.stringify(left) === JSON.stringify(wantLeft);
  allOk &&= leftOk;
  lines.push(`${leftOk ? 'ok ' : 'BAD'} no stray file, lock or empty rejects file left by any of the above: ${left.join(' | ')}`);
  const unchanged = fs.readFileSync(path.join(cwd, 'mixed.csv'), 'utf8') === mixed && fs.readFileSync(path.join(cwd, 'good.csv'), 'utf8') === good;
  allOk &&= unchanged;
  lines.push(`${unchanged ? 'ok ' : 'BAD'} the CSV files themselves are untouched`);
  expect('qty after all of the above: 5 good imports of 5', run(['qty', 'widget']), 0, /^widget: 30\n$/);
  report('awkward use of the command line: refused or handled, never a crash with a stack trace, never a file overwritten', allOk, lines.join('\n      '));
}

// 8. The command killed in the middle of imports, twenty times: what is in the ledger is always whole lines of one import.
{
  const file = path.join(dir, 'killed.jsonl');
  const csv = path.join(dir, 'killed.csv');
  fs.writeFileSync(csv, `item,type,quantity\n${Array.from({ length: 30000 }, (_, i) => `widget-${i % 100},in,1`).join('\n')}\n`);
  let kills = 0; let readError = null;
  for (let round = 0; round < 20; round += 1) {
    const child = spawn(process.execPath, [ENTRY, 'import', csv, '--file', file], { stdio: 'ignore' });
    await new Promise((resolve) => { setTimeout(() => { if (child.kill('SIGKILL')) kills += 1; }, 20 + round * 12); child.on('close', resolve); });
    fs.rmSync(`${file}.lock`, { force: true });   // what a person has to do after a kill (known limit)
  }
  let count = 0;
  try { count = readMovements(file).length; } catch (err) { readError = err.message; }
  report('the import killed part-way, 20 times at different moments: the ledger is still readable and holds only whole imports',
    readError === null && count % 30000 === 0,
    `kill signals delivered ${kills} of 20; movements in the ledger ${count} (${count / 30000} whole imports of 30,000); read error ${readError}. This check cannot choose the instant of the kill: it shows no damage in these 20 runs, not that damage is impossible.`);
}

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length} of ${results.length} stress checks passed`);
process.exit(failed.length ? 1 : 0);
