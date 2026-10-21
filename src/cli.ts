#!/usr/bin/env node
import { main } from './main.js';

// Writing to a closed pipe (e.g. `fshare list | head -1`) must not crash the process.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

const code = await main(process.argv.slice(2));

// Exit once stdout/stderr are flushed, even if some handle is still open.
let pending = 2;
const done = (): void => {
  pending -= 1;
  if (pending === 0) process.exit(code);
};
process.stdout.write('', done);
process.stderr.write('', done);
setTimeout(() => process.exit(code), 2_000).unref();
