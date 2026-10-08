// The consumer side of BR-RUA-036: a delivered SQS body checked against the active trial
// registration before any provider call. "A post-publication consumer mismatch records
// `MESSAGE_REJECTED`, calls no provider, and makes the trial indeterminate" (AC-RUA-019).
//
// The body is untrusted bytes, so the check is total: any string, including JSON nested far
// deeper than the call stack, non-finite numbers (`1e400`) and inherited member names, yields a
// verdict and never throws (Owner amendment A-05). The guard is hand-written and fuzzed
// differentially against the `trial_message` schema (test/fuzz/trial-message).
//
// The checks run in a fixed order, and the first failure is the reason:
// 1. no active registration: `NO_ACTIVE_TRIAL`;
// 2. not a JSON object: `SCHEMA_INVALID`;
// 3. a well-formed `run_id` or `variant_validation_id` naming another run or variant validation:
//    `EXECUTION_IDENTITY_MISMATCH`;
// 4. a well-formed trial-manifest digest other than the registered one, or a well-formed
//    `trial_id` other than the registered one: `TRIAL_MANIFEST_DIGEST_MISMATCH`, because the
//    frozen manifest the digest names fixes the trial id (the closed reason enum has no trial-id
//    code; WP-20 decision log row 4);
// 5. an absent correlation field (no execution identity, `trial_id` or digest): `CORRELATION_MISSING`;
// 6. any other `trial_message` schema violation: `SCHEMA_INVALID`.
//
// Steps 3 and 4 come before the schema check: a message that names another execution, digest or
// trial is a mismatch even when another of its properties breaks the schema. Design D-28 makes
// exactly those two reasons G2 `invalid` (and a missing correlation G2 `unverified`), and
// BR-RUA-036 makes every post-publication mismatch leave the trial indeterminate, so reporting
// such a message as SCHEMA_INVALID would hide the mismatch from the oracle (WP-20 review).

import { isSha256Hex } from '../record-contract/digests.ts';
import { isUuid4 } from '../record-contract/identifiers.ts';
import { boundedJsonText, describeJson, isJsonObject } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { JsonObject, Result } from '../record-contract/primitives.ts';
import { err, ok } from '../record-contract/primitives.ts';
import type { TrialMessage } from '../record-contract/records/group-a/trial_message.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import type { TrialMessageRejectionReason } from '../record-contract/records/group-b/vocabulary.ts';
import type { TrialExecutionRef } from './trial-message-fields.ts';
import {
  TRIAL_EXECUTION_FIELDS,
  describeParseFailure,
  executionRefOf,
  isNonemptyTrimmed,
  ownField,
  trialExecutionOf,
  unexpectedField,
} from './trial-message-fields.ts';

/**
 * Why a delivered message was rejected, with what the `trial_message_rejected` event carries:
 * the offending and expected values of a mismatch, and the business identity when the body
 * names a readable one (so the request state can name its request).
 */
export interface ConsumerRejection {
  readonly kind: 'rejected';
  readonly reason: TrialMessageRejectionReason;
  readonly detail: string;
  readonly offending_value?: string;
  readonly expected_value?: string;
  readonly refund_request_id?: string;
  readonly payment_id?: string;
}

export type ConsumerValidation = { readonly kind: 'accepted'; readonly message: TrialMessage } | ConsumerRejection;

/**
 * The longest business identifier a rejection carries. A hostile body may name a
 * megabyte-long identifier; such a value is left out instead of journaled or keyed.
 */
export const CARRIED_IDENTIFIER_LIMIT = 200;

const TRIAL_MESSAGE_FIELDS: ReadonlySet<string> = new Set([
  'schema_version',
  'record_type',
  'run_id',
  'variant_validation_id',
  'trial_id',
  'trial_manifest_sha256',
  'payment_id',
  'refund_request_id',
]);

type BusinessIdentity = Pick<ConsumerRejection, 'refund_request_id' | 'payment_id'>;

/**
 * Validates a delivered body against the active registration of the consuming variant.
 *
 * @example
 * const validation = validateDeliveredMessage(record.body, registration);
 * if (validation.kind === 'rejected') journal.append('trial_message_rejected', { ...validation, ... });
 */
