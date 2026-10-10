# stock-ledger

A small command-line stock ledger. Throwaway project, built in stages by separate workers.

Stages: 1. Movements and quantities (built) — 2. Reports (built) — 3. CSV import (built) — 4. What a batch
write does and does not promise: rules 6, 18 and 23 reworded, and a test of a failed append (built; no change
to how the tool behaves).

Plain Node.js, ES modules, no dependencies. Written and tested on Node v22.20.0, Windows 10.

## Use

```
node bin/stock-ledger.js in  <item> <quantity>     record goods in
node bin/stock-ledger.js out <item> <quantity>     record goods out
node bin/stock-ledger.js qty <item>                show the item's current quantity
node bin/stock-ledger.js level <item> <number>     set the item's re-order level (0 switches it off)
node bin/stock-ledger.js price <item> <amount>     set the item's unit price, such as 12.50
node bin/stock-ledger.js low                       report: items below their re-order level
node bin/stock-ledger.js value                     report: the value of the stock, per item and in total
node bin/stock-ledger.js import <csv file>         record the movements in a CSV file; bad rows are rejected
```

```
> node bin/stock-ledger.js in widget 10
recorded in 10 widget; quantity now 10
> node bin/stock-ledger.js out widget 3
recorded out 3 widget; quantity now 7
> node bin/stock-ledger.js qty widget
widget: 7
```

### The reports (stage 2)

A report needs facts the movements do not hold: what level an item should not fall below, and what one unit
of it is worth. Set them per item with `level` and `price`; set them again to change them.

```
> node bin/stock-ledger.js in bolt 100
recorded in 100 bolt; quantity now 100
> node bin/stock-ledger.js in gadget 4
recorded in 4 gadget; quantity now 4
> node bin/stock-ledger.js level widget 10
re-order level of widget set to 10
> node bin/stock-ledger.js level bolt 100
re-order level of bolt set to 100
> node bin/stock-ledger.js level nut 2
re-order level of nut set to 2
> node bin/stock-ledger.js price widget 12.5
price of widget set to 12.50
> node bin/stock-ledger.js price bolt 0.25
price of bolt set to 0.25
> node bin/stock-ledger.js low
nut: 0 (re-order level 2)
widget: 7 (re-order level 10)
2 items below their re-order level
> node bin/stock-ledger.js value
bolt: 100 x 0.25 = 25.00
widget: 7 x 12.50 = 87.50
gadget: 4 x (no price) = not counted
total: 112.50 (excludes 1 item with no price)
```

In that example `bolt` is exactly at its level, so it is not listed; `nut` has a level and has never come in,
so it is listed with 0; `gadget` has no level, so `low` leaves it out, and no price, so `value` shows it as
not counted and says so on the total line. `value` also writes `stock-ledger: the total excludes 1 item with
no price` on the error stream, and still exits `0`.

With nothing to report, `low` prints `no items below their re-order level` (adding `(no re-order levels are
set)` when that is why) and `value` prints `total: 0.00`. Both lists are sorted by item name.

### Importing a CSV file (stage 3)

`import` records many movements from one file. The file is CSV: a first line naming the columns `item`, `type`
and `quantity`, then one movement per line. Given `moves.csv`:

```
item,type,quantity
widget,in,20
bolt,out,40
"blue, widget",in,5
gadget,out,9
nut,in,12.5
washer,in
```

```
> node bin/stock-ledger.js import moves.csv --rejects rejects.csv
stock-ledger: moves.csv line 5 rejected: cannot take 9 of "gadget" out: only 4 in stock at that point
stock-ledger: moves.csv line 6 rejected: quantity must be a whole number of 1 or more, written in digits only (got "12.5")
stock-ledger: moves.csv line 7 rejected: the row has 2 fields, the header has 3
imported 3 movements from moves.csv; rejected 3 of 6 rows
stock-ledger: 3 of 6 rows rejected and not in the ledger. The other 3 are recorded: do not import moves.csv again, correct the rejected rows and import only those.
stock-ledger: the rejected rows were written to rejects.csv
> node bin/stock-ledger.js qty widget
widget: 27
> node bin/stock-ledger.js qty bolt
bolt: 60
> node bin/stock-ledger.js qty gadget
gadget: 4
```

