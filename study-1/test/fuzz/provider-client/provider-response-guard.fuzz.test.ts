// readProviderRefundResponse properties: totality over arbitrary JSON with bounded errors, and
// differential agreement with the real Ajv schema over near-valid payloads (testing rule 6: a
// validator of untrusted bytes; design §12.5 hand-written guards). The example cases are in
// test/unit/provider-client/provider-response-guard.test.ts; the properties live here so
// `npm run test:fuzz` and `fuzz:campaign` reach them (Owner amendment A-11).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { readProviderRefundResponse } from '../../../src/provider-client/provider-response-guard.ts';
import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { FIRST_ATTEMPT_ID, PROVIDER_CALL_ID } from '../../support/provider-client/provider-client-fixtures.ts';
import {
  GUARD_REJECTED as REJECTED,
  GUARD_SUCCEEDED as SUCCEEDED,
  withoutMember as without,
} from '../../support/provider-client/provider-response-guard-samples.ts';

describe('readProviderRefundResponse', () => {
  it('is total over arbitrary JSON values, deep ones included, with bounded errors (property)', () => {
    const value = fc.oneof(
      fc.jsonValue({ depthSize: 'xlarge', maxDepth: 50 }) as fc.Arbitrary<JsonValue>,
      fc
        .tuple(
          fc.constantFrom(...Object.keys(SUCCEEDED), 'rejection_reason'),
          fc.jsonValue() as fc.Arbitrary<JsonValue>,
        )
        .map(([name, field]): JsonValue => ({ ...SUCCEEDED, [name]: field })),
      fc.nat({ max: 20_000 }).map((depth) => JSON.parse(`${'['.repeat(depth)}1${']'.repeat(depth)}`) as JsonValue),
    );
    fc.assert(
      fc.property(value, (candidate) => {
        const result = readProviderRefundResponse(candidate);
        // The longest message names one bounded value plus a fixed expected shape.
        assert.ok(result.ok || result.error.length <= 600, result.ok ? '' : result.error.slice(0, 200));
      }),
      fuzzParameters(),
    );
  });

  it('agrees with the Ajv schema on near-valid payloads (property)', () => {
    const validator = createRecordValidator();
    const fieldValue = fc.oneof(
      fc.constantFrom<JsonValue>(
        1,
        2,
        null,
        true,
        '',
        'SUCCEEDED',
        'REJECTED',
        'provider_refund_response',
        'AMOUNT_INVALID',
        PROVIDER_CALL_ID,
        FIRST_ATTEMPT_ID,
        FIRST_ATTEMPT_ID.toUpperCase(),
        [],
        {},
        // Inherited member names as values (Owner amendment A-05.3).
        'toString',
        'constructor',
      ),
      fc.string(),
      fc.integer(),
    );
    // A computed key makes even `__proto__` an own property, as JSON.parse does (A-05.3).
    const names = fc.constantFrom(
      ...Object.keys(SUCCEEDED),
      'rejection_reason',
      'unexpected_property',
      '__proto__',
      'constructor',
      'toString',
    );
    const mutation = fc.oneof(
      fc.record({ op: fc.constant('drop' as const), name: names }),
      fc.record({ op: fc.constant('set' as const), name: names, value: fieldValue }),
    );
    const payload = fc
      .tuple(fc.constantFrom(SUCCEEDED, REJECTED), fc.array(mutation, { maxLength: 3 }))
      .map(([base, mutations]) =>
        mutations.reduce<JsonObject>(
          (current, step) =>
            step.op === 'drop' ? without(current, step.name) : { ...current, [step.name]: step.value },
          base,
        ),
      );
    const seen = { valid: 0, invalid: 0 };
    fc.assert(
      fc.property(payload, (value) => {
        const schemaValid = validator.validateAs('provider_refund_response', value).valid;
        seen[schemaValid ? 'valid' : 'invalid'] += 1;
        assert.equal(readProviderRefundResponse(value).ok, schemaValid, JSON.stringify(value));
      }),
      fuzzParameters(),
    );
    // Both verdicts must occur, or the agreement would be vacuous.
    assert.ok(seen.valid > 0 && seen.invalid > 0, JSON.stringify(seen));
  });
});
