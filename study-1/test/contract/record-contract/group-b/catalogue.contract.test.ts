// AC-RUA-046 (group B): the catalogue rows 19-65 plus the warm-up pair (addendum §3) each have
// exactly one schema and one record module; the schemas follow the catalogue conventions; the
// closed vocabularies the TypeScript modules export are the ones the schemas enforce.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { EVENT_SOURCES } from '../../../../src/record-contract/envelope.ts';
import { EXECUTION_KINDS, VARIANT_IDS } from '../../../../src/record-contract/primitives.ts';
import { EVENT_RECORD_TYPES, RECORD_TYPES, RECORD_TYPE_GROUPS } from '../../../../src/record-contract/record-types.ts';
import type { GroupBRecordType } from '../../../../src/record-contract/records/group-b/record-map.ts';
import * as vocabulary from '../../../../src/record-contract/records/group-b/vocabulary.ts';
import { findSchemaConventionViolations } from '../../../../src/record-contract/schema-conventions.ts';
import { listSchemaFiles } from '../../../../src/record-contract/schema-registry.ts';
import { CANONICAL_EXAMPLES, GROUP_B_EXAMPLES } from './examples/group-b-examples.ts';
import { toJson } from './support/record-builders.ts';
import { groupBValidator } from './support/group-b-validation.ts';
import { resolvePointer, schemaOf } from './support/schema-reading.ts';

