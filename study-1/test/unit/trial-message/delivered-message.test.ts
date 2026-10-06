// The consumer check of BR-RUA-036 (AC-RUA-019 feed): which delivered bodies are accepted, the
// reason each rejection carries, and totality over hostile bodies (Owner amendment A-05: deep
// nesting, non-finite numbers, inherited member names). Expected reasons follow the order the
// module header states, from the spec's correlation fields.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JsonObject } from '../../../src/record-contract/primitives.ts';
import { CARRIED_IDENTIFIER_LIMIT, validateDeliveredMessage } from '../../../src/trial-message/delivered-message.ts';
import type { ConsumerValidation } from '../../../src/trial-message/delivered-message.ts';
import { DEEP_NESTING, towerText } from '../../support/kernel/deep-json.ts';
import {
  OTHER_RUN_ID,
  OTHER_TRIAL_ID,
  OTHER_TRIAL_MANIFEST_SHA,
  PAYMENT_ID,
  REFUND_REQUEST_ID,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION_ID,
  messageBody,
  runMessage,
  runMessageObject,
  runRegistration,
  validationRegistration,
  withoutFields,
} from './support/trial-message-fixtures.ts';

const IDENTITY = { refund_request_id: REFUND_REQUEST_ID, payment_id: PAYMENT_ID };

function validate(body: string): ConsumerValidation {
  return validateDeliveredMessage(body, runRegistration());
}

function rejectedWith(
  validation: ConsumerValidation,
  reason: string,
): ConsumerValidation & { readonly kind: 'rejected' } {
  assert.equal(validation.kind, 'rejected', JSON.stringify(validation));
  assert.equal(validation.reason, reason, validation.detail);
  return validation;
}

