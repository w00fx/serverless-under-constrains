// The publisher side of BR-RUA-036: the canonical trial message of one frozen trial, and the
// check that the exact bytes about to be published are that message. "A pre-publication
// mismatch rejects setup and starts no trial", so the check returns every mismatch it finds
// and the runner publishes only when the list is empty.
//
// The trial manifest does not carry the business identity (it pins the approved decision by
// digest), so the publication also names the approved decision's `payment_id` and
// `refund_request_id` (WP-20 decision log row 2: the design signature took only the manifest).

import type { RecordValidator } from '../record-contract/schema-registry.ts';
import { serializeRecordFile } from '../record-contract/canonical-json.ts';
import { boundedText } from '../record-contract/json-value.ts';
import { parseJsonDocument } from '../record-contract/parsing.ts';
import type { Sha256Hex, StructuredReason } from '../record-contract/primitives.ts';
import type { ApprovedDecision } from '../record-contract/records/group-a/approved_decision.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { TrialMessage } from '../record-contract/records/group-a/trial_message.ts';
import { describeParseFailure, executionIdentityOfTrial, executionRefOf } from './trial-message-fields.ts';

/** What one trial publishes: its frozen manifest and digest, and the request it refunds. */
export interface TrialPublication {
  readonly trial: TrialManifest;
  readonly trial_manifest_sha256: Sha256Hex;
  readonly request: Pick<ApprovedDecision, 'payment_id' | 'refund_request_id'>;
}

export interface BuiltTrialMessage {
  readonly record: TrialMessage;
  /** `serializeRecordFile(record)`: canonical JSON plus a newline, the exact SQS body. */
  readonly bytes: Uint8Array;
}

export const PUBLICATION_MISMATCH_CODES = [
  'MESSAGE_UNPARSEABLE',
  'SCHEMA_INVALID',
  'NON_CANONICAL_BYTES',
  'EXECUTION_IDENTITY_MISMATCH',
  'TRIAL_ID_MISMATCH',
  'TRIAL_MANIFEST_DIGEST_MISMATCH',
  'BUSINESS_IDENTITY_MISMATCH',
] as const;
export type PublicationMismatchCode = (typeof PUBLICATION_MISMATCH_CODES)[number];

const SUBJECT = 'BR-RUA-036';

/**
 * Builds the canonical message of a trial and its exact bytes.
 *
 * @example
 * const { bytes } = buildTrialMessage({ trial, trial_manifest_sha256, request: approvedDecision });
 * await queue.send(new TextDecoder().decode(bytes));
 */
export function buildTrialMessage(publication: TrialPublication): BuiltTrialMessage {
  const { trial, trial_manifest_sha256, request } = publication;
  const record: TrialMessage = {
    ...executionIdentityOfTrial(trial),
    schema_version: 1,
    record_type: 'trial_message',
    trial_id: trial.trial_id,
    trial_manifest_sha256,
    payment_id: request.payment_id,
    refund_request_id: request.refund_request_id,
  };
  return { record, bytes: serializeRecordFile(record) };
}

/**
 * Every reason the bytes are not the canonical message of the publication; empty when they
 * are. Total over any bytes.
 *
 * @example
 * const reasons = validateBeforePublication(bytes, publication, createRecordValidator());
 * if (reasons.length > 0) return rejectSetup(reasons); // no trial starts
 */
export function validateBeforePublication(
  bytes: Uint8Array,
  publication: TrialPublication,
  validator: RecordValidator,
): readonly StructuredReason[] {
  const parsed = parseJsonDocument(bytes);
  if (!parsed.ok) {
    return [
      mismatch(
        'MESSAGE_UNPARSEABLE',
        `message bytes are not one JSON document (${describeParseFailure(parsed.error)}); expected the canonical trial_message`,
      ),
    ];
  }
  const checked = validator.validateAs('trial_message', parsed.value);
  if (!checked.valid) {
    return checked.violations.map((violation) =>
      mismatch('SCHEMA_INVALID', `trial_message ${violation.instance_path} ${violation.keyword}: ${violation.detail}`),
    );
  }
  // validateAs('trial_message') accepted the value, so it is a trial_message.
  const message = checked.record as TrialMessage;
  const expected = buildTrialMessage(publication);
  const canonical = sameBytes(bytes, serializeRecordFile(message));
  return [
    ...(canonical
      ? []
      : [
          mismatch(
            'NON_CANONICAL_BYTES',
            `message bytes are not canonical JSON followed by one newline; expected serializeRecordFile of the message`,
          ),
        ]),
    ...fieldMismatches(message, expected.record),
  ];
}

function fieldMismatches(message: TrialMessage, expected: TrialMessage): readonly StructuredReason[] {
  const offered = executionRefOf(message);
  const wanted = executionRefOf(expected);
  const comparisons: readonly (readonly [PublicationMismatchCode, string, string, string])[] = [
    [
      'EXECUTION_IDENTITY_MISMATCH',
      'execution identity',
      `${offered.field} ${offered.id}`,
      `${wanted.field} ${wanted.id}`,
    ],
    ['TRIAL_ID_MISMATCH', 'trial_id', message.trial_id, expected.trial_id],
    [
      'TRIAL_MANIFEST_DIGEST_MISMATCH',
      'trial_manifest_sha256',
      message.trial_manifest_sha256,
      expected.trial_manifest_sha256,
    ],
    ['BUSINESS_IDENTITY_MISMATCH', 'payment_id', message.payment_id, expected.payment_id],
    ['BUSINESS_IDENTITY_MISMATCH', 'refund_request_id', message.refund_request_id, expected.refund_request_id],
  ];
  return comparisons
    .filter(([, , got, want]) => got !== want)
    .map(([code, field, got, want]) =>
      mismatch(code, `message ${field} ${boundedText(got)}; expected ${boundedText(want)} of the frozen trial`),
    );
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function mismatch(code: PublicationMismatchCode, detail: string): StructuredReason {
  return { code, subject: SUBJECT, detail };
}
