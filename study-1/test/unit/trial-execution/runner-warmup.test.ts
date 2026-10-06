// The runner's warm-up check (addendum §2): only the provider's completion of this very warm-up,
// from the expected published version, lets the trial publish; everything else is a setup
// rejection that names what was wrong.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ProviderTransportResult } from '../../../src/provider-client/provider-invocation-port.ts';
import type { JsonValue } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { warmupRequestOf, warmupSettlementProblem } from '../../../src/trial-execution/runner-warmup.ts';
import { SequentialUuidSource } from '../../support/kernel/sequential-uuid-source.ts';
import { MANIFEST_SHA, RUN_ID, TRIAL_ID, warmupCompleted, warmupRequest } from './support/trial-execution-fixtures.ts';

const validator = createRecordValidator();
const encoder = new TextEncoder();

function response(
  payload: JsonValue | Uint8Array,
  overrides: Partial<ProviderTransportResult> = {},
): ProviderTransportResult {
  return {
    kind: 'response',
    status_code: 200,
    executed_version: '1',
    function_error: undefined,
    payload: payload instanceof Uint8Array ? payload : encoder.encode(JSON.stringify(payload)),
    ...overrides,
  } as ProviderTransportResult;
}

function problemOf(settlement: ProviderTransportResult): string | undefined {
  const problem = warmupSettlementProblem(settlement, warmupRequest(), '1', validator);
  assert.equal(problem?.code ?? 'PROVIDER_WARMUP_FAILED', 'PROVIDER_WARMUP_FAILED');
  return problem?.detail;
}

describe('warmupRequestOf', () => {
  it('names the execution, its manifest, a fresh warm-up id and the trial about to start', () => {
    const request = warmupRequestOf(
      {
        execution: { execution_kind: 'RUN', run_id: RUN_ID },
        execution_manifest_sha256: MANIFEST_SHA,
        trial: { trial_id: TRIAL_ID },
      } as Parameters<typeof warmupRequestOf>[0],
      new SequentialUuidSource('abababab'),
    );
    assert.deepEqual(request, {
      schema_version: 1,
      record_type: 'provider_warmup_request',
      run_id: RUN_ID,
      execution_manifest_sha256: MANIFEST_SHA,
      warmup_id: 'abababab-0000-4000-8000-000000000001',
      trial_id: TRIAL_ID,
    });
    assert.equal(validator.validate(request as unknown as JsonValue).valid, true);
  });
});

describe('warmupSettlementProblem', () => {
  it('accepts the completion of this warm-up from the expected version', () => {
    assert.equal(problemOf(response(warmupCompleted())), undefined);
  });

  it('refuses a transport error, naming it', () => {
    const detail = problemOf({ kind: 'transport_error', error_name: 'TimeoutError', message: 'socket hang up' });
    assert.match(detail ?? '', /the Invoke failed with TimeoutError: socket hang up/);
  });

  it('refuses a function error or a status other than 200', () => {
    assert.match(
      problemOf(response(warmupCompleted(), { function_error: 'Unhandled' })) ?? '',
      /function error Unhandled/,
    );
    assert.match(problemOf(response(warmupCompleted(), { status_code: 500 })) ?? '', /status 500/);
  });

  it('refuses another executed version, or none', () => {
    assert.match(
      problemOf(response(warmupCompleted(), { executed_version: '$LATEST' })) ?? '',
      /executed version \$LATEST, not 1/,
    );
    assert.match(
      problemOf(response(warmupCompleted(), { executed_version: undefined })) ?? '',
      /executed version undefined/,
    );
  });

  it('refuses a payload that is not one JSON document', () => {
    assert.match(problemOf(response(encoder.encode('{"truncated":'))) ?? '', /not one JSON document \(invalid_json\)/);
    assert.match(problemOf(response(Uint8Array.of(0xff))) ?? '', /not one JSON document \(invalid_utf8\)/);
  });

  it('refuses a payload that is not a provider_warmup_completed', () => {
    assert.match(
      problemOf(response({ record_type: 'provider_refund_response' })) ?? '',
      /not a provider_warmup_completed/,
    );
    assert.match(problemOf(response(warmupCompleted({ provider_call_id: 'not-a-uuid' }))) ?? '', /provider_call_id/);
  });

  it('refuses the completion of another warm-up or execution, naming the field', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['warmup_id', '99999999-0000-4000-8000-000000000001'],
      ['execution_manifest_sha256', 'b'.repeat(64)],
      ['run_id', '99999999-0000-4000-8000-000000000002'],
    ];
    for (const [field, value] of cases) {
      assert.match(
        problemOf(response(warmupCompleted({ [field]: value }))) ?? '',
        new RegExp(`names ${field} "${value}"`),
        field,
      );
    }
    const { run_id: _run, ...withoutRun } = warmupCompleted();
    const validation = { ...withoutRun, variant_validation_id: '99999999-0000-4000-8000-000000000003' };
    assert.match(problemOf(response(validation)) ?? '', /names run_id absent, not "/);
  });
});