The three good rows are in the ledger. The three bad ones are not, and each is named with its line in the CSV
and the reason. Only the line `imported …` is on the output stream; the lines starting `stock-ledger:` are on
the error stream. The exit code is `3`. With every row good the command prints only
`imported 6 movements from moves.csv` and exits `0`.

**Do not import the same file again after fixing it:** the good rows would be recorded a second time. Correct
only the rejected rows and import only those. `--rejects <path>` is there for that: it writes the rejected
rows, exactly as they were and under the same header, to a new file. The command above leaves `rejects.csv` as:

```
item,type,quantity
gadget,out,9
nut,in,12.5
washer,in
```

Correct those three lines in it, so that `rejects.csv` reads:

```
item,type,quantity
gadget,out,4
nut,in,12
washer,in,30
```

```
> node bin/stock-ledger.js import rejects.csv
imported 3 movements from rejects.csv
> node bin/stock-ledger.js qty gadget
gadget: 0
```

The rejects file is created only when a row is rejected. Its name must end in `.csv`, and a file that is already
there is never overwritten: the import is refused before anything is recorded.

What the CSV file must look like:

- **The first line names the columns**: `item`, `type` and `quantity`, in any order and any case (`qty` is
  accepted for `quantity`). A file with no such line, with a column missing, with any other column, or with the
  columns separated by semicolons or tabs is refused as a whole: exit `1`, nothing recorded.
- **`type`** is `in` or `out`, in any case. **`item`** and **`quantity`** follow rules 3 and 4 below. Spaces
  round a field are dropped. A quantity is digits only: `1,000`, `5.0` and `12.5` are rejected.
- **Quotes**: a field holding a comma or a quote is wrapped in double quotes, and a quote inside it is written
  twice: `"blue, widget"`, `"6"" nail"`. This is what a spreadsheet writes when it saves as CSV.
- **Text is UTF-8.** In Excel choose "CSV UTF-8". Lines may end the Windows or the Unix way. Lines holding only
  spaces are passed over.
- **The rows are recorded in the order of the file**, so goods must come in on an earlier line than the line
  that takes them out.

Which ledger file is used, first match wins:

1. `--file <path>` (or `--file=<path>`) on the command line;
2. the `STOCK_LEDGER_FILE` environment variable;
3. `stock-ledger.jsonl` in the folder the command is run from.

A relative path is taken from the folder the command is run from. The file is created by the first movement.
The folder it is in must already exist.

Levels and prices are kept in a second file beside the ledger: the ledger file's name with `.items.jsonl`
added (`stock-ledger.jsonl.items.jsonl`). It follows whichever ledger file is chosen and is created by the
first `level` or `price`. Move or copy the two files together.

Only `--file`, `--rejects`, `--help` (or `-h`) and `--` are options. `--rejects <path>` (or `--rejects=<path>`)
goes with `import` only; with any other command it is not understood. Put `--` before an item whose name starts
with `--`. An item name with spaces needs quotes: `in "blue widget" 5`.

The CSV file and the rejects file are separate from the ledger file: a relative path for either is taken from
the folder the command is run from, and `--file` and `STOCK_LEDGER_FILE` still choose the ledger they go into.

Exit codes: `0` done · `1` the ledger refused, or a file could not be used (reason on the error stream; nothing
written, with the one exception in "A failed append is not undone" under the known limits) · `2` the command
was not understood (usage on the error stream, nothing written) · `3` an import rejected at least one row:
every other row is recorded, and each rejected row is named on the error stream. Apart from that exception,
`3` is the only exit code after which something may have been written although something was refused.

## Test

```
npm test
```

