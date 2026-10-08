# stock-ledger

A small command-line stock ledger. Throwaway project, built in stages by separate workers.

Stages: 1. Movements and quantities (built) — 2. Reports (not built) — 3. CSV import (not built).

Plain Node.js, ES modules, no dependencies. Written and tested on Node v22.20.0, Windows 10.

## Use

```
node bin/stock-ledger.js in  <item> <quantity>     record goods in
node bin/stock-ledger.js out <item> <quantity>     record goods out
node bin/stock-ledger.js qty <item>                show the item's current quantity
```

```
> node bin/stock-ledger.js in widget 10
recorded in 10 widget; quantity now 10
> node bin/stock-ledger.js out widget 3
recorded out 3 widget; quantity now 7
> node bin/stock-ledger.js qty widget
widget: 7
```

Which ledger file is used, first match wins:

1. `--file <path>` (or `--file=<path>`) on the command line;
2. the `STOCK_LEDGER_FILE` environment variable;
3. `stock-ledger.jsonl` in the folder the command is run from.

A relative path is taken from the folder the command is run from. The file is created by the first movement.
The folder it is in must already exist.

Only `--file`, `--help` (or `-h`) and `--` are options. Put `--` before an item whose name starts with `--`.
An item name with spaces needs quotes: `in "blue widget" 5`.

Exit codes: `0` done · `1` the ledger refused (reason on the error stream, nothing written) · `2` the command
was not understood (usage on the error stream, nothing written).

## Test

```
npm test
```

runs `node --test`: `test/ledger.test.js` (the library) and `test/cli.test.js` (the real entry point, started
as a separate process). One test waits 5 seconds on purpose (the locked-ledger test).

## The parts and how they connect

```
bin/stock-ledger.js   entry point. Passes the arguments to run() and sets the exit code. Nothing else.
        |
src/cli.js            run(argv, {env, cwd, stdout, stderr}) -> exit code. Reads the arguments, chooses the
        |             ledger file, calls the ledger, prints. Holds no stock logic.
        |
src/ledger.js         all stock logic and the only code that touches the ledger file.
        |
<ledger file>         the movements. The only state there is.
```

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

`LedgerError` codes: `BAD_ITEM`, `BAD_QUANTITY`, `BAD_TYPE`, `BAD_TIME`, `INSUFFICIENT_STOCK`,
`QUANTITY_TOO_LARGE`, `DAMAGED_LEDGER`, `LOCKED`, `FILE_ERROR`.

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
- **No list of items and no history on the command line.** `qty` shows one item. (`quantities()` and
  `readMovements()` exist in the library for stage 2.)
- **Lower-casing follows JavaScript's `toLowerCase()`,** which is not the same as "equal to a human reader" in
  every language.
