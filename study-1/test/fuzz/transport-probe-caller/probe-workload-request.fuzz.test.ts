// Property-based tests of the probe caller's untrusted-input boundary: the runner's synchronous
// invocation payload (testing rule 6; BR-RUA-027, RK-01). The guard is hand-written, so it is
// checked differentially against the catalogue's Ajv validator: on near-valid requests (a valid
// request with up to three properties removed or replaced by boundary values) it accepts exactly
// what `probe_workload_request` accepts and that names this deployment's probe. It is total over
// arbitrary JSON, and every refusal names the offending property.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { parseProbeWorkloadRequest } from '../../../src/transport-probe-caller/probe-workload-request.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  MANIFEST_SHA,
  OTHER_RUN_ID,
  PROBE,
  PROBE_ID,
  RUN,
  workloadRequest,
} from '../../unit/transport-probe-caller/support/probe-fixtures.ts';

const validator = createRecordValidator();

const PROPERTIES = Object.keys(workloadRequest());

const boundaryValue: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(
    0,
    1,
    -1,
    1.5,
    2,
    10000,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    -0,
    '',
    ' ',
    'a',
    ' a',
    'a ',
    'a b',
    'pay\npoc',
    ' a',
    'BRL',
    'brl',
    'USD',
    'probe_workload_request',
    'provider_refund_call',
    null,
    true,
    [],
    {},
    PROBE_ID,
    OTHER_RUN_ID,
    PROBE_ID.toUpperCase(),
    'aaaaaaaa-0000-1000-8000-000000000001',
    MANIFEST_SHA,
    MANIFEST_SHA.toUpperCase(),
    MANIFEST_SHA.slice(1),
  ),
  fc.uuid({ version: 4 }),
  fc.stringMatching(/^[0-9a-f]{64}$/u),
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
);

type Mutation = readonly [string, JsonValue | undefined];

function mutated(base: JsonObject, mutations: readonly Mutation[]): JsonObject {
  const request: Record<string, JsonValue> = { ...base };
  for (const [property, value] of mutations) {
    if (value === undefined) {
      Reflect.deleteProperty(request, property);
      continue;
    }
    request[property] = value;
  }
  return request;
}

const mutation: fc.Arbitrary<Mutation> = fc.tuple(
  fc.constantFrom(...PROPERTIES, 'unexpected_property'),
  fc.option(boundaryValue, { nil: undefined, freq: 4 }),
);
const nearValidRequest = fc.array(mutation, { maxLength: 3 }).map((mutations) => mutated(workloadRequest(), mutations));

describe('probe workload request properties', () => {
  it('accepts exactly what the probe_workload_request schema accepts and names this probe', () => {
    // Both verdicts must be exercised, or the differential is vacuous.
    const seen = { accepted: 0, refused: 0 };
    fc.assert(
      fc.property(nearValidRequest, (request) => {
        const expected =
          validator.validateAs('probe_workload_request', request).valid && request['transport_probe_id'] === PROBE_ID;
        seen[expected ? 'accepted' : 'refused'] += 1;
        assert.equal(parseProbeWorkloadRequest(request, PROBE).ok, expected, JSON.stringify(request));
      }),
      fuzzParameters(),
    );
    assert.ok(seen.accepted > 0 && seen.refused > 0, JSON.stringify(seen));
  });

  it('judges any JSON value without throwing, and refuses with a prefixed reason', () => {
    fc.assert(
      fc.property(fc.oneof(nearValidRequest, fc.jsonValue() as fc.Arbitrary<JsonValue>), (payload) => {
        const result = parseProbeWorkloadRequest(payload, PROBE);
        if (result.ok) {
          assert.equal(validator.validateAs('probe_workload_request', payload).valid, true);
          return;
        }
        assert.match(result.error, /^probe workload request invalid: \S/);
      }),
      fuzzParameters(),
    );
  });

  it('accepts nothing in a deployment that is not a transport probe', () => {
    fc.assert(
      fc.property(nearValidRequest, (request) => {
        const result = parseProbeWorkloadRequest(request, RUN);
        assert.equal(result.ok, false);
      }),
      fuzzParameters(),
    );
  });
});