runs `node --test`: `test/ledger.test.js` (the library) and `test/cli.test.js` (the real entry point, started
as a separate process). One test waits 5 seconds on purpose (the locked-ledger test). Stage 2 added
`test/items.test.js` (levels and prices), `test/reports.test.js` (the two reports) and
`test/reports-cli.test.js` (the four new commands through the real entry point), and left the two stage 1
test files as they were. Stage 3 added `test/csv.test.js` (the CSV reader), `test/import.test.js`
(`recordMovements` and the import, as a library; one more test that waits on purpose, 10 seconds, for two
locked-ledger checks) and
`test/import-cli.test.js` (the `import` command through the real entry point), and left the five earlier test
files as they were. Stage 4 added `test/append-failure.test.js`: two tests in which the system itself refuses
the append to the ledger file, showing what the user is told and what is in the file afterwards (rule 23). On
Windows the second one starts `powershell.exe` once, to hold a lock on the file from another process. Both
tests exist everywhere but do not run everywhere: the second is skipped off Windows, and the first is skipped
for a user who can write to a read-only file (see "Stage 4 limits"). Stage 4 left the eight earlier test
files and the three stress scripts as they were, and changed no code under `src/`: only two comments there,
above `recordMovement` and `recordSetting`, which claimed more than the code holds.

```
npm run stress
```

runs `stress/stress.mjs`, which tries to break the ledger: 50,000 movements, eight processes writing at once,
eight processes racing to take the last stock, readers during writes, a lock left behind, damaged files and
awkward input. It is not part of `npm test`; it takes about 15 seconds and prints PASS or FAIL per check.

```
npm run stress:reports
```

runs `stress/stress-reports.mjs`, the same idea for stage 2: reports over a large ledger with many items,
eight processes setting levels and prices at once, reports read while settings and movements are written,
amounts beyond what a JavaScript number can count, damaged items files and awkward input. It takes about 40
seconds and prints PASS or FAIL per check.

```
npm run stress:import
```

runs `stress/stress-import.mjs`, the same idea for stage 3: a CSV of 100,000 rows with one row in seven bad in
six different ways, checked row for row against a separate calculation; eight processes importing at once;
imports racing single movements and readers; a lock left behind and a damaged ledger; 42 awkward CSV files;
files in the wrong encoding; awkward command lines; and the command killed part-way twenty times. It takes
about 45 seconds and prints PASS or FAIL per check.

## The parts and how they connect

```
bin/stock-ledger.js   entry point. Passes the arguments to run() and sets the exit code. Nothing else.
        |
src/cli.js            run(argv, {env, cwd, stdout, stderr}) -> exit code. Reads the arguments, chooses the
        |             ledger file, calls the three modules below, prints. Holds no stock logic.
        |
        +-- src/ledger.js    all stock logic and the only code that touches the ledger file.
        |        |
        |   <ledger file>    the movements.
        |
        +-- src/items.js     levels and prices, and the only code that touches the items file.
        |        |           Uses normalizeItem, LedgerError and withLock from src/ledger.js.
        |   <ledger file>.items.jsonl    the settings.
        |
        +-- src/reports.js   the two reports. Pure functions: given quantities and settings, they
        |                    return the report. Touches no file.
        |
        +-- src/import.js    the CSV import. Reads the CSV file, checks the header, turns each row into
                 |           a movement and hands them all, in one call, to recordMovements in
                 |           src/ledger.js. Writes the rejects file. Never writes the ledger itself.
                 |
                 +-- src/csv.js    the CSV reader. Pure: text in, records out. Touches no file and
                                   knows nothing about stock.
```

The movements and the settings are the only state there is. For a report, `src/cli.js` does this and nothing
more: `lowStock(quantities(readMovements(file)), readSettings(itemsFileFor(file)))`, and the same with
`stockValue`. For an import it calls `importCsv(file, csvFile, { rejectsFile })` and prints what comes back.

The path of one imported row: `src/cli.js` → `importCsv` reads the CSV file → `parseCsv` splits it into
records → `importCsvText` checks the header and each row's shape → `recordMovements` checks item, type and
quantity with the same functions `recordMovement` uses, takes the ledger's lock, reads the ledger once, checks
each row against the stock, and appends every accepted row in one append call (rule 23).