export function validateDeliveredMessage(
  body: string,
  registration: TrialRegistration | undefined,
): ConsumerValidation {
  const parsed = parseJsonDocument(new TextEncoder().encode(body));
  const object = parsed.ok && isJsonObject(parsed.value) ? parsed.value : undefined;
  const identity = object === undefined ? {} : readableBusinessIdentity(object);
  if (registration === undefined) {
    return rejection(
      'NO_ACTIVE_TRIAL',
      'no active trial registration for the consuming variant; expected the runner to register the trial before publishing its message',
      identity,
    );
  }
  if (!parsed.ok) {
    return rejection(
      'SCHEMA_INVALID',
      `message body is not JSON (${describeParseFailure(parsed.error)}); expected a trial_message`,
      {},
    );
  }
  if (object === undefined) {
    return rejection('SCHEMA_INVALID', `message body is ${describeJson(parsed.value)}; expected a JSON object`, {});
  }
  return validateMessageObject(object, registration, identity);
}

// A message that passes steps 3 to 6 holds well-formed identity fields that equal the
// registration's, so the schema-valid message is the accepted one.
function validateMessageObject(
  object: JsonObject,
  registration: TrialRegistration,
  identity: BusinessIdentity,
): ConsumerValidation {
  const mismatch = registrationMismatch(object, registration, identity);
  if (mismatch !== undefined) {
    return mismatch;
  }
  const missing = missingCorrelationField(object);
  if (missing !== undefined) {
    return rejection(
      'CORRELATION_MISSING',
      `message has no ${missing}; expected the BR-RUA-036 correlation fields`,
      identity,
    );
  }
  const checked = checkTrialMessage(object);
  return checked.ok
    ? { kind: 'accepted', message: checked.value }
    : rejection('SCHEMA_INVALID', checked.error, identity);
}

function missingCorrelationField(object: JsonObject): string | undefined {
  if (ownField(object, 'run_id') === undefined && ownField(object, 'variant_validation_id') === undefined) {
    return 'run_id or variant_validation_id';
  }
  return ['trial_id', 'trial_manifest_sha256'].find((name) => ownField(object, name) === undefined);
}

// Every `trial_message` schema rule the correlation step left: closed properties, the two
// constants, exactly one execution identity, the identity formats and the business fields.
function checkTrialMessage(object: JsonObject): Result<TrialMessage, string> {
  const extra = unexpectedField(object, TRIAL_MESSAGE_FIELDS);
  if (extra !== undefined) {
    return err(`message has the unexpected property ${boundedJsonText(extra)}; expected only the BR-RUA-036 fields`);
  }
  const constants = constantViolation(object);
  if (constants !== undefined) {
    return err(constants);
  }
  const execution = trialExecutionOf(object);
  if (execution === undefined) {
    return err(
      `message execution identity run_id ${describeJson(ownField(object, 'run_id'))}, variant_validation_id ${describeJson(ownField(object, 'variant_validation_id'))}; expected exactly one lowercase UUIDv4`,
    );
  }
  const identifiers = identifierViolation(object);
  return identifiers === undefined ? ok(toTrialMessage(object, execution)) : err(identifiers);
}

function constantViolation(object: JsonObject): string | undefined {
  const version = ownField(object, 'schema_version');
  if (version !== 1) {
    return `message schema_version ${describeJson(version)}; expected 1`;
  }
  const type = ownField(object, 'record_type');
  return type === 'trial_message' ? undefined : `message record_type ${describeJson(type)}; expected "trial_message"`;
}

function identifierViolation(object: JsonObject): string | undefined {
  const trialId = ownField(object, 'trial_id');
  if (!isUuid4(trialId)) {
    return `message trial_id ${describeJson(trialId)}; expected a lowercase UUIDv4`;
  }
  const digest = ownField(object, 'trial_manifest_sha256');
  if (!isSha256Hex(digest)) {
    return `message trial_manifest_sha256 ${describeJson(digest)}; expected 64 lowercase hex characters`;
  }
  const badBusiness = ['payment_id', 'refund_request_id'].find((name) => !isNonemptyTrimmed(ownField(object, name)));
  return badBusiness === undefined
    ? undefined
    : `message ${badBusiness} ${describeJson(ownField(object, badBusiness))}; expected a string without leading or trailing whitespace and at least one character`;
}

