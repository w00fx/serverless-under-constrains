// Runner-journal and coordination-journal events for the terminal-reason and lease-status tests:
// valid records whose only varying members are the phase, status, cause or lease event and the
// instant they occurred at.

import type { Sha256Hex, Uuid4, UtcMillis } from '../../../../src/record-contract/primitives.ts';
import type { LeaseEventRecorded } from '../../../../src/record-contract/records/group-b/lease_event_recorded.ts';
import type { PhaseTransitionRecorded } from '../../../../src/record-contract/records/group-b/phase_transition_recorded.ts';
import type { TrialInterrupted } from '../../../../src/record-contract/records/group-b/trial_interrupted.ts';
import type {
  ExecutionPhase,
  InterruptionCause,
  LeaseEvent,
  StepStatus,
} from '../../../../src/record-contract/records/group-b/vocabulary.ts';

const RUN_ID = 'b42ee7a8-4b45-43d7-8ca3-cb72ceae84c4' as Uuid4;
const MANIFEST_SHA256 = '2984caaa5b239ade122795836daf9a192274668b9ae3ccaeba026eee004ec052' as Sha256Hex;
const RUNNER_INSTANCE = '14f07508-d729-44a9-9316-85ec257e833b' as Uuid4;
const LEASE_INSTANCE = '7d1c3e0a-5b6f-4c2d-9e8a-1f0b2c3d4e5f' as Uuid4;

/** `2026-10-05T12:MM:00.000Z` for minute `minute`. */
function minuteAt(minute: number): UtcMillis {
  return `2026-10-05T12:${String(minute).padStart(2, '0')}:00.000Z` as UtcMillis;
}

function eventId(minute: number, kind: number): Uuid4 {
  return `00000000-0000-4000-8000-${String(kind).padStart(6, '0')}${String(minute).padStart(6, '0')}` as Uuid4;
}

/**
 * A runner phase transition at minute `minute`.
 *
 * @example
 * phaseEvent('PROVISIONING', 'failed', 5);
 */
export function phaseEvent(phase: ExecutionPhase, status: StepStatus, minute: number): PhaseTransitionRecorded {
  return {
    schema_version: 1,
    record_type: 'phase_transition_recorded',
    event_id: eventId(minute, 1),
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA256,
    occurred_at: minuteAt(minute),
    source: 'runner',
    source_instance_id: RUNNER_INSTANCE,
    source_sequence: minute + 1,
    phase,
    status,
    reasons: [],
  };
}

/**
 * A trial interruption at minute `minute`.
 *
 * @example
 * interruptionEvent('OPERATOR_ABORT', 20);
 */
export function interruptionEvent(cause: InterruptionCause, minute: number): TrialInterrupted {
  return {
    schema_version: 1,
    record_type: 'trial_interrupted',
    event_id: eventId(minute, 2),
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA256,
    occurred_at: minuteAt(minute),
    source: 'runner',
    source_instance_id: RUNNER_INSTANCE,
    source_sequence: minute + 1,
    cause,
    detail: `interrupted by ${cause}`,
  };
}

/**
 * A coordination-lease event at minute `minute`.
 *
 * @example
 * leaseEvent('RELEASED', 59);
 */
export function leaseEvent(event: LeaseEvent, minute: number): LeaseEventRecorded {
  return {
    schema_version: 1,
    record_type: 'lease_event_recorded',
    event_id: eventId(minute, 3),
    run_id: RUN_ID,
    execution_manifest_sha256: MANIFEST_SHA256,
    occurred_at: minuteAt(minute),
    source: 'coordination_lease',
    source_instance_id: LEASE_INSTANCE,
    source_sequence: minute + 1,
    lease_event: event,
    owner_kind: 'RUN',
    owner_id: RUN_ID,
    owner_manifest_sha256: MANIFEST_SHA256,
  };
}
