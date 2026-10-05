// The provider's production bindings (design §9.4): the process clocks, UUID source and sleeper
// behind `systemRuntime()`, and the Lambda entry's refusal to start without its environment.
// These run against the real Node runtime; nothing here reaches AWS.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import { systemRuntime } from '../../../src/refund-provider/node/system-runtime.ts';
import { handler } from '../../../src/refund-provider/refund-provider.handler.ts';

describe('systemRuntime', () => {
  it('reads the wall clock, a monotonic clock and fresh lowercase UUIDv4s', () => {
    const runtime = systemRuntime();
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

  it('sleeps at least the requested time on the monotonic clock', async () => {
    const runtime = systemRuntime();
    const start = runtime.monotonic.nowNs();
    await runtime.sleeper.sleep(20);
    assert.ok(runtime.monotonic.nowNs() - start >= 19_000_000n);
  });
});

describe('refund provider Lambda entry', () => {
  it('refuses to compose without its environment, naming every missing variable', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('SUC_'))) {
      Reflect.deleteProperty(process.env, name);
    }
    try {
      await assert.rejects(handler({}), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^provider environment invalid: SUC_EXECUTION_KIND=undefined/u);
        assert.match(error.message, /SUC_TABLE_CONTROL=undefined; expected a non-empty table name$/u);
        return true;
      });
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
