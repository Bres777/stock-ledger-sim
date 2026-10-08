// The command line. Exit codes: 0 done, 1 refused by the ledger, 2 command not understood,
// 3 an import that rejected at least one row (every other row is recorded).

import path from 'node:path';
import { DEFAULT_LEDGER_FILE, LedgerError, normalizeItem, quantities, quantityOf, readMovements, recordMovement } from './ledger.js';
import { itemsFileFor, readSettings, recordSetting } from './items.js';
import { lowStock, stockValue } from './reports.js';
import { importCsv } from './import.js';

export const USAGE = `Usage:
  stock-ledger in  <item> <quantity>   record goods in
  stock-ledger out <item> <quantity>   record goods out
  stock-ledger qty <item>              show the item's current quantity
  stock-ledger level <item> <number>   set the item's re-order level (0 switches it off)
  stock-ledger price <item> <amount>   set the item's unit price, such as 12.50
  stock-ledger low                     report: items below their re-order level
  stock-ledger value                   report: the value of the stock, per item and in total
  stock-ledger import <csv file>       record the movements in a CSV file with the columns
                                       item,type,quantity; a bad row is rejected, the rest recorded

Options:
  --file <path>   ledger file to use. Otherwise the STOCK_LEDGER_FILE environment
                  variable, otherwise ${DEFAULT_LEDGER_FILE} in the current folder.
                  Levels and prices are kept beside it, in <ledger file>.items.jsonl.
  --rejects <path>
                  with import: write the rejected rows to this new .csv file
  --help          show this text
`;

class UsageError extends Error {}

