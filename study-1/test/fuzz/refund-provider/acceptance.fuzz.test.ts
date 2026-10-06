// Property-based tests of the provider's untrusted-input boundary (testing rule 6; BR-RUA-018,
// design §9.10, RK-01). The provider judges calls with a hand-written guard instead of Ajv, so
// the guard is checked against the schema itself: on near-valid calls (a valid trial or probe
// call with up to three properties removed or replaced by boundary values) the guard plus the
// identity-structure and amount checks accept exactly what `provider_refund_call` accepts, and
// the warm-up guard accepts exactly what `provider_warmup_request` accepts. The judgement is
// total over arbitrary JSON, and through the composed provider a call either commits one ledger
// transaction or none, never anything in between.
//
// The inputs include what the Lambda runtime's JSON.parse can deliver beyond fc.jsonValue():
// ±Infinity (from literals such as `1e400`), nesting thousands of levels deep and oversized
// strings (WP-07 review round 1: these made the digest and the guards' details throw).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { canonicalJson } from '../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { AcceptanceContext } from '../../../src/refund-provider/acceptance.ts';
import { evaluateAcceptance } from '../../../src/refund-provider/acceptance.ts';
import { ProviderFault } from '../../../src/refund-provider/provider-fault.ts';
import { guardWarmupRequest, WARMUP_REQUEST_PROPERTIES } from '../../../src/refund-provider/provider-warmup.ts';
import {
  amountViolation,
  guardRefundCallShape,
  identityStructureViolation,
  REFUND_CALL_PROPERTIES,
} from '../../../src/refund-provider/refund-call-shape.ts';
import { QUOTED_JSON_LIMIT } from '../../../src/record-contract/json-value.ts';
import { describeUntrusted, requestDigest } from '../../../src/refund-provider/untrusted-json.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import {
  ATTEMPT_ID,
  MANIFEST_SHA,
  PAYMENT_ID,
  PROBE_ID,
  providerEventTypes,
  providerHarness,
  ledgerItems,
  RUN,
  RUN_ID,
  seedRunTrial,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_PK,
  validCall,
  validProbeCall,
  VALIDATION_ID,
  WARMUP_ID,
} from '../../unit/refund-provider/support/provider-fixtures.ts';

const validator = createRecordValidator();

/** The marker the kernel's `boundedJsonText` appends to a cut text. */
const TRUNCATED = '…[truncated]';