What `src/ledger.js` exports — a later stage should build on these and not read the file itself:

| Export | What it does |
| --- | --- |
| `readMovements(file)` | All movements in the file, oldest first. A missing file is an empty ledger. |
| `parseLedgerText(text, name)` | The same, from text already in memory. |
| `quantities(movements)` | `Map` of item → current quantity, for every item that has a movement. |
| `quantityOf(movements, item)` | One item's current quantity. `0` if it has no movements. |
| `recordMovement(file, {item, type, qty, at})` | Checks, then appends one movement. Returns `{movement, quantity}`. `at` is a `Date`, default now. |
| `normalizeItem(text)`, `parseQuantity(value)` | The item and quantity rules below, on their own. |
| `LedgerError` | Every deliberate refusal. Has a `code` (list below). |
| `DEFAULT_LEDGER_FILE`, `MOVEMENT_TYPES` | `'stock-ledger.jsonl'`, `['in', 'out']`. |
| `withLock(file, action)` | Runs `action` while holding `<file>.lock` (rule 8). Exported in stage 2 for `src/items.js`. |
| `recordMovements(file, entries, {at})` | Stage 3. Many movements in one go: `entries` is a list of `{item, type, qty}`. Returns one result per entry, in the same order: `{movement, quantity}` if it was recorded, `{error}` (a `LedgerError`) if not. A bad entry never stops the others (rules 17–19). One lock, one read, one append call (rule 23); every recorded movement gets the same `at`. Throws only when the ledger itself refuses. Damaged, locked or a bad `at`: nothing was written. A file that cannot be used (`FILE_ERROR`): nothing was written if it could not be read or opened; if the append itself failed, see rule 23. |

What `src/items.js` exports:

| Export | What it does |
| --- | --- |
| `itemsFileFor(ledgerFile)` | The items file that belongs to a ledger file: the same path plus `.items.jsonl`. |
| `readSettings(file)` | `Map` of item → `{level, price}` in force. Either may be `undefined` (never set). `level` is a number, `price` is text such as `'12.50'`. A missing file is no settings. |
| `parseItemsText(text, name)` | Every setting record in the text, oldest first. |
| `settingsFrom(records)` | The same `Map`, from records already in memory. The last record for an item wins. |
| `recordSetting(file, {item, set, value, at})` | Checks, then appends one setting. `set` is `'level'` or `'price'`. Returns the stored record. |
| `parseLevel(value)`, `parsePrice(text)` | The level and price rules below, on their own. `parsePrice` returns the stored form. |
| `priceToCents(price)`, `centsToText(cents)` | `'12.50'` → `1250n` and back. Amounts are `BigInt` hundredths, never floating point. |
| `ITEMS_FILE_SUFFIX`, `SETTINGS` | `'.items.jsonl'`, `['level', 'price']`. |

What `src/reports.js` exports — both take the `Map` from `quantities()` and the `Map` from `readSettings()`:

| Export | What it does |
| --- | --- |
| `lowStock(quantities, settings)` | `[{item, quantity, level}]` for every item below its level, sorted by item. |
| `stockValue(quantities, settings)` | `{lines: [{item, quantity, price, value}], total, unpriced: [{item, quantity}]}`. `price`, `value` and `total` are amount text. Both lists sorted by item. |

What `src/import.js` exports:

