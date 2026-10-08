// The publisher side of BR-RUA-036: the canonical message of a frozen trial and the
// pre-publication check that rejects setup on any mismatch. Expected messages are built from the
// spec's field list and the OR-RUA-001 identity, never from the code under test.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import type { TrialManifest } from '../../../src/record-contract/records/group-a/trial_manifest.ts';
import {
  PUBLICATION_MISMATCH_CODES,
  buildTrialMessage,
  validateBeforePublication,
} from '../../../src/trial-message/trial-message-publication.ts';
import {
  OTHER_RUN_ID,
  OTHER_TRIAL_ID,
  OTHER_TRIAL_MANIFEST_SHA,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION_ID,
  messageBody,
  runMessageObject,
  runPublication,
  runTrialManifest,
  withoutFields,
} from './support/trial-message-fixtures.ts';

const validator = createRecordValidator();
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function codesOf(bytes: Uint8Array): readonly string[] {
  return validateBeforePublication(bytes, runPublication(), validator).map((reason) => reason.code);
}

describe('buildTrialMessage', () => {
  it('holds exactly the BR-RUA-036 fields of the frozen trial and its approved request', () => {
    const built = buildTrialMessage(runPublication());
    assert.deepEqual(built.record, {
      schema_version: 1,
      record_type: 'trial_message',
      run_id: RUN_ID,
      trial_id: TRIAL_ID,
      trial_manifest_sha256: TRIAL_MANIFEST_SHA,
      payment_id: 'pay-poc-001',
      refund_request_id: 'ref-poc-001',
    });
    assert.equal(new TextDecoder().decode(built.bytes), messageBody(runMessageObject()));
  });

  it('carries the variant validation id of a validation trial', () => {
    const { run_id: _run, ...rest } = runTrialManifest() as TrialManifest & { readonly run_id: string };
    const trial = { ...rest, variant_validation_id: VALIDATION_ID } as TrialManifest;
    const built = buildTrialMessage(runPublication({ trial }));
    assert.equal(built.record.variant_validation_id, VALIDATION_ID);
    assert.equal('run_id' in built.record, false);
    assert.deepEqual(validateBeforePublication(built.bytes, runPublication({ trial }), validator), []);
  });
});

describe('validateBeforePublication', () => {
  it('finds nothing wrong with the built bytes', () => {
    assert.deepEqual(
      validateBeforePublication(buildTrialMessage(runPublication()).bytes, runPublication(), validator),
      [],
    );
  });

  it('rejects bytes that are not one JSON document, including invalid UTF-8', () => {
    const [utf8] = validateBeforePublication(Uint8Array.of(0x7b, 0xff, 0x7d), runPublication(), validator);
    assert.equal(
      utf8?.detail,
      'message bytes are not one JSON document (invalid UTF-8 at byte 1); expected the canonical trial_message',
    );
    for (const bytes of [encode('{"run_id":'), Uint8Array.of(0x7b, 0xff, 0x7d), encode('{"a":1e400}')]) {
      const reasons = validateBeforePublication(bytes, runPublication(), validator);
      assert.equal(reasons.length, 1);
      assert.equal(reasons[0]?.code, 'MESSAGE_UNPARSEABLE');
      assert.equal(reasons[0].subject, 'BR-RUA-036');
      assert.match(
        reasons[0].detail,
        /^message bytes are not one JSON document \(.+\); expected the canonical trial_message$/,
      );
    }
  });

  it('reports each schema violation, and nothing else, for a message the schema rejects', () => {
    const reasons = validateBeforePublication(
      encode(messageBody(runMessageObject({ amount_minor: 1 }))),
      runPublication(),
      validator,
    );
    assert.ok(reasons.length >= 1);
    assert.ok(
      reasons.every((reason) => reason.code === 'SCHEMA_INVALID' && reason.detail.startsWith('trial_message ')),
    );
    assert.deepEqual(
      codesOf(encode(messageBody(withoutFields(runMessageObject(), 'trial_id')))).at(0),
      'SCHEMA_INVALID',
    );
  });

  it('rejects valid but non-canonical bytes: whitespace, member order or a missing newline', () => {
    const object = runMessageObject();
    assert.deepEqual(codesOf(encode(`${JSON.stringify(object, null, 2)}\n`)), ['NON_CANONICAL_BYTES']);
    assert.deepEqual(codesOf(encode(messageBody(object).trimEnd())), ['NON_CANONICAL_BYTES']);
    const reordered = `{"trial_id":"${TRIAL_ID}",${JSON.stringify(withoutFields(object, 'trial_id')).slice(1)}\n`;
    assert.deepEqual(codesOf(encode(reordered)), ['NON_CANONICAL_BYTES']);
  });

  it('names every field that differs from the frozen trial', () => {
    const cases = [
      [
        { run_id: OTHER_RUN_ID },
        'EXECUTION_IDENTITY_MISMATCH',
        `message execution identity run_id ${OTHER_RUN_ID}; expected run_id ${RUN_ID} of the frozen trial`,
      ],
      [
        { trial_id: OTHER_TRIAL_ID },
        'TRIAL_ID_MISMATCH',
        `message trial_id ${OTHER_TRIAL_ID}; expected ${TRIAL_ID} of the frozen trial`,
      ],
      [
        { trial_manifest_sha256: OTHER_TRIAL_MANIFEST_SHA },
        'TRIAL_MANIFEST_DIGEST_MISMATCH',
        `message trial_manifest_sha256 ${OTHER_TRIAL_MANIFEST_SHA}; expected ${TRIAL_MANIFEST_SHA} of the frozen trial`,
      ],
      [
        { payment_id: 'pay-poc-002' },
        'BUSINESS_IDENTITY_MISMATCH',
        'message payment_id pay-poc-002; expected pay-poc-001 of the frozen trial',
      ],
      [
        { refund_request_id: 'ref-poc-002' },
        'BUSINESS_IDENTITY_MISMATCH',
        'message refund_request_id ref-poc-002; expected ref-poc-001 of the frozen trial',
      ],
    ] as const;
    for (const [override, code, detail] of cases) {
      const reasons = validateBeforePublication(
        encode(messageBody(runMessageObject(override))),
        runPublication(),
        validator,
      );
      assert.deepEqual(reasons, [{ code, subject: 'BR-RUA-036', detail }]);
    }
  });

  it('reports a validation identity against a run trial as an execution identity mismatch', () => {
    const object = { ...withoutFields(runMessageObject(), 'run_id'), variant_validation_id: RUN_ID };
    assert.deepEqual(codesOf(encode(messageBody(object))), ['EXECUTION_IDENTITY_MISMATCH']);
  });

  it('reports all mismatches at once, in a fixed order, with the non-canonical form first', () => {
    const object = runMessageObject({
      run_id: OTHER_RUN_ID,
      trial_id: OTHER_TRIAL_ID,
      payment_id: 'x',
      refund_request_id: 'y',
    });
    assert.deepEqual(codesOf(encode(JSON.stringify(object))), [
      'NON_CANONICAL_BYTES',
      'EXECUTION_IDENTITY_MISMATCH',
      'TRIAL_ID_MISMATCH',
      'BUSINESS_IDENTITY_MISMATCH',
      'BUSINESS_IDENTITY_MISMATCH',
    ]);
    assert.ok(
      codesOf(encode(JSON.stringify(object))).every((code) =>
        (PUBLICATION_MISMATCH_CODES as readonly string[]).includes(code),
      ),
    );
  });
});
