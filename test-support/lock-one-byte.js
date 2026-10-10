// Stage 6. The one lock helper for the two append-failure tests (test/append-failure.test.js, stage 4, and
// test/items-append-failure.test.js, stage 5). Each held a copy; this is that copy, lifted out, with the
// stage-5 signature. It lives outside test/ on purpose: `node --test` with no arguments runs every .js file
// under a folder named test as a test file and counts it, so a helper there would be reported as a test.
// Nothing in src/ knows this file exists; only tests import it.

import { spawn } from 'node:child_process';

// Holds a lock on ONE byte of the file, at `offset`, from another process, until release() is called.
// Windows refuses any read or write that would cover a byte another process has locked. The file under
// test is far shorter than the offset and Node's read of it stops well before that byte, so the file still
// opens and is still read; an append long enough to reach that byte is refused at the write. An append
// that ends before that byte is not affected. (What this would miss: a Node whose read reaches further
// past the end of the file than the offset would be refused at the read, not the write; each test asserts
// the read first, so that shows up as a failed read with EBUSY, not as a false pass.) Windows only: the
// lock is held by powershell.exe, so the tests that use this helper are skipped off Windows.
//
// The script starts with $ErrorActionPreference='Stop' (stage 6 review, H-1): without it a failed Open or
// Lock is only an error record, the script goes on and prints HELD, and the helper would resolve without
// holding anything. With it the script stops there, prints nothing, and the helper rejects with the
// system's reason ("the lock helper ended before it held the lock: Could not find file ...").
export async function lockOneByte(file, offset) {
  const script = `$ErrorActionPreference='Stop';$f=[IO.File]::Open($env:STOCK_LEDGER_TEST_FILE,'Open','ReadWrite','ReadWrite,Delete');$f.Lock(${offset},1);[Console]::Out.WriteLine('HELD');[Console]::Out.Flush();[void][Console]::In.ReadLine();$f.Close()`;
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
