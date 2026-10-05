// The guard of the runner's single probe invocation payload (BR-RUA-027,
// `probe_workload_request`): the schema's rules plus "this deployment's probe".

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject, JsonValue } from '../../../src/record-contract/primitives.ts';
import { parseProbeWorkloadRequest } from '../../../src/transport-probe-caller/probe-workload-request.ts';
import { OTHER_RUN_ID, PROBE, PROBE_ID, RUN, workloadRequest } from './support/probe-fixtures.ts';

function refusal(problem: string): object {
  return { ok: false, error: `probe workload request invalid: ${problem}` };
}

describe('parseProbeWorkloadRequest', () => {
  it('accepts a complete request for this probe', () => {
    assert.deepEqual(parseProbeWorkloadRequest(workloadRequest(), PROBE), { ok: true, value: workloadRequest() });
    const edge = workloadRequest({ payment_id: 'p', refund_request_id: 'a b', amount_minor: Number.MAX_SAFE_INTEGER });
    assert.equal(parseProbeWorkloadRequest(edge, PROBE).ok, true);
  });

  it('refuses a payload that is not an object', () => {
    for (const payload of [null, [], 'x', 1] as readonly JsonValue[]) {
      assert.equal(parseProbeWorkloadRequest(payload, PROBE).ok, false);
    }
    assert.deepEqual(
      parseProbeWorkloadRequest(null, PROBE),
      refusal('payload is null null; expected a probe_workload_request object'),
    );
  });

  it('refuses unexpected and missing properties', () => {
    assert.deepEqual(
      parseProbeWorkloadRequest(workloadRequest({ trial_id: PROBE_ID }), PROBE),
      refusal(
        'unexpected properties ["trial_id"]; expected only schema_version, record_type, transport_probe_id, execution_manifest_sha256, payment_id, refund_request_id, amount_minor, currency',
      ),
    );
    const { currency: _c, amount_minor: _a, ...partial } = workloadRequest();
    assert.deepEqual(
      parseProbeWorkloadRequest(partial, PROBE),
      refusal('missing properties ["amount_minor","currency"]'),
    );
  });

  it('refuses each malformed field with the offending value and the expected shape', () => {
    const cases: readonly [JsonObject, string][] = [
      [{ schema_version: 2 }, 'schema_version number 2; expected 1'],
      [
        { record_type: 'provider_refund_call' },
        'record_type string "provider_refund_call"; expected probe_workload_request',
      ],
      [{ transport_probe_id: 'ABC' }, 'transport_probe_id string "ABC"; expected a lowercase RFC 4122 version-4 UUID'],
      [{ execution_manifest_sha256: 'a' }, 'execution_manifest_sha256 string "a"; expected 64 lowercase hex digits'],
      [{ payment_id: ' pay' }, 'payment_id string " pay"; expected a non-empty string without edge whitespace'],
      [{ refund_request_id: '' }, 'refund_request_id string ""; expected a non-empty string without edge whitespace'],
      [
        { refund_request_id: 'a\nb' },
        'refund_request_id string "a\\nb"; expected a non-empty string without edge whitespace',
      ],
      [{ refund_request_id: 7 }, 'refund_request_id number 7; expected a non-empty string without edge whitespace'],
      [{ amount_minor: 0 }, 'amount_minor number 0; expected a safe integer >= 1'],
      [{ amount_minor: 1.5 }, 'amount_minor number 1.5; expected a safe integer >= 1'],
      [{ amount_minor: '1' }, 'amount_minor string "1"; expected a safe integer >= 1'],
      [{ amount_minor: 2 ** 53 }, 'amount_minor number 9007199254740992; expected a safe integer >= 1'],
      [{ currency: 'USD' }, 'currency string "USD"; expected BRL'],
    ];
    for (const [overrides, problem] of cases) {
      assert.deepEqual(parseProbeWorkloadRequest(workloadRequest(overrides), PROBE), refusal(problem), problem);
    }
  });

  it("refuses a request for another probe or in a deployment that is not this probe's", () => {
    assert.deepEqual(
      parseProbeWorkloadRequest(workloadRequest({ transport_probe_id: OTHER_RUN_ID }), PROBE),
      refusal(`transport_probe_id string "${OTHER_RUN_ID}"; expected this deployment's probe ${PROBE_ID}`),
    );
    assert.deepEqual(
      parseProbeWorkloadRequest(workloadRequest(), RUN),
      refusal(`transport_probe_id string "${PROBE_ID}"; expected this deployment's probe (none: RUN deployment)`),
    );
  });
});
