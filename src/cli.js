// The command line. Exit codes: 0 done, 1 refused by the ledger, 2 command not understood.

import path from 'node:path';
import { DEFAULT_LEDGER_FILE, LedgerError, normalizeItem, quantityOf, readMovements, recordMovement } from './ledger.js';

export const USAGE = `Usage:
  stock-ledger in  <item> <quantity>   record goods in
  stock-ledger out <item> <quantity>   record goods out
  stock-ledger qty <item>              show the item's current quantity

Options:
  --file <path>   ledger file to use. Otherwise the STOCK_LEDGER_FILE environment
                  variable, otherwise ${DEFAULT_LEDGER_FILE} in the current folder.
  --help          show this text
`;

class UsageError extends Error {}

// Only --file, --help and -- are options. Anything else, including "-5", is a plain word,
// so a negative quantity is refused as a quantity and not misread as an option.
function parseArgs(argv) {
  const words = [];
  let file;
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
    } else {
      throw new UsageError(`unknown option ${arg}`);
    }
  }
  if (file === '') throw new UsageError('--file needs a path');
  return { words, file, help };
}

export function run(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { words, file: fileOption, help } = parseArgs(argv);
    if (help) {
      stdout.write(USAGE);
      return 0;
    }
    const [command, ...rest] = words;
    const file = path.resolve(cwd, fileOption ?? (env.STOCK_LEDGER_FILE || DEFAULT_LEDGER_FILE));

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
