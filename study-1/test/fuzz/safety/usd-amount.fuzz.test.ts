// Property tests of the USD arithmetic behind the cost ceilings (testing rule 6: a decoder of
// money text; BR-RUA-046). Exact rendering and parsing are inverse; rounding up to cents never
// understates and overstates by less than one cent; any text that is not a money decimal with at
// most twelve fraction digits is refused, never guessed. Runs FC_RUNS cases per property (10,000
// under `npm run test:fuzz`).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { USD_SCALE_DIGITS, centsCeiling, exactUsd, scaledUsd } from '../../../src/safety/usd-amount.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';

const SCALE = 10n ** BigInt(USD_SCALE_DIGITS);
const amount = fc.bigInt({ min: 0n, max: 10n ** 30n });

describe('USD amount properties', () => {
  it('parses the exact rendering of any amount back to that amount', () => {
    fc.assert(
      fc.property(amount, (scaled) => {
        assert.equal(scaledUsd(exactUsd(scaled)), scaled);
      }),
      fuzzParameters(),
    );
  });

  it('rounds up to cents without understating or overstating by a cent', () => {
    fc.assert(
      fc.property(amount, (scaled) => {
        const cents = centsCeiling(scaled);
        assert.match(cents, /^(0|[1-9][0-9]*)\.[0-9]{2}$/);
        const back = scaledUsd(cents);
        assert.ok(back !== undefined);
        assert.ok(back >= scaled && back - scaled < SCALE / 100n, `${cents} for ${String(scaled)}`);
      }),
      fuzzParameters(),
    );
  });

  it('refuses any text that is not a money decimal of at most twelve fraction digits', () => {
    const money = /^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/;
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^-?[0-9]{0,4}(\.[0-9]{0,14})?$/)), (text) => {
        const parsed = scaledUsd(text);
        assert.equal(parsed !== undefined, money.test(text), JSON.stringify(text));
      }),
      fuzzParameters(),
    );
  });
});
