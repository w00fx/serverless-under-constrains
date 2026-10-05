// The controller's production bindings (design §9.4): the wall clock and UUID source behind
// `controllerSystemRuntime()`, and the Lambda entry's refusal to start without its environment.
// These run against the real Node runtime; nothing here reaches AWS.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isUuid4 } from '../../../src/record-contract/identifiers.ts';
import { controllerSystemRuntime } from '../../../src/treatment-controller/node/system-runtime.ts';
import { handler } from '../../../src/treatment-controller/treatment-controller.handler.ts';

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
  it('refuses to compose without its environment, naming every missing variable', async () => {
    const saved = { ...process.env };
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('SUC_'))) {
      Reflect.deleteProperty(process.env, name);
    }
    try {
      await assert.rejects(handler({ Records: [] }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^controller environment invalid: SUC_EXECUTION_KIND=undefined/u);
        assert.match(error.message, /SUC_TABLE_CONTROL=undefined; expected a non-empty table name$/u);
        return true;
      });
    } finally {
      Object.assign(process.env, saved);
    }
  });
});
