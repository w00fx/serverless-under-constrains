// transportErrorFromThrown over arbitrary thrown values (WP-06 review round 1; testing rule 6).
// The example cases are in test/unit/provider-client/transport-race.test.ts; the property lives
// here so `npm run test:fuzz` and `fuzz:campaign` reach it (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { transportErrorFromThrown } from '../../../src/provider-client/provider-invocation-port.ts';
import { hostileThrownValues } from '../../support/provider-client/hostile-thrown-values.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

describe('transportErrorFromThrown', () => {
  it('returns a transport error for any thrown value (property)', () => {
    const thrown = fc.oneof(
      fc.anything({ withNullPrototype: true, withBigInt: true, withMap: true, withSet: true, withDate: true }),
      fc.constantFrom(...hostileThrownValues()),
      fc.string().map((message) => new Error(message)),
    );
    fc.assert(
      fc.property(thrown, (value) => {
        const error = transportErrorFromThrown(value);
        assert.equal(error.kind, 'transport_error');
        assert.equal(typeof error.error_name, 'string');
        assert.equal(typeof error.message, 'string');
      }),
      fuzzParameters(),
    );
  });
});