const GROUP_B: readonly GroupBRecordType[] = RECORD_TYPE_GROUPS['group-b'];
const RECORD_MODULE_DIRECTORY = fileURLToPath(
  new URL('../../../../src/record-contract/records/group-b/', import.meta.url),
);
const SHARED_MODULES = ['record-map.ts', 'shared-shapes.ts', 'vocabulary.ts'];

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// Each closed vocabulary and the schema locations that must enforce exactly it.
const VOCABULARY_SITES: readonly (readonly [readonly string[], GroupBRecordType, string])[] = [
  [vocabulary.CALLER_IDS, 'provider_call_accepted', '/properties/caller_id/enum'],
  [vocabulary.ATTEMPT_OUTCOMES, 'attempt_outcome_recorded', '/properties/outcome/enum'],
  [vocabulary.DISPATCH_STATES, 'attempt_outcome_recorded', '/properties/dispatch_state/enum'],
  [vocabulary.PROVIDER_REJECTION_REASONS, 'attempt_outcome_recorded', '/properties/rejection_reason/enum'],
  [vocabulary.ATTEMPT_FAILURE_CODES, 'attempt_outcome_recorded', '/properties/failure/allOf/1/properties/code/enum'],
  [vocabulary.PRE_DISPATCH_FAILURE_CODES, 'attempt_not_dispatched', '/properties/failure/allOf/1/properties/code/enum'],
  [vocabulary.PROCESSING_STATES, 'request_state_recorded', '/properties/processing_state/enum'],
  [vocabulary.PROCESSING_TERMINAL_REASONS, 'request_state_recorded', '/properties/processing_terminal_reason/enum'],
  [vocabulary.EFFECT_KNOWLEDGE_STATES, 'request_state_recorded', '/properties/effect_knowledge/enum'],
  [vocabulary.ARBITER_WINNERS, 'caller_timeout_recorded', '/properties/arbiter_winner/enum'],
  [vocabulary.TRANSPORT_SETTLEMENT_KINDS, 'transport_settled_after_timeout', '/properties/settlement_kind/enum'],
  [vocabulary.TRIAL_MESSAGE_REJECTION_REASONS, 'trial_message_rejected', '/properties/reason/enum'],
  [vocabulary.PROVIDER_REJECTION_REASONS, 'provider_call_rejected', '/properties/reason/enum'],
  [vocabulary.TREATMENT_STATES, 'caller_timeout_rejected', '/properties/treatment_state/enum'],
  [vocabulary.TREATMENT_STATES, 'treatment_state_snapshot', '/$defs/treatment_item/properties/state/enum'],
  [vocabulary.TREATMENT_STATES, 'pre_cleanup_snapshot', '/$defs/treatment_read/properties/state/enum'],
  [vocabulary.NONTERMINAL_TREATMENT_STATES, 'treatment_safety_released', '/properties/from_state/enum'],
  [vocabulary.SIGNALLED_TREATMENT_STATES, 'timeout_signal_duplicate_observed', '/properties/treatment_state/enum'],
  [vocabulary.SIGNALLED_TREATMENT_STATES, 'timeout_signal_conflict_recorded', '/properties/treatment_state/enum'],
  [vocabulary.SAFETY_RELEASE_CAUSES, 'treatment_safety_released', '/properties/cause/enum'],
  [
    vocabulary.SAFETY_RELEASE_CAUSES,
    'treatment_state_snapshot',
    '/$defs/treatment_item/properties/safety_release_cause/enum',
  ],
  [vocabulary.CALLER_TIMEOUT_REJECTION_REASONS, 'caller_timeout_rejected', '/properties/reason/enum'],
  [vocabulary.EXECUTION_PHASES, 'phase_transition_recorded', '/properties/phase/enum'],
  [vocabulary.STEP_STATUSES, 'phase_transition_recorded', '/properties/status/enum'],
  [vocabulary.STEP_STATUSES, 'cleanup_action_recorded', '/properties/step_status/enum'],
  [vocabulary.PROVISIONING_EVENTS, 'provisioning_event_recorded', '/properties/provisioning_event/enum'],
  [vocabulary.TRIAL_PARTITION_TABLE_ROLES, 'trial_partitions_verified_absent', '/properties/table_roles/items/enum'],
  [vocabulary.SETTLEMENT_STATUSES, 'settlement_assessed', '/properties/status/enum'],
  [vocabulary.SETTLEMENT_RESTART_CAUSES, 'settlement_assessed', '/$defs/settlement_restart/properties/cause/enum'],
  [vocabulary.SETTLEMENT_SAMPLE_PHASES, 'settlement_sample', '/properties/phase/enum'],
  [vocabulary.QUEUE_COUNTER_MARKERS, 'settlement_sample', '/properties/source_queue/anyOf/1/enum'],
  [vocabulary.QUEUE_COUNTER_MARKERS, 'settlement_sample', '/properties/dlq/anyOf/1/enum'],
  [vocabulary.INTERRUPTION_CAUSES, 'trial_interrupted', '/properties/cause/enum'],
  [vocabulary.SAFETY_BOUNDARIES, 'safety_check_recorded', '/properties/boundary/enum'],
  [vocabulary.SAFETY_RESULTS, 'safety_check_recorded', '/properties/result/enum'],
  [vocabulary.LEASE_EVENTS, 'lease_event_recorded', '/properties/lease_event/enum'],
  [vocabulary.LEASE_HEALTH_STATES, 'lease_event_recorded', '/properties/lease_health/enum'],
  [EXECUTION_KINDS, 'lease_event_recorded', '/properties/owner_kind/enum'],
  [EXECUTION_KINDS, 'lease_event_recorded', '/properties/holder_owner_kind/enum'],
  [vocabulary.CLEANUP_MODES, 'cleanup_action_recorded', '/properties/cleanup_mode/enum'],
  [vocabulary.CLEANUP_MODES, 'pre_cleanup_snapshot', '/properties/cleanup_mode/enum'],
  [vocabulary.OWNERSHIP_BASES, 'cleanup_action_recorded', '/properties/ownership_basis/enum'],
  [vocabulary.QUEUE_ROLES, 'queue_observation', '/properties/queue_role/enum'],
  [vocabulary.READ_STATUSES, 'queue_observation', '/properties/read_status/enum'],
  [vocabulary.READ_STATUSES, 'pre_cleanup_snapshot', '/$defs/queue_read/properties/read_status/enum'],
  [vocabulary.TREATMENT_READ_STATUSES, 'pre_cleanup_snapshot', '/$defs/treatment_read/properties/read_status/enum'],
  [
    vocabulary.DURABLE_EXECUTION_STATUSES,
    'pre_cleanup_snapshot',
    '/$defs/durable_execution_status/properties/status/enum',
  ],
  [
    vocabulary.DURABLE_EXECUTION_STATUSES,
    'durable_execution_metadata',
    '/$defs/durable_execution/properties/status/enum',
  ],
  [
    vocabulary.TELEMETRY_AVAILABILITIES,
    'telemetry_availability',
    '/$defs/signal_availability/properties/availability/enum',
  ],
  [vocabulary.LEDGER_TRANSACTION_STATUSES, 'ledger_snapshot', '/$defs/ledger_transaction/properties/status/enum'],
  [VARIANT_IDS, 'trial_message_published', '/properties/variant_id/enum'],
];

