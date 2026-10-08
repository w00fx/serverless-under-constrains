// Property-based tests of the consumer's untrusted-input boundary (testing rule 6; BR-RUA-036,
// AC-RUA-019). The guard is hand-written, so it is checked differentially against the
// catalogue's Ajv validator: on near-valid bodies (a valid message with up to three properties
// removed or replaced by boundary values) it accepts exactly the bodies the `trial_message`
// schema accepts that also match the active registration, and it reports a mismatch exactly when
// a well-formed identity value names another execution, digest or trial (design D-28), schema
// faults elsewhere in the body notwithstanding. Every rejection must journal as a valid `trial_message_rejected`
// event. The check is total over arbitrary strings, JSON nested far deeper than the call stack
// and non-finite numbers (Owner amendment A-05).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import fc from 'fast-check';

import { buildJournalEvent } from '../../../src/event-journal/journal-event.ts';
import type { JournalScope } from '../../../src/event-journal/journal-scope.ts';
import { sha256Hex } from '../../../src/record-contract/digests.ts';
import type { JsonObject, JsonValue, Uuid4, UtcMillis } from '../../../src/record-contract/primitives.ts';
import type { TrialRegistration } from '../../../src/record-contract/records/group-a/trial_registration.ts';
import { TRIAL_MESSAGE_REJECTION_REASONS } from '../../../src/record-contract/records/group-b/vocabulary.ts';
import { createRecordValidator } from '../../../src/record-contract/schema-registry.ts';
import { validateDeliveredMessage } from '../../../src/trial-message/delivered-message.ts';
import type { ConsumerRejection } from '../../../src/trial-message/delivered-message.ts';
import { executionRefOf } from '../../../src/trial-message/trial-message-fields.ts';
import { fuzzParameters } from '../../support/kernel/fuzz-parameters.ts';
import { mutated, nearValidObjects } from './support/near-valid-objects.ts';
import { towerText } from '../../support/kernel/deep-json.ts';
import {
  MANIFEST_SHA,
  OTHER_RUN_ID,
  OTHER_TRIAL_ID,
  OTHER_TRIAL_MANIFEST_SHA,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION_ID,
  runMessageObject,
  runRegistration,
  validationRegistration,
} from '../../unit/trial-message/support/trial-message-fixtures.ts';

const validator = createRecordValidator();
const PROPERTIES = Object.keys(runMessageObject());
const REJECTION_SCOPE: JournalScope = {
  execution: RUN,
  execution_manifest_sha256: MANIFEST_SHA,
  partition: { kind: 'trial', trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA },
};

const boundaryValue: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.constantFrom<JsonValue>(
    0,
    1,
    2,
    1.5,
    -1,
    '',
    ' ',
    'a',
    ' a',
    'a ',
    'pay\npoc',
    'ref-poc-001',
    'trial_message',
    'trial_registration',
    null,
    true,
    [],
    {},
    RUN_ID,
    OTHER_RUN_ID,
    VALIDATION_ID,
    TRIAL_ID,
    OTHER_TRIAL_ID,
    RUN_ID.toUpperCase(),
    TRIAL_MANIFEST_SHA,
    OTHER_TRIAL_MANIFEST_SHA,
    TRIAL_MANIFEST_SHA.toUpperCase(),
    TRIAL_MANIFEST_SHA.slice(1),
  ),
  fc.uuid({ version: 4 }),
  fc.stringMatching(/^[0-9a-f]{64}$/u),
  fc.string({ maxLength: 6 }),
  fc.integer(),
);

const nearValidObject = nearValidObjects(runMessageObject(), ['variant_validation_id'], boundaryValue);
const registrationArbitrary: fc.Arbitrary<TrialRegistration> = fc.constantFrom(
  runRegistration(),
  validationRegistration(),
);

// Bodies far deeper than the call stack, and a near-valid body whose number overflows a double.
const hostileBody: fc.Arbitrary<string> = fc.oneof(
  fc
    .record({
      shape: fc.constantFrom('array', 'object', 'mixed' as const),
      depth: fc.integer({ min: 2_500, max: 20_000 }),
    })
    .map(({ shape, depth }) => towerText(shape, depth, '1')),
  fc
    .constantFrom(...PROPERTIES)
    .map((property) =>
      JSON.stringify(mutated(runMessageObject(), [[property, 'NON_FINITE']])).replace('"NON_FINITE"', '1e400'),
    ),
  fc.string(),
);

function matchesRegistration(message: JsonObject, registration: TrialRegistration): boolean {
  const expected = executionRefOf(registration);
  return (
    message[expected.field] === expected.id &&
    message['trial_manifest_sha256'] === registration.trial_manifest_sha256 &&
    message['trial_id'] === registration.trial_id
  );
}

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

function wellFormed(value: JsonValue | undefined, pattern: RegExp): value is string {
  return typeof value === 'string' && pattern.test(value);
}

