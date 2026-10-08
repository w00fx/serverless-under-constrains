// Named edits of the base probe that the treatment-fidelity and probe-verdict units share. Each is
// the smallest golden-operation edit that states one fact of design §8.10 or §8.11; the units
// assert what the production code concludes from it.

import type { JsonObject, JsonValue } from '../../../../src/record-contract/primitives.ts';
import type { ScenarioOperation } from '../../../support/golden-builder/operation-parsing.ts';
import { deleteOp, documentOp, PROBE_IDS, removeOp, setOp, SUBJECT_FILES } from './treatment-evidence.ts';

const RESEQUENCE_PROVIDER: ScenarioOperation = { op: 'resequence', path: SUBJECT_FILES.provider };
const RESEQUENCE_CALLER: ScenarioOperation = { op: 'resequence', path: SUBJECT_FILES.caller };
const RESEQUENCE_CONTROLLER: ScenarioOperation = { op: 'resequence', path: SUBJECT_FILES.controller };

/** The base probe's execution manifest digest, as its events record it. */
const MANIFEST_SHA256 = '497bf46f0ff0900e84ff83d413f9d4baf5e6de429ffebe29934360c42234cd21';
const PROBE_ID = '2559d5f6-ec95-4777-a74e-452fcfde7526';
const CONTROLLER_INSTANCE = 'e9db59a7-5876-42f2-8b0b-3b0800182db0';

/** The base probe's only ledger transaction, for a duplicate or a second transaction. */
export const LEDGER_TRANSACTION: JsonObject = {
  amount_minor: 10000,
  attempt_id: PROBE_IDS.attempt,
  commit_requested_at: '2026-10-05T12:05:05.120Z',
  currency: 'BRL',
  payment_id: 'pay-poc-001',
  provider_call_id: PROBE_IDS.call,
  provider_commit_id: PROBE_IDS.commit,
  provider_request_id: '58ae07f2-4809-4e4c-9659-f16beb4cfb68',
  provider_transaction_id: PROBE_IDS.transaction,
  refund_request_id: 'ref-poc-001',
  status: 'SUCCEEDED',
};

/** A second caller event that tried to signal the same treatment (BR-RUA-025 conflicting evidence). */
const CONFLICT_RECORD: JsonValue = {
  attempt_id: PROBE_IDS.attempt,
  caller_timeout_event_id: PROBE_IDS.absent,
  existing_caller_event_id: PROBE_IDS.timeout_event,
  causation_event_ids: [PROBE_IDS.timeout_event],
  event_id: '6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  execution_manifest_sha256: MANIFEST_SHA256,
  occurred_at: '2026-10-05T12:05:08.200Z',
  record_type: 'timeout_signal_conflict_recorded',
  schema_version: 1,
  source: 'treatment_controller',
  source_instance_id: CONTROLLER_INSTANCE,
  source_sequence: 2,
  transport_probe_id: PROBE_ID,
  treatment_state: 'TIMEOUT_SIGNALLED',
};