| Export | What it does |
| --- | --- |
| `importCsv(ledgerFile, csvFile, {at, rejectsFile})` | Imports a CSV file. Returns `{rows, recorded, rejected, header, rejectsFile, rejectsError}`. `rows` is the number of rows, not counting the header and blank lines; `recorded` is `[{line, movement, quantity}]`; `rejected` is `[{line, code, reason, raw}]`, where `raw` is the row's own text; both in file order, and `rows` is always `recorded.length + rejected.length`. `rejectsFile` is the file the rejected rows were written to, or `undefined` if none was written. `rejectsError` is set only if rows were rejected and that file could not be written after the good rows were already recorded. Throws a `LedgerError`, with nothing written, when the whole CSV file is refused; and throws whatever `recordMovements` throws when the ledger itself refuses (see that row, above). |
| `importCsvText(ledgerFile, text, {name, at})` | The same for CSV text already in memory, without the rejects file. `name` is what the CSV is called in messages. Returns `{rows, recorded, rejected, header}`. |
| `IMPORT_COLUMNS` | `['item', 'type', 'quantity']`. |

What `src/csv.js` exports:

| Export | What it does |
| --- | --- |
| `parseCsv(text)` | `[{line, fields, raw, problem}]`, one per record, in order. `line` is the line the record starts on, from 1; `fields` are the values with quotes removed and not trimmed; `raw` is the record's own text; `problem` is `undefined`, or why its quoting cannot be trusted. A record with a problem is still returned, so one bad row never hides the next. |

## The ledger file

Text, UTF-8, one movement per line, each line one JSON object:

```
{"at":"2026-10-08T01:55:00.000Z","item":"widget","type":"in","qty":10}
{"at":"2026-10-08T01:56:10.000Z","item":"widget","type":"out","qty":3}
```

| Field | Meaning |
| --- | --- |
| `at` | When the movement was recorded: UTC, ISO 8601 text. |
| `item` | The item name in its stored form: trimmed, lower case. |
| `type` | `"in"` or `"out"`. |
| `qty` | A whole number, 1 or more. Always positive; `type` gives the direction. |

The order of the lines is the order the movements were recorded. Lines are only ever added at the end.

Stage 2 did not change this file or its format in any way. Neither did stage 3: an imported movement is a line
like any other, and nothing in the file says it came from an import. All the movements of one import carry the
same `at`, the moment of the import.

## The items file

`<ledger file>.items.jsonl`. Text, UTF-8, one setting per line, each line one JSON object:

```
{"at":"2026-10-08T02:10:00.000Z","item":"widget","set":"level","value":10}
{"at":"2026-10-08T02:10:05.000Z","item":"widget","set":"price","value":"12.50"}
```

| Field | Meaning |
| --- | --- |
| `at` | When the setting was recorded: UTC, ISO 8601 text. |
| `item` | The item name in its stored form: trimmed, lower case. The item need not have any movement yet. |
| `set` | `"level"` or `"price"`. |
| `value` | For a level: a whole number, 0 or more. For a price: text with exactly two decimals, `"12.50"`. |

Lines are only ever added at the end. The last `level` line for an item is its level and the last `price`
line is its price; earlier ones stay in the file as history and no command shows them.

## The rules

1. **A quantity is never stored.** It is always goods in minus goods out, worked out from the movements.
   There is no second copy to fall out of step.
2. **The file is append-only.** No command changes or removes a line. There is no command to correct a wrong
   movement; record the opposite movement.
3. **Item names are trimmed and lower-cased.** `Widget`, ` widget ` and `WIDGET` are one item, stored and shown
   as `widget`. Empty names and names with control characters (tab, line break) are refused.
4. **Quantities are whole numbers from 1 to 9007199254740991**, on the command line written in digits only.
   Refused: `0`, `-5`, `1.5`, `1e3`, `0x10`, `+5`, `05`, a quantity with spaces round it.
5. **Goods out can never take an item below zero.** Taking out more than is in stock is refused, and so is
   taking out an item that has never come in.
6. **Refused means nothing was written.** Every check is made before the write, so a movement the ledger
   refuses wrote nothing. This is about the checks, not about a write that fails or is cut short: see "A
   failed append is not undone" in the known limits.
7. **A line that is not a valid movement stops everything**, reading and writing, with the line number. It is
   never skipped, because skipping it would give a wrong quantity with no warning. The line must be repaired
   or removed by hand. Lines holding only spaces are passed over, a byte-order mark and Windows line ends are
   accepted, and fields the tool does not know are kept as they are.
