// The controller's production bindings (design §9.4): the wall clock and UUID source behind
// `controllerSystemRuntime()`, and the Lambda entry's refusal to start without its environment.
// These run against the real Node runtime; nothing here reaches AWS.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import { controllerSystemRuntime } from '../../../src/treatment-controller/node/system-runtime.ts';
import { handler } from '../../../src/treatment-controller/treatment-controller.handler.ts';
import { ProcessStreamCapture } from '../../support/transport-rehearsal/process-stream-capture.ts';

describe('controllerSystemRuntime', () => {
  it('reads the wall clock and fresh lowercase UUIDv4s', () => {
    const runtime = controllerSystemRuntime();
    const before = Date.now();
    const wall = runtime.wall.now().getTime();
    assert.ok(wall >= before && wall <= Date.now());
    const a = runtime.ids.next();
    const b = runtime.ids.next();
    assert.ok(isUuid4(a) && isUuid4(b));
    assert.notEqual(a, b);
  });
});

describe('treatment controller Lambda entry', () => {
  it('refuses to compose without its environment, naming every missing variable in one JSON log line', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('SUC_'))) {
      Reflect.deleteProperty(process.env, name);
    }
    const stdout = new ProcessStreamCapture(process.stdout);
    stdout.start();
    let thrown: unknown;
    try {
      await handler({ Records: [] }).catch((error: unknown) => {
        thrown = error;
      });
    } finally {
      stdout.stop();
      Object.assign(process.env, saved);
    }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /^controller environment invalid: SUC_EXECUTION_KIND=undefined/u);
    assert.match(thrown.message, /SUC_TABLE_CONTROL=undefined; expected a non-empty table name$/u);
    assert.deepEqual(stdout.jsonLines(), [
      { level: 'error', event: 'controller_error', detail: `Error: ${thrown.message}` },
    ]);
  });
});
