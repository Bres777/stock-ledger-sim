# stock-ledger

A small command-line stock ledger. Throwaway project, built in stages by separate workers.

Stages: 1. Movements and quantities (built) — 2. Reports (built) — 3. CSV import (not built).

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

Which ledger file is used, first match wins:

1. `--file <path>` (or `--file=<path>`) on the command line;
2. the `STOCK_LEDGER_FILE` environment variable;
3. `stock-ledger.jsonl` in the folder the command is run from.

A relative path is taken from the folder the command is run from. The file is created by the first movement.
The folder it is in must already exist.

Levels and prices are kept in a second file beside the ledger: the ledger file's name with `.items.jsonl`
added (`stock-ledger.jsonl.items.jsonl`). It follows whichever ledger file is chosen and is created by the
first `level` or `price`. Move or copy the two files together.

Only `--file`, `--help` (or `-h`) and `--` are options. Put `--` before an item whose name starts with `--`.
An item name with spaces needs quotes: `in "blue widget" 5`.

Exit codes: `0` done · `1` the ledger refused (reason on the error stream, nothing written) · `2` the command
was not understood (usage on the error stream, nothing written).

## Test

```
npm test
```

runs `node --test`: `test/ledger.test.js` (the library) and `test/cli.test.js` (the real entry point, started
as a separate process). One test waits 5 seconds on purpose (the locked-ledger test). Stage 2 added
`test/items.test.js` (levels and prices), `test/reports.test.js` (the two reports) and
`test/reports-cli.test.js` (the four new commands through the real entry point), and left the two stage 1
test files as they were.

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
amounts beyond what a JavaScript number can count, damaged items files and awkward input.

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
                             return the report. Touches no file.
```

The movements and the settings are the only state there is. For a report, `src/cli.js` does this and nothing
more: `lowStock(quantities(readMovements(file)), readSettings(itemsFileFor(file)))`, and the same with
`stockValue`.

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

Stage 2 did not change this file or its format in any way.

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
6. **Refused means nothing was written.** A movement is written whole or not at all.
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

`LedgerError` codes: `BAD_ITEM`, `BAD_QUANTITY`, `BAD_TYPE`, `BAD_TIME`, `INSUFFICIENT_STOCK`,
`QUANTITY_TOO_LARGE`, `DAMAGED_LEDGER`, `LOCKED`, `FILE_ERROR`; from stage 2 also `BAD_LEVEL`, `BAD_PRICE`,
`BAD_SETTING`, `DAMAGED_ITEMS`, `NEGATIVE_STOCK`. All are refusals: exit code `1`.

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
- **Stage 3 (CSV import) has no way yet to bring in levels or prices in bulk**; `recordSetting()` is the
  function to call, one setting at a time, and it reads the whole items file each time.
- **Lower-casing follows JavaScript's `toLowerCase()`,** which is not the same as "equal to a human reader" in
  every language.