// Design D-28, stated independently of the guard: which mismatch reason a message earns by
// naming, in a well-formed value, another execution, or another digest or trial id.
function namedMismatch(message: JsonObject, registration: TrialRegistration): string | undefined {
  const expected = executionRefOf(registration);
  const foreignExecution = (['run_id', 'variant_validation_id'] as const).some((field) => {
    const id = Object.hasOwn(message, field) ? message[field] : undefined;
    return wellFormed(id, UUID4) && (field !== expected.field || id !== expected.id);
  });
  if (foreignExecution) {
    return 'EXECUTION_IDENTITY_MISMATCH';
  }
  const digest = message['trial_manifest_sha256'];
  const trialId = message['trial_id'];
  const foreignDigest = wellFormed(digest, SHA256) && digest !== registration.trial_manifest_sha256;
  const foreignTrial = wellFormed(trialId, UUID4) && trialId !== registration.trial_id;
  return foreignDigest || foreignTrial ? 'TRIAL_MANIFEST_DIGEST_MISMATCH' : undefined;
}

function rejectionEvent(rejection: ConsumerRejection, body: string): JsonValue {
  const { kind: _kind, ...fields } = rejection;
  const event = buildJournalEvent(
    'trial_message_rejected',
    { ...fields, message_id: 'message-1', message_body_sha256: sha256Hex(new TextEncoder().encode(body)) },
    {
      scope: REJECTION_SCOPE,
      source: 'conventional_caller',
      source_instance_id: 'cccccccc-0000-4000-8000-000000000001' as Uuid4,
      source_sequence: 2,
      event_id: 'cccccccc-0000-4000-8000-000000000002' as Uuid4,
      occurred_at: '2026-10-05T12:00:00.000Z' as UtcMillis,
      causation: ['cccccccc-0000-4000-8000-000000000003' as Uuid4],
    },
  );
  return event as unknown as JsonValue;
}

describe('delivered trial message properties', () => {
  it('accepts exactly the schema-valid bodies that match the registration, and reports exactly the D-28 mismatches', () => {
    const seen = { accepted: 0, mismatched: 0, invalid: 0, invalid_mismatch: 0 };
    fc.assert(
      fc.property(nearValidObject, registrationArbitrary, (object, registration) => {
        const body = JSON.stringify(object);
        const reparsed = JSON.parse(body) as JsonObject;
        const schemaValid = validator.validateAs('trial_message', reparsed).valid;
        const expected = schemaValid && matchesRegistration(reparsed, registration);
        const mismatch = namedMismatch(reparsed, registration);
        const validation = validateDeliveredMessage(body, registration);
        seen[expected ? 'accepted' : schemaValid ? 'mismatched' : 'invalid'] += 1;
        seen.invalid_mismatch += !schemaValid && mismatch !== undefined ? 1 : 0;
        if (validation.kind === 'accepted') {
          assert.ok(expected, body);
          assert.deepEqual(validation.message, reparsed);
          return;
        }
        assert.ok(!expected, `${body} rejected as ${validation.reason}: ${validation.detail}`);
        const mismatchReasons: readonly string[] = ['EXECUTION_IDENTITY_MISMATCH', 'TRIAL_MANIFEST_DIGEST_MISMATCH'];
        const reported = mismatchReasons.includes(validation.reason) ? validation.reason : undefined;
        assert.equal(reported, mismatch, `${body}: ${validation.reason}`);
      }),
      fuzzParameters(),
    );
    const { accepted, mismatched, invalid, invalid_mismatch: invalidMismatch } = seen;
    assert.ok(accepted > 0 && mismatched > 0 && invalid > 0 && invalidMismatch > 0, JSON.stringify(seen));
  });

  it('judges any body without throwing, and every rejection journals as a valid trial_message_rejected event', () => {
    const body = fc.oneof(
      nearValidObject.map((object) => JSON.stringify(object)),
      hostileBody,
    );
    fc.assert(
      fc.property(body, fc.option(registrationArbitrary, { nil: undefined }), (text, registration) => {
        const validation = validateDeliveredMessage(text, registration);
        if (validation.kind === 'accepted') {
          return;
        }
        assert.ok((TRIAL_MESSAGE_REJECTION_REASONS as readonly string[]).includes(validation.reason));
        assert.ok(validation.detail.length > 0 && validation.detail.length < 2_000, validation.detail.slice(0, 300));
        const checked = validator.validateAs('trial_message_rejected', rejectionEvent(validation, text));
        assert.ok(checked.valid, JSON.stringify(checked).slice(0, 2_000));
      }),
      fuzzParameters(),
    );
  });

  it('rejects every body as NO_ACTIVE_TRIAL when no trial is registered', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          nearValidObject.map((object) => JSON.stringify(object)),
          fc.string(),
        ),
        (text) => {
          const validation = validateDeliveredMessage(text, undefined);
          assert.equal(validation.kind === 'rejected' ? validation.reason : 'accepted', 'NO_ACTIVE_TRIAL');
        },
      ),
      fuzzParameters(),
    );
  });
});