// The `source` each journal event admits (design §6.2 writers; BR-RUA-033 envelope).
const CALLERS = vocabulary.CALLER_EVENT_SOURCES;
const EVENT_WRITERS: Readonly<Partial<Record<GroupBRecordType, readonly string[]>>> = {
  caller_invocation_started: CALLERS,
  trial_message_rejected: ['conventional_caller', 'durable_caller'],
  attempt_registered: CALLERS,
  attempt_not_dispatched: CALLERS,
  dispatch_started: CALLERS,
  caller_timeout_recorded: [...CALLERS, 'runner'],
  transport_settled_after_timeout: CALLERS,
  attempt_outcome_recorded: CALLERS,
  request_state_recorded: CALLERS,
  inner_execution_exhausted: ['durable_caller'],
  provider_call_received: ['refund_provider'],
  provider_call_rejected: ['refund_provider'],
  provider_call_accepted: ['refund_provider'],
  provider_transaction_committed: ['refund_provider'],
  provider_commit_confirmed: ['refund_provider'],
  provider_commit_failed: ['refund_provider'],
  treatment_timeout_observed: ['refund_provider'],
  treatment_response_released: ['refund_provider'],
  treatment_safety_released: ['refund_provider'],
  provider_response_returned: ['refund_provider'],
  provider_warmup_completed: ['refund_provider'],
  timeout_signal_recorded: ['treatment_controller'],
  timeout_signal_duplicate_observed: ['treatment_controller'],
  timeout_signal_conflict_recorded: ['treatment_controller'],
  late_timeout_signal_rejected: ['treatment_controller'],
  caller_timeout_rejected: ['treatment_controller'],
  controller_canary_acknowledged: ['treatment_controller'],
  phase_transition_recorded: ['runner'],
  provisioning_event_recorded: ['runner'],
  trial_partitions_verified_absent: ['runner'],
  treatment_armed: ['runner'],
  trial_message_published: ['runner'],
  probe_workload_invoked: ['runner'],
  settlement_assessed: ['runner'],
  trial_evidence_frozen: ['runner'],
  trial_interrupted: ['runner'],
  safety_check_recorded: ['runner'],
  lease_event_recorded: ['coordination_lease'],
  cleanup_action_recorded: ['cleanup'],
};

describe('AC-RUA-046 group B catalogue', () => {
  it('lists exactly the 49 group-B record types, one schema each, within 90 catalogued names', () => {
    const listed = listSchemaFiles()
      .filter((file) => file.relative_path.startsWith('group-b/'))
      .map((file) => file.record_type);
    assert.deepEqual(listed, GROUP_B.toSorted());
    assert.equal(GROUP_B.length, 49);
    assert.equal(RECORD_TYPES.length, 90);
    assert.ok(GROUP_B.includes('provider_warmup_request') && GROUP_B.includes('provider_warmup_completed'));
    const mapMatchesCatalogue: Equal<GroupBRecordType, (typeof RECORD_TYPE_GROUPS)['group-b'][number]> = true;
    assert.equal(mapMatchesCatalogue, true);
  });

  it('every group-B schema follows the catalogue conventions', () => {
    for (const recordType of GROUP_B) {
      assert.deepEqual(findSchemaConventionViolations(recordType, schemaOf(recordType)), [], recordType);
    }
  });

  it('has one record module per type plus the shared vocabulary, shapes and type map', async () => {
    const modules = readdirSync(RECORD_MODULE_DIRECTORY).toSorted();
    assert.deepEqual(modules, [...GROUP_B.map((recordType) => `${recordType}.ts`), ...SHARED_MODULES].toSorted());
    for (const name of modules.filter((module) => module !== 'vocabulary.ts')) {
      const loaded = (await import(join(RECORD_MODULE_DIRECTORY, name))) as Readonly<Record<string, unknown>>;
      assert.deepEqual(Object.keys(loaded), [], `${name} is type-only`);
    }
  });

  it('every closed vocabulary is the enum its schema enforces', () => {
    for (const [values, recordType, pointer] of VOCABULARY_SITES) {
      assert.deepEqual(resolvePointer(schemaOf(recordType), pointer), [...values], `${recordType}#${pointer}`);
    }
    assert.equal(
      resolvePointer(schemaOf('settlement_sample'), '/properties/inner_executions_terminal/anyOf/1/const'),
      vocabulary.NOT_APPLICABLE,
    );
    for (const recordType of GROUP_B.filter((type) => EVENT_WRITERS[type] !== undefined)) {
      assert.deepEqual(
        resolvePointer(schemaOf(recordType), '/properties/source/enum'),
        EVENT_WRITERS[recordType],
        `${recordType} source`,
      );
    }
  });

  it('marks as journal events exactly the types that carry the envelope', () => {
    const events: readonly string[] = EVENT_RECORD_TYPES;
    assert.deepEqual(
      GROUP_B.filter((recordType) => events.includes(recordType)),
      GROUP_B.filter((recordType) => EVENT_WRITERS[recordType] !== undefined),
    );
  });

  it('rejects every event source outside the writers of each journal event', () => {
    for (const recordType of GROUP_B) {
      const writers = EVENT_WRITERS[recordType] ?? [];
      const record = toJson(CANONICAL_EXAMPLES[recordType]());
      for (const source of EVENT_SOURCES.filter((candidate) => writers.length > 0 && !writers.includes(candidate))) {
        assert.equal(groupBValidator.validate({ ...record, source }).valid, false, `${recordType} from ${source}`);
      }
    }
  });

  it('has a valid canonical example of every type, validated as that type', () => {
    for (const recordType of GROUP_B) {
      const record = toJson(CANONICAL_EXAMPLES[recordType]());
      assert.equal(record['record_type'], recordType);
      assert.equal(groupBValidator.validateAs(recordType, record).valid, true, recordType);
    }
    const covered = new Set(GROUP_B_EXAMPLES.map((example) => example.record.record_type));
    assert.equal(covered.size, GROUP_B.length);
  });
});
