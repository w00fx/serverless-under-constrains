// What an expected artifact's class says about its records (design §8.1 expected artifact set,
// §8.2 I2): the record type every line or document must be, and whether the file belongs to the
// execution (manifests, runner journal) or to the trial or probe under evaluation. Ingestion owns
// this table because it may not import evidence-package (same layer, no declared edge, §5.4).

import type { RecordType } from '../record-contract/record-types.ts';
import type { ArtifactClass } from '../record-contract/records/group-c/vocabulary.ts';
import type { ParsedArtifact } from './artifact-reading.ts';

/** Any journal event type: a journal holds many event types, and nothing else. */
export const ANY_EVENT = 'any_event';
export type ExpectedRecordShape = RecordType | typeof ANY_EVENT;

const RECORD_SHAPE_BY_CLASS: ReadonlyMap<ArtifactClass, ExpectedRecordShape> = new Map<
  ArtifactClass,
  ExpectedRecordShape
>([
  ['execution_manifest', 'execution_manifest'],
  ['resource_manifest', 'resource_manifest'],
  ['runner_journal', ANY_EVENT],
  ['trial_manifest', 'trial_manifest'],
  ['payment', 'payment'],
  ['approved_decision', 'approved_decision'],
  ['published_message', 'trial_message'],
  ['provider_trial_configuration', 'provider_trial_configuration'],
  ['treatment_state_snapshot', 'treatment_state_snapshot'],
  ['trial_registration', 'trial_registration'],
  ['caller_journal', ANY_EVENT],
  ['provider_journal', ANY_EVENT],
  ['controller_journal', ANY_EVENT],
  ['ledger_snapshot', 'ledger_snapshot'],
  ['source_observations', 'queue_observation'],
  ['dlq_observations', 'queue_observation'],
  ['dlq_snapshot', 'dlq_snapshot'],
  ['settlement_samples', 'settlement_sample'],
  ['durable_execution_metadata', 'durable_execution_metadata'],
  ['telemetry_availability', 'telemetry_availability'],
]);

/** The expected classes that belong to the whole execution rather than to the evaluated unit. */
const EXECUTION_LEVEL_CLASSES: ReadonlySet<ArtifactClass> = new Set<ArtifactClass>([
  'execution_manifest',
  'resource_manifest',
  'runner_journal',
]);

/**
 * The record shape an artifact's class demands, or `undefined` when the class demands none (a
 * supplementary or execution-scope artifact, validated against whatever type it declares).
 *
 * @example
 * expectedRecordShape({ artifact_class: 'published_message' }); // 'trial_message'
 */
export function expectedRecordShape(artifact: Pick<ParsedArtifact, 'artifact_class'>): ExpectedRecordShape | undefined {
  return artifact.artifact_class === undefined ? undefined : RECORD_SHAPE_BY_CLASS.get(artifact.artifact_class);
}

/**
 * Whether an artifact is a file of the evaluated trial or probe directory, whose records must
 * carry the subject's trial identity (design §8.2 I2, I3).
 *
 * @example
 * isUnitFile({ origin: 'subject', artifact_class: 'caller_journal' }); // true
 * isUnitFile({ origin: 'subject', artifact_class: 'runner_journal' }); // false
 */
export function isUnitFile(artifact: Pick<ParsedArtifact, 'origin' | 'artifact_class'>): boolean {
  return (
    artifact.origin === 'subject' &&
    artifact.artifact_class !== undefined &&
    !EXECUTION_LEVEL_CLASSES.has(artifact.artifact_class)
  );
}