describe('validateDeliveredMessage', () => {
  it('accepts the canonical run message and returns exactly its fields', () => {
    assert.deepEqual(validate(messageBody()), { kind: 'accepted', message: runMessage() });
    assert.deepEqual(validate(JSON.stringify(runMessageObject())), { kind: 'accepted', message: runMessage() });
  });

  it('accepts a variant-validation message against a variant-validation registration', () => {
    const body = messageBody({ ...withoutFields(runMessageObject(), 'run_id'), variant_validation_id: VALIDATION_ID });
    const validation = validateDeliveredMessage(body, validationRegistration());
    assert.equal(validation.kind, 'accepted');
    assert.equal(validation.message.variant_validation_id, VALIDATION_ID);
    assert.equal('run_id' in validation.message, false);
  });

  it('rejects any message as NO_ACTIVE_TRIAL without a registration, keeping a readable identity', () => {
    const validation = validateDeliveredMessage(messageBody(), undefined);
    assert.deepEqual(rejectedWith(validation, 'NO_ACTIVE_TRIAL'), {
      kind: 'rejected',
      reason: 'NO_ACTIVE_TRIAL',
      detail:
        'no active trial registration for the consuming variant; expected the runner to register the trial before publishing its message',
      ...IDENTITY,
    });
    const unreadable = rejectedWith(validateDeliveredMessage('not json', undefined), 'NO_ACTIVE_TRIAL');
    assert.equal(unreadable.refund_request_id, undefined);
  });

  it('rejects a body that is not one JSON object as SCHEMA_INVALID', () => {
    const notJson = rejectedWith(validate('{"schema_version":'), 'SCHEMA_INVALID');
    assert.match(notJson.detail, /^message body is not JSON \(/);
    assert.match(
      rejectedWith(validate('[1, 2]'), 'SCHEMA_INVALID').detail,
      /^message body is array \[1,2\]; expected a JSON object$/,
    );
    assert.match(rejectedWith(validate('null'), 'SCHEMA_INVALID').detail, /expected a JSON object/);
    assert.equal(notJson.refund_request_id, undefined);
  });

  it('rejects a body holding a non-finite number (1e400) as SCHEMA_INVALID, never as a message', () => {
    const body = messageBody().replace('"schema_version":1', '"schema_version":1e400');
    assert.match(rejectedWith(validate(body), 'SCHEMA_INVALID').detail, /^message body is not JSON/);
  });

  it(`stays total on bodies nested ${String(DEEP_NESTING)} levels deep`, () => {
    for (const shape of ['array', 'object', 'mixed'] as const) {
      const validation = validate(towerText(shape, DEEP_NESTING, '1'));
      assert.equal(validation.kind, 'rejected');
      assert.ok(validation.detail.length < 1_000);
    }
    const deepField = JSON.stringify(runMessageObject()).replace(
      `"${PAYMENT_ID}"`,
      towerText('array', DEEP_NESTING, '1'),
    );
    const rejected = rejectedWith(validate(deepField), 'SCHEMA_INVALID');
    assert.match(rejected.detail, /^message payment_id array \[\[\[/);
    assert.ok(rejected.detail.length < 1_000);
  });

  it('rejects a message without its correlation fields as CORRELATION_MISSING', () => {
    const cases: readonly (readonly [JsonObject, string])[] = [
      [withoutFields(runMessageObject(), 'run_id'), 'message has no run_id or variant_validation_id'],
      [withoutFields(runMessageObject(), 'trial_id'), 'message has no trial_id'],
      [withoutFields(runMessageObject(), 'trial_manifest_sha256'), 'message has no trial_manifest_sha256'],
    ];
    for (const [object, prefix] of cases) {
      const rejected = rejectedWith(validate(messageBody(object)), 'CORRELATION_MISSING');
      assert.equal(rejected.detail, `${prefix}; expected the BR-RUA-036 correlation fields`);
      assert.deepEqual(
        { refund: rejected.refund_request_id, payment: rejected.payment_id },
        { refund: REFUND_REQUEST_ID, payment: PAYMENT_ID },
      );
    }
  });

  it('rejects every other trial_message schema violation as SCHEMA_INVALID, naming the property', () => {
    const cases: readonly (readonly [JsonObject, RegExp])[] = [
      [runMessageObject({ amount_minor: 10000 }), /unexpected property "amount_minor"/],
      [runMessageObject({ schema_version: 2 }), /schema_version number 2; expected 1$/],
      [runMessageObject({ schema_version: '1' }), /schema_version string "1"; expected 1$/],
      [
        runMessageObject({ record_type: 'trial_manifest' }),
        /record_type string "trial_manifest"; expected "trial_message"$/,
      ],
      [runMessageObject({ variant_validation_id: VALIDATION_ID }), /expected exactly one lowercase UUIDv4$/],
      [
        runMessageObject({ run_id: RUN_ID.toUpperCase() }),
        /run_id string "AAAAAAAA-.*expected exactly one lowercase UUIDv4$/,
      ],
      [runMessageObject({ trial_id: 'trial-1' }), /trial_id string "trial-1"; expected a lowercase UUIDv4$/],
      [
        runMessageObject({ trial_manifest_sha256: 'B'.repeat(64) }),
        /trial_manifest_sha256 string "B+"; expected 64 lowercase hex/,
      ],
      [runMessageObject({ payment_id: ' pay-poc-001' }), /payment_id string " pay-poc-001"; expected a string without/],
      [runMessageObject({ refund_request_id: 7 }), /refund_request_id number 7; expected a string without/],
      [withoutFields(runMessageObject(), 'refund_request_id'), /refund_request_id absent; expected a string without/],
    ];
    for (const [object, pattern] of cases) {
      assert.match(rejectedWith(validate(messageBody(object)), 'SCHEMA_INVALID').detail, pattern);
    }
  });

  it('treats inherited member names as properties of their own, never as fields', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const body = messageBody().replace('{', `{"${name}":{"run_id":"${RUN_ID}"},`);
      const rejected = rejectedWith(validate(body), 'SCHEMA_INVALID');
      assert.match(rejected.detail, new RegExp(`unexpected property "${name}"`));
    }
    const noIdentity = messageBody(withoutFields(runMessageObject(), 'run_id')).replace(
      '{',
      '{"__proto__":{"run_id":1},',
    );
    rejectedWith(validate(noIdentity), 'CORRELATION_MISSING');
  });

  it('rejects another execution identity as EXECUTION_IDENTITY_MISMATCH with both values', () => {
    const rejected = rejectedWith(
      validate(messageBody(runMessageObject({ run_id: OTHER_RUN_ID }))),
      'EXECUTION_IDENTITY_MISMATCH',
    );
    assert.deepEqual(rejected, {
      kind: 'rejected',
      reason: 'EXECUTION_IDENTITY_MISMATCH',
      detail: `message run_id ${OTHER_RUN_ID}; expected run_id ${RUN_ID} of the active trial registration`,
      offending_value: OTHER_RUN_ID,
      expected_value: RUN_ID,
      ...IDENTITY,
    });
    const validationMessage = { ...withoutFields(runMessageObject(), 'run_id'), variant_validation_id: RUN_ID };
    const crossKind = rejectedWith(validate(messageBody(validationMessage)), 'EXECUTION_IDENTITY_MISMATCH');
    assert.equal(
      crossKind.detail,
      `message variant_validation_id ${RUN_ID}; expected run_id ${RUN_ID} of the active trial registration`,
    );
  });

  it('rejects another trial-manifest digest as TRIAL_MANIFEST_DIGEST_MISMATCH with both values', () => {
    const rejected = rejectedWith(
      validate(messageBody(runMessageObject({ trial_manifest_sha256: OTHER_TRIAL_MANIFEST_SHA }))),
      'TRIAL_MANIFEST_DIGEST_MISMATCH',
    );
    assert.deepEqual(rejected, {
      kind: 'rejected',
      reason: 'TRIAL_MANIFEST_DIGEST_MISMATCH',
      detail: `message trial_manifest_sha256 ${OTHER_TRIAL_MANIFEST_SHA}; expected ${TRIAL_MANIFEST_SHA} of the active trial`,
      offending_value: OTHER_TRIAL_MANIFEST_SHA,
      expected_value: TRIAL_MANIFEST_SHA,
      ...IDENTITY,
    });
  });

  it('rejects another trial id under the registered digest as TRIAL_MANIFEST_DIGEST_MISMATCH', () => {
    const rejected = rejectedWith(
      validate(messageBody(runMessageObject({ trial_id: OTHER_TRIAL_ID }))),
      'TRIAL_MANIFEST_DIGEST_MISMATCH',
    );
    assert.deepEqual(
      { offending: rejected.offending_value, expected: rejected.expected_value },
      { offending: OTHER_TRIAL_ID, expected: TRIAL_ID },
    );
    assert.match(rejected.detail, /expected trial_id .* which that frozen trial manifest names$/);
  });

  it('checks the execution identity before the digest and the digest before the trial id', () => {
    const all = runMessageObject({
      run_id: OTHER_RUN_ID,
      trial_manifest_sha256: OTHER_TRIAL_MANIFEST_SHA,
      trial_id: OTHER_TRIAL_ID,
    });
    rejectedWith(validate(messageBody(all)), 'EXECUTION_IDENTITY_MISMATCH');
    const digestAndTrial = runMessageObject({
      trial_manifest_sha256: OTHER_TRIAL_MANIFEST_SHA,
      trial_id: OTHER_TRIAL_ID,
    });
    assert.equal(
      rejectedWith(validate(messageBody(digestAndTrial)), 'TRIAL_MANIFEST_DIGEST_MISMATCH').offending_value,
      OTHER_TRIAL_MANIFEST_SHA,
    );
  });

  it(`carries a business identifier of up to ${String(CARRIED_IDENTIFIER_LIMIT)} characters, and leaves longer ones out`, () => {
    const atLimit = 'r'.repeat(CARRIED_IDENTIFIER_LIMIT);
    const carried = rejectedWith(
      validateDeliveredMessage(messageBody(runMessageObject({ refund_request_id: atLimit })), undefined),
      'NO_ACTIVE_TRIAL',
    );
    assert.equal(carried.refund_request_id, atLimit);
    const tooLong = rejectedWith(
      validateDeliveredMessage(
        messageBody(runMessageObject({ refund_request_id: `${atLimit}r`, payment_id: ' x' })),
        undefined,
      ),
      'NO_ACTIVE_TRIAL',
    );
    assert.deepEqual(
      { refund: tooLong.refund_request_id, payment: tooLong.payment_id },
      { refund: undefined, payment: undefined },
    );
  });

  it('bounds the detail of a multi-megabyte property name', () => {
    const name = 'k'.repeat(5_000_000);
    const rejected = rejectedWith(validate(messageBody(runMessageObject({ [name]: 1 }))), 'SCHEMA_INVALID');
    assert.ok(rejected.detail.length < 1_000, `detail of ${String(rejected.detail.length)} characters`);
  });
});
