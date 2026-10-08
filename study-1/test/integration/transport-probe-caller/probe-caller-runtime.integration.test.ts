// The probe caller's production bindings (design §9.4): the clocks, UUID source and setTimeout
// scheduler behind `probeCallerSystemRuntime()`, and the Lambda entry's refusal to start without
// its environment. These run against the real Node runtime; nothing here reaches AWS.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import { probeCallerSystemRuntime } from '../../../src/transport-probe-caller/node/system-runtime.ts';
import { handler } from '../../../src/transport-probe-caller/transport-probe-caller.handler.ts';
import { ProcessStreamCapture } from '../../support/transport-rehearsal/process-stream-capture.ts';

describe('probeCallerSystemRuntime', () => {
  it('reads the wall clock, a monotonic clock and fresh lowercase UUIDv4s', () => {
    const runtime = probeCallerSystemRuntime();
    const before = Date.now();
    const wall = runtime.wall.now().getTime();
    assert.ok(wall >= before && wall <= Date.now());
    const first = runtime.monotonic.nowNs();
    assert.ok(runtime.monotonic.nowNs() >= first);
    const a = runtime.ids.next();
    const b = runtime.ids.next();
    assert.ok(isUuid4(a) && isUuid4(b));
    assert.notEqual(a, b);
  });

  it('fires a scheduled timer after its delay, and never fires a cancelled one', async () => {
    const runtime = probeCallerSystemRuntime();
    const fired: string[] = [];
    const start = runtime.monotonic.nowNs();
    const cancelled = runtime.scheduler.schedule(5, () => fired.push('cancelled'));
    cancelled.cancel();
    await new Promise<void>((resolve) => {
      runtime.scheduler.schedule(20, () => {
        fired.push('kept');
        resolve();
      });
    });
    assert.ok(runtime.monotonic.nowNs() - start >= 19_000_000n);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(fired, ['kept']);
  });
});

describe('probe caller Lambda entry', () => {
  it('refuses to compose without its environment, naming every missing variable in one JSON log line', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('SUC_'))) {
      Reflect.deleteProperty(process.env, name);
    }
    const stderr = new ProcessStreamCapture(process.stderr);
    stderr.start();
    let thrown: unknown;
    try {
      await handler({}, { awsRequestId: 'req-0001' }).catch((error: unknown) => {
        thrown = error;
      });
    } finally {
      stderr.stop();
      Object.assign(process.env, saved);
    }
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /^probe caller environment invalid: SUC_EXECUTION_KIND=undefined/u);
    assert.match(thrown.message, /SUC_PROVIDER_QUALIFIER=undefined/u);
    assert.deepEqual(stderr.jsonLines(), [
      { level: 'error', event: 'probe_caller_error', detail: `Error: ${thrown.message}` },
    ]);
  });
});
