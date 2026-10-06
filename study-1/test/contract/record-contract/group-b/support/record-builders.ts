// Typed builders for group-B canonical examples. Examples are written as their TypeScript
// record types and reach the validator only through the serialization kernel
// (`serializeRecordFile` then `parseJsonDocument`), so every contract case also proves that a
// typed record serializes into schema-valid bytes (BR-RUA-033).

import { serializeRecordFile } from '../../../../../src/record-contract/canonical-json.ts';
import { isDecimalString } from '../../../../../src/record-contract/decimal.ts';
import { sha256Hex } from '../../../../../src/record-contract/digests.ts';
import type { EventEnvelope, ExecutionIdentityFields } from '../../../../../src/record-contract/envelope.ts';
import { isUuid4 } from '../../../../../src/record-contract/identifiers.ts';
import { isJsonObject } from '../../../../../src/record-contract/json-value.ts';
import { parseJsonDocument } from '../../../../../src/record-contract/parsing.ts';
import type {
  DecimalString,
  JsonObject,
  Sha256Hex,
  StructuredReason,
  Uuid4,
  UtcMillis,
} from '../../../../../src/record-contract/primitives.ts';
import type { EventRecordType } from '../../../../../src/record-contract/record-types.ts';
import type {
  AttemptCorrelation,
  CommitTriple,
  TrialScoped,
} from '../../../../../src/record-contract/records/group-b/shared-shapes.ts';
import type { StudyRecord } from '../../../../../src/record-contract/records/index.ts';
import { formatUtcMillis } from '../../../../../src/record-contract/timestamps.ts';

const BASE_INSTANT_MS = Date.UTC(2026, 9, 5, 12, 0, 0, 0);

/**
 * A deterministic lowercase UUIDv4 whose last group encodes `n`, so ids sort by `n`.
 *
 * @example
 * uuid(1); // '00000000-0000-4000-8000-000000000001'
 */
export function uuid(n: number): Uuid4 {
  const value = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  if (!isUuid4(value)) {
    throw new RangeError(`uuid(${String(n)}) built ${JSON.stringify(value)}; expected a lowercase UUIDv4`);
  }
  return value;
}

/**
 * A millisecond UTC timestamp `offsetMs` after 2026-10-05T12:00:00.000Z.
 *
 * @example
 * at(1); // '2026-10-05T12:00:00.001Z'
 */
export function at(offsetMs: number): UtcMillis {
  return formatUtcMillis(new Date(BASE_INSTANT_MS + offsetMs));
}

/**
 * The SHA-256 of a seed string, standing in for the digest of some artifact bytes.
 *
 * @example
 * digest('ledger-snapshot'); // 64 lowercase hex characters
 */
export function digest(seed: string): Sha256Hex {
  return sha256Hex(new TextEncoder().encode(seed));
}

/**
 * A canonical nonnegative decimal string (elapsed nanoseconds).
 *
 * @example
 * ns(3_000_000_000n); // '3000000000'
 */
export function ns(value: bigint): DecimalString {
  const text = value.toString();
  if (!isDecimalString(text)) {
    throw new RangeError(`ns(${text}) is not a canonical nonnegative decimal; expected ^(0|[1-9][0-9]*)$`);
  }
  return text;
}

/**
 * A structured reason with an UPPER_SNAKE code.
 *
 * @example
 * reason('LEDGER_UNAVAILABLE', 'ledger'); // { code, subject, detail }
 */
export function reason(code: string, subject: string): StructuredReason {
  return { code, subject, detail: `${subject} reported ${code}; expected a clean read` };
}

export const RUN_ID = uuid(0x100);
export const PROBE_ID = uuid(0x101);
export const VALIDATION_ID = uuid(0x102);
export const TRIAL_ID = uuid(0x103);
export const EXECUTION_MANIFEST_SHA256 = digest('execution-manifest');
export const TRIAL_MANIFEST_SHA256 = digest('trial-manifest');
export const TRIAL_PARTITION = `${RUN_ID}#${TRIAL_ID}`;
export const PAYMENT_ID = 'payment-0001';

export const ATTEMPT_CORRELATION: AttemptCorrelation = {
  attempt_id: uuid(0x300),
  provider_request_id: uuid(0x301),
  refund_request_id: 'refund-request-0001',
};

export const COMMIT_TRIPLE: CommitTriple = {
  provider_commit_id: uuid(0x400),
  provider_transaction_id: uuid(0x401),
  provider_call_id: uuid(0x402),
};

export const TRIAL_SCOPE: TrialScoped = { trial_id: TRIAL_ID, trial_manifest_sha256: TRIAL_MANIFEST_SHA256 };

/** Which of the three executions an example belongs to (BR-RUA-033 execution identity). */
export type ExecutionScope = 'run' | 'probe' | 'validation';

type EnvelopeHead<T extends EventRecordType> = Omit<
  EventEnvelope<T>,
  'source' | 'run_id' | 'transport_probe_id' | 'variant_validation_id' | 'trial_id' | 'trial_manifest_sha256'
>;

/**
 * The single execution-identity field of a scope.
 *
 * @example
 * identityOf('probe'); // { transport_probe_id: PROBE_ID }
 */
export function identityOf(scope: ExecutionScope): ExecutionIdentityFields {
  switch (scope) {
    case 'run':
      return { run_id: RUN_ID };
    case 'probe':
      return { transport_probe_id: PROBE_ID };
    case 'validation':
      return { variant_validation_id: VALIDATION_ID };
  }
}

/**
 * The envelope of an execution-level event (no trial identity), without `source`.
 *
 * @example
 * const head = executionEnvelope('phase_transition_recorded', 'run', 3, 7);
 */
export function executionEnvelope<T extends EventRecordType>(
  recordType: T,
  scope: ExecutionScope,
  eventNumber: number,
  sequence: number,
): EnvelopeHead<T> & ExecutionIdentityFields {
  return {
    schema_version: 1,
    record_type: recordType,
    event_id: uuid(eventNumber),
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    occurred_at: at(eventNumber),
    source_instance_id: uuid(0x200 + sequence),
    source_sequence: sequence,
    ...identityOf(scope),
  };
}

/**
 * The envelope of a trial event of the run, without `source`.
 *
 * @example
 * const head = trialEnvelope('dispatch_started', 5, 3);
 */
export function trialEnvelope<T extends EventRecordType>(
  recordType: T,
  eventNumber: number,
  sequence: number,
): EnvelopeHead<T> & ExecutionIdentityFields & TrialScoped {
  return { ...executionEnvelope(recordType, 'run', eventNumber, sequence), ...TRIAL_SCOPE };
}

/**
 * Serializes a typed record with the kernel and parses the bytes back, as a reader would.
 *
 * @example
 * validator.validate(toJson(example.record));
 */
export function toJson(record: StudyRecord): JsonObject {
  const parsed = parseJsonDocument(serializeRecordFile(record));
  if (!parsed.ok) {
    throw new Error(
      `record ${record.record_type} did not parse back (${JSON.stringify(parsed.error)}); expected a JSON object document`,
    );
  }
  if (!isJsonObject(parsed.value)) {
    throw new Error(
      `record ${record.record_type} parsed back as ${JSON.stringify(parsed.value)}; expected a JSON object document`,
    );
  }
  return parsed.value;
}
