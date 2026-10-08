// Conformance of ProcessStreamCapture with the process stream it stands in front of: while
// started it records what `write` receives instead of forwarding it, `jsonLines` parses the
// newline-delimited JSON a Lambda entry writes, and `stop` restores the stream's own `write`.

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { ProcessStreamCapture } from '../../../support/transport-rehearsal/process-stream-capture.ts';

function ownWrite(stream: PassThrough): unknown {
  return Object.getOwnPropertyDescriptor(stream, 'write')?.value as unknown;
}

describe('ProcessStreamCapture conformance', () => {
  it('records JSON lines while started and restores the stream after stop', () => {
    const stream = new PassThrough();
    const forwarded: string[] = [];
    stream.on('data', (chunk: Buffer) => forwarded.push(chunk.toString()));
    const capture = new ProcessStreamCapture(stream);
    capture.start();
    stream.write('{"a":1}\n{"b":');
    stream.write('[2]}\n');
    capture.stop();
    stream.write('after\n');
    assert.deepEqual(capture.jsonLines(), [{ a: 1 }, { b: [2] }]);
    assert.equal(Object.hasOwn(stream, 'write'), false);
    assert.deepEqual(forwarded, ['after\n']);
  });

  it('restores an own write property the stream already had', () => {
    const stream = new PassThrough();
    const own = (): boolean => true;
    Object.defineProperty(stream, 'write', { value: own, configurable: true, writable: true });
    const capture = new ProcessStreamCapture(stream);
    capture.start();
    assert.notEqual(ownWrite(stream), own);
    capture.stop();
    capture.stop();
    assert.equal(ownWrite(stream), own);
  });
});
