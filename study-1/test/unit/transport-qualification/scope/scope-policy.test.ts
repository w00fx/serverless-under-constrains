// BR-RUA-028: the committed scope policy is validated against its schema and digested over
// its canonical record bytes, so formatting never drifts the scope but content always does.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { serializeRecordFile } from '../../../../src/record-contract/canonical-json.ts';
import { sha256Hex } from '../../../../src/record-contract/digests.ts';
import { createRecordValidator } from '../../../../src/record-contract/schema-registry.ts';
import {
  TRANSPORT_SCOPE_POLICY_PATH,
  parseTransportScopePolicy,
  projectionSelector,
} from '../../../../src/transport-qualification/scope/scope-policy.ts';
import { SAMPLE_POLICY } from './support/scope-fixtures.ts';

const encoder = new TextEncoder();
const validator = createRecordValidator();

describe('parseTransportScopePolicy', () => {
  it('returns the policy and the digest of its canonical record bytes', () => {
    const parsed = parseTransportScopePolicy(encoder.encode(JSON.stringify(SAMPLE_POLICY, null, 2)), validator);
    assert.deepEqual(parsed, {
      ok: true,
      value: { policy: SAMPLE_POLICY, policy_sha256: sha256Hex(serializeRecordFile(SAMPLE_POLICY)) },
    });
  });

  it('gives the same digest for a reformatted policy and a new digest for changed content', () => {
    const pretty = parseTransportScopePolicy(encoder.encode(JSON.stringify(SAMPLE_POLICY, null, 4)), validator);
    const compact = parseTransportScopePolicy(encoder.encode(JSON.stringify(SAMPLE_POLICY)), validator);
    const changed = parseTransportScopePolicy(
      encoder.encode(JSON.stringify({ ...SAMPLE_POLICY, dependencies: ['@scope/declared-dep', 'esbuild'] })),
      validator,
    );
    assert.ok(pretty.ok && compact.ok && changed.ok);
    assert.equal(pretty.value.policy_sha256, compact.value.policy_sha256);
    assert.notEqual(changed.value.policy_sha256, compact.value.policy_sha256);
  });

  it('refuses bytes that are not one JSON document', () => {
    assert.deepEqual(parseTransportScopePolicy(Uint8Array.from([0x7b, 0xff]), validator), {
      ok: false,
      error: [
        {
          code: 'SCOPE_POLICY_UNREADABLE',
          subject: 'BR-RUA-028',
          detail: `${TRANSPORT_SCOPE_POLICY_PATH}: invalid UTF-8 at byte 1; expected one JSON document`,
        },
      ],
    });
    const notJson = parseTransportScopePolicy(encoder.encode('{"a":'), validator);
    assert.ok(!notJson.ok);
    assert.deepEqual(
      notJson.error.map((reason) => reason.code),
      ['SCOPE_POLICY_UNREADABLE'],
    );
    assert.match(
      notJson.error[0]?.detail ?? '',
      /^src\/transport-qualification\/transport-scope\.policy\.json: .+; expected one JSON document$/,
    );
  });

  it('refuses a policy the schema rejects, one reason per violation', () => {
    const invalid = { ...SAMPLE_POLICY, entry_points: [], extra: true };
    const parsed = parseTransportScopePolicy(encoder.encode(JSON.stringify(invalid)), validator);
    assert.ok(!parsed.ok);
    const reasons = parsed.error;
    assert.ok(reasons.length >= 2, `expected a reason per violation, got ${JSON.stringify(reasons)}`);
    assert.deepEqual(new Set(reasons.map((reason) => reason.code)), new Set(['SCOPE_POLICY_INVALID']));
    assert.ok(
      reasons.some((reason) => reason.detail.startsWith(`${TRANSPORT_SCOPE_POLICY_PATH}/entry_points fails minItems`)),
    );
    assert.ok(reasons.some((reason) => reason.detail.includes('fails additionalProperties')));
  });

  it('refuses duplicate projection ids once per id', () => {
    const projection = SAMPLE_POLICY.configuration_projections[0];
    const duplicated = {
      ...SAMPLE_POLICY,
      configuration_projections: [
        projection,
        { ...projection, resource_type: 'AWS::Lambda::Version' },
        { ...projection, resource_type: 'AWS::IAM::Role' },
      ],
    };
    assert.deepEqual(parseTransportScopePolicy(encoder.encode(JSON.stringify(duplicated)), validator), {
      ok: false,
      error: [
        {
          code: 'SCOPE_POLICY_DUPLICATE_PROJECTION',
          subject: 'BR-RUA-028',
          detail:
            'projection_id "experiment_core__functions" is declared more than once; expected unique projection ids',
        },
      ],
    });
  });
});

describe('projectionSelector', () => {
  it('takes the id up to the first label separator', () => {
    assert.equal(projectionSelector('experiment_core__functions'), 'experiment_core');
    assert.equal(projectionSelector('experiment_core__a__b'), 'experiment_core');
    assert.equal(projectionSelector('provider_function'), 'provider_function');
    assert.equal(projectionSelector('a_b'), 'a_b');
  });
});