8. **One writer at a time.** While a movement is being checked and written, a file `<ledger file>.lock`
   exists beside the ledger. Another writer waits up to 5 seconds for it, then gives up with a refusal.

Stage 2 rules:

9. **A level or price is never changed in place.** Setting it again adds a line; the last line wins. There is
   no command to remove one. A level of `0` switches the level off (nothing can be below 0); a price of `0`
   is a real price and values the item at nothing.
10. **A re-order level is a whole number from 0 to 9007199254740991**, written in digits only, like a
    quantity. **A price is digits, then optionally a point and one or two digits**: `12`, `12.5`, `12.50`,
    `0.07`; at most `90071992547409.91`. Refused: `-1`, `+1`, `1.234`, `1.`, `.5`, `1,50`, `1e3`, `05`, a
    currency sign, spaces. A price has no currency: every amount is in the same unit, whatever it is.
11. **Below means strictly less than.** An item exactly at its level is not in the `low` report. An item with
    no level is never in it. An item with a level and no movements has quantity 0 and is in it.
12. **Value is the current quantity times the item's one current price.** It is not what the goods cost when
    they came in: there is one price per item, and changing it revalues everything in stock. Amounts are
    worked out in whole hundredths, exactly, however large.
13. **An item in stock with no price is never counted as zero without saying so.** `value` lists it as
    `not counted`, says how many such items there are on the total line and on the error stream, and leaves
    it out of the total. Items with nothing in stock are not shown at all.
14. **A line in the items file that is not a valid setting stops `level`, `price`, `low` and `value`**, with
    the line number, for the same reason as rule 7: skipping it could bring back an older level or price with
    no warning. `in`, `out` and `qty` never read the items file and keep working.
15. **`value` refuses a ledger that shows an item below zero** (possible only after editing the ledger by
    hand), because a negative value would quietly reduce the total. `low` shows the quantity as it is.
16. **One writer at a time on the items file too**, with its own lock `<ledger file>.items.jsonl.lock`. It is
    a different lock from the ledger's, so a movement and a setting can be written at the same moment.

Stage 3 rules:

17. **An import records every row it can and rejects the rest.** A rejected row never stops the rows before it
    or after it. It is never passed over without a word: each one is named on the error stream with its line
    in the CSV and the reason, the output line counts them, and the exit code is `3`.
18. **Every row is counted once: as recorded or as rejected.** The number of rows is always the number recorded
    plus the number rejected. Whether a row is rejected is decided before anything is written, so a rejected
    row wrote nothing (rule 6, row by row). This is about how the rows of an import that ran to its end are
    counted and reported. It is not a promise about the ledger file when the append itself fails or is cut
    short: for that see rule 23 and the known limits.
19. **Rows are applied in the order of the file, each against the stock as the rows before it left it.** An
    `out` may use goods that an earlier row of the same file brought in. An `out` on a line before its `in` is
    rejected, as it would be on the command line. A rejected row changes nothing for the rows after it.
20. **The header must be right, or nothing is read.** It must name exactly `item`, `type` and `quantity`,
    separated by commas. A missing or unknown column is never guessed at or ignored, because a row read with
    the wrong columns is a wrong movement with no warning. The whole file is refused: exit `1`, nothing written.
21. **A row follows the rules of the command line.** Rule 3 for the item, rule 4 for the quantity, rule 5 for
    goods out. Two things are looser than on the command line: spaces round a field are dropped, and the type
    may be in any case.
22. **A row whose text cannot be trusted is rejected, not repaired.** That is a row with the wrong number of
    fields, with a quote in the wrong place, or with bytes that are not UTF-8 (which would otherwise be recorded
    under a mangled item name). A quote that is opened and never closed swallows the rest of the file, so
    everything from that line to the end is rejected as one row; the rows before it are recorded.