/** The probe edits, by the fact each states. */
export const PROBE_EDITS = {
  /** K′ is absent; the provider journal stays dense. */
  no_confirmation: [removeOp(SUBJECT_FILES.provider, 'provider_commit_confirmed'), RESEQUENCE_PROVIDER],
  /** Θ is absent; the caller journal stays dense. */
  no_caller_timeout: [removeOp(SUBJECT_FILES.caller, 'caller_timeout_recorded'), RESEQUENCE_CALLER],
  /** T's outcome is absent. */
  no_outcome: [removeOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded'), RESEQUENCE_CALLER],
  /** T's dispatch is absent. */
  no_dispatch: [removeOp(SUBJECT_FILES.caller, 'dispatch_started'), RESEQUENCE_CALLER],
  /** Ρ is absent (the last provider event, so no gap). */
  no_release: [removeOp(SUBJECT_FILES.provider, 'treatment_response_released')],
  /** Ω is absent and the provider journal has a gap where it was. */
  no_observation_gapped: [removeOp(SUBJECT_FILES.provider, 'treatment_timeout_observed')],
  /** Ω is absent from a dense provider journal; Ρ names Σ instead. */
  no_observation_dense: [
    removeOp(SUBJECT_FILES.provider, 'treatment_timeout_observed'),
    RESEQUENCE_PROVIDER,
    setOp(SUBJECT_FILES.provider, 'treatment_response_released', '/causation_event_ids', [PROBE_IDS.signal_event]),
  ],
  /** Σ is absent; the controller journal stays dense. */
  no_signal: [removeOp(SUBJECT_FILES.controller, 'timeout_signal_recorded'), RESEQUENCE_CONTROLLER],
  /** K and K′ are absent, and a complete ledger holds no transaction: the provider never committed. */
  no_commit: [
    removeOp(SUBJECT_FILES.provider, 'provider_transaction_committed'),
    removeOp(SUBJECT_FILES.provider, 'provider_commit_confirmed'),
    RESEQUENCE_PROVIDER,
    documentOp(SUBJECT_FILES.ledger, '/transactions', []),
    documentOp(SUBJECT_FILES.ledger, '/pages/0/item_count', 0),
  ],
  /** A second targeted commit, so K is not unique. */
  two_targeted_commits: [
    {
      op: 'clone_record',
      path: SUBJECT_FILES.provider,
      select: { record_type: 'provider_transaction_committed' },
      set: [
        { pointer: '/event_id', value: '7b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' },
        { pointer: '/provider_commit_id', value: '8c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f' },
        { pointer: '/provider_transaction_id', value: '9d4e5f6a-7b8c-4d9e-8f1a-2b3c4d5e6f7a' },
      ],
    },
    RESEQUENCE_PROVIDER,
  ],
  /** A recorded timeout-signal conflict. */
  signal_conflict: [{ op: 'insert_record', path: SUBJECT_FILES.controller, record: CONFLICT_RECORD }],
  /** Θ records the abort after the timeout itself. */
  abort_after_record: [
    setOp(SUBJECT_FILES.caller, 'caller_timeout_recorded', '/abort_requested_at', '2026-10-05T12:05:09.000Z'),
  ],
  /** Θ ran less than three seconds. */
  elapsed_short: [setOp(SUBJECT_FILES.caller, 'caller_timeout_recorded', '/elapsed_ns', '2999999999')],
  /** Θ names the invocation, not the dispatch, as its monotonic origin. */
  origin_not_dispatch: [
    setOp(SUBJECT_FILES.caller, 'caller_timeout_recorded', '/monotonic_origin_event_id', PROBE_IDS.invocation_event),
  ],
  /** T's outcome is SUCCEEDED with K's call and transaction. */
  outcome_succeeded: [
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/outcome', 'SUCCEEDED'),
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/provider_call_id', PROBE_IDS.call),
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/provider_transaction_id', PROBE_IDS.transaction),
  ],
  /** T's outcome is REJECTED. */
  outcome_rejected: [
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/outcome', 'REJECTED'),
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/provider_call_id', PROBE_IDS.call),
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/rejection_reason', 'PAYMENT_NOT_FOUND'),
  ],
  /** T's TIMED_OUT outcome still carries K's transaction id. */
  timed_out_carrying_transaction: [
    setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/provider_transaction_id', PROBE_IDS.transaction),
  ],
  /** Ω names K, not Σ, as its cause. */
  observation_caused_by_commit: [
    setOp(SUBJECT_FILES.provider, 'treatment_timeout_observed', '/causation_event_ids', [PROBE_IDS.commit_event]),
  ],
  /** Ω names Θ as the signal it observed. */
  observation_names_other_signal: [
    setOp(SUBJECT_FILES.provider, 'treatment_timeout_observed', '/signal_event_id', PROBE_IDS.timeout_event),
  ],
  /** Ρ names Σ, not Ω, as its cause. */
  release_caused_by_signal: [
    setOp(SUBJECT_FILES.provider, 'treatment_response_released', '/causation_event_ids', [PROBE_IDS.signal_event]),
  ],
  /** Ρ was written by another provider instance. */
  release_other_instance: [
    setOp(
      SUBJECT_FILES.provider,
      'treatment_response_released',
      '/source_instance_id',
      '1e2d3c4b-5a69-4788-97a6-b5c4d3e2f1a0',
    ),
    setOp(SUBJECT_FILES.provider, 'treatment_response_released', '/source_sequence', 1),
  ],
  /** Σ references another attempt. */
  signal_other_attempt: [setOp(SUBJECT_FILES.controller, 'timeout_signal_recorded', '/attempt_id', PROBE_IDS.absent)],
  /** Σ references the dispatch as the caller timeout. */
  signal_other_timeout: [
    setOp(SUBJECT_FILES.controller, 'timeout_signal_recorded', '/caller_timeout_event_id', PROBE_IDS.dispatch_event),
  ],
  /** Σ references the accepted call as the provider commit. */
  signal_other_commit: [
    setOp(SUBJECT_FILES.controller, 'timeout_signal_recorded', '/provider_commit_event_id', PROBE_IDS.accepted_event),
  ],
  /** K′ lost its causation; it still shares K's transaction. */
  confirmation_not_caused_by_commit: [
    setOp(SUBJECT_FILES.provider, 'provider_commit_confirmed', '/causation_event_ids', [PROBE_IDS.accepted_event]),
  ],
  /** The treatment item records another provider call. */
  snapshot_other_call: [documentOp(SUBJECT_FILES.snapshot, '/treatment/provider_call_id', PROBE_IDS.absent)],
  /** The ledger transaction records another commit id. */
  ledger_other_commit: [documentOp(SUBJECT_FILES.ledger, '/transactions/0/provider_commit_id', PROBE_IDS.absent)],
  /** K′ records another provider call. */
  confirmation_other_call: [
    setOp(SUBJECT_FILES.provider, 'provider_commit_confirmed', '/provider_call_id', PROBE_IDS.absent),
  ],
  /** The ledger's only transaction is not K's. */
  ledger_without_commit: [
    documentOp(SUBJECT_FILES.ledger, '/transactions/0/provider_transaction_id', PROBE_IDS.absent),
  ],
  /** The ledger holds K's transaction twice. */
  ledger_duplicate: [
    documentOp(SUBJECT_FILES.ledger, '/transactions/1', LEDGER_TRANSACTION),
    documentOp(SUBJECT_FILES.ledger, '/pages/0/item_count', 2),
  ],
  /** The ledger snapshot does not declare a consistent read. */
  ledger_inconsistent: [documentOp(SUBJECT_FILES.ledger, '/consistent_read', false)],
  /** The ledger snapshot does not declare completion. */
  ledger_incomplete: [documentOp(SUBJECT_FILES.ledger, '/complete', false)],
  /** The runner judged settlement not established. */
  settlement_not_established: [
    setOp(SUBJECT_FILES.runner, 'settlement_assessed', '/status', 'not_established'),
    {
      op: 'remove',
      path: SUBJECT_FILES.runner,
      select: { record_type: 'settlement_assessed' },
      pointer: '/window_start',
    },
    {
      op: 'remove',
      path: SUBJECT_FILES.runner,
      select: { record_type: 'settlement_assessed' },
      pointer: '/established_at',
    },
    {
      op: 'remove',
      path: SUBJECT_FILES.runner,
      select: { record_type: 'settlement_assessed' },
      pointer: '/rechecked_at',
    },
    setOp(SUBJECT_FILES.runner, 'settlement_assessed', '/reasons', [
      { code: 'WINDOW_NOT_QUIET', subject: 'BR-RUA-032', detail: 'the source queue was not quiet for the window' },
    ]),
  ],
  /** The runner never assessed settlement (its last event, so no gap). */
  settlement_not_assessed: [removeOp(SUBJECT_FILES.runner, 'settlement_assessed')],
  /** A journal or document is absent. */
  no_caller_journal: [deleteOp(SUBJECT_FILES.caller)],
  no_provider_journal: [deleteOp(SUBJECT_FILES.provider)],
  no_controller_journal: [deleteOp(SUBJECT_FILES.controller)],
  no_runner_journal: [deleteOp(SUBJECT_FILES.runner)],
  no_ledger: [deleteOp(SUBJECT_FILES.ledger)],
  no_snapshot: [deleteOp(SUBJECT_FILES.snapshot)],
  no_configuration: [deleteOp(SUBJECT_FILES.configuration)],
  no_samples: [deleteOp(SUBJECT_FILES.samples)],
  /** The settlement samples hold a line that is not JSON. */
  unreadable_samples: [{ op: 'append_text', path: SUBJECT_FILES.samples, text: 'not a sample\n' }],
  /** A schema-invalid caller event (SUCCEEDED without its provider ids). */
  invalid_outcome_record: [setOp(SUBJECT_FILES.caller, 'attempt_outcome_recorded', '/outcome', 'SUCCEEDED')],
} as const satisfies Readonly<Record<string, readonly ScenarioOperation[]>>;
