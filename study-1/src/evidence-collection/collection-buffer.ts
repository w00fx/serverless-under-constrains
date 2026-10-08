// The buffer a collection fills (design §10.2 T8 "collect into a buffer"): each artifact's exact
// bytes under its layout key, with the role ingestion may give it, plus every structured reason a
// read produced. A record that cannot be encoded, or a read that produced none, adds a reason and
// no file, so a missing artifact is reported missing instead of written partially.

import type { JsonObject, Result, StructuredReason } from '../record-contract/primitives.ts';
import { encodeRecordFile } from './collected-records.ts';
import type { CollectedJournalFile } from './journal-export.ts';

/** The layout keys of the files a collection can produce (evidence-package UNIT_PATHS / EXECUTION_PATHS). */
export type CollectedFileKey =
  | CollectedJournalFile
  | 'ledgerSnapshot'
  | 'dlqSnapshot'
  | 'treatmentStateSnapshot'
  | 'providerTrialConfiguration'
  | 'trialRegistration'
  | 'durableExecutions'
  | 'telemetryAvailability'
  | 'executionConfiguration';

/**
 * How ingestion may use a file: unit evidence, or supplementary execution-level evidence that is
 * packaged and indexed but never an input of a rule, gate or execution scope (A-13, decision 56).
 */
export type CollectedFileRole = 'trial_evidence' | 'supplementary';

/** One collected artifact: its layout key, its role and its exact bytes. */
export interface CollectedFile {
  readonly key: CollectedFileKey;
  readonly role: CollectedFileRole;
  readonly bytes: Uint8Array;
}

/** The files collected so far and the reasons of the reads that produced none. */
export interface CollectionBuffer {
  readonly files: CollectedFile[];
  readonly failures: StructuredReason[];
}

/**
 * Encodes a record into the buffer under its key, or records why it cannot be encoded.
 *
 * @example
 * keepRecord(buffer, 'ledgerSnapshot', ledger.record);
 */
export function keepRecord(
  buffer: CollectionBuffer,
  key: CollectedFileKey,
  record: JsonObject,
  role: CollectedFileRole = 'trial_evidence',
): void {
  const bytes = encodeRecordFile(record, key);
  if (!bytes.ok) {
    buffer.failures.push(bytes.error);
    return;
  }
  buffer.files.push({ key, role, bytes: bytes.value });
}

/**
 * Keeps a read's record, or its failure when the read did not produce one.
 *
 * @example
 * keepRead(buffer, 'trialRegistration', await captureTrialRegistration(store, 'conventional'));
 */
export function keepRead(
  buffer: CollectionBuffer,
  key: CollectedFileKey,
  read: Result<JsonObject, StructuredReason>,
  role: CollectedFileRole = 'trial_evidence',
): void {
  if (!read.ok) {
    buffer.failures.push(read.error);
    return;
  }
  keepRecord(buffer, key, read.value, role);
}