// Rebuilt field by field from the checked object, so the accepted message holds nothing else.
// identifierViolation proved the fields; the assertion restates its checks for the compiler.
function toTrialMessage(object: JsonObject, execution: TrialExecutionRef): TrialMessage {
  const fields = {
    schema_version: 1,
    record_type: 'trial_message',
    trial_id: object['trial_id'],
    trial_manifest_sha256: object['trial_manifest_sha256'],
    payment_id: object['payment_id'],
    refund_request_id: object['refund_request_id'],
  } as Omit<TrialMessage, 'run_id' | 'variant_validation_id'>;
  return execution.field === 'run_id'
    ? { ...fields, run_id: execution.id }
    : { ...fields, variant_validation_id: execution.id };
}

// Steps 3 and 4: only well-formed values count as naming something, so a malformed or absent
// identity field is left to the correlation and schema steps.
function registrationMismatch(
  object: JsonObject,
  registration: TrialRegistration,
  identity: BusinessIdentity,
): ConsumerRejection | undefined {
  const expected = executionRefOf(registration);
  const offered = foreignExecution(object, expected);
  if (offered !== undefined) {
    return rejection(
      'EXECUTION_IDENTITY_MISMATCH',
      `message ${offered.field} ${offered.id}; expected ${expected.field} ${expected.id} of the active trial registration`,
      { offending_value: offered.id, expected_value: expected.id, ...identity },
    );
  }
  const digest = ownField(object, 'trial_manifest_sha256');
  if (isSha256Hex(digest) && digest !== registration.trial_manifest_sha256) {
    return rejection(
      'TRIAL_MANIFEST_DIGEST_MISMATCH',
      `message trial_manifest_sha256 ${digest}; expected ${registration.trial_manifest_sha256} of the active trial`,
      { offending_value: digest, expected_value: registration.trial_manifest_sha256, ...identity },
    );
  }
  const trialId = ownField(object, 'trial_id');
  if (isUuid4(trialId) && trialId !== registration.trial_id) {
    return rejection(
      'TRIAL_MANIFEST_DIGEST_MISMATCH',
      `message trial_id ${trialId}; expected trial_id ${registration.trial_id}, which the frozen trial manifest ${registration.trial_manifest_sha256} of the active trial names`,
      { offending_value: trialId, expected_value: registration.trial_id, ...identity },
    );
  }
  return undefined;
}

// The first execution identity the message names that is not the registered one: a well-formed
// id under the other identity field, or another id under the registered field.
function foreignExecution(object: JsonObject, expected: TrialExecutionRef): TrialExecutionRef | undefined {
  for (const field of TRIAL_EXECUTION_FIELDS) {
    const id = ownField(object, field);
    if (isUuid4(id) && (field !== expected.field || id !== expected.id)) {
      return { field, id };
    }
  }
  return undefined;
}

function readableBusinessIdentity(object: JsonObject): BusinessIdentity {
  const refund = carriedIdentifier(object, 'refund_request_id');
  const payment = carriedIdentifier(object, 'payment_id');
  return {
    ...(refund === undefined ? {} : { refund_request_id: refund }),
    ...(payment === undefined ? {} : { payment_id: payment }),
  };
}

function carriedIdentifier(object: JsonObject, name: string): string | undefined {
  const value = ownField(object, name);
  return isNonemptyTrimmed(value) && value.length <= CARRIED_IDENTIFIER_LIMIT ? value : undefined;
}

function rejection(
  reason: TrialMessageRejectionReason,
  detail: string,
  fields: Omit<ConsumerRejection, 'kind' | 'reason' | 'detail'>,
): ConsumerRejection {
  return { kind: 'rejected', reason, detail, ...fields };
}