// Only --file, --rejects, --help and -- are options. Anything else, including "-5", is a plain word,
// so a negative quantity is refused as a quantity and not misread as an option.
function parseArgs(argv) {
  const words = [];
  let file;
  let rejects;
  let help = false;
  let optionsOver = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (optionsOver || !arg.startsWith('--')) {
      if (!optionsOver && arg === '-h') help = true;
      else words.push(arg);
    } else if (arg === '--') {
      optionsOver = true;
    } else if (arg === '--help') {
      help = true;
    } else if (arg === '--file') {
      i += 1;
      if (i >= argv.length) throw new UsageError('--file needs a path');
      file = argv[i];
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    } else if (arg === '--rejects') {
      i += 1;
      if (i >= argv.length) throw new UsageError('--rejects needs a path');
      rejects = argv[i];
    } else if (arg.startsWith('--rejects=')) {
      rejects = arg.slice('--rejects='.length);
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  if (file === '') throw new UsageError('--file needs a path');
  if (rejects === '') throw new UsageError('--rejects needs a path');
  return { words, file, rejects, help };
}

export function run(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { words, file: fileOption, rejects, help } = parseArgs(argv);
    if (help) {
      stdout.write(USAGE);
      return 0;
    }
    const [command, ...rest] = words;
    const file = path.resolve(cwd, fileOption ?? (env.STOCK_LEDGER_FILE || DEFAULT_LEDGER_FILE));
    if (rejects !== undefined && command !== 'import') throw new UsageError('--rejects is only for "import"');

    if (command === 'in' || command === 'out') {
      if (rest.length !== 2) throw new UsageError(`"${command}" needs an item and a quantity`);
      const { movement, quantity } = recordMovement(file, { item: rest[0], type: command, qty: rest[1] });
      stdout.write(`recorded ${movement.type} ${movement.qty} ${movement.item}; quantity now ${quantity}\n`);
      return 0;
    }
    if (command === 'qty') {
      if (rest.length !== 1) throw new UsageError('"qty" needs exactly one item');
      const item = normalizeItem(rest[0]);
      stdout.write(`${item}: ${quantityOf(readMovements(file), item)}\n`);
      return 0;
    }
    if (command === 'level' || command === 'price') {
      if (rest.length !== 2) throw new UsageError(`"${command}" needs an item and ${command === 'level' ? 'a number' : 'an amount'}`);
      const { item, value } = recordSetting(itemsFileFor(file), { item: rest[0], set: command, value: rest[1] });
      stdout.write(`${command === 'level' ? 're-order level' : 'price'} of ${item} set to ${value}\n`);
      return 0;
    }
    if (command === 'low') {
      if (rest.length !== 0) throw new UsageError('"low" takes no item');
      const settings = readSettings(itemsFileFor(file));
      const low = lowStock(quantities(readMovements(file)), settings);
      for (const { item, quantity, level } of low) stdout.write(`${item}: ${quantity} (re-order level ${level})\n`);
      if (low.length > 0) {
        stdout.write(low.length === 1 ? '1 item below its re-order level\n' : `${low.length} items below their re-order level\n`);
      } else if ([...settings.values()].some(({ level }) => level !== undefined)) {
        stdout.write('no items below their re-order level\n');
      } else {
        stdout.write('no items below their re-order level (no re-order levels are set)\n');
      }
      return 0;
    }
    if (command === 'value') {
      if (rest.length !== 0) throw new UsageError('"value" takes no item');
      const { lines, total, unpriced } = stockValue(quantities(readMovements(file)), readSettings(itemsFileFor(file)));
      for (const { item, quantity, price, value } of lines) stdout.write(`${item}: ${quantity} x ${price} = ${value}\n`);
      for (const { item, quantity } of unpriced) stdout.write(`${item}: ${quantity} x (no price) = not counted\n`);
      if (unpriced.length === 0) {
        stdout.write(`total: ${total}\n`);
      } else {
        // An item with no price is never counted as zero without saying so: the total line itself says it.
        const excluded = unpriced.length === 1 ? '1 item with no price' : `${unpriced.length} items with no price`;
        stdout.write(`total: ${total} (excludes ${excluded})\n`);
        stderr.write(`stock-ledger: the total excludes ${excluded}\n`);
      }
      return 0;
    }
    if (command === 'import') {
      if (rest.length !== 1) throw new UsageError('"import" needs exactly one CSV file');
      const csv = rest[0];
      const result = importCsv(file, path.resolve(cwd, csv), { rejectsFile: rejects === undefined ? undefined : path.resolve(cwd, rejects) });
      const { rows, recorded, rejected } = result;
      const movements = recorded.length === 1 ? '1 movement' : `${recorded.length} movements`;
      if (rejected.length === 0) {
        stdout.write(`imported ${movements} from ${csv}${rows === 0 ? ' (the file has no rows)' : ''}\n`);
        return 0;
      }
      // A rejected row is never passed over in silence: each one is named, with its line and the reason.
      for (const { line, reason } of rejected) stderr.write(`stock-ledger: ${csv} line ${line} rejected: ${reason}\n`);
      const ofRows = `${rejected.length} of ${rows} ${rows === 1 ? 'row' : 'rows'}`;
      stdout.write(`imported ${movements} from ${csv}; rejected ${ofRows}\n`);
      const others = recorded.length === 1 ? 'The other 1 is' : `The other ${recorded.length} are`;
      const next = recorded.length === 0 ? 'Nothing was recorded.'
        : `${others} recorded: do not import ${csv} again, correct the rejected rows and import only those.`;
      stderr.write(`stock-ledger: ${ofRows} rejected and not in the ledger. ${next}\n`);
      if (result.rejectsFile !== undefined) stderr.write(`stock-ledger: the rejected rows were written to ${rejects}\n`);
      if (result.rejectsError !== undefined) stderr.write(`stock-ledger: ${result.rejectsError}\n`);
      return 3;
    }
    throw new UsageError(command === undefined ? 'no command given' : `unknown command "${command}"`);
  } catch (err) {
    if (err instanceof UsageError) {
      stderr.write(`stock-ledger: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof LedgerError) {
      stderr.write(`stock-ledger: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}
