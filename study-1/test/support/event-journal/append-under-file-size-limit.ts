// Child-process entry point for the NodeAppendOnlyFile write-failure integration test. The
// parent runs it under `ulimit -f 1` (RLIMIT_FSIZE of one block), so the real `appendFile`
// writes up to the limit and then fails with EFBIG: a genuine partial write on the real file
// system, with no injected file handle. Node ignores SIGXFSZ, so the write returns the error
// instead of killing the process. It appends one line of `<bytes>` bytes to `<path>` and prints
// the outcome as one JSON line on stdout.
//
// Usage: node append-under-file-size-limit.ts <path> <bytes>

import { NodeAppendOnlyFile } from '../../../src/event-journal/node/node-append-only-file.ts';

const [path, size] = process.argv.slice(2);
const lineLength = Number(size);
if (path === undefined || !Number.isSafeInteger(lineLength) || lineLength < 1) {
  throw new RangeError(`arguments ${JSON.stringify(process.argv.slice(2))}; expected <path> <bytes>, bytes >= 1`);
}
const line = new TextEncoder().encode(`${'x'.repeat(lineLength - 1)}\n`);
process.stdout.write(`${JSON.stringify(await new NodeAppendOnlyFile().append(path, line))}\n`);