23. **One import is one append under one lock** (rule 8) **— not an all-or-nothing transaction.** The ledger is
    read once, the lines of every accepted row are joined into one text, and that text is given to Node in a
    single `fs.appendFileSync` call while the lock is held (how many writes Node and the system make of it
    is theirs to decide). So no writer that takes the lock — every `in`, `out` and `import` does — can put a
    movement between two rows of one import. That is all it means. The append is not undone if it fails or
    is cut short:
    - if the system refuses the append before taking any of the text, the ledger file is left as it was, and
      the command gives the system's reason on the error stream and exits `1` (tested, two real refusals:
      `test/append-failure.test.js`);
    - if the append stops part-way — the process is killed, or the system takes part of the text and then
      fails — some of the import's rows can be in the file and the last one cut off (known limits).

    A damaged or locked ledger is found before the append and refuses the whole import, as it refuses every
    write: exit `1`, nothing written.
24. **Importing the same rows twice records them twice.** The ledger does not know a row has been imported
    before. After an import that rejected rows, correct and import only the rejected rows.
25. **The rejects file is never an existing file.** `--rejects` must name a file that is not there yet and whose
    name ends in `.csv`; otherwise the import is refused before anything is recorded. It is created only when a
    row is rejected.

`LedgerError` codes: `BAD_ITEM`, `BAD_QUANTITY`, `BAD_TYPE`, `BAD_TIME`, `INSUFFICIENT_STOCK`,
`QUANTITY_TOO_LARGE`, `DAMAGED_LEDGER`, `LOCKED`, `FILE_ERROR`; from stage 2 also `BAD_LEVEL`, `BAD_PRICE`,
`BAD_SETTING`, `DAMAGED_ITEMS`, `NEGATIVE_STOCK`; from stage 3 also `BAD_CSV` (the header is wrong, or the file
is empty or not UTF-8 text) and `BAD_ROW` (rule 22). Thrown, each is a refusal: exit code `1`. In an import a
rejected row carries one of `BAD_ROW`, `BAD_ITEM`, `BAD_TYPE`, `BAD_QUANTITY`, `INSUFFICIENT_STOCK` or
`QUANTITY_TOO_LARGE` as its `code`, and is not thrown.

## Known limits

- **A crash while writing leaves the ledger refusing all commands.** If the process is killed in the middle of
  writing a line, the half line stops every later command (rule 7) until it is removed by hand. If it is
  killed while holding the lock, `<ledger file>.lock` stays and every later write is refused after 5 seconds
  until that file is deleted by hand. The tool does not clear a stale lock by itself.
- **The whole file is read for every command.** Recording a movement and showing a quantity both get slower
  as the ledger grows.
- **`qty` does not take the lock.** It reads while a writer may be appending.
- **A ledger edited by hand can show a negative quantity.** Reading does not check that stock stayed at or
  above zero at every line; only `recordMovement` enforces rule 5, at the time of writing.
- **`at` is the time of recording, from this machine's clock.** There is no way on the command line to give
  the date the goods actually moved, and no reference or note field.
- **No list of items and no history on the command line.** `qty` shows one item; `value` lists only items in
  stock and `low` only items below their level. (`quantities()` and `readMovements()` exist in the library.)
- **No command shows an item's level or price.** They appear only in the reports, or in the items file.
- **One price per item, no cost history.** `value` cannot say what the stock cost to buy, and cannot value
  stock as it was on an earlier date at the price of that date. See rule 12.
- **The two files are separate.** Moving or copying the ledger without its `.items.jsonl` file loses every
  level and price with no warning: `low` then reports nothing and `value` reports every item as not counted.
- **A report reads both files in full, without a lock,** so it gets slower as they grow, and a report run
  while writes are happening shows the state at some moment during them.
- **A lock message from the items file says "the ledger is locked by"** and names the items lock file: the
  wording comes from stage 1's lock.
- **The items file has the same crash behaviour as the ledger** (first limit above): a half-written line or a
  lock left behind must be cleared by hand.