const TRIAL_CONTEXT: AcceptanceContext = {
  deployment_execution: RUN,
  trial_configuration: {
    execution_manifest_sha256: MANIFEST_SHA,
    registered_caller_id: 'conventional',
    scenario: 'CONTROL',
    payment_id: PAYMENT_ID,
    trial: { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
  },
  payment: { payment_id: PAYMENT_ID, currency: 'BRL' },
};

/** A value nested `depth` levels deep in arrays or single-member objects, built without recursion. */
function nestedValue(depth: number, asObject: boolean, leaf: JsonValue): JsonValue {
  let value = leaf;
  for (let level = 0; level < depth; level += 1) {
    value = asObject ? { a: value } : [value];
  }
  return value;
}

/** What JSON.parse delivers that fc.jsonValue() never generates: non-finite numbers, deep nesting, long strings. */
function runtimeOnlyValues(maxDepth: number): fc.Arbitrary<JsonValue> {
  return fc.oneof(
    fc.constantFrom<JsonValue>(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    fc
      .tuple(
        fc.integer({ min: 1_000, max: maxDepth }),
        fc.boolean(),
        fc.constantFrom<JsonValue>(1, Number.POSITIVE_INFINITY, 'x', null, []),
      )
      .map(([depth, asObject, leaf]) => nestedValue(depth, asObject, leaf)),
    fc.integer({ min: 1_000, max: 100_000 }).map((length) => 'z'.repeat(length)),
  );
}

/** Runtime-only values for the totality properties: nesting up to 20,000 levels. */
const runtimeOnlyValue = runtimeOnlyValues(20_000);
// The Ajv oracle of the differential properties is the kernel validator, which itself throws
// RangeError on a `record_type` nested about 7,000 levels deep (schema-registry.ts
// `JSON.stringify(declared)`; reported to the Owner as a kernel item by WP-07 review round 1).
// The differential therefore draws nesting from the depth where its oracle is total; the
// provider's own totality is held to 20,000 levels by the properties below.
const oracleSafeRuntimeValue = runtimeOnlyValues(2_000);

/** Values at the edges of every rule the call and warm-up schemas state. */
const boundaryValue: fc.Arbitrary<JsonValue> = fc.oneof(
  oracleSafeRuntimeValue,
  fc.constantFrom<JsonValue>(
    0,
    1,
    -1,
    1.5,
    2,
    10000,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    2 ** 60,
    -0,
    '',
    ' ',
    'a',
    ' a',
    'a ',
    'a b',
    'pay\npoc',
    ' x',
    'BRL',
    'USD',
    'brl',
    'BRLX',
    'conventional',
    'durable',
    'probe',
    'provider_refund_call',
    'provider_warmup_request',
    null,
    true,
    false,
    [],
    {},
    RUN_ID,
    PROBE_ID,
    VALIDATION_ID,
    TRIAL_ID,
    ATTEMPT_ID,
    ATTEMPT_ID.toUpperCase(),
    WARMUP_ID,
    MANIFEST_SHA,
    MANIFEST_SHA.toUpperCase(),
    MANIFEST_SHA.slice(1),
    'aaaaaaaa-0000-1000-8000-000000000001',
    'aaaaaaaa-0000-4000-c000-000000000001',
  ),
  fc.uuid({ version: 4 }),
  fc.stringMatching(/^[0-9a-f]{64}$/u),
  fc.string({ maxLength: 6 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.jsonValue({ maxDepth: 1 }) as fc.Arbitrary<JsonValue>,
);

type Mutation = readonly [string, JsonValue | undefined];

function mutated(base: JsonObject, mutations: readonly Mutation[]): JsonObject {
  const call: Record<string, JsonValue> = { ...base };
  for (const [property, value] of mutations) {
    if (value === undefined) {
      Reflect.deleteProperty(call, property);
      continue;
    }
    call[property] = value;
  }
  return call;
}

function nearValid(
  base: fc.Arbitrary<JsonObject>,
  properties: readonly string[],
  values: fc.Arbitrary<JsonValue> = boundaryValue,
): fc.Arbitrary<JsonObject> {
  const mutation: fc.Arbitrary<Mutation> = fc.tuple(
    fc.constantFrom(...properties, 'unexpected_property'),
    fc.option(values, { nil: undefined, freq: 4 }),
  );
  return fc.tuple(base, fc.array(mutation, { maxLength: 3 })).map(([call, mutations]) => mutated(call, mutations));
}

const callBase = fc.constantFrom(validCall(), validProbeCall(), validCall({ caller_id: 'durable' }));
const nearValidCall = nearValid(callBase, REFUND_CALL_PROPERTIES);
/** Near-valid calls whose replaced members also reach the full 20,000-level nesting. */
const hostileCall = nearValid(callBase, REFUND_CALL_PROPERTIES, fc.oneof(boundaryValue, runtimeOnlyValue));
const warmupBase = fc.constantFrom<JsonObject>(
  {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    trial_id: TRIAL_ID,
    warmup_id: WARMUP_ID,
  },
  {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    warmup_id: WARMUP_ID,
  },
);
const nearValidWarmup = nearValid(warmupBase, WARMUP_REQUEST_PROPERTIES);

function guardAccepts(raw: JsonValue): boolean {
  const shape = guardRefundCallShape(raw);
  return (
    shape.ok && identityStructureViolation(shape.value) === undefined && amountViolation(shape.value) === undefined
  );
}

// A payload that declares itself a warm-up is routed to the warm-up and refused there when
// malformed (seed -667107247, promoted to provider-warmup.integration.test.ts); any other fault
// means the call named no configured trial partition. Both faults leave the call unjournaled,
// which AC-RUA-042 does not provide for: WP-07 review round 1 raised it to the Owner as an open
// plan-consistency item, and this expectation changes with the Owner's decision.
function assertExpectedFault(fault: ProviderFault, call: JsonObject): void {
  if (call['record_type'] === 'provider_warmup_request') {
    assert.equal(fault.code, 'WARMUP_REQUEST_INVALID', fault.message);
    return;
  }
  assert.ok(['UNATTRIBUTABLE_CALL', 'CONFIGURATION_MISSING'].includes(fault.code), fault.message);
  assert.notEqual(call['trial_id'], TRIAL_ID);
}

describe('refund-provider acceptance properties', () => {
  it('the call guard accepts exactly what the provider_refund_call schema accepts', () => {
    fc.assert(
      fc.property(nearValidCall, (call) => {
        assert.equal(
          guardAccepts(call),
          validator.validateAs('provider_refund_call', call).valid,
          describeUntrusted(call),
        );
      }),
      fuzzParameters(),
    );
  });

  it('the warm-up guard accepts exactly what the provider_warmup_request schema accepts', () => {
    fc.assert(
      fc.property(nearValidWarmup, (request) => {
        assert.equal(
          guardWarmupRequest(request).ok,
          validator.validateAs('provider_warmup_request', request).valid,
          describeUntrusted(request),
        );
      }),
      fuzzParameters(),
    );
  });

  it('judges any JSON value without throwing, and accepts only schema-valid calls', () => {
    fc.assert(
      fc.property(
        fc.oneof(nearValidCall, hostileCall, fc.jsonValue() as fc.Arbitrary<JsonValue>, runtimeOnlyValue),
        (raw) => {
          const decision = evaluateAcceptance(raw, TRIAL_CONTEXT);
          if (decision.accepted) {
            assert.equal(validator.validateAs('provider_refund_call', raw).valid, true, describeUntrusted(raw));
            return;
          }
          assert.ok(decision.detail.length > 0);
          if (!guardRefundCallShape(raw).ok) {
            assert.ok(['AUTHORIZATION_FAILED', 'SCHEMA_INVALID'].includes(decision.reason), decision.reason);
          }
        },
      ),
      fuzzParameters(),
    );
  });

  it('through the provider, a call commits one ledger transaction or none, or faults unattributed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(nearValidCall, hostileCall), async (call) => {
        const harness = providerHarness();
        seedRunTrial(harness, 'CONTROL');
        let response: JsonValue;
        try {
          response = (await harness.provider.handle(call)) as unknown as JsonValue;
        } catch (error) {
          assert.ok(error instanceof ProviderFault, String(error));
          assertExpectedFault(error, call);
          assert.deepEqual(harness.store.itemsIn('experiment_journal'), []);
          return;
        }
        const outcome = (response as JsonObject)['outcome'];
        const ledger = ledgerItems(harness, TRIAL_PK);
        if (outcome === 'REJECTED') {
          assert.deepEqual(ledger, []);
          assert.deepEqual(providerEventTypes(harness, TRIAL_PK), ['provider_call_received', 'provider_call_rejected']);
          return;
        }
        assert.equal(outcome, 'SUCCEEDED');
        assert.equal(ledger.length, 1);
        assert.equal(validator.validateAs('provider_refund_call', call).valid, true);
      }),
      fuzzParameters(),
    );
  });

  it('digests any parsed payload without throwing, equal to the canonical-JSON digest when finite', () => {
    fc.assert(
      fc.property(fc.jsonValue() as fc.Arbitrary<JsonValue>, (raw) => {
        assert.equal(requestDigest(raw), sha256Hex(new TextEncoder().encode(canonicalJson(raw))));
      }),
      fuzzParameters(),
    );
    fc.assert(
      fc.property(fc.oneof(runtimeOnlyValue, hostileCall), (raw) => {
        assert.match(requestDigest(raw), /^[0-9a-f]{64}$/u);
      }),
      fuzzParameters(),
    );
  });

  it('describes any parsed value within the bound', () => {
    fc.assert(
      fc.property(fc.oneof(runtimeOnlyValue, fc.jsonValue() as fc.Arbitrary<JsonValue>, hostileCall), (raw) => {
        const described = describeUntrusted(raw);
        assert.ok(described.length <= 'boolean '.length + QUOTED_JSON_LIMIT + TRUNCATED.length);
        assert.equal(described.isWellFormed(), true);
      }),
      fuzzParameters(),
    );
  });
});
