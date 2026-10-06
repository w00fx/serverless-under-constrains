// Shared fixtures of the trial-message and conventional-variant tests: one run trial and one
// variant-validation trial, their registrations and canonical messages, built from the spec's
// OR-RUA-001 business identity (`pay-poc-001`, `ref-poc-001`), never from oracle output.

import { canonicalJson } from '../../../../src/record-contract/canonical-json.ts';
import type { JsonObject, Sha256Hex, Uuid4, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { TrialManifest } from '../../../../src/record-contract/records/group-a/trial_manifest.ts';
import type { TrialMessage } from '../../../../src/record-contract/records/group-a/trial_message.ts';
import type { TrialRegistration } from '../../../../src/record-contract/records/group-a/trial_registration.ts';
import type { TrialPublication } from '../../../../src/trial-message/trial-message-publication.ts';
import {
  MANIFEST_SHA,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION_ID,
} from '../../../support/event-journal/journal-fixtures.ts';

export {
  EPOCH_MS,
  MANIFEST_SHA,
  RUN,
  RUN_ID,
  TRIAL_ID,
  TRIAL_MANIFEST_SHA,
  VALIDATION,
  VALIDATION_ID,
} from '../../../support/event-journal/journal-fixtures.ts';

export const PAYMENT_ID = 'pay-poc-001';
export const REFUND_REQUEST_ID = 'ref-poc-001';
export const OTHER_RUN_ID = 'aaaaaaaa-0000-4000-8000-0000000000ff' as Uuid4;
export const OTHER_TRIAL_ID = 'bbbbbbbb-0000-4000-8000-0000000000ff' as Uuid4;
export const OTHER_TRIAL_MANIFEST_SHA = 'c'.repeat(64) as Sha256Hex;
export const REGISTERED_AT = '2026-10-05T11:59:00.000Z' as UtcMillis;
/** The partition key of the run trial's journal items. */
export const TRIAL_PK = `${RUN_ID}#${TRIAL_ID}`;

/** The registration of the conventional variant's active run trial. */
export function runRegistration(overrides: Partial<TrialRegistration> = {}): TrialRegistration {
  return {
    schema_version: 1,
    record_type: 'trial_registration',
    variant_id: 'conventional',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    trial_id: TRIAL_ID,
    trial_manifest_sha256: TRIAL_MANIFEST_SHA,
    registry_version: 1,
    registered_at: REGISTERED_AT,
    ...overrides,
  } as TrialRegistration;
}

/** The registration of a variant-validation trial of the conventional variant. */
export function validationRegistration(): TrialRegistration {
  const { run_id: _run, ...rest } = runRegistration() as TrialRegistration & { readonly run_id: Uuid4 };
  return { ...rest, variant_validation_id: VALIDATION_ID };
}

/** The canonical message of the run trial, as a plain JSON object a test may alter. */
export function runMessageObject(overrides: JsonObject = {}): JsonObject {
  return {
    schema_version: 1,
    record_type: 'trial_message',
    run_id: RUN_ID,
    trial_id: TRIAL_ID,
    trial_manifest_sha256: TRIAL_MANIFEST_SHA,
    payment_id: PAYMENT_ID,
    refund_request_id: REFUND_REQUEST_ID,
    ...overrides,
  };
}

/** The run trial's message, typed. */
export function runMessage(): TrialMessage {
  return runMessageObject() as unknown as TrialMessage;
}

/** An object without the named properties. */
export function withoutFields(object: JsonObject, ...names: readonly string[]): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([name]) => !names.includes(name)));
}

/** The SQS body of a message object: canonical JSON plus a newline, as the runner publishes it. */
export function messageBody(object: JsonObject = runMessageObject()): string {
  return `${canonicalJson(object)}\n`;
}

/** The frozen manifest of the run trial. */
export function runTrialManifest(): TrialManifest {
  return {
    schema_version: 1,
    record_type: 'trial_manifest',
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA,
    resource_manifest_sha256: 'd'.repeat(64) as Sha256Hex,
    trial_id: TRIAL_ID,
    sequence: 1,
    variant_id: 'conventional',
    scenario: 'CONTROL',
    payment_sha256: 'e'.repeat(64) as Sha256Hex,
    approved_decision_sha256: 'f'.repeat(64) as Sha256Hex,
    frozen_at: REGISTERED_AT,
  };
}

/** The publication of the run trial: its manifest, digest and OR-RUA-001 business identity. */
export function runPublication(overrides: Partial<TrialPublication> = {}): TrialPublication {
  return {
    trial: runTrialManifest(),
    trial_manifest_sha256: TRIAL_MANIFEST_SHA,
    request: { payment_id: PAYMENT_ID, refund_request_id: REFUND_REQUEST_ID },
    ...overrides,
  };
}
