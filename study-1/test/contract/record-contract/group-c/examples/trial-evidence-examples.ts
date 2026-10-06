// Group-C examples of the derived trial evidence: the attempt projection and the evidence index
// (catalogue rows 66 and 68; the oracle results of row 67 live in `oracle-examples.ts`). Each
// variant exercises another branch of a conditional rule of its schema. Paths follow the
// design §7 package layout.

import type { AttemptProjection } from '../../../../../src/record-contract/records/group-c/attempt_projection.ts';
import type { EvidenceIndex } from '../../../../../src/record-contract/records/group-c/evidence_index.ts';
import {
  ATTEMPT_CORRELATION,
  COMMIT_TRIPLE,
  EXECUTION_MANIFEST_SHA256,
  PROBE_ID,
  RUN_ID,
  TRIAL_SCOPE,
  at,
  ns,
  uuid,
} from '../../group-b/support/record-builders.ts';
import {
  EXECUTION_MANIFEST_PATH,
  PROBE_PATHS,
  TRIAL_PATHS,
  evidenceRef,
  indexEntry,
} from '../support/group-c-builders.ts';
import { groupCExample } from '../support/record-example.ts';
import type { GroupCExample } from '../support/record-example.ts';

/**
 * A trial projection: one timed-out attempt joined to its commit, one rejected and one
 * unresolved provider call, and the ledger transaction by reference (design §8.9).
 *
 * @example
 * attemptProjection().attempts[0]?.outcome_class; // 'AMBIGUOUS'
 */
export function attemptProjection(): AttemptProjection {
  return {
    schema_version: 1,
    record_type: 'attempt_projection',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    ...TRIAL_SCOPE,
    attempts: [
      {
        ...ATTEMPT_CORRELATION,
        registered_event_id: uuid(0x501),
        invocation: {
          source: 'conventional_caller',
          source_instance_id: uuid(0x201),
          message_id: 'message-0001',
          receive_count: 1,
        },
        dispatch_state: 'DISPATCHED',
        outcome: 'TIMED_OUT',
        outcome_class: 'AMBIGUOUS',
        provider_call_id: COMMIT_TRIPLE.provider_call_id,
        provider_transaction_id: COMMIT_TRIPLE.provider_transaction_id,
        late_transport_settlement: { settlement_kind: 'resolved', observed_after_elapsed_ns: ns(250_000_000n) },
        knowledge_after_derived: 'ONE_EFFECT_CONFIRMED',
        knowledge_after_recorded: 'UNKNOWN',
      },
    ],
    provider_calls: [
      {
        provider_call_id: COMMIT_TRIPLE.provider_call_id,
        received_event_id: uuid(0x502),
        disposition: 'ACCEPTED',
        attempt_id: ATTEMPT_CORRELATION.attempt_id,
        provider_request_id: ATTEMPT_CORRELATION.provider_request_id,
      },
      {
        provider_call_id: uuid(0x403),
        received_event_id: uuid(0x503),
        disposition: 'REJECTED',
        rejection_reason: 'AMOUNT_INVALID',
      },
      { provider_call_id: uuid(0x404), received_event_id: uuid(0x504), disposition: 'UNRESOLVED' },
    ],
    transactions: [
      { ...COMMIT_TRIPLE, ledger_ref: evidenceRef(TRIAL_PATHS.ledgerSnapshot, { json_pointer: '/transactions/0' }) },
    ],
    durable_executions: [],
    derived_at: at(900),
  };
}

/**
 * A probe projection: a Durable step that failed before dispatch (BR-RUA-021 proven
 * `NOT_DISPATCHED`), so no provider call and no transaction.
 *
 * @example
 * probeAttemptProjection().attempts[0]?.outcome_class; // 'PRE_DISPATCH_FAILURE'
 */
export function probeAttemptProjection(): AttemptProjection {
  return {
    schema_version: 1,
    record_type: 'attempt_projection',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    attempts: [
      {
        ...ATTEMPT_CORRELATION,
        registered_event_id: uuid(0x511),
        invocation: {
          source: 'probe_caller',
          source_instance_id: uuid(0x211),
          durable_execution_arn: 'arn:aws:lambda:eu-west-1:000000000000:function:probe:durable/0001',
          step_attempt: 1,
        },
        dispatch_state: 'NOT_DISPATCHED',
        outcome: 'FAILED',
        outcome_class: 'PRE_DISPATCH_FAILURE',
        knowledge_after_derived: 'NOT_ATTEMPTED',
      },
    ],
    provider_calls: [],
    transactions: [],
    durable_executions: [
      {
        durable_execution_arn: 'arn:aws:lambda:eu-west-1:000000000000:function:probe:durable/0001',
        status: 'SUCCEEDED',
      },
    ],
    derived_at: at(910),
  };
}

/**
 * The evidence index that freezes the shared trial: an execution-level core file plus the
 * trial's own files, sorted by path (design §7 index scopes).
 *
 * @example
 * trialEvidenceIndex().index_scope; // 'TRIAL'
 */
export function trialEvidenceIndex(): EvidenceIndex {
  return {
    schema_version: 1,
    record_type: 'evidence_index',
    run_id: RUN_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    ...TRIAL_SCOPE,
    index_scope: 'TRIAL',
    entries: [
      indexEntry(EXECUTION_MANIFEST_PATH, 'execution_manifest'),
      indexEntry(TRIAL_PATHS.oracleResult, 'oracle_result', 'derived'),
      indexEntry(TRIAL_PATHS.callerJournal, 'caller_journal'),
    ],
    created_at: at(1100),
  };
}

/**
 * The probe's evidence index: the probe has no trial (D-06).
 *
 * @example
 * probeEvidenceIndex().index_scope; // 'PROBE'
 */
export function probeEvidenceIndex(): EvidenceIndex {
  return {
    schema_version: 1,
    record_type: 'evidence_index',
    transport_probe_id: PROBE_ID,
    execution_manifest_sha256: EXECUTION_MANIFEST_SHA256,
    index_scope: 'PROBE',
    entries: [
      indexEntry('probe/derived/transport-probe-result.json', 'transport_probe_result', 'derived'),
      indexEntry(PROBE_PATHS.providerJournal, 'provider_journal'),
    ],
    created_at: at(1110),
  };
}

export const TRIAL_EVIDENCE_EXAMPLES: readonly GroupCExample[] = [
  groupCExample('attempt_projection', attemptProjection()),
  groupCExample('attempt_projection (probe)', probeAttemptProjection()),
  groupCExample('evidence_index', trialEvidenceIndex()),
  groupCExample('evidence_index (probe)', probeEvidenceIndex()),
];
