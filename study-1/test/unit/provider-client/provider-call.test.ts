// buildProviderCall (design §5.3 C2) and assertValidAttemptInput: the call carries exactly one
// execution identity matching its caller (D-06), every call it builds is valid under the real
// `provider_refund_call` schema, and inputs the attempt records could not hold are refused.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { assertValidAttemptInput } from '../../../src/provider-client/attempt-input.ts';
import type { AttemptInput } from '../../../src/provider-client/attempt-input.ts';
import { buildProviderCall } from '../../../src/provider-client/provider-call.ts';
import type { JsonValue, Uuid4 } from '../../../src/record-contract/primitives.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import {
  executionLevelScope,
  MANIFEST_SHA,
  PROBE,
  PROBE_ID,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  TRIAL_SCOPE,
  VALIDATION,
  VALIDATION_ID,
} from '../../support/event-journal/journal-fixtures.ts';
import {
  attemptInput,
  FIRST_ATTEMPT_ID,
  FIRST_PROVIDER_REQUEST_ID,
  PROVIDER_CALL,
} from '../../support/provider-client/provider-client-fixtures.ts';

const IDS = { attempt_id: FIRST_ATTEMPT_ID, provider_request_id: FIRST_PROVIDER_REQUEST_ID };
const VALIDATION_TRIAL_SCOPE: JournalScope = { ...TRIAL_SCOPE, execution: VALIDATION };
const validator = createRecordValidator();

function built(input: AttemptInput, scope: JournalScope): JsonValue {
  const result = buildProviderCall(input, IDS, scope);
  assert.ok(result.ok, JSON.stringify(result));
  return result.value as unknown as JsonValue;
}

describe('buildProviderCall', () => {
  it('a variant caller in a run trial carries run_id and the trial identity', () => {
    const call = built(attemptInput({ caller_id: 'durable' }), TRIAL_SCOPE);
    assert.deepEqual(call, {
      caller_id: 'durable',
      run_id: RUN_ID,
      trial_id: TRIAL_ID,
      trial_manifest_sha256: TRIAL_MANIFEST_SHA,
      schema_version: 1,
      record_type: 'provider_refund_call',
      execution_manifest_sha256: MANIFEST_SHA,
      attempt_id: FIRST_ATTEMPT_ID,
      provider_request_id: FIRST_PROVIDER_REQUEST_ID,
      refund_request_id: 'ref-poc-001',
      payment_id: 'pay-poc-001',
      amount_minor: 10000,
      currency: 'BRL',
    });
    assert.equal(validator.validateAs('provider_refund_call', call).valid, true);
  });

  it('the PoC conventional attempt in a run trial builds the shared PROVIDER_CALL fixture', () => {
    assert.deepEqual(built(attemptInput(), TRIAL_SCOPE), PROVIDER_CALL);
  });

  it('a variant caller in a variant-validation trial carries variant_validation_id', () => {
    const call = built(attemptInput(), VALIDATION_TRIAL_SCOPE);
    assert.equal((call as Record<string, JsonValue>)['variant_validation_id'], VALIDATION_ID);
    assert.equal('run_id' in (call as Record<string, JsonValue>), false);
    assert.equal(validator.validateAs('provider_refund_call', call).valid, true);
  });

  it('the probe caller in the probe partition carries transport_probe_id and no trial', () => {
    const call = built(attemptInput({ caller_id: 'probe' }), executionLevelScope(PROBE, 'probe'));
    const fields = call as Record<string, JsonValue>;
    assert.equal(fields['caller_id'], 'probe');
    assert.equal(fields['transport_probe_id'], PROBE_ID);
    assert.equal('trial_id' in fields, false);
    assert.equal('trial_manifest_sha256' in fields, false);
    assert.equal(validator.validateAs('provider_refund_call', call).valid, true);
  });

  it('refuses every caller and scope pair no valid call can carry', () => {
    const cases: readonly (readonly [AttemptInput['caller_id'], JournalScope, string])[] = [
      ['probe', TRIAL_SCOPE, 'caller probe in a RUN execution with partition trial'],
      [
        'probe',
        executionLevelScope(PROBE, 'canary'),
        'caller probe in a TRANSPORT_PROBE execution with partition canary',
      ],
      ['probe', executionLevelScope(RUN, 'probe'), 'caller probe in a RUN execution with partition probe'],
      [
        'conventional',
        executionLevelScope(PROBE, 'probe'),
        'caller conventional in a TRANSPORT_PROBE execution with partition probe',
      ],
      ['durable', executionLevelScope(RUN, 'warmup'), 'caller durable in a RUN execution with partition warmup'],
      [
        'conventional',
        { ...TRIAL_SCOPE, execution: PROBE },
        'caller conventional in a TRANSPORT_PROBE execution with partition trial',
      ],
    ];
    for (const [callerId, scope, prefix] of cases) {
      const result = buildProviderCall(attemptInput({ caller_id: callerId }), IDS, scope);
      assert.equal(result.ok, false, prefix);
      assert.equal(result.error.code, 'CALL_BUILD_FAILED');
      assert.equal(result.error.subject, 'BR-RUA-021');
      assert.ok(result.error.detail.startsWith(`${prefix}; expected a `), prefix);
    }
  });
});

describe('assertValidAttemptInput', () => {
  it('accepts the PoC input', () => {
    assert.doesNotThrow(() => {
      assertValidAttemptInput(attemptInput());
    });
  });

  it('refuses each field the attempt_registered schema would reject', () => {
    const cases: readonly (readonly [Partial<AttemptInput>, string])[] = [
      [
        { refund_request_id: '' },
        'refund_request_id ""; expected a string without leading or trailing whitespace and at least one character',
      ],
      [{ refund_request_id: ' ref' }, 'refund_request_id " ref"'],
      [{ payment_id: 'pay\n' }, 'payment_id "pay\\n"'],
      [{ amount_minor: 0 }, 'amount_minor 0; expected a safe integer >= 1'],
      [{ amount_minor: 1.5 }, 'amount_minor 1.5'],
      [{ amount_minor: 2 ** 53 }, 'amount_minor 9007199254740992'],
      [{ provider_qualifier: '$LATEST' }, 'provider_qualifier "$LATEST"; expected a Lambda version number such as "7"'],
      [{ provider_qualifier: '07' }, 'provider_qualifier "07"'],
      [
        { causation_event_ids: ['not-a-uuid' as Uuid4] },
        'causation event id "not-a-uuid"; expected a lowercase UUIDv4',
      ],
    ];
    for (const [overrides, message] of cases) {
      assert.throws(
        () => {
          assertValidAttemptInput(attemptInput(overrides));
        },
        (error: unknown) =>
          error instanceof RangeError && error.message.startsWith(`invalid attempt input: ${message}`),
        message,
      );
    }
  });

  it('accepts single-character identities and the largest safe amount', () => {
    assert.doesNotThrow(() => {
      assertValidAttemptInput(
        attemptInput({
          refund_request_id: 'r',
          payment_id: 'p',
          amount_minor: Number.MAX_SAFE_INTEGER,
          causation_event_ids: [],
        }),
      );
    });
  });
});
