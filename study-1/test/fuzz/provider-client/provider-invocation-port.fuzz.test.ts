// transportResultOf over arbitrary resolved values: every value a port resolves becomes a
// well-formed settlement (WP-06 review round 2; testing rule 6). The example cases are in
// test/unit/provider-client/provider-invocation-port.test.ts; the property lives here so
// `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { transportResultOf } from '../../../src/provider-client/provider-invocation-port.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

describe('transportResultOf', () => {
  it('always returns a well-formed settlement (property)', () => {
    const settlement = fc.oneof(
      fc.record({
        kind: fc.constant('response' as const),
        status_code: fc.integer(),
        executed_version: fc.option(fc.string(), { nil: undefined }),
        function_error: fc.option(fc.string(), { nil: undefined }),
        payload: fc.uint8Array({ maxLength: 16 }),
      }),
      fc.record(
        {
          kind: fc.constant('transport_error' as const),
          error_name: fc.string(),
          message: fc.string(),
          http_status: fc.integer(),
        },
        { requiredKeys: ['kind', 'error_name', 'message'] },
      ),
    );
    const anyValue = fc.anything({ withNullPrototype: true, withBigInt: true, withMap: true, withTypedArray: true });
    fc.assert(
      fc.property(fc.oneof(settlement, anyValue), (value) => {
        const result = transportResultOf(value);
        assert.ok(result.kind === 'response' || typeof result.error_name === 'string');
        assert.ok(result.kind === 'transport_error' || result.payload instanceof Uint8Array);
      }),
      fuzzParameters(),
    );
    fc.assert(
      fc.property(settlement, (value) => {
        // fc.record may build a null-prototype object; the copy is a plain one with equal fields.
        assert.deepEqual(transportResultOf(value), { ...value });
      }),
      fuzzParameters(),
    );
  });
});
