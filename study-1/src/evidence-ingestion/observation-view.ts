// The subject's single-record documents and observation streams as typed records (design §5.3
// `ObservationView`), plus the one requirement ingestion can only decide after reading them: the
// DLQ snapshot is conditional, required when a settlement sample correlates a DLQ message to the
// trial (design §8.1 expected artifact set; BR-RUA-037), and then its absence is ARTIFACT_MISSING.

import type { ApprovedDecision } from '../record-contract/records/group-a/approved_decision.ts';
import type { ExecutionManifest } from '../record-contract/records/group-a/execution_manifest.ts';
import type { Payment } from '../record-contract/records/group-a/payment.ts';
import type { ProviderTrialConfiguration } from '../record-contract/records/group-a/provider_trial_configuration.ts';
import type { ResourceManifest } from '../record-contract/records/group-a/resource_manifest.ts';
import type { TrialManifest } from '../record-contract/records/group-a/trial_manifest.ts';
import type { TrialMessage } from '../record-contract/records/group-a/trial_message.ts';
import type { TrialRegistration } from '../record-contract/records/group-a/trial_registration.ts';
import type { DlqSnapshot } from '../record-contract/records/group-b/dlq_snapshot.ts';
import type { DurableExecutionMetadata } from '../record-contract/records/group-b/durable_execution_metadata.ts';
import type { QueueObservation } from '../record-contract/records/group-b/queue_observation.ts';
import type { SettlementSample } from '../record-contract/records/group-b/settlement_sample.ts';
import type { TelemetryAvailabilityRecord } from '../record-contract/records/group-b/telemetry_availability.ts';
import type { TreatmentStateSnapshot } from '../record-contract/records/group-b/treatment_state_snapshot.ts';
import { missingArtifactFinding } from './artifact-reading.ts';
import type { ExpectedArtifact, IngestedArtifact, IngestionFinding, ObservationView } from './ingestion-model.ts';
import { soleRecord, streamRecords, subjectArtifact } from './located-records.ts';

export interface ObservationReading {
  readonly view: ObservationView;
  readonly findings: readonly IngestionFinding[];
}

/**
 * Builds the typed view of the subject's documents and streams and reports a conditional DLQ
 * snapshot that became required but is absent.
 *
 * @example
 * const { view } = readObservations(artifacts, input.expected);
 * view.payment?.record.captured_amount_minor;
 */
export function readObservations(
  artifacts: readonly IngestedArtifact[],
  expected: readonly ExpectedArtifact[],
): ObservationReading {
  const view: ObservationView = {
    ...optional('execution_manifest', soleRecord<ExecutionManifest>(artifacts, 'execution_manifest')),
    ...optional('resource_manifest', soleRecord<ResourceManifest>(artifacts, 'resource_manifest')),
    ...optional('trial_manifest', soleRecord<TrialManifest>(artifacts, 'trial_manifest')),
    ...optional('payment', soleRecord<Payment>(artifacts, 'payment')),
    ...optional('approved_decision', soleRecord<ApprovedDecision>(artifacts, 'approved_decision')),
    ...optional('published_message', soleRecord<TrialMessage>(artifacts, 'published_message')),
    ...optional(
      'provider_configuration',
      soleRecord<ProviderTrialConfiguration>(artifacts, 'provider_trial_configuration'),
    ),
    ...optional('treatment_snapshot', soleRecord<TreatmentStateSnapshot>(artifacts, 'treatment_state_snapshot')),
    ...optional('trial_registration', soleRecord<TrialRegistration>(artifacts, 'trial_registration')),
    ...optional('dlq_snapshot', soleRecord<DlqSnapshot>(artifacts, 'dlq_snapshot')),
    ...optional('durable_executions', soleRecord<DurableExecutionMetadata>(artifacts, 'durable_execution_metadata')),
    ...optional('telemetry', soleRecord<TelemetryAvailabilityRecord>(artifacts, 'telemetry_availability')),
    settlement_samples: streamRecords<SettlementSample>(artifacts, 'settlement_samples'),
    source_observations: streamRecords<QueueObservation>(artifacts, 'source_observations'),
    dlq_observations: streamRecords<QueueObservation>(artifacts, 'dlq_observations'),
  };
  return { view, findings: conditionalDlqSnapshot(view, artifacts, expected) };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

function conditionalDlqSnapshot(
  view: ObservationView,
  artifacts: readonly IngestedArtifact[],
  expected: readonly ExpectedArtifact[],
): readonly IngestionFinding[] {
  const declared = expected.find((artifact) => artifact.artifact_class === 'dlq_snapshot');
  const correlated = view.settlement_samples.some((sample) => sample.record.correlated_dlq_message_ids.length > 0);
  if (declared === undefined || !correlated || subjectArtifact(artifacts, 'dlq_snapshot') !== undefined) {
    return [];
  }
  return [missingArtifactFinding({ ...declared, requirement: 'required' })];
}
