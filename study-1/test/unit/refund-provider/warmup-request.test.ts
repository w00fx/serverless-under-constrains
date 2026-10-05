// The hand-written `provider_warmup_request` guard (addendum §2): a closed property set, the
// fixed record identity, one execution identity, the manifest digest, the warm-up id and an
// optional well-formed trial_id; each refusal names the value and the expected shape.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { guardWarmupRequest, WARMUP_REQUEST_PROPERTIES } from '../../../src/refund-provider/provider-warmup.ts';
import { MANIFEST_SHA, PROBE, PROBE_ID, RUN, RUN_ID, TRIAL_ID, WARMUP_ID } from './support/provider-fixtures.ts';

function request(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'provider_warmup_request',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    trial_id: TRIAL_ID,
    warmup_id: WARMUP_ID,
    ...overrides,
  };
}

function refusal(raw: JsonValue): string {
  const result = guardWarmupRequest(raw);
  assert.equal(result.ok, false);
  return result.error;
}

describe('guardWarmupRequest', () => {
  it('reads a trial warm-up and a probe warm-up without a trial', () => {
    const expected = { execution: RUN, execution_manifest_sha256: MANIFEST_SHA, warmup_id: WARMUP_ID };
    assert.deepEqual(guardWarmupRequest(request()), { ok: true, value: expected });
    const { run_id: _run, trial_id: _trial, ...probe } = request({ transport_probe_id: PROBE_ID });
    assert.deepEqual(guardWarmupRequest(probe), { ok: true, value: { ...expected, execution: PROBE } });
  });

  it('refuses a non-object and a property outside the closed set', () => {
    assert.equal(refusal([1]), 'warm-up request is array [1]; expected a provider_warmup_request object');
    assert.equal(
      refusal(request({ attempt_id: WARMUP_ID })),
      `property "attempt_id" is not part of provider_warmup_request; expected only ${WARMUP_REQUEST_PROPERTIES.join(', ')}`,
    );
  });

  it('refuses a wrong version, record type, digest, warm-up id or trial id', () => {
    assert.equal(refusal(request({ schema_version: '1' })), 'schema_version is string "1"; expected the number 1');
    assert.equal(
      refusal(request({ record_type: 'provider_refund_call' })),
      'record_type is string "provider_refund_call"; expected "provider_warmup_request"',
    );
    const { execution_manifest_sha256: _sha, ...withoutSha } = request();
    assert.equal(refusal(withoutSha), 'execution_manifest_sha256 is absent; expected 64 lowercase hex digits');
    assert.equal(
      refusal(request({ warmup_id: 'w-1' })),
      'warmup_id is string "w-1"; expected a lowercase RFC 4122 version-4 UUID',
    );
    assert.equal(
      refusal(request({ trial_id: null })),
      'trial_id is null null; expected a lowercase RFC 4122 version-4 UUID when present',
    );
  });

  it('requires exactly one execution identity', () => {
    assert.equal(
      refusal(request({ transport_probe_id: PROBE_ID })),
      'execution identity fields [run_id, transport_probe_id]; expected exactly one of run_id, variant_validation_id, transport_probe_id',
    );
  });
});