- **The CSV import brings in movements only, not levels or prices.** There is still no way to set them in
  bulk; `recordSetting()` is the function to call, one setting at a time, and it reads the whole items file
  each time: 2,000 settings one after another took 16 seconds in the stress test.
- **A report on a ledger file that does not exist is an empty report, exit `0`,** not a refusal — the same as
  `qty`, because a missing file is an empty ledger. A mistyped `--file` therefore reports nothing below its
  level and `total: 0.00`.
- **Lower-casing follows JavaScript's `toLowerCase()`,** which is not the same as "equal to a human reader" in
  every language.

Stage 3 limits:

- **An import cannot be tried out first.** There is no way to see which rows would be rejected without
  recording the good ones, and no way to take an import back (rule 2).
- **Nothing stops the same file being imported twice** (rule 24). The warning printed after a part import is
  the only guard.
- **Only the three columns.** A CSV with a date, a note or a reference column is refused (rule 20), not
  imported without it. Every imported movement gets the time of the import as its `at`, not the date the goods
  moved.
- **Only commas.** A spreadsheet that writes CSV with semicolons, as Excel does in many European settings, is
  refused with a message naming the header line; the file has to be saved again with commas.
- **Spaces round a field are always dropped, even inside quotes,** and a space between a comma and an opening
  quote (`a, "b"`) rejects the row.
- **The whole CSV file is read into memory, and the whole ledger with it.**
- **A row's line number is the line it starts on.** For a row with a line break inside quotes that is its
  first line.
- **A rejected row with bytes that are not UTF-8 is written to the rejects file with replacement characters,**
  not with its original bytes.
- **If the rejects file cannot be written after the good rows are recorded** (a full disk), the command says so
  on the error stream and may leave that file empty; the rejected rows are still each named on the error stream.
- **When every row of a CSV fails the item, type or quantity check, the ledger is not opened at all,** so a
  damaged or locked ledger goes unreported by that import: exit `3`, nothing recorded.
- **A crash in the middle of an import can leave some of its rows written and the last one cut off,** which is
  the first limit above with more lines at stake. The stress test kills the command twenty times and has not
  seen it happen, but it cannot choose the instant of the kill, so that is not proof.
- **A reader that takes no lock (`qty`, `low`, `value`) could in principle read while an import is half
  appended** and stop on a cut-off line (rule 7); running it again would then work. In the stress test 1,200
  reads during imports of 4,000 rows each never saw it. That is not proof either.
- **A busy ledger can refuse a whole import as locked.** The lock is not a queue: with two processes importing
  and two recording single movements without pause, some imports waited the full 5 seconds and were refused
  (exit `1`, nothing written; run it again).
- **A byte-order mark or other invisible space round a column name or a field is dropped like a space.**

Stage 4 limits:

- **A failed append is not undone.** Every write to the ledger — one movement or a whole import — is one append
  call, and `src/ledger.js` has no way to take back what the system has already written. Two real failures
  are tested (`test/append-failure.test.js`), and in both the system took none of the text and the ledger file
  was left byte for byte as it was: the ledger file read-only, and, on Windows, another process holding a lock
  on a byte the write would cover. A failure after part of the text is in — a disk that fills during the write
  — could not be produced for a test and has not been seen. By the code, what the system had taken would stay
  in the file, as after a crash (the first limit above, and "A crash in the middle of an import"), and the
  command would exit `1` with `cannot use ledger file …`. That message gives the system's reason; it never says
  whether anything was written. After it, run `qty` on any item: if the ledger is damaged it says so, with the
  line.
- **The lock keeps out only writers that take it.** Every command of this tool does. Anything else that writes
  the ledger file — an editor, a script, a copy — is not held back by `<ledger file>.lock` and can write in the
  middle of an import.
- **The items file is written the same way** (`recordSetting`: one append call, not undone), so both limits
  above hold for it too. No test makes that append fail.
- **The second append-failure test runs on Windows only.** It needs a byte-range lock held by `powershell.exe`;
  on other systems it is reported as skipped. The first one is skipped for a user who can write to a read-only
  file (root).
